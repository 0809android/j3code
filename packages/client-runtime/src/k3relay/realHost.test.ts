// @effect-diagnostics nodeBuiltinImport:off -- loads the real host from apps/server at run time.
import * as NodeURL from "node:url";

import { assert, describe, expect, it } from "@effect/vitest";
import {
  type K3RelayDevice,
  type K3RelayHostState,
  K3RelayHostState as K3RelayHostStateSchema,
  type K3RelayPairingOffer,
  K3_RELAY_PROVISIONAL_ORIGIN,
  WS_METHODS,
} from "@t3tools/contracts";
import { DpopPublicJwk } from "@t3tools/shared/dpop";
import { type RelayGrant, decodeBase64url, encodeBase64url } from "@t3tools/shared/relay";
import { deviceIdFromPublicKey } from "@t3tools/shared/socketE2ee";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

import { resolveRemoteDpopWebSocketConnectionUrl } from "../authorization/remote.ts";
import {
  type ConnectionRegistration,
  K3RelayConnectionRegistration,
} from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as DpopProof from "../relay/dpopProof.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { findK3RelayFailureReason } from "./admission.ts";
import {
  K3RELAY_VIRTUAL_WS_ORIGIN,
  k3relayTunnelInput,
  overTransport,
  pairingRecordOf,
  renewK3RelayGrant,
} from "./broker.ts";
import * as DeviceKeyStore from "./deviceKeyStore.ts";
import { k3relayFailureText } from "./failure.ts";
import { layerTestCrypto, layerWebSocketGlobal } from "./k3relay.testkit.ts";
import {
  type K3RelayPairingProgress,
  K3RelayOnboarding,
  layer as layerOnboarding,
  previewK3RelayOffer,
  runK3RelayDevicePairing,
} from "./pairing.ts";
import { checkK3RelayTunnelInput, openK3RelayTunnel } from "./tunnel.ts";

/**
 * The client runtime against the real host: `infra/k3-relay` and the server's `RelayConnector`,
 * device ledger, `EnvironmentAuth` and relay bridge, all in this process. Nothing on either side
 * is a stand-in, so a wire disagreement between the two halves fails here.
 */

// ── The host, loaded from apps/server at run time ───────────────────────────

/** `apps/server/src/relay/k3relay/k3relayHost.testkit.ts`, as far as these tests use it. */
interface RealHost {
  readonly hostId: string;
  readonly hostIdentityKey: Uint8Array;
  readonly environmentId: string;
  readonly state: () => Promise<K3RelayHostState>;
  readonly awaitState: (
    predicate: (state: K3RelayHostState) => boolean,
    timeoutMs?: number,
  ) => Promise<K3RelayHostState>;
  readonly createPairingOffer: () => Promise<K3RelayPairingOffer>;
  readonly approvePairing: (deviceId: string, confirmationCode?: string) => Promise<K3RelayDevice>;
  readonly revokeDevice: (deviceId: string) => Promise<K3RelayDevice>;
  readonly signGrant: (input: {
    readonly alg: "ed25519" | "p256";
    readonly devicePublicKey: Uint8Array;
    readonly issuedAt: number;
  }) => Promise<RelayGrant>;
  readonly dispose: () => Promise<void>;
}

interface RealHostTestkit {
  startK3RelayTestRelayHandle(): Promise<{ url: string; dispose(): Promise<void> }>;
  startK3RelayTestHost(options: { readonly relayUrl: string }): Promise<RealHost>;
}

/** Loaded at run time so this package's type check stays out of the server's sources. */
const loadHostTestkit = Effect.promise(
  async () =>
    (await import(
      /* @vite-ignore */ NodeURL.fileURLToPath(
        new URL(
          "../../../../apps/server/src/relay/k3relay/k3relayHost.testkit.ts",
          import.meta.url,
        ),
      )
    )) as RealHostTestkit,
);

const startRelay = Effect.acquireRelease(
  Effect.flatMap(loadHostTestkit, (testkit) =>
    Effect.promise(() => testkit.startK3RelayTestRelayHandle()),
  ),
  (relay) => Effect.promise(() => relay.dispose()),
);

const startHost = (relayUrl: string) =>
  Effect.acquireRelease(
    Effect.flatMap(loadHostTestkit, (testkit) =>
      Effect.promise(() => testkit.startK3RelayTestHost({ relayUrl })),
    ),
    (host) => Effect.promise(() => host.dispose()),
  );

