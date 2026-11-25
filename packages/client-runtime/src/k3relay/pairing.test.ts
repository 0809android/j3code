import { assert, describe, it } from "@effect/vitest";
import { makeMuxHandler, serveHttp } from "@t3tools/shared/mux";
import { encodeBase64url } from "@t3tools/shared/relay";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as DeviceKeyStore from "./deviceKeyStore.ts";
import {
  type PairingDecision,
  layerTestCrypto,
  layerWebSocketGlobal,
  startTestHost,
  startTestRelay,
} from "./k3relay.testkit.ts";
import {
  type K3RelayPairingProgress,
  k3relayPairingFailureText,
  previewK3RelayOffer,
  redeemK3RelayPairing,
  runK3RelayDevicePairing,
} from "./pairing.ts";
import { openK3RelayTunnel } from "./tunnel.ts";

const ENVIRONMENT_ID = "env-k3relay-paired";
const BOOTSTRAP = "bootstrap-for-this-device";

/** The host's routes that the device uses right after pairing. */
const makeRedeemHandler = (tokenRequests: Queue.Queue<string>) =>
  makeMuxHandler({
    http: serveHttp<never, never>((request) =>
      Effect.gen(function* () {
        if (request.path === "/.well-known/t3/environment") {
          return {
            status: 200,
            headers: [["content-type", "application/json"]],
            body: JSON.stringify({
              environmentId: ENVIRONMENT_ID,
              label: "Studio Mac",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "1.0.0",
              capabilities: { repositoryIdentity: true },
            }),
          };
        }
        if (request.path === "/oauth/token" && request.method === "POST") {
          const chunks = yield* Stream.runCollect(request.body).pipe(Effect.orDie);
          const body = new TextDecoder().decode(
            Uint8Array.from(chunks.flatMap((chunk) => [...chunk])),
          );
          yield* Queue.offer(tokenRequests, body);
          const form = new URLSearchParams(body);
          const dpop = request.headers.find(([name]) => name.toLowerCase() === "dpop")?.[1];
          if (form.get("subject_token") !== BOOTSTRAP || dpop !== "test-proof") {
            return { status: 401, headers: [], body: "{}" };
          }
          return {
            status: 200,
            headers: [["content-type", "application/json"]],
            body: JSON.stringify({
              access_token: "session-token",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "DPoP",
              expires_in: 900,
              scope: "orchestration:read",
            }),
          };
        }
        return { status: 404, headers: [], body: "missing" };
      }),
    ),
  });

const layerPlatform = Layer.mergeAll(
  layerWebSocketGlobal,
  layerTestCrypto,
  DeviceKeyStore.layerMemory(),
  FetchHttpClient.layer,
  Layer.succeed(ClientCapabilities.ClientPresentation, {
    metadata: { label: "Test phone", deviceType: "mobile" },
  }),
  Layer.succeed(
    ManagedRelay.ManagedRelayDpopSigner,
    ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("thumbprint"),
      createProof: () => Effect.succeed("test-proof"),
    }),
  ),
);

const recordProgress = Effect.gen(function* () {
  const seen = yield* Queue.unbounded<K3RelayPairingProgress>();
  return {
    seen,
    onProgress: (progress: K3RelayPairingProgress) =>
      Queue.offer(seen, progress).pipe(Effect.asVoid),
  };
});

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit), "expected pairing to fail");
  const error = Exit.isFailure(exit) ? (exit.cause.reasons[0] as { error?: unknown }).error : null;
  return (error as { readonly reason?: string } | null)?.reason;
};

/** The host decides only after the test saw both codes. */
const deciding = Effect.gen(function* () {
  const decision = yield* Deferred.make<PairingDecision>();
  return { decision, decidePairing: () => Deferred.await(decision) };
});

