import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type K3RelayHostState, ThreadId } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { hpkeGenerateKeyPair } from "@t3tools/shared/notify";
import { encodeBase64url, relayDeviceId } from "@t3tools/shared/relay";
import { generateDeviceKeypair, layerE2eeCrypto } from "@t3tools/shared/socketE2ee";

import type { AgentAwarenessThread } from "../../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  layerK3RelayTestHost as layerHost,
  startK3RelayTestRelay as startRelay,
} from "./k3relayHost.testkit.ts";
import * as RelayConnector from "./RelayConnector.ts";
import * as RelayDeviceLedger from "./RelayDeviceLedger.ts";
import * as RelayNotifier from "./RelayNotifier.ts";
import { alertKeyOf, notifyKindOfPhase } from "./RelayNotifyWatcher.ts";

const layerTest = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerE2eeCrypto);

const awaitState = (predicate: (state: K3RelayHostState) => boolean) =>
  Effect.flatMap(RelayConnector.RelayConnector, (connector) =>
    connector.changes.pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.timeout("20 seconds"),
    ),
  );

const ALL = { approval: true, input: true, completed: true, failed: true };

/** A device the ledger approved, as pairing leaves it. */
const approvedDevice = Effect.gen(function* () {
  const ledger = yield* RelayDeviceLedger.RelayDeviceLedger;
  const keypair = yield* generateDeviceKeypair("ed25519");
  yield* ledger.add({
    alg: "ed25519",
    publicKey: keypair.publicKey,
    name: "Test phone",
    now: yield* Clock.currentTimeMillis,
  });
  return relayDeviceId("ed25519", keypair.publicKey);
});

describe("RelayNotifier", () => {
  it.live("registers only active devices and only valid keys", () =>
    Effect.gen(function* () {
      const { url } = yield* startRelay;
      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.status === "connected");
        const notifier = yield* RelayNotifier.RelayNotifier;
        const deviceId = yield* approvedDevice;
        const nk = hpkeGenerateKeyPair();
        const status = yield* notifier.register(deviceId, {
          publicKey: encodeBase64url(nk.publicKey),
          kinds: ALL,
        });
        expect(status).toMatchObject({ registered: true, hostEnabled: true, kinds: ALL });
        expect(yield* notifier.registeredDeviceIds).toEqual(new Set([deviceId]));

        const badKey = yield* Effect.flip(
          notifier.register(deviceId, { publicKey: "too-short", kinds: ALL }),
        );
        expect(badKey.reason).toBe("invalid-key");
        const stranger = yield* Effect.flip(
          notifier.register("a".repeat(32), {
            publicKey: encodeBase64url(nk.publicKey),
            kinds: ALL,
          }),
        );
        expect(stranger.reason).toBe("inactive-device");

        // Revoking forgets the key, and its device is not notified again.
        yield* (yield* RelayConnector.RelayConnector).revokeDevice(deviceId);
        expect((yield* notifier.status(deviceId)).registered).toBe(false);
        expect(
          (yield* (yield* RelayConnector.RelayConnector).state).devices.find(
            (device) => device.deviceId === deviceId,
          ),
        ).toMatchObject({ status: "revoked", notifications: false });
        expect(yield* notifier.notify({ kind: "approval", threadId: "t-1" })).toEqual([]);
      }).pipe(Effect.provide(layerHost({ relayUrl: url })));
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("sends nothing while relay notifications are off, and respects each device's kinds", () =>
    Effect.gen(function* () {
      const { url } = yield* startRelay;
      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.status === "connected");
        const notifier = yield* RelayNotifier.RelayNotifier;
        const settings = yield* ServerSettings.ServerSettingsService;
        const deviceId = yield* approvedDevice;
        yield* notifier.register(deviceId, {
          publicKey: encodeBase64url(hpkeGenerateKeyPair().publicKey),
          kinds: { ...ALL, completed: false },
        });
        // Registered with the host, but no push token at the relay yet.
        expect(yield* notifier.notify({ kind: "approval", threadId: "t-1" })).toEqual([
          "no-target",
        ]);
        expect(yield* notifier.notify({ kind: "completed", threadId: "t-1" })).toEqual([
          "kind-off",
        ]);
        // A device joining by introduction is told to every device, whatever it chose.
        yield* notifier.register(deviceId, {
          publicKey: encodeBase64url(hpkeGenerateKeyPair().publicKey),
          kinds: { approval: false, input: false, completed: false, failed: false },
        });
        expect(yield* notifier.notifyIntroduction).toEqual(["no-target"]);

        yield* settings.updateSettings({ relay: { notifications: false } });
        expect(yield* notifier.notify({ kind: "approval", threadId: "t-1" })).toEqual([]);
        expect((yield* notifier.status(deviceId)).hostEnabled).toBe(false);
        // Turning notifications off does not drop the relay connection.
        expect((yield* (yield* RelayConnector.RelayConnector).state).status).toBe("connected");

        yield* settings.updateSettings({ relay: { notifications: true, enabled: false } });
        expect(yield* notifier.notify({ kind: "approval", threadId: "t-1" })).toEqual([]);
      }).pipe(Effect.provide(layerHost({ relayUrl: url })));
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("which thread changes notify", () => {
  const thread = (overrides: Partial<AgentAwarenessThread>) =>
    ({
      id: ThreadId.make("thread-1"),
      updatedAt: DateTime.makeUnsafe("2026-11-25T00:00:00.000Z"),
      pendingRuntimeRequest: null,
      latestRunId: "run-1",
      ...overrides,
    }) as unknown as AgentAwarenessThread;

  it("maps waiting and finished phases, and nothing else", () => {
    expect(notifyKindOfPhase("waiting_for_approval")).toBe("approval");
    expect(notifyKindOfPhase("waiting_for_input")).toBe("input");
    expect(notifyKindOfPhase("completed")).toBe("completed");
    expect(notifyKindOfPhase("failed")).toBe("failed");
    for (const phase of ["starting", "running", "stale"] as const) {
      expect(notifyKindOfPhase(phase)).toBeNull();
    }
  });

  it("keys an alert by its request or its run, so one wait is one notification", () => {
    const waiting = thread({
      pendingRuntimeRequest: { id: "req-1", kind: "command" },
    } as unknown as Partial<AgentAwarenessThread>);
    expect(alertKeyOf("approval", waiting)).toBe("approval:req-1");
    const next = thread({
      pendingRuntimeRequest: { id: "req-2", kind: "command" },
    } as unknown as Partial<AgentAwarenessThread>);
    assert.notStrictEqual(alertKeyOf("approval", next), alertKeyOf("approval", waiting));
    expect(alertKeyOf("completed", thread({}))).toBe("completed:run-1");
    expect(alertKeyOf("completed", thread({ latestRunId: "run-2" } as never))).toBe(
      "completed:run-2",
    );
  });
});