const hostCall = <A>(call: () => Promise<A>) => Effect.promise(call);

// ── The device: real key store, a real P-256 DPoP key, the platform pieces ──

const decodePublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);

/** A non-extractable WebCrypto P-256 key, as the web app keeps its DPoP key. */
const webCryptoDpopKey = Effect.gen(function* () {
  const signature = yield* Signature.Signature;
  const pair = yield* Effect.promise(
    () =>
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify",
      ]) as Promise<CryptoKeyPair>,
  );
  const publicJwk = yield* Effect.promise(() =>
    crypto.subtle.exportKey("jwk", pair.publicKey),
  ).pipe(Effect.flatMap(decodePublicJwk), Effect.orDie);
  const privateKey = yield* Signature.privateKeyFromCryptoKey(
    Signature.ecdsaP256,
    pair.privateKey,
  ).pipe(Effect.orDie);
  return {
    publicJwk,
    sign: (data) => signature.sign(privateKey, data).pipe(Effect.orDie),
  } satisfies DpopProof.DpopProofKey;
});

const layerDpopSigner = DpopProof.layerSigner({
  keyStore: "indexed-db",
  loadOrCreateKey: webCryptoDpopKey,
}).pipe(
  Layer.provide(
    Layer.mergeAll(Digest.layerWebCrypto, Signature.layerWebCrypto).pipe(
      Layer.provideMerge(SecureRandom.layerWebCrypto),
    ),
  ),
);

const layerDevice = Layer.mergeAll(
  layerTestCrypto,
  DeviceKeyStore.layerMemory(),
  FetchHttpClient.layer,
  layerDpopSigner,
  SecureRandom.layerWebCrypto,
  Layer.succeed(ClientCapabilities.ClientPresentation, {
    metadata: { label: "Test phone", deviceType: "mobile" },
  }),
);

/** Records what onboarding saves; onboarding calls only these three methods. */
const recordingRegistry = (saved: Ref.Ref<Option.Option<ConnectionRegistration>>) =>
  Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
    register: (registration: ConnectionRegistration) =>
      Ref.set(saved, Option.some(registration)).pipe(Effect.as(true)),
    setCompatibility: () => Effect.void,
    setEnabled: () => Effect.void,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

/** The two RPCs the host's test socket serves, as the client declares them. */
const HostRpcs = RpcGroup.make(
  Rpc.make("relayProbe.whoami", {
    success: Schema.Struct({ subject: Schema.String, transport: Schema.String }),
  }),
  Rpc.make(WS_METHODS.k3RelaySubscribe, {
    payload: Schema.Struct({}),
    success: K3RelayHostStateSchema,
    stream: true,
  }),
);

/** Pairs through `K3RelayOnboarding` while the host user compares codes and approves. */
const pairThroughOnboarding = (host: RealHost) =>
  Effect.gen(function* () {
    const saved = yield* Ref.make(Option.none<ConnectionRegistration>());
    const progress = yield* Queue.unbounded<K3RelayPairingProgress>();
    const offer = yield* hostCall(() => host.createPairingOffer());
    const onboarding = yield* K3RelayOnboarding.pipe(
      Effect.provide(layerOnboarding.pipe(Layer.provide(recordingRegistry(saved)))),
    );
    const pairing = yield* onboarding
      .pair({ link: offer.link, deviceName: "Kino's phone" }, (next) =>
        Queue.offer(progress, next).pipe(Effect.asVoid),
      )
      .pipe(Effect.forkScoped);

    const waiting = (yield* hostCall(() =>
      host.awaitState((state) => state.pairing.phase === "awaiting-approval"),
    )).pairing;
    assert(waiting.phase === "awaiting-approval");
    let deviceCode: string | undefined;
    while (deviceCode === undefined) {
      const next = yield* Queue.take(progress);
      if (next.phase === "awaiting-approval") deviceCode = next.confirmationCode;
    }
    // The user compares: the host shows the same code and the name the device sent.
    expect(waiting.confirmationCode).toBe(deviceCode);
    expect(waiting.deviceName).toBe("Kino's phone");
    yield* hostCall(() => host.approvePairing(waiting.deviceId, waiting.confirmationCode));

    const environmentId = yield* Fiber.join(pairing);
    const registration = Option.getOrThrow(yield* Ref.get(saved));
    assert(isK3RelayRegistration(registration));
    return { environmentId, registration, deviceId: waiting.deviceId };
  });

