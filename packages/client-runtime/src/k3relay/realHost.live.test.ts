// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalConsole:off - drives a deployed relay over the network.
import * as NodeDns from "node:dns";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { assert, describe, expect, it } from "@effect/vitest";
import {
  type K3RelayDevice,
  type K3RelayHostState,
  type K3RelayPairingOffer,
  K3_RELAY_PROVISIONAL_ORIGIN,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { DpopPublicJwk } from "@t3tools/shared/dpop";

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
import { K3RELAY_VIRTUAL_WS_ORIGIN, k3relayTunnelInput, overTransport } from "./broker.ts";
import * as DeviceKeyStore from "./deviceKeyStore.ts";
import { layerTestCrypto, layerWebSocketGlobal } from "./k3relay.testkit.ts";
import {
  type K3RelayPairingProgress,
  K3RelayOnboarding,
  layer as layerOnboarding,
} from "./pairing.ts";
import { makeRelayAssetCache, resolveRelayAssetUrl } from "./relayAssets.ts";
import { uploadThroughRelay } from "./relayUpload.ts";
import { fetchK3RelayHostPresence } from "./status.ts";
import { openK3RelayTunnel } from "./tunnel.ts";

/**
 * The real host (in this process) and the client runtime against a deployed relay. Skipped unless
 * `K3_LIVE_RELAY=1`. It registers one host and pairs one device, then revokes the device.
 * `K3_LIVE_RELAY_URL` names the relay; `K3_LIVE_RELAY_IP` pins its address when DNS is not trusted.
 */

const LIVE = process.env.K3_LIVE_RELAY === "1";
const RELAY_URL = process.env.K3_LIVE_RELAY_URL ?? "https://relay.k3.kinocode.jp";
const PINNED_IP = process.env.K3_LIVE_RELAY_IP;

let pinnedLookups = 0;
if (LIVE && PINNED_IP !== undefined) {
  const relayHost = new URL(RELAY_URL).hostname;
  const original = NodeDns.lookup;
  type Callback = (error: Error | null, address: unknown, family?: number) => void;
  const pinned = function (hostname: string, options: unknown, callback?: Callback) {
    const cb = (typeof options === "function" ? options : callback) as Callback;
    const opts = typeof options === "object" && options !== null ? options : {};
    if (hostname !== relayHost)
      return Reflect.apply(original, NodeDns, [hostname, options, callback]);
    pinnedLookups += 1;
    if ((opts as { all?: boolean }).all) {
      process.nextTick(cb, null, [{ address: PINNED_IP, family: 4 }]);
    } else {
      process.nextTick(cb, null, PINNED_IP, 4);
    }
  };
  (NodeDns as unknown as { default: { lookup: unknown } }).default.lookup = pinned;
}

interface RealHost {
  readonly hostId: string;
  readonly environmentId: string;
  readonly state: () => Promise<K3RelayHostState>;
  readonly awaitState: (
    predicate: (state: K3RelayHostState) => boolean,
    timeoutMs?: number,
  ) => Promise<K3RelayHostState>;
  readonly createPairingOffer: () => Promise<K3RelayPairingOffer>;
  readonly approvePairing: (deviceId: string, confirmationCode?: string) => Promise<K3RelayDevice>;
  readonly revokeDevice: (deviceId: string) => Promise<K3RelayDevice>;
  readonly dispose: () => Promise<void>;
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
    )) as { startK3RelayTestHost(options: { readonly relayUrl: string }): Promise<RealHost> },
);

const decodePublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);
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

const layerDevice = Layer.mergeAll(
  layerTestCrypto,
  DeviceKeyStore.layerMemory(),
  FetchHttpClient.layer,
  DpopProof.layerSigner({ keyStore: "indexed-db", loadOrCreateKey: webCryptoDpopKey }).pipe(
    Layer.provide(
      Layer.mergeAll(Digest.layerWebCrypto, Signature.layerWebCrypto).pipe(
        Layer.provideMerge(SecureRandom.layerWebCrypto),
      ),
    ),
  ),
  SecureRandom.layerWebCrypto,
  Layer.succeed(ClientCapabilities.ClientPresentation, {
    metadata: { label: "Live relay check", deviceType: "mobile" },
  }),
);

const HostRpcs = RpcGroup.make(
  Rpc.make("relayProbe.whoami", {
    success: Schema.Struct({ subject: Schema.String, transport: Schema.String }),
  }),
  Rpc.make("relayProbe.assetUrl", {
    payload: Schema.Struct({ attachmentId: Schema.String }),
    success: Schema.Struct({
      relativeUrl: Schema.String,
      attachmentId: Schema.optionalKey(Schema.String),
    }),
    error: Schema.String,
  }),
  Rpc.make("relayProbe.uploadUrl", {
    payload: Schema.Struct({
      name: Schema.String,
      mimeType: Schema.String,
      sizeBytes: Schema.Number,
    }),
    success: Schema.Struct({
      relativeUrl: Schema.String,
      attachmentId: Schema.optionalKey(Schema.String),
    }),
    error: Schema.String,
  }),
);