describe("K3 Relay device pairing", () => {
  it.live("pairs when the user approves matching codes, then signs in over the new grant", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const tokenRequests = yield* Queue.unbounded<string>();
      const { decision, decidePairing } = yield* deciding;
      const host = yield* startTestHost(relay, {
        handler: makeRedeemHandler(tokenRequests),
        decidePairing,
      });
      const link = yield* host.openPairing;
      const preview = previewK3RelayOffer(link, yield* Clock.currentTimeMillis);
      assert.isTrue(typeof preview === "object" && preview.relayUrl === relay.relayUrl);
      const { seen, onProgress } = yield* recordProgress;

      const pairing = yield* runK3RelayDevicePairing(
        { link, deviceName: "Test phone" },
        onProgress,
      ).pipe(Effect.forkScoped);
      const hostCode = yield* Queue.take(host.codes);
      assert.deepStrictEqual(yield* Queue.take(seen), {
        phase: "connecting",
        relayUrl: relay.relayUrl,
      });
      const shown = yield* Queue.take(seen);
      assert.deepStrictEqual(shown, { phase: "awaiting-approval", confirmationCode: hostCode });
      assert.match(hostCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
      yield* Deferred.succeed(decision, { kind: "approve", bootstrapToken: BOOTSTRAP });
      const paired = yield* Fiber.join(pairing);
      assert.strictEqual(paired.record.hostId, host.hostId);
      assert.strictEqual(paired.record.hostIdentityKey, encodeBase64url(host.hostIdentityKey));
      assert.strictEqual(paired.bootstrapToken, BOOTSTRAP);

      const registration = yield* redeemK3RelayPairing(paired);
      assert.strictEqual(registration.target.environmentId, ENVIRONMENT_ID);
      assert.strictEqual(registration.profile.hostId, host.hostId);
      assert.strictEqual(registration.profile.deviceKeyId, paired.keyId);
      assert.strictEqual(registration.credential.accessToken, "session-token");
      // The bootstrap credential went to the host inside the tunnel, never to the relay.
      assert.include(yield* Queue.take(tokenRequests), `subject_token=${BOOTSTRAP}`);
      assert.isFalse(relayLogsMention(relay.testRelay.logs, BOOTSTRAP));
      assert.isFalse(relayLogsMention(relay.testRelay.logs, "Test phone"));
    }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
  );

  it.live("fails with `rejected` and removes the new device key when the host rejects", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const host = yield* startTestHost(relay, {
        decidePairing: () => Effect.succeed({ kind: "reject" } as const),
      });
      const link = yield* host.openPairing;
      const keys = yield* DeviceKeyStore.DeviceKeyStore;
      let createdKeyId: string | undefined;
      const exit = yield* runK3RelayDevicePairing(
        { link, deviceName: "Test phone" },
        () => Effect.void,
      ).pipe(
        Effect.provideService(DeviceKeyStore.DeviceKeyStore, {
          ...keys,
          create: (keyId) => {
            createdKeyId = keyId;
            return keys.create(keyId);
          },
        }),
        Effect.exit,
      );
      assert.strictEqual(failureOf(exit), "rejected");
      assert.isDefined(createdKeyId);
      assert.isTrue((yield* keys.load(createdKeyId!))._tag === "None");
      assert.strictEqual(k3relayPairingFailureText("rejected"), "The host rejected this device.");
    }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
  );

  it.live("times out while nobody approves", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const host = yield* startTestHost(relay);
      const link = yield* host.openPairing;
      const exit = yield* runK3RelayDevicePairing(
        { link, deviceName: "Test phone", approvalTimeoutMs: 300 },
        () => Effect.void,
      ).pipe(Effect.exit);
      assert.strictEqual(failureOf(exit), "timeout");
    }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
  );

  it.live("refuses expired links and links whose host key was swapped, before connecting", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const host = yield* startTestHost(relay);
      const link = yield* host.openPairing;
      const url = new URL(link);
      const otherKey = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
      url.searchParams.set("hk", otherKey);
      const swapped = yield* runK3RelayDevicePairing(
        { link: url.toString(), deviceName: "Test phone" },
        () => Effect.void,
      ).pipe(Effect.exit);
      assert.strictEqual(failureOf(swapped), "host-mismatch");

      const expiredUrl = new URL(link);
      expiredUrl.searchParams.set("exp", String((yield* Clock.currentTimeMillis) - 1_000));
      const expired = yield* runK3RelayDevicePairing(
        { link: expiredUrl.toString(), deviceName: "Test phone" },
        () => Effect.void,
      ).pipe(Effect.exit);
      assert.strictEqual(failureOf(expired), "expired");

      const plainHttp = new URL(link);
      plainHttp.searchParams.set("relay", "http://relay.example.com/");
      assert.strictEqual(
        previewK3RelayOffer(plainHttp.toString(), yield* Clock.currentTimeMillis),
        "insecure-relay",
      );
    }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
  );

  it.live("shows a code the real host never shows when the link points at another host", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const real = yield* startTestHost(relay);
      const attacker = yield* startTestHost(relay);
      yield* real.openPairing;
      const attackerLink = yield* attacker.openPairing;
      const { seen, onProgress } = yield* recordProgress;
      yield* runK3RelayDevicePairing(
        { link: attackerLink, deviceName: "Test phone" },
        onProgress,
      ).pipe(Effect.forkScoped);
      yield* Queue.take(seen);
      const shown = yield* Queue.take(seen);
      const attackerCode = yield* Queue.take(attacker.codes);
      assert.deepStrictEqual(shown, { phase: "awaiting-approval", confirmationCode: attackerCode });
      // The real host saw no claim, so there is no code there to match: comparing fails.
      assert.strictEqual(yield* Queue.size(real.codes), 0);
    }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
  );

  it.live("a tampered secret is refused without spending the offer", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const host = yield* startTestHost(relay, {
        decidePairing: () => Effect.succeed({ kind: "reject" } as const),
      });
      const link = yield* host.openPairing;
      const tampered = new URL(link);
      tampered.hash = `s=${encodeBase64url(crypto.getRandomValues(new Uint8Array(16)))}`;
      const forged = yield* runK3RelayDevicePairing(
        { link: tampered.toString(), deviceName: "Intruder" },
        () => Effect.void,
      ).pipe(Effect.exit);
      assert.strictEqual(failureOf(forged), "invalid-claim");
      // The genuine link still reaches the approval step afterwards. The relay admits one
      // pairing connection at a time and frees the slot once it sees the first one close.
      const honest = yield* runK3RelayDevicePairing(
        { link, deviceName: "Test phone" },
        () => Effect.void,
      ).pipe(
        Effect.exit,
        Effect.repeat({
          while: (exit) => failureOf(exit) === "no-window",
          // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the relay frees its pairing slot asynchronously and emits no event for it
          schedule: Schedule.spaced("50 millis"),
          times: 40,
        }),
      );
      assert.strictEqual(failureOf(honest), "rejected");
    }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
  );

  it.live("keeps nothing from a reply whose grant the pinned host did not sign", () =>
    Effect.gen(function* () {
      const relay = yield* startTestRelay;
      const other = yield* startTestHost(relay);
      const host = yield* startTestHost(relay, {
        decidePairing: () =>
          Effect.succeed({ kind: "approve", bootstrapToken: BOOTSTRAP } as const),
        tamperReply: (reply) =>
          typeof reply === "object" && reply !== null && "grant" in reply
            ? { ...reply, grant: { ...(reply.grant as object), sig: forgedSig } }
            : reply,
      });
      const forgedSig = encodeBase64url(crypto.getRandomValues(new Uint8Array(64)));
      const link = yield* host.openPairing;
      const exit = yield* runK3RelayDevicePairing(
        { link, deviceName: "Test phone" },
        () => Effect.void,
      ).pipe(Effect.exit);
      assert.strictEqual(failureOf(exit), "invalid-reply");
      assert.notStrictEqual(other.hostId, host.hostId);
    }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
  );

  it.live(
    "the paired device's grant opens a tunnel; a revoked one is refused with the reason",
    () =>
      Effect.gen(function* () {
        const relay = yield* startTestRelay;
        const tokenRequests = yield* Queue.unbounded<string>();
        const host = yield* startTestHost(relay, {
          handler: makeRedeemHandler(tokenRequests),
          decidePairing: () =>
            Effect.succeed({ kind: "approve", bootstrapToken: BOOTSTRAP } as const),
        });
        const link = yield* host.openPairing;
        const paired = yield* runK3RelayDevicePairing(
          { link, deviceName: "Test phone" },
          () => Effect.void,
        );
        const input = {
          relayUrl: paired.record.relayUrl,
          hostId: paired.record.hostId,
          hostIdentityKey: host.hostIdentityKey,
          signer: paired.signer,
          grant: paired.record.grant,
        };
        yield* Effect.scoped(openK3RelayTunnel(input));
        yield* host.revoke(paired.signer);
        const exit = yield* Effect.scoped(openK3RelayTunnel(input)).pipe(Effect.exit);
        assert.strictEqual(failureOf(exit), "revoked");
      }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
  );
});

function relayLogsMention(logs: ReadonlyArray<string>, needle: string): boolean {
  return logs.some((line) => line.includes(needle));
}