/** The device's RPC socket through the tunnel: ticket, DPoP upgrade proof, mux WebSocket. */
const openRpc = (transport: Parameters<typeof overTransport>[0] & object, accessToken: string) =>
  Effect.gen(function* () {
    const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
    const url = yield* resolveRemoteDpopWebSocketConnectionUrl({
      wsBaseUrl: K3RELAY_VIRTUAL_WS_ORIGIN,
      httpBaseUrl: K3_RELAY_PROVISIONAL_ORIGIN,
      accessToken,
      createProof: (input) => signer.createProof(input),
    }).pipe(overTransport(transport));
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
      ).pipe(
        Layer.provide(Socket.layerWebSocket(url)),
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor, (socketUrl, options) =>
            transport.webSocketConstructor(
              socketUrl,
              typeof options === "string" || Array.isArray(options) ? options : undefined,
            ),
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(HostRpcs).pipe(Effect.provide(protocol));
  });

const DAY_MS = 86_400_000;
const isK3RelayRegistration = Schema.is(K3RelayConnectionRegistration);

describe("K3 Relay client against the real host", () => {
  it.live(
    "pairs with matching codes, redeems the bootstrap credential, and calls RPCs through the mux",
    () =>
      Effect.gen(function* () {
        const relay = yield* startRelay;
        const host = yield* startHost(relay.url);
        const { environmentId, registration, deviceId } = yield* pairThroughOnboarding(host);

        // The saved environment is the host's, reached through the relay with the pinned key.
        expect(environmentId).toBe(host.environmentId);
        const profile = registration.profile;
        expect(profile.hostId).toBe(host.hostId);
        expect(profile.hostIdentityKey).toBe(encodeBase64url(host.hostIdentityKey));
        expect(
          deviceIdFromPublicKey(profile.deviceAlg, decodeBase64url(profile.devicePublicKey, 32)!),
        ).toBe(deviceId);
        expect(registration.credential.accessToken.length).toBeGreaterThan(0);
        expect((yield* hostCall(() => host.state())).devices).toEqual([
          expect.objectContaining({ deviceId, name: "Kino's phone", status: "active" }),
        ]);

        // Later sessions: the saved profile and device key open a tunnel on their own.
        const input = yield* k3relayTunnelInput(profile);
        const tunnel = yield* openK3RelayTunnel(input);
        expect(tunnel.session.deviceAuthenticated).toBe(true);
        const rpc = yield* openRpc(tunnel.transport, registration.credential.accessToken);
        expect(yield* rpc["relayProbe.whoami"]()).toEqual({
          subject: `relay-paired-device:${deviceId}`,
          transport: "k3relay",
        });
        // A real host RPC: the relay state stream shows this device's live session.
        const seen = yield* rpc[WS_METHODS.k3RelaySubscribe]({}).pipe(
          Stream.filter((state) =>
            state.devices.some(
              (device) => device.deviceId === deviceId && device.connectedSessions > 0,
            ),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.timeout("10 seconds"),
        );
        expect(seen.activeSessions).toBeGreaterThan(0);
        expect(seen.status).toBe("connected");
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDevice, layerWebSocketGlobal))),
  );

  it.live("a revoked device loses its live session and is turned away with a reason to show", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay;
      const host = yield* startHost(relay.url);
      const { registration, deviceId } = yield* pairThroughOnboarding(host);
      const input = yield* k3relayTunnelInput(registration.profile);

      const closed = yield* Effect.scoped(
        Effect.gen(function* () {
          const tunnel = yield* openK3RelayTunnel(input);
          const rpc = yield* openRpc(tunnel.transport, registration.credential.accessToken);
          yield* rpc["relayProbe.whoami"]();
          yield* hostCall(() => host.revokeDevice(deviceId));
          return yield* tunnel.closed.pipe(Effect.timeout("10 seconds"));
        }),
      );
      // Whichever cut it first, the host's authenticated reason or the relay's 4403, says revoked.
      expect(findK3RelayFailureReason(closed)).toBe("revoked");

      const refused = yield* Effect.scoped(openK3RelayTunnel(input)).pipe(
        Effect.flip,
        Effect.timeout("10 seconds"),
      );
      expect(refused.reason).toBe("revoked");
      expect(k3relayFailureText(refused.reason, "Studio Mac")).toBe(
        "Studio Mac revoked this device. Pair it again to reconnect.",
      );
      const state = yield* hostCall(() => host.awaitState((next) => next.activeSessions === 0));
      expect(state.devices.find((device) => device.deviceId === deviceId)?.status).toBe("revoked");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDevice, layerWebSocketGlobal))),
  );

  it.live("renews a grant with under 30 days left over the tunnel, and the new grant gets in", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay;
      const host = yield* startHost(relay.url);
      const { registration } = yield* pairThroughOnboarding(host);
      const input = yield* k3relayTunnelInput(registration.profile);
      const record = pairingRecordOf(registration.profile, input.grant);

      // A fresh grant is not due: nothing is asked.
      const fresh = yield* Effect.scoped(
        Effect.flatMap(openK3RelayTunnel(input), (tunnel) =>
          renewK3RelayGrant({ record, signer: input.signer, transport: tunnel.transport }),
        ),
      );
      expect(Option.isNone(fresh)).toBe(true);

      const now = yield* Clock.currentTimeMillis;
      const aging = yield* hostCall(() =>
        host.signGrant({
          alg: input.signer.alg,
          devicePublicKey: input.signer.publicKey,
          issuedAt: now - 80 * DAY_MS,
        }),
      );
      const renewed = yield* Effect.scoped(
        Effect.flatMap(openK3RelayTunnel({ ...input, grant: aging }), (tunnel) =>
          renewK3RelayGrant({
            record: { ...record, grant: aging },
            signer: input.signer,
            transport: tunnel.transport,
          }),
        ),
      );
      assert(Option.isSome(renewed), "the host should renew a grant with 10 days left");
      expect(renewed.value.grant.expiresAt).toBeGreaterThan(aging.expiresAt);
      expect(renewed.value.grant.expiresAt - now).toBeGreaterThan(80 * DAY_MS);

      // The relay learned the renewed grant from the host, so it admits the device with it.
      const again = yield* Effect.scoped(
        Effect.map(
          openK3RelayTunnel({ ...input, grant: renewed.value.grant }),
          (tunnel) => tunnel.session.deviceAuthenticated,
        ),
      );
      expect(again).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDevice, layerWebSocketGlobal))),
  );

  it.live(
    "a different host behind the relay is caught by the pinned key before anything is sent",
    () =>
      Effect.gen(function* () {
        const relay = yield* startRelay;
        const host = yield* startHost(relay.url);
        const impostor = yield* startHost(relay.url);
        expect(impostor.hostId).not.toBe(host.hostId);
        const offer = yield* hostCall(() => host.createPairingOffer());
        // The impostor is waiting for a device too, so a misrouted connection would reach it.
        yield* hostCall(() => impostor.createPairingOffer());

        // A relay that routes the device to another host: pairing must stop at the E2E handshake.
        const misrouting = Layer.succeed(
          Socket.WebSocketConstructor,
          (url, options) =>
            new globalThis.WebSocket(
              url.replace(`/v1/client/${host.hostId}`, `/v1/client/${impostor.hostId}`),
              typeof options === "string" || Array.isArray(options) ? options : undefined,
            ) as unknown as Socket.WebSocketLike,
        );
        const misrouted = yield* runK3RelayDevicePairing(
          { link: offer.link, deviceName: "Kino's phone" },
          () => Effect.void,
        ).pipe(Effect.provide(misrouting), Effect.exit);
        assert(Exit.isFailure(misrouted));
        expect(Option.getOrUndefined(Exit.findErrorOption(misrouted))?.reason).toBe("key-mismatch");
        // The impostor never saw a claim, and the real host's window is untouched.
        expect((yield* hostCall(() => impostor.state())).pairing.phase).toBe("open");
        expect((yield* hostCall(() => host.state())).pairing.phase).toBe("open");

        // A link whose key was swapped for the impostor's is refused before dialing.
        const swapped = new URL(offer.link);
        swapped.searchParams.set("hk", encodeBase64url(impostor.hostIdentityKey));
        expect(previewK3RelayOffer(swapped.toString(), yield* Clock.currentTimeMillis)).toBe(
          "host-mismatch",
        );

        // A saved pairing with the impostor's key for the real host id never dials either.
        const { registration } = yield* pairThroughOnboarding(host);
        const input = yield* k3relayTunnelInput(registration.profile);
        const mismatch = yield* checkK3RelayTunnelInput({
          ...input,
          hostIdentityKey: impostor.hostIdentityKey,
        }).pipe(Effect.flip);
        expect(mismatch.reason).toBe("key-mismatch");
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDevice, layerWebSocketGlobal))),
  );
});
