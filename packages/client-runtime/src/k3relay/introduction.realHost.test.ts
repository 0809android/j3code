// @effect-diagnostics nodeBuiltinImport:off -- loads the real host and relay at run time.
import * as NodeURL from "node:url";

import { assert, describe, expect, it } from "@effect/vitest";
import {
  K3_RELAY_INTRODUCTION_APPROVE_PATH,
  K3_RELAY_PROVISIONAL_ORIGIN,
  type K3RelayDevice,
  type K3RelayHostState,
  type K3RelayPairingOffer,
} from "@t3tools/contracts";
import {
  decodeBase64url,
  parseIntroductionLink,
  signIntroductionApproval,
} from "@t3tools/shared/relay";
import { deviceIdFromPublicKey } from "@t3tools/shared/socketE2ee";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import type { ConnectionTransport } from "../connection/model.ts";
import * as DeviceKeyStore from "./deviceKeyStore.ts";
import {
  type K3RelayIntroducedProgress,
  type K3RelayIntroducerHost,
  approveK3RelayIntroduction,
  collectK3RelayIntroductionClaims,
  openK3RelayIntroduction,
  revokeK3RelayDeviceAsIntroducer,
  runK3RelayIntroducedPairing,
} from "./introduction.ts";
import { layerTestCrypto, layerWebSocketGlobal } from "./k3relay.testkit.ts";
import { type K3RelayPairedDevice, runK3RelayDevicePairing } from "./pairing.ts";
import { openK3RelayTunnel } from "./tunnel.ts";

/**
 * Introductions end to end (spec §18.2): the real relay, real hosts (`RelayConnector`, ledger,
 * `EnvironmentAuth`), and this runtime's introducer and new-device halves, all in this process.
 */

interface RealHost {
  readonly hostId: string;
  readonly hostIdentityKey: Uint8Array;
  readonly state: () => Promise<K3RelayHostState>;
  readonly awaitState: (
    predicate: (state: K3RelayHostState) => boolean,
    timeoutMs?: number,
  ) => Promise<K3RelayHostState>;
  readonly createPairingOffer: () => Promise<K3RelayPairingOffer>;
  readonly approvePairing: (deviceId: string, confirmationCode?: string) => Promise<K3RelayDevice>;
  readonly setDevicePermissions: (deviceId: string, invite: boolean) => Promise<K3RelayDevice>;
  readonly dispose: () => Promise<void>;
}

interface HostTestkit {
  startK3RelayTestRelayHandle(): Promise<{ url: string; dispose(): Promise<void> }>;
  startK3RelayTestHost(options: { readonly relayUrl: string }): Promise<RealHost>;
}

const loadHostTestkit = Effect.promise(
  async () =>
    (await import(
      /* @vite-ignore */ NodeURL.fileURLToPath(
        new URL(
          "../../../../apps/server/src/relay/k3relay/k3relayHost.testkit.ts",
          import.meta.url,
        ),
      )
    )) as HostTestkit,
);

const startRelay = Effect.acquireRelease(
  Effect.flatMap(loadHostTestkit, (kit) => Effect.promise(() => kit.startK3RelayTestRelayHandle())),
  (relay) => Effect.promise(() => relay.dispose()),
);

const startHost = (relayUrl: string) =>
  Effect.acquireRelease(
    Effect.flatMap(loadHostTestkit, (kit) =>
      Effect.promise(() => kit.startK3RelayTestHost({ relayUrl })),
    ),
    (host) => Effect.promise(() => host.dispose()),
  );

const hostCall = <A>(call: () => Promise<A>) => Effect.promise(call);

const layerDevice = Layer.mergeAll(
  layerTestCrypto,
  layerWebSocketGlobal,
  DeviceKeyStore.layerMemory(),
  SecureRandom.layerWebCrypto,
);

/** QR pairing, the host's user approving with the compared code. */
const pair = (host: RealHost, deviceName: string) =>
  Effect.gen(function* () {
    const offer = yield* hostCall(() => host.createPairingOffer());
    const pairing = yield* runK3RelayDevicePairing(
      { link: offer.link, deviceName },
      () => Effect.void,
    ).pipe(Effect.forkScoped);
    const waiting = (yield* hostCall(() =>
      host.awaitState((state) => state.pairing.phase === "awaiting-approval"),
    )).pairing;
    assert(waiting.phase === "awaiting-approval");
    yield* hostCall(() => host.approvePairing(waiting.deviceId, waiting.confirmationCode));
    const paired = yield* Fiber.join(pairing);
    return { paired, deviceId: waiting.deviceId };
  });

