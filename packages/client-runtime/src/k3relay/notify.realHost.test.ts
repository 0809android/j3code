// @effect-diagnostics nodeBuiltinImport:off -- loads the real host, relay and fake APNs / FCM at run time.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, expect, it } from "@effect/vitest";
import type { K3RelayHostState } from "@t3tools/contracts";
import { decodeBase64url } from "@t3tools/shared/relay";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as DeviceKeyStore from "./deviceKeyStore.ts";
import { layerTestCrypto, layerWebSocketGlobal } from "./k3relay.testkit.ts";
import { NotificationKeyStore, layerMemoryNotificationKeyStore } from "./notificationKeyStore.ts";
import {
  DEFAULT_NOTIFY_KINDS,
  openK3RelayPush,
  readK3RelayNotificationStatus,
  registerK3RelayNotificationKey,
  registerK3RelayPushToken,
  sendK3RelayTestNotification,
  unregisterK3RelayNotificationKey,
} from "./notify.ts";
import { runK3RelayDevicePairing } from "./pairing.ts";
import { openK3RelayTunnel } from "./tunnel.ts";

/**
 * Notifications end to end, with nothing stood in for but APNs and FCM: the real relay with its
 * push gateway, the real host (`RelayConnector`, `RelayNotifier`, ledger), and this runtime's
 * pairing, tunnel, key store and registration. The device opens what the fake APNs received.
 */

interface RealHost {
  readonly hostId: string;
  readonly environmentId: string;
  readonly createPairingOffer: () => Promise<{ readonly link: string }>;
  readonly awaitState: (
    predicate: (state: K3RelayHostState) => boolean,
    timeoutMs?: number,
  ) => Promise<K3RelayHostState>;
  readonly state: () => Promise<K3RelayHostState>;
  readonly approvePairing: (deviceId: string, confirmationCode?: string) => Promise<unknown>;
  readonly revokeDevice: (deviceId: string) => Promise<unknown>;
  readonly notify: (
    kind: "approval" | "input" | "completed" | "failed",
    threadId: string,
  ) => Promise<ReadonlyArray<string>>;
  readonly dispose: () => Promise<void>;
}

interface HostTestkit {
  startK3RelayTestRelayHandle(overrides: object): Promise<{
    url: string;
    logs: () => ReadonlyArray<string>;
    dispose(): Promise<void>;
  }>;
  startK3RelayTestHost(options: { readonly relayUrl: string }): Promise<RealHost>;
}

interface FakeApns {
  readonly credentials: object;
  readonly requests: Array<{ readonly body: Record<string, unknown>; readonly jwtValid: boolean }>;
  close(): Promise<void>;
}

interface PushTestkit {
  startFakeApns(): Promise<FakeApns>;
  readonly APNS_TOKEN: string;
}

const load = <A>(relative: string) =>
  Effect.promise(
    async () =>
      (await import(
        /* @vite-ignore */ NodeURL.fileURLToPath(new URL(relative, import.meta.url))
      )) as A,
  );

const loadHostTestkit = load<HostTestkit>(
  "../../../../apps/server/src/relay/k3relay/k3relayHost.testkit.ts",
);
const loadPushTestkit = load<PushTestkit>("../../../../infra/k3-relay/src/push.testkit.ts");

/** The relay with a fake APNs behind it and its database in a file, so its bytes can be read. */
const startStack = Effect.gen(function* () {
  const pushKit = yield* loadPushTestkit;
  const hostKit = yield* loadHostTestkit;
  const apns = yield* Effect.acquireRelease(
    Effect.promise(() => pushKit.startFakeApns()),
    (fake) => Effect.promise(() => fake.close()),
  );
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "k3-notify-e2e-"))),
    (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
  );
  const relay = yield* Effect.acquireRelease(
    Effect.promise(() =>
      hostKit.startK3RelayTestRelayHandle({
        apns: apns.credentials,
        dbPath: NodePath.join(directory, "relay.sqlite"),
      }),
    ),
    (handle) => Effect.promise(() => handle.dispose()),
  );
  const host = yield* Effect.acquireRelease(
    Effect.promise(() => hostKit.startK3RelayTestHost({ relayUrl: relay.url })),
    (started) => Effect.promise(() => started.dispose()),
  );
  return { apns, relay, host, directory, token: pushKit.APNS_TOKEN };
});

