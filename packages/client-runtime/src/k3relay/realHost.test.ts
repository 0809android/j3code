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
  k3RelayUnsupportedFeatureOf,
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
import { RELAY_ASSET_LIMITS, makeRelayAssetCache, resolveRelayAssetUrl } from "./relayAssets.ts";
import { uploadThroughRelay } from "./relayUpload.ts";
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
const Issued = Schema.Struct({
  relativeUrl: Schema.String,
  attachmentId: Schema.optionalKey(Schema.String),
});

const HostRpcs = RpcGroup.make(
  Rpc.make("relayProbe.whoami", {
    success: Schema.Struct({ subject: Schema.String, transport: Schema.String }),
  }),
  Rpc.make("relayProbe.assetUrl", {
    payload: Schema.Struct({ attachmentId: Schema.String }),
    success: Issued,
    error: Schema.String,
  }),
  Rpc.make("relayProbe.uploadUrl", {
    payload: Schema.Struct({
      name: Schema.String,
      mimeType: Schema.String,
      sizeBytes: Schema.Number,
    }),
    success: Issued,
    error: Schema.String,
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

/** A relay asset store that keeps bytes in memory and names them, as `blob:` URLs would. */
const memoryAssetStore = () => {
  const kept = new Map<string, Uint8Array>();
  let next = 0;
  return {
    kept,
    store: {
      put: async ({ bytes }: { readonly bytes: Uint8Array }) => {
        next += 1;
        const url = `memory:${next}`;
        kept.set(url, bytes);
        return url;
      },
      release: (url: string) => {
        kept.delete(url);
      },
    },
  };
};
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
    "uploads an attachment, then shows it, over the mux: handles only, local copies, size cap",
    () =>
      Effect.gen(function* () {
        const relay = yield* startRelay;
        const host = yield* startHost(relay.url);
        const { registration } = yield* pairThroughOnboarding(host);
        const input = yield* k3relayTunnelInput(registration.profile);
        const tunnel = yield* openK3RelayTunnel(input);
        const rpc = yield* openRpc(tunnel.transport, registration.credential.accessToken);
        const prepared = { httpBaseUrl: K3_RELAY_PROVISIONAL_ORIGIN, transport: tunnel.transport };
        const bytes = Uint8Array.from({ length: 700_000 }, (_, index) => (index * 31) % 256);

        // The composer's upload: a relay slot, the bytes streamed with progress.
        const slot = yield* rpc["relayProbe.uploadUrl"]({
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
        });
        expect(slot.relativeUrl.startsWith("/api/attachments/upload/relay/")).toBe(true);
        const progress: Array<number> = [];
        yield* Effect.promise(() =>
          uploadThroughRelay({
            transport: tunnel.transport,
            url: `${K3_RELAY_PROVISIONAL_ORIGIN}${slot.relativeUrl}`,
            body: new Blob([bytes]),
            mimeType: "image/png",
            onProgress: (value) => progress.push(value),
          }),
        );
        expect(progress.at(-1)).toBe(1);

        // `<img>` gets a local URL holding exactly the uploaded bytes.
        const minted = yield* rpc["relayProbe.assetUrl"]({ attachmentId: slot.attachmentId! });
        expect(minted.relativeUrl.startsWith("/api/assets/file/")).toBe(true);
        const memory = memoryAssetStore();
        const cache = makeRelayAssetCache(memory.store);
        const local = yield* resolveRelayAssetUrl(cache, prepared, minted.relativeUrl, "photo");
        expect(memory.kept.get(local)).toEqual(bytes);
        // A re-mint names a new handle; the same asset key keeps the copy and its URL.
        const reminted = yield* rpc["relayProbe.assetUrl"]({ attachmentId: slot.attachmentId! });
        expect(reminted.relativeUrl).not.toBe(minted.relativeUrl);
        expect(yield* resolveRelayAssetUrl(cache, prepared, reminted.relativeUrl, "photo")).toBe(
          local,
        );
        expect(cache.stats().entries).toBe(1);

        // Over the cap, the fetch stops and nothing is kept.
        const small = makeRelayAssetCache(memoryAssetStore().store, {
          ...RELAY_ASSET_LIMITS,
          maxAssetBytes: 100_000,
        });
        const tooLarge = yield* resolveRelayAssetUrl(small, prepared, reminted.relativeUrl).pipe(
          Effect.flip,
        );
        expect(tooLarge.reason).toBe("too-large");
        expect(small.stats().entries).toBe(0);

        // The cache lets go of the oldest copy past its budget, releasing it.
        const tight = memoryAssetStore();
        const tightCache = makeRelayAssetCache(tight.store, {
          ...RELAY_ASSET_LIMITS,
          maxCacheBytes: bytes.byteLength + 10,
        });
        const first = yield* resolveRelayAssetUrl(tightCache, prepared, minted.relativeUrl, "a");
        yield* resolveRelayAssetUrl(tightCache, prepared, reminted.relativeUrl, "b");
        expect(tight.kept.has(first)).toBe(false);
        expect(tightCache.stats().entries).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDevice, layerWebSocketGlobal))),
  );

  it.live("an EventSource over the mux resumes after Last-Event-ID when its stream ends", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay;
      const host = yield* startHost(relay.url);
      const { registration } = yield* pairThroughOnboarding(host);
      const tunnel = yield* openK3RelayTunnel(yield* k3relayTunnelInput(registration.profile));
      const EventSource = tunnel.transport.eventSourceConstructor!;
      const seen = yield* Effect.promise(
        () =>
          new Promise<Array<{ readonly data: string; readonly lastEventId: string }>>((resolve) => {
            const source = new EventSource(`${K3_RELAY_PROVISIONAL_ORIGIN}/relay-probe/events`);
            const events: Array<{ readonly data: string; readonly lastEventId: string }> = [];
            source.onmessage = (event) => {
              events.push({ data: event.data, lastEventId: event.lastEventId });
              if (events.length === 7) {
                source.close();
                resolve(events);
              }
            };
          }),
      ).pipe(Effect.timeout("10 seconds"));
      // Each response carries three events and ends; every reconnect picks up the next one.
      expect(seen.map((event) => JSON.parse(event.data).n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(seen.at(-1)?.lastEventId).toBe("7");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDevice, layerWebSocketGlobal))),
  );

  it.live("what a device says about its address is not believed, and media routes refuse it", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay;
      const host = yield* startHost(relay.url);
      const { registration } = yield* pairThroughOnboarding(host);
      const tunnel = yield* openK3RelayTunnel(yield* k3relayTunnelInput(registration.profile));
      const probe = yield* Effect.promise(async () =>
        (
          await tunnel.transport.fetch(`${K3_RELAY_PROVISIONAL_ORIGIN}/relay-probe`, {
            headers: { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" },
          })
        ).json(),
      );
      expect(probe).toEqual({ transport: "k3relay", ipAddress: "k3relay" });
      const refused = yield* Effect.promise(async () => {
        const response = await tunnel.transport.fetch(
          `${K3_RELAY_PROVISIONAL_ORIGIN}/api/preview/tunnel?port=22`,
        );
        return { status: response.status, body: await response.json() };
      });
      expect(refused.status).toBe(403);
      expect(k3RelayUnsupportedFeatureOf(refused.body)).toBe("preview-tunnel");
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