/** A paired device's own tunnel to its host, as the introducer screen reaches each host. */
const tunnelOf = (paired: K3RelayPairedDevice, label = "Host") =>
  Effect.gen(function* () {
    const hostIdentityKey = decodeBase64url(paired.record.hostIdentityKey, 32)!;
    const tunnel = yield* openK3RelayTunnel({
      relayUrl: paired.record.relayUrl,
      hostId: paired.record.hostId,
      hostIdentityKey,
      signer: paired.signer,
      grant: paired.record.grant,
    });
    return {
      label,
      relayUrl: paired.record.relayUrl,
      hostId: paired.record.hostId,
      hostIdentityKey,
      signer: paired.signer,
      transport: tunnel.transport,
    } satisfies K3RelayIntroducerHost;
  });

/** Opens, lets the new device claim, compares, approves: the whole introduction. */
const introduce = (hosts: ReadonlyArray<K3RelayIntroducerHost>, deviceName: string) =>
  Effect.gen(function* () {
    const session = yield* openK3RelayIntroduction(hosts);
    const progress = yield* Queue.unbounded<K3RelayIntroducedProgress>();
    const joining = yield* runK3RelayIntroducedPairing({ link: session.link, deviceName }, (next) =>
      Queue.offer(progress, next).pipe(Effect.asVoid),
    ).pipe(Effect.forkScoped);
    const claims = yield* collectK3RelayIntroductionClaims(session, { settleMs: 1_500 });
    let deviceCode: string | undefined;
    while (deviceCode === undefined) {
      const next = yield* Queue.take(progress);
      if (next.phase === "awaiting-approval") deviceCode = next.confirmationCode;
    }
    return { session, claims, deviceCode, joining };
  });