/** QR pairing with the real host, the user approving with the compared code. */
const pair = (host: RealHost) =>
  Effect.gen(function* () {
    const offer = yield* Effect.promise(() => host.createPairingOffer());
    const pairing = yield* runK3RelayDevicePairing(
      { link: offer.link, deviceName: "Kino's phone" },
      () => Effect.void,
    ).pipe(Effect.forkScoped);
    const waiting = (yield* Effect.promise(() =>
      host.awaitState((state) => state.pairing.phase === "awaiting-approval"),
    )).pairing;
    assert(waiting.phase === "awaiting-approval");
    yield* Effect.promise(() => host.approvePairing(waiting.deviceId, waiting.confirmationCode));
    const paired = yield* Fiber.join(pairing);
    return { paired, deviceId: waiting.deviceId };
  });

const layerDevice = Layer.mergeAll(
  layerTestCrypto,
  layerWebSocketGlobal,
  DeviceKeyStore.layerMemory(),
  layerMemoryNotificationKeyStore(),
  SecureRandom.layerWebCrypto,
);

const THREAD_ID = "thread-notify-e2e-7f31";

describe("K3 relay notifications, end to end", () => {
  it.live(
    "a device registers Nk and its token; the host's event reaches it sealed and opens to the event",
    () =>
      Effect.gen(function* () {
        const { apns, relay, host, directory, token } = yield* startStack;
        const { paired, deviceId } = yield* pair(host);
        const record = paired.record;
        const tunnel = yield* openK3RelayTunnel({
          relayUrl: record.relayUrl,
          hostId: record.hostId,
          hostIdentityKey: decodeBase64url(record.hostIdentityKey, 32)!,
          signer: paired.signer,
          grant: record.grant,
        });

        // Nk to the host, inside the E2E channel.
        const keys = yield* NotificationKeyStore;
        const key = yield* keys.ensure({
          hostId: record.hostId,
          environmentId: host.environmentId,
          hostLabel: "Studio Mac",
        });
        const status = yield* registerK3RelayNotificationKey(tunnel.transport, {
          publicKey: key.publicKey,
          kinds: DEFAULT_NOTIFY_KINDS,
        });
        expect(status).toMatchObject({ registered: true, keyId: key.keyId, hostEnabled: true });
        expect(
          (yield* Effect.promise(() => host.state())).devices.find(
            (device) => device.deviceId === deviceId,
          )?.notifications,
        ).toBe(true);

        // Nothing to send to yet: the relay has no token for this device.
        expect(yield* Effect.promise(() => host.notify("approval", THREAD_ID))).toEqual([
          "no-target",
        ]);

        // The push token to the relay, signed with Dk.
        yield* registerK3RelayPushToken({
          relayUrl: record.relayUrl,
          hostId: record.hostId,
          signer: paired.signer,
          grant: record.grant,
          push: { platform: "ios", token },
        });

        expect(yield* Effect.promise(() => host.notify("approval", THREAD_ID))).toEqual(["sent"]);
        expect(apns.requests).toHaveLength(1);
        const delivered = apns.requests[0]!;
        expect(delivered.jwtValid).toBe(true);
        const opened = yield* openK3RelayPush(delivered.body.k3);
        assert(opened.ok);
        expect(opened.payload).toMatchObject({
          kind: "approval",
          thread: THREAD_ID,
          env: host.environmentId,
        });
        expect(opened.context).toEqual({
          hostId: record.hostId,
          environmentId: host.environmentId,
          hostLabel: "Studio Mac",
        });
        // The same envelope again is a replay.
        expect(yield* openK3RelayPush(delivered.body.k3)).toEqual({
          ok: false,
          reason: "replayed",
        });

        // A test notification, asked for through the tunnel, reaches only this device.
        expect(yield* sendK3RelayTestNotification(tunnel.transport)).toBe("sent");
        const test = yield* openK3RelayPush(apns.requests[1]!.body.k3);
        assert(test.ok);
        expect(test.payload.kind).toBe("test");

        // Kinds the device turned off are not sent.
        yield* registerK3RelayNotificationKey(tunnel.transport, {
          publicKey: key.publicKey,
          kinds: { ...DEFAULT_NOTIFY_KINDS, completed: false },
        });
        expect(yield* Effect.promise(() => host.notify("completed", THREAD_ID))).toEqual([
          "kind-off",
        ]);
        expect(apns.requests).toHaveLength(2);

        // Neither the relay's database nor its log holds anything from the notification.
        const raw = NodeFS.readdirSync(directory)
          .map((name) => NodeFS.readFileSync(NodePath.join(directory, name)).toString("latin1"))
          .join("\n");
        const logs = relay.logs().join("\n");
        for (const needle of [
          THREAD_ID,
          host.environmentId,
          "Studio Mac",
          String(delivered.body.k3),
        ]) {
          expect(raw.includes(needle), `relay database holds ${needle}`).toBe(false);
          expect(logs.includes(needle), `relay log holds ${needle}`).toBe(false);
        }
        expect(raw).toContain(record.hostId);
      }).pipe(Effect.scoped, Effect.provide(layerDevice)),
  );

  it.live("a revoked device gets nothing more, and the host forgets its key", () =>
    Effect.gen(function* () {
      const { apns, host, token } = yield* startStack;
      const { paired, deviceId } = yield* pair(host);
      const record = paired.record;
      const keys = yield* NotificationKeyStore;
      const key = yield* keys.ensure({
        hostId: record.hostId,
        environmentId: host.environmentId,
        hostLabel: null,
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tunnel = yield* openK3RelayTunnel({
            relayUrl: record.relayUrl,
            hostId: record.hostId,
            hostIdentityKey: decodeBase64url(record.hostIdentityKey, 32)!,
            signer: paired.signer,
            grant: record.grant,
          });
          yield* registerK3RelayNotificationKey(tunnel.transport, {
            publicKey: key.publicKey,
            kinds: DEFAULT_NOTIFY_KINDS,
          });
          expect((yield* readK3RelayNotificationStatus(tunnel.transport)).registered).toBe(true);
          // A device can take itself off, and back on.
          expect((yield* unregisterK3RelayNotificationKey(tunnel.transport)).registered).toBe(
            false,
          );
          yield* registerK3RelayNotificationKey(tunnel.transport, {
            publicKey: key.publicKey,
            kinds: DEFAULT_NOTIFY_KINDS,
          });
        }),
      );
      yield* registerK3RelayPushToken({
        relayUrl: record.relayUrl,
        hostId: record.hostId,
        signer: paired.signer,
        grant: record.grant,
        push: { platform: "ios", token },
      });
      expect(yield* Effect.promise(() => host.notify("failed", THREAD_ID))).toEqual(["sent"]);

      yield* Effect.promise(() => host.revokeDevice(deviceId));
      expect(yield* Effect.promise(() => host.notify("failed", THREAD_ID))).toEqual([]);
      expect(apns.requests).toHaveLength(1);
      const state = yield* Effect.promise(() => host.state());
      expect(state.devices.find((device) => device.deviceId === deviceId)).toMatchObject({
        status: "revoked",
        notifications: false,
      });
    }).pipe(Effect.scoped, Effect.provide(layerDevice)),
  );
});