const isK3RelayRegistration = Schema.is(K3RelayConnectionRegistration);
// oxlint-disable-next-line t3code/no-wall-clock-in-tests -- measurements to report, behind K3_LIVE_RELAY; nothing asserts on them.
const now = () => performance.now();
const elapsed = (from: number) => Math.round((now() - from) * 10) / 10;
const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
/** Test output is not shown for a passing test, so `K3_LIVE_RELAY_LOG` names a file to append to. */
const LOG_FILE = process.env.K3_LIVE_RELAY_LOG;
const log = (label: string, value: unknown) => {
  const line = `[live-relay] ${label} ${JSON.stringify(value)}`;
  console.log(line);
  if (LOG_FILE !== undefined) NodeFS.appendFileSync(LOG_FILE, `${line}\n`);
};

describe.skipIf(!LIVE)("K3 Relay against a deployed relay", () => {
  it.live(
    "registers, pairs, opens a session, measures it, and revokes",
    () =>
      Effect.gen(function* () {
        // 1. Registration (PoW) and the control connection.
        const testkit = yield* loadHostTestkit;
        const startedAt = now();
        const host = yield* Effect.acquireRelease(
          Effect.promise(() => testkit.startK3RelayTestHost({ relayUrl: RELAY_URL })),
          (h) => Effect.promise(() => h.dispose()),
        );
        log("host connected", { ms: elapsed(startedAt), pinnedLookups });
        expect(host.hostId.length).toBeGreaterThan(0);
        if (PINNED_IP !== undefined) expect(pinnedLookups).toBeGreaterThan(0);

        // 2. Pairing: offer, anonymous E2E, claim, codes, approval, grant and bootstrap.
        const pairingAt = now();
        const saved = yield* Ref.make(Option.none<ConnectionRegistration>());
        const progress = yield* Queue.unbounded<K3RelayPairingProgress>();
        const offer = yield* Effect.promise(() => host.createPairingOffer());
        const onboarding = yield* K3RelayOnboarding.pipe(
          Effect.provide(
            layerOnboarding.pipe(
              Layer.provide(
                Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
                  register: (registration: ConnectionRegistration) =>
                    Ref.set(saved, Option.some(registration)).pipe(Effect.as(true)),
                  setCompatibility: () => Effect.void,
                  setEnabled: () => Effect.void,
                } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
              ),
            ),
          ),
        );
        const pairing = yield* onboarding
          .pair({ link: offer.link, deviceName: "Live relay check" }, (next) =>
            Queue.offer(progress, next).pipe(Effect.asVoid),
          )
          .pipe(Effect.forkScoped);
        const waiting = (yield* Effect.promise(() =>
          host.awaitState((state) => state.pairing.phase === "awaiting-approval", 30_000),
        )).pairing;
        assert(waiting.phase === "awaiting-approval");
        let deviceCode: string | undefined;
        while (deviceCode === undefined) {
          const next = yield* Queue.take(progress);
          if (next.phase === "awaiting-approval") deviceCode = next.confirmationCode;
        }
        expect(waiting.confirmationCode).toBe(deviceCode);
        log("codes match", { host: waiting.confirmationCode, device: deviceCode });
        yield* Effect.promise(() =>
          host.approvePairing(waiting.deviceId, waiting.confirmationCode),
        );
        const environmentId = yield* Fiber.join(pairing);
        expect(environmentId).toBe(host.environmentId);
        const registration = Option.getOrThrow(yield* Ref.get(saved));
        assert(isK3RelayRegistration(registration));
        const deviceId = waiting.deviceId;
        const afterPairing = yield* Effect.promise(() => host.state());
        log("paired", { ms: elapsed(pairingAt), pairingPhase: afterPairing.pairing });

        // 3. A session: tunnel, E2E v2, mux, the RPC WebSocket and HTTP fetch.
        const input = yield* k3relayTunnelInput(registration.profile);
        const accessToken = registration.credential.accessToken;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const tunnelAt = now();
            const tunnel = yield* openK3RelayTunnel(input);
            expect(tunnel.session.deviceAuthenticated).toBe(true);
            log("tunnel open", { ms: elapsed(tunnelAt) });

            const rpcAt = now();
            const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
            const url = yield* resolveRemoteDpopWebSocketConnectionUrl({
              wsBaseUrl: K3RELAY_VIRTUAL_WS_ORIGIN,
              httpBaseUrl: K3_RELAY_PROVISIONAL_ORIGIN,
              accessToken,
              createProof: (proof) => signer.createProof(proof),
            }).pipe(overTransport(tunnel.transport));
            const protocol = yield* Layer.build(
              Layer.effect(
                RpcClient.Protocol,
                RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
              ).pipe(
                Layer.provide(Socket.layerWebSocket(url)),
                Layer.provide(
                  Layer.succeed(Socket.WebSocketConstructor, (socketUrl, options) =>
                    tunnel.transport.webSocketConstructor(
                      socketUrl,
                      typeof options === "string" || Array.isArray(options) ? options : undefined,
                    ),
                  ),
                ),
                Layer.provide(RpcSerialization.layerJson),
              ),
            );
            const rpc = yield* RpcClient.make(HostRpcs).pipe(Effect.provide(protocol));
            expect(yield* rpc["relayProbe.whoami"]()).toEqual({
              subject: `relay-paired-device:${deviceId}`,
              transport: "k3relay",
            });
            log("rpc socket + first whoami", { ms: elapsed(rpcAt) });

            const fetchAt = now();
            const probe = yield* Effect.promise(async () =>
              (await tunnel.transport.fetch(`${K3_RELAY_PROVISIONAL_ORIGIN}/relay-probe`)).json(),
            );
            expect(probe).toEqual({ transport: "k3relay", ipAddress: "k3relay" });
            log("http fetch /relay-probe", { ms: elapsed(fetchAt) });

            // 5. Round trips and a 1 MiB asset each way.
            const rtts: Array<number> = [];
            for (let i = 0; i < 20; i++) {
              const at = now();
              yield* rpc["relayProbe.whoami"]();
              rtts.push(elapsed(at));
            }
            const sorted = [...rtts].sort((a, b) => a - b);
            log("whoami rtt x20", {
              median: (sorted[9]! + sorted[10]!) / 2,
              p95: percentile(sorted, 95),
              min: sorted[0],
              max: sorted.at(-1),
              all: rtts,
            });

            const bytes = Uint8Array.from(
              { length: 1024 * 1024 },
              (_, index) => (index * 31) % 256,
            );
            const slot = yield* rpc["relayProbe.uploadUrl"]({
              name: "live.png",
              mimeType: "image/png",
              sizeBytes: bytes.byteLength,
            });
            const uploadAt = now();
            yield* Effect.promise(() =>
              uploadThroughRelay({
                transport: tunnel.transport,
                url: `${K3_RELAY_PROVISIONAL_ORIGIN}${slot.relativeUrl}`,
                body: new Blob([bytes]),
                mimeType: "image/png",
                onProgress: () => undefined,
              }),
            );
            const uploadMs = elapsed(uploadAt);
            const minted = yield* rpc["relayProbe.assetUrl"]({ attachmentId: slot.attachmentId! });
            const kept = new Map<string, Uint8Array>();
            const cache = makeRelayAssetCache({
              put: async ({ bytes: b }: { readonly bytes: Uint8Array }) => {
                kept.set("memory:1", b);
                return "memory:1";
              },
              release: (key: string) => {
                kept.delete(key);
              },
            });
            const downloadAt = now();
            const local = yield* resolveRelayAssetUrl(
              cache,
              { httpBaseUrl: K3_RELAY_PROVISIONAL_ORIGIN, transport: tunnel.transport },
              minted.relativeUrl,
              "live",
            );
            const downloadMs = elapsed(downloadAt);
            expect(kept.get(local)).toEqual(bytes);
            const mibPerSec = (ms: number) => Math.round((1000 / ms) * 100) / 100;
            log("1 MiB asset", {
              uploadMs,
              uploadMiBps: mibPerSec(uploadMs),
              downloadMs,
              downloadMiBps: mibPerSec(downloadMs),
            });

            // 4. Status while online, then revocation cuts the live session.
            const online = yield* fetchK3RelayHostPresence(input);
            log("status before revoke", online);
            expect(online).toMatchObject({ kind: "reachable", online: true });

            const revokeAt = now();
            yield* Effect.promise(() => host.revokeDevice(deviceId));
            const closed = yield* tunnel.closed.pipe(Effect.timeout("15 seconds"));
            log("revoked session closed", {
              ms: elapsed(revokeAt),
              reason: findK3RelayFailureReason(closed),
            });
            expect(findK3RelayFailureReason(closed)).toBe("revoked");
          }),
        );

        const refused = yield* Effect.scoped(openK3RelayTunnel(input)).pipe(
          Effect.flip,
          Effect.timeout("15 seconds"),
        );
        log("reconnect after revoke", { reason: refused.reason });
        expect(refused.reason).toBe("revoked");
        const revokedStatus = yield* fetchK3RelayHostPresence(input);
        log("status after revoke", revokedStatus);
        expect(revokedStatus.kind).toBe("revoked");

        const final = yield* Effect.promise(() => host.state());
        log("host final", {
          pairing: final.pairing,
          activeSessions: final.activeSessions,
          devices: final.devices.map((d) => ({ status: d.status })),
        });
        expect(final.devices.find((d) => d.deviceId === deviceId)?.status).toBe("revoked");
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDevice, layerWebSocketGlobal))),
    180_000,
  );
});