const rawPost = (transport: ConnectionTransport, path: string, body: unknown) =>
  Effect.promise(async () => {
    const response = await transport.fetch(`${K3_RELAY_PROVISIONAL_ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  });

const failureReason = <A>(exit: Exit.Exit<A, { readonly reason: string }>) =>
  Exit.isFailure(exit)
    ? (Exit.findErrorOption(exit).pipe((option) =>
        option._tag === "Some" ? option.value.reason : "defect",
      ) as string)
    : "success";

describe("K3 Relay introductions against real hosts", () => {
  it.live(
    "one comparison adds the new device to both hosts, recorded as introduced, and it cannot introduce",
    () =>
      Effect.gen(function* () {
        const relay = yield* startRelay;
        const host1 = yield* startHost(relay.url);
        const host2 = yield* startHost(relay.url);
        const on1 = yield* pair(host1, "Kino's phone");
        const on2 = yield* pair(host2, "Kino's phone");
        // Pairing alone never lets a device introduce.
        expect((yield* hostCall(() => host1.state())).devices[0]?.permissions).toEqual([]);
        const refused = yield* Effect.exit(openK3RelayIntroduction([yield* tunnelOf(on1.paired)]));
        expect(failureReason(refused)).toBe("not-permitted");

        yield* hostCall(() => host1.setDevicePermissions(on1.deviceId, true));
        yield* hostCall(() => host2.setDevicePermissions(on2.deviceId, true));
        const hosts = [yield* tunnelOf(on1.paired, "One"), yield* tunnelOf(on2.paired, "Two")];
        const { session, claims, deviceCode, joining } = yield* introduce(hosts, "New tablet");

        // The QR code names both hosts; the relay is told of neither list.
        const parsed = parseIntroductionLink(session.link, session.expiresAt - 1);
        assert(parsed.ok);
        expect(parsed.offer.hosts.map((host) => host.hostId).sort()).toEqual(
          [host1.hostId, host2.hostId].sort(),
        );
        // One code on both screens, covering both hosts.
        expect(claims.confirmationCode).toBe(deviceCode);
        expect(claims.deviceName).toBe("New tablet");
        expect(claims.claims.length).toBe(2);
        // The host's screen shows who is introducing whom while it waits.
        const pending = yield* hostCall(() =>
          host1.awaitState((state) => state.introduction.phase === "claimed"),
        );
        assert(pending.introduction.phase === "claimed");
        expect(pending.introduction.introducerDeviceId).toBe(on1.deviceId);
        expect(pending.introduction.deviceName).toBe("New tablet");

        const approvals = yield* approveK3RelayIntroduction(claims, claims.confirmationCode);
        expect(approvals.map((approval) => approval.result.ok)).toEqual([true, true]);
        const joined = yield* Fiber.join(joining);
        expect(joined.map((host) => Exit.isSuccess(host.result))).toEqual([true, true]);

        // A separate key per host: the relay cannot link the two.
        const keys = joined.map((host) =>
          Exit.isSuccess(host.result)
            ? deviceIdFromPublicKey(
                host.result.value.signer.alg,
                host.result.value.signer.publicKey,
              )
            : "",
        );
        expect(new Set(keys).size).toBe(2);

        for (const [host, introducer] of [
          [host1, on1],
          [host2, on2],
        ] as const) {
          const state = yield* hostCall(() => host.state());
          const introduced = state.devices.find((device) => keys.includes(device.deviceId));
          expect(introduced).toEqual(
            expect.objectContaining({
              name: "New tablet",
              status: "active",
              approvedVia: "introduction",
              introducedBy: introducer.deviceId,
              permissions: [],
            }),
          );
          expect(state.devices.find((device) => device.deviceId === introducer.deviceId)).toEqual(
            expect.objectContaining({ approvedVia: "qr", permissions: ["devices:invite"] }),
          );
          expect(state.introduction.phase).toBe("idle");
        }

        // The introduced device reaches its hosts, but introductions do not chain.
        const newOn1 = joined.find((host) => host.hostId === host1.hostId)!;
        assert(Exit.isSuccess(newOn1.result));
        const newTunnel = yield* tunnelOf(newOn1.result.value);
        const chained = yield* Effect.exit(openK3RelayIntroduction([newTunnel]));
        expect(failureReason(chained)).toBe("not-permitted");
        const newDeviceId = keys.find((key) =>
          Exit.isSuccess(newOn1.result)
            ? key ===
              deviceIdFromPublicKey(
                newOn1.result.value.signer.alg,
                newOn1.result.value.signer.publicKey,
              )
            : false,
        )!;
        const granted = yield* Effect.exit(
          Effect.promise(() => host1.setDevicePermissions(newDeviceId, true).then(() => "granted")),
        );
        // The host's user cannot make an introduced device an introducer either.
        expect(Exit.isFailure(granted)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(layerDevice)),
  );

  it.live(
    "refuses unconfirmed and replayed approvals, stops at three a day, and limits who revokes whom",
    () =>
      Effect.gen(function* () {
        const relay = yield* startRelay;
        const host = yield* startHost(relay.url);
        const introducer = yield* pair(host, "Kino's phone");
        const otherInviter = yield* pair(host, "Kino's laptop");
        const plain = yield* pair(host, "Old phone");
        yield* hostCall(() => host.setDevicePermissions(introducer.deviceId, true));
        yield* hostCall(() => host.setDevicePermissions(otherInviter.deviceId, true));
        const hosts = [yield* tunnelOf(introducer.paired)];

        // An approval naming any code but the compared one is refused; the right one then works.
        const first = yield* introduce(hosts, "New tablet 1");
        const unconfirmed = yield* approveK3RelayIntroduction(first.claims, "AAAA-AAAA");
        expect(unconfirmed[0]?.result).toEqual({ ok: false, reason: "code-mismatch" });
        const entry = first.claims.claims[0]!;
        const replay = yield* signIntroductionApproval(
          entry.window.host.signer,
          entry.claim,
          first.claims.confirmationCode,
        );
        const accepted = yield* rawPost(
          hosts[0]!.transport,
          K3_RELAY_INTRODUCTION_APPROVE_PATH,
          replay,
        );
        expect(accepted.status).toBe(200);
        yield* Fiber.join(first.joining);
        // The same signed approval again: the window is spent.
        const replayed = yield* rawPost(
          hosts[0]!.transport,
          K3_RELAY_INTRODUCTION_APPROVE_PATH,
          replay,
        );
        expect(replayed).toEqual({ status: 409, body: { error: "no-introduction" } });

        for (const name of ["New tablet 2", "New tablet 3"]) {
          const next = yield* introduce(hosts, name);
          const approved = yield* approveK3RelayIntroduction(
            next.claims,
            next.claims.confirmationCode,
          );
          expect(approved[0]?.result.ok).toBe(true);
          yield* Fiber.join(next.joining);
        }
        const fourth = yield* Effect.exit(openK3RelayIntroduction(hosts));
        expect(failureReason(fourth)).toBe("limit");

        // Revoking a lost device: only an inviter, only ordinary devices.
        const plainTunnel = yield* tunnelOf(plain.paired);
        const byPlain = yield* Effect.exit(
          revokeK3RelayDeviceAsIntroducer(plainTunnel.transport, introducer.deviceId),
        );
        expect(failureReason(byPlain)).toBe("not-permitted");
        for (const target of [otherInviter.deviceId, introducer.deviceId]) {
          const protectedTarget = yield* Effect.exit(
            revokeK3RelayDeviceAsIntroducer(hosts[0]!.transport, target),
          );
          expect(failureReason(protectedTarget)).toBe("protected-device");
        }
        const stranger = yield* Effect.exit(
          revokeK3RelayDeviceAsIntroducer(hosts[0]!.transport, "a".repeat(32)),
        );
        expect(failureReason(stranger)).toBe("unknown-device");
        yield* revokeK3RelayDeviceAsIntroducer(hosts[0]!.transport, plain.deviceId);
        const after = yield* hostCall(() => host.state());
        expect(after.devices.find((device) => device.deviceId === plain.deviceId)?.status).toBe(
          "revoked",
        );
        expect(after.devices.filter((device) => device.approvedVia === "introduction").length).toBe(
          3,
        );
      }).pipe(Effect.scoped, Effect.provide(layerDevice)),
  );
});
