// @effect-diagnostics nodeBuiltinImport:off -- a raw TCP listener proves no socket is opened.
import * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  type K3RelayHostState,
  WS_METHODS,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

import { type MuxClient, makeMuxClient, makeMuxFetch, makeMuxWebSocket } from "@t3tools/shared/mux";
import {
  type DevicePairingRecord,
  acceptRenewedGrant,
  createPairingClaim,
  decodeBase64url,
  encodeBase64url,
  receivePairingReply,
  relayDeviceId,
  relaySigningInput,
  type RelayGrant,
  signGrant,
  startDevicePairing,
} from "@t3tools/shared/relay";
import {
  type E2eeDeviceSigner,
  deviceSignerFromKeypair,
  generateDeviceKeypair,
  generateIdentityKeypair,
  layerE2eeCrypto,
  wrapClientSocketWithE2eeV2,
} from "@t3tools/shared/socketE2ee";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { makeDpopKey } from "../../auth/dpop.testkit.ts";
import * as ServerE2eeIdentity from "../../auth/ServerE2eeIdentity.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  layerK3RelayTestHost as layerHost,
  RelayProbeRpcs as ProbeRpcs,
  startK3RelayTestRelay as startRelay,
} from "./k3relayHost.testkit.ts";
import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import * as RelayConnector from "./RelayConnector.ts";
import * as RelayDeviceLedger from "./RelayDeviceLedger.ts";

const awaitState = (predicate: (state: K3RelayHostState) => boolean) =>
  Effect.flatMap(RelayConnector.RelayConnector, (connector) =>
    connector.changes.pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.timeout("20 seconds"),
    ),
  );

const awaitConnected = awaitState((state) => state.status === "connected");

// ── A device: raw WebSocket, the relay's own handshake, then E2EE v2 ─────────

const rawRelaySocket = (url: string) =>
  Socket.fromWebSocket(
    Effect.acquireRelease(
      Effect.sync(() => {
        const ws = new NodeWS.WebSocket(url, { perMessageDeflate: false });
        ws.on("error", () => undefined);
        return ws;
      }),
      (ws) => Effect.sync(() => ws.close()),
    ),
    { disableReconnects: true },
  );

const parseFrame = (frame: string | Uint8Array | undefined): Record<string, unknown> =>
  typeof frame === "string" ? (JSON.parse(frame) as Record<string, unknown>) : {};

/**
 * Completes the relay's part (the nonce signature for a client, nothing for pairing) and waits for
 * `accepted`; what follows is the E2E channel.
 */
const relayClientSocket = (url: string, auth?: (nonce: Uint8Array) => Effect.Effect<string>) =>
  Effect.map(rawRelaySocket(url), (raw) =>
    Socket.make({
      reader: Effect.gen(function* () {
        const reader = yield* raw.reader;
        const writer = yield* raw.writer;
        const buffered: Array<string | Uint8Array> = [];
        const next = Effect.gen(function* () {
          if (buffered.length === 0) buffered.push(...(yield* reader.pull));
          return buffered.shift();
        });
        if (auth !== undefined) {
          const nonce = decodeBase64url(parseFrame(yield* next).nonce, 32);
          if (nonce === null) return yield* Effect.die("no nonce from the relay");
          yield* writer.write(yield* auth(nonce));
        }
        const accepted = parseFrame(yield* next);
        if (accepted.type !== "accepted") return yield* Effect.die("the relay refused the device");
        return {
          upgrade: reader.upgrade,
          pull: Effect.suspend(() =>
            buffered.length > 0
              ? Effect.succeed(buffered.splice(0) as unknown as readonly [string | Uint8Array])
              : reader.pull,
          ),
        } satisfies Socket.Reader;
      }),
      writer: raw.writer,
    }),
  );

const clientAuthFrame =
  (hostId: string, signer: E2eeDeviceSigner, grant: RelayGrant) => (nonce: Uint8Array) =>
    Effect.map(
      signer
        .sign(
          relaySigningInput(
            "k3relay-v1/client",
            hostId,
            relayDeviceId(signer.alg, signer.publicKey),
            nonce,
          ),
        )
        .pipe(Effect.orDie),
      (sig) =>
        JSON.stringify({
          type: "auth",
          alg: signer.alg,
          dk: encodeBase64url(signer.publicKey),
          grant,
          sig: encodeBase64url(sig),
        }),
    );

const newDevice = Effect.map(generateDeviceKeypair("ed25519"), deviceSignerFromKeypair);

interface HostView {
  readonly relayUrl: string;
  readonly hostId: string;
  readonly hostIdentityKey: Uint8Array;
}

const hostView = (relayUrl: string) =>
  Effect.gen(function* () {
    const keypair = yield* (yield* ServerE2eeIdentity.ServerE2eeIdentity).getKeypair;
    const state = yield* awaitConnected;
    return {
      relayUrl,
      hostId: state.hostId ?? "",
      hostIdentityKey: keypair.publicKey,
      seed: keypair.seed,
    };
  });

/** Pairs a device end to end: offer, anonymous E2E, claim, the user's approval, the reply. */
const pairDevice = (host: HostView, signer: E2eeDeviceSigner, name = "Test Phone") =>
  Effect.scoped(
    Effect.gen(function* () {
      const connector = yield* RelayConnector.RelayConnector;
      const offer = yield* connector.createPairingOffer;
      const offerState = startDevicePairing(offer.link, yield* Clock.currentTimeMillis);
      const e2ee = yield* wrapClientSocketWithE2eeV2(
        yield* relayClientSocket(`${host.relayUrl}/v1/client/${host.hostId}?pairing=1`),
        { environmentId: host.hostId, expectedServerIdentityKey: host.hostIdentityKey },
      );
      const reader = yield* e2ee.reader;
      const writer = yield* e2ee.writer;
      const info = yield* e2ee.sessionInfo;
      const claim = yield* createPairingClaim(offerState, {
        transcriptHash: info.transcriptHash,
        signer,
        name,
        now: yield* Clock.currentTimeMillis,
      });
      yield* writer.write(JSON.stringify(claim.claim));
      const pending = yield* awaitState((state) => state.pairing.phase === "awaiting-approval");
      assert(pending.pairing.phase === "awaiting-approval");
      // The user compares the codes: the host's and the device's must match.
      expect(pending.pairing.confirmationCode).toBe(claim.confirmationCode);
      expect(pending.pairing.deviceName).toBe(name);
      yield* connector.approvePairing(pending.pairing.deviceId, claim.confirmationCode);
      const reply = parseFrame((yield* reader.pull)[0]);
      const paired = receivePairingReply(claim.state, reply, yield* Clock.currentTimeMillis);
      assert(paired.phase === "paired");
      return { record: paired.record, bootstrapToken: paired.bootstrapToken };
    }),
  );

/** A device session through the relay: relay auth, E2EE v2 with the grant, then the mux. */
const openDeviceSession = (host: HostView, signer: E2eeDeviceSigner, grant: RelayGrant) =>
  Effect.gen(function* () {
    const e2ee = yield* wrapClientSocketWithE2eeV2(
      yield* relayClientSocket(
        `${host.relayUrl}/v1/client/${host.hostId}`,
        clientAuthFrame(host.hostId, signer, grant),
      ),
      {
        environmentId: host.hostId,
        expectedServerIdentityKey: host.hostIdentityKey,
        device: signer,
        grant,
      },
    );
    const client = yield* makeMuxClient({ socket: e2ee });
    return { client, e2ee, fetch: makeMuxFetch(client) };
  });

const ORIGIN = "https://k3host.invalid";
const nowSeconds = Effect.map(Clock.currentTimeMillis, (now) => Math.floor(now / 1000));

/** Bootstrap credential → DPoP session → RPC ticket → the RPC socket, all through the mux. */
const signInAndCallRpc = (client: MuxClient, bootstrapToken: string) =>
  Effect.gen(function* () {
    const fetch = makeMuxFetch(client);
    const dpop = makeDpopKey();
    const iat = yield* nowSeconds;
    const token = yield* Effect.promise(async () => {
      const response = await fetch("/oauth/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: dpop.sign({
            method: "POST",
            url: `${ORIGIN}/oauth/token`,
            token: bootstrapToken,
            iat,
          }),
        },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: bootstrapToken,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }).toString(),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    });
    expect(token.status).toBe(200);
    const accessToken = String(token.body.access_token);
    const ticket = yield* Effect.promise(async () => {
      const url = `${ORIGIN}/api/auth/websocket-ticket/rpc`;
      const response = await fetch("/api/auth/websocket-ticket/rpc", {
        method: "POST",
        headers: {
          authorization: `DPoP ${accessToken}`,
          dpop: dpop.sign({ method: "POST", url, token: accessToken, iat }),
        },
      });
      return ((await response.json()) as { ticket: string }).ticket;
    });
    const proof = dpop.sign({
      method: "GET",
      url: `${ORIGIN}/ws`,
      token: ticket,
      iat,
    });
    const MuxWebSocket = makeMuxWebSocket(client);
    const socketUrl = `/ws?wsTicket=${encodeURIComponent(ticket)}&dpop=${encodeURIComponent(proof)}`;
    // Built into the caller's scope: the protocol must outlive `RpcClient.make`.
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
      ).pipe(
        Layer.provide(Socket.layerWebSocket(socketUrl)),
        Layer.provide(
          Layer.succeed(
            Socket.WebSocketConstructor,
            (url, protocols) =>
              new MuxWebSocket(
                url,
                typeof protocols === "string" || Array.isArray(protocols) ? protocols : [],
              ) as unknown as globalThis.WebSocket,
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    const rpc = yield* RpcClient.make(ProbeRpcs).pipe(Effect.provide(protocol));
    return { rpc, accessToken, dpop };
  });

/** The authenticated reason the host sent, wherever the error chain carries it. */
const closeReason = (
  error: unknown,
): { readonly _tag: string; readonly reason: string } | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const value = current as { _tag?: unknown; reason?: unknown; cause?: unknown };
    if (value._tag === "E2eeRejectedError" && typeof value.reason === "string") {
      return { _tag: value._tag, reason: value.reason };
    }
    current =
      typeof value.reason === "object" && value.reason !== null && "cause" in value.reason
        ? (value.reason as { cause: unknown }).cause
        : value.cause;
  }
  return undefined;
};

const expectRejected = <A, E, R>(effect: Effect.Effect<A, E, R>, reason: string) =>
  Effect.gen(function* () {
    const failure = yield* Effect.scoped(effect).pipe(Effect.flip, Effect.timeout("15 seconds"));
    expect(closeReason(failure)).toMatchObject({ _tag: "E2eeRejectedError", reason });
  });

/** Confirms the E2E handshake: the client learns the host's verdict on its first read. */
const handshake = (host: HostView, signer: E2eeDeviceSigner, grant: RelayGrant) =>
  Effect.gen(function* () {
    const { e2ee } = yield* openDeviceSession(host, signer, grant);
    return yield* e2ee.sessionInfo;
  });

const layerTest = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerE2eeCrypto);

describe("RelayConnector through a real relay", () => {
  it.live(
    "registers, pairs a device, and serves its RPC socket through the in-process bridge",
    () =>
      Effect.gen(function* () {
        const { url, relay } = yield* startRelay;
        yield* Effect.gen(function* () {
          const host = yield* hostView(url);
          expect(relay.store.getHost(host.hostId)).toBeDefined();
          const signer = yield* newDevice;
          const paired = yield* pairDevice(host, signer);
          const deviceId = relayDeviceId(signer.alg, signer.publicKey);
          const ledger = yield* RelayDeviceLedger.RelayDeviceLedger;
          expect((yield* ledger.get(deviceId))?.status).toBe("active");

          yield* Effect.scoped(
            Effect.gen(function* () {
              const { client, fetch } = yield* openDeviceSession(host, signer, paired.record.grant);
              const { rpc } = yield* signInAndCallRpc(client, paired.bootstrapToken);
              expect(yield* rpc["relayProbe.whoami"]()).toEqual({
                subject: EnvironmentAuth.relayPairedDeviceSubject(deviceId),
                transport: "k3relay",
              });
              const state = yield* awaitState((next) => next.activeSessions === 1);
              expect(state.connectedDevices).toBe(1);
              expect(state.devices.find((device) => device.deviceId === deviceId)).toMatchObject({
                status: "active",
                connectedSessions: 1,
              });

              // Forwarding headers from the device are only headers.
              const probe = yield* Effect.promise(async () =>
                (
                  await fetch("/relay-probe", {
                    headers: {
                      "x-forwarded-for": "127.0.0.1",
                      "x-forwarded-proto": "http",
                      "cf-connecting-ip": "127.0.0.1",
                      forwarded: "for=127.0.0.1",
                      host: "127.0.0.1",
                    },
                  })
                ).json(),
              );
              expect(probe).toEqual({ transport: "k3relay", ipAddress: "k3relay" });

              // A fresh grant is not renewed; the device can fetch another bootstrap credential.
              const renewal = yield* Effect.promise(async () =>
                (await fetch("/api/relay/grant", { method: "POST" })).json(),
              );
              expect(renewal).toEqual({ grant: null });
              const again = yield* Effect.promise(async () => {
                const response = await fetch("/api/relay/bootstrap", { method: "POST" });
                return { status: response.status, body: await response.json() };
              });
              expect(again.status).toBe(200);
              const second = yield* signInAndCallRpc(
                client,
                String((again.body as { bootstrapToken: string }).bootstrapToken),
              );
              expect((yield* second.rpc["relayProbe.whoami"]()).transport).toBe("k3relay");
            }),
          );
        }).pipe(Effect.provide(layerHost({ relayUrl: url })));
      }).pipe(Effect.provide(layerTest)),
  );

  it.live("revoking a device cuts its live session and refuses it afterwards", () =>
    Effect.gen(function* () {
      const { url } = yield* startRelay;
      yield* Effect.gen(function* () {
        const host = yield* hostView(url);
        const signer = yield* newDevice;
        const paired = yield* pairDevice(host, signer);
        const deviceId = relayDeviceId(signer.alg, signer.publicKey);
        const connector = yield* RelayConnector.RelayConnector;
        const sessions = yield* SessionStore.SessionStore;

        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* openDeviceSession(host, signer, paired.record.grant);
            const { rpc, accessToken } = yield* signInAndCallRpc(client, paired.bootstrapToken);
            yield* rpc["relayProbe.whoami"]();
            const revoked = yield* connector.revokeDevice(deviceId);
            expect(revoked.status).toBe("revoked");
            // The live session ends: whichever comes first, the host's authenticated reason or
            // the relay's own cut once it applied the revocation (4403).
            const closed = yield* client.closed.pipe(Effect.timeout("10 seconds"));
            const relayCut =
              Socket.isSocketError(closed.cause) &&
              closed.cause.reason._tag === "SocketCloseError" &&
              closed.cause.reason.code === 4403;
            expect(relayCut || closeReason(closed)?.reason === "revoked").toBe(true);
            expect(
              yield* rpc["relayProbe.whoami"]().pipe(Effect.flip, Effect.timeout("10 seconds")),
            ).toBeDefined();
            // Its HTTP session is gone too.
            expect((yield* sessions.verify(accessToken).pipe(Effect.flip))._tag).toBeDefined();
          }),
        );
        const state = yield* awaitState((next) => next.activeSessions === 0);
        expect(state.devices.find((device) => device.deviceId === deviceId)?.status).toBe(
          "revoked",
        );
        // The relay keeps an advisory copy and turns the device away itself (4403).
        const refused = yield* Effect.scoped(handshake(host, signer, paired.record.grant)).pipe(
          Effect.flip,
          Effect.timeout("10 seconds"),
        );
        expect(refused).toBeDefined();
      }).pipe(Effect.provide(layerHost({ relayUrl: url })));
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("the host ledger refuses what the relay admits: unknown and revoked devices", () =>
    Effect.gen(function* () {
      const { url } = yield* startRelay;
      yield* Effect.gen(function* () {
        const host = yield* hostView(url);
        const ledger = yield* RelayDeviceLedger.RelayDeviceLedger;
        const keypair = yield* (yield* ServerE2eeIdentity.ServerE2eeIdentity).getKeypair;
        // A grant the host really signed, for a device the ledger never approved.
        const stranger = yield* newDevice;
        const strangerGrant = yield* signGrant({
          hostIdentitySeed: keypair.seed,
          alg: stranger.alg,
          devicePublicKey: stranger.publicKey,
          now: yield* Clock.currentTimeMillis,
          nonce: "unknown-device-nonce-0001",
        });
        yield* expectRejected(handshake(host, stranger, strangerGrant), "unknown-device");

        // A device revoked in the ledger while the relay was never told (a relay that hides it).
        const signer = yield* newDevice;
        const paired = yield* pairDevice(host, signer);
        yield* ledger.revoke(
          relayDeviceId(signer.alg, signer.publicKey),
          yield* Clock.currentTimeMillis,
        );
        yield* expectRejected(handshake(host, signer, paired.record.grant), "revoked");
      }).pipe(Effect.provide(layerHost({ relayUrl: url })));
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("cuts a revoked device itself when the relay ignores the revocation", () =>
    Effect.gen(function* () {
      const { url, clock } = yield* startRelay;
      yield* Effect.gen(function* () {
        const host = yield* hostView(url);
        const signer = yield* newDevice;
        const paired = yield* pairDevice(host, signer);
        const connector = yield* RelayConnector.RelayConnector;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* openDeviceSession(host, signer, paired.record.grant);
            const { rpc } = yield* signInAndCallRpc(client, paired.bootstrapToken);
            yield* rpc["relayProbe.whoami"]();
            // Ten minutes ahead, the relay finds the host's revocation stale and keeps the session.
            clock.skewMs = 10 * 60_000;
            yield* connector.revokeDevice(relayDeviceId(signer.alg, signer.publicKey));
            const closed = yield* client.closed.pipe(Effect.timeout("10 seconds"));
            expect(closeReason(closed)).toEqual({ _tag: "E2eeRejectedError", reason: "revoked" });
          }),
        );
        // The relay still admits the device; the host's ledger turns it away.
        yield* expectRejected(handshake(host, signer, paired.record.grant), "revoked");
      }).pipe(Effect.provide(layerHost({ relayUrl: url })));
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("refuses sessions over the configured limit with the authenticated reason", () =>
    Effect.gen(function* () {
      const { url } = yield* startRelay;
      yield* Effect.gen(function* () {
        const host = yield* hostView(url);
        const signer = yield* newDevice;
        const paired = yield* pairDevice(host, signer);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* handshake(host, signer, paired.record.grant);
            yield* awaitState((state) => state.activeSessions === 1);
            yield* expectRejected(handshake(host, signer, paired.record.grant), "limit");
          }),
        );
        // Once the first session is gone, its slot is free again.
        yield* awaitState((state) => state.activeSessions === 0);
        yield* Effect.scoped(handshake(host, signer, paired.record.grant));
      }).pipe(Effect.provide(layerHost({ relayUrl: url, maxSessions: 1 })));
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("refuses grants from another host, expired grants, and connections without E2EE", () =>
    Effect.gen(function* () {
      const { url } = yield* startRelay;
      yield* Effect.gen(function* () {
        const host = yield* hostView(url);
        const signer = yield* newDevice;
        yield* pairDevice(host, signer);
        const keypair = yield* (yield* ServerE2eeIdentity.ServerE2eeIdentity).getKeypair;

        // Signed by some other host's key: the relay refuses it before the host sees it.
        const otherHost = yield* generateIdentityKeypair();
        const foreign = yield* signGrant({
          hostIdentitySeed: otherHost.seed,
          alg: signer.alg,
          devicePublicKey: signer.publicKey,
          now: yield* Clock.currentTimeMillis,
          nonce: "foreign-host-grant-nonce1",
        });
        const foreignResult = yield* Effect.scoped(handshake(host, signer, foreign)).pipe(
          Effect.exit,
          Effect.timeout("10 seconds"),
        );
        expect(foreignResult._tag).toBe("Failure");

        // Expired: signed by this host, but past its expiry.
        const expired = yield* signGrant({
          hostIdentitySeed: keypair.seed,
          alg: signer.alg,
          devicePublicKey: signer.publicKey,
          now: (yield* Clock.currentTimeMillis) - 100 * 86_400_000,
          nonce: "expired-grant-nonce-00001",
        });
        const expiredResult = yield* Effect.scoped(handshake(host, signer, expired)).pipe(
          Effect.exit,
          Effect.timeout("10 seconds"),
        );
        expect(expiredResult._tag).toBe("Failure");

        // A valid grant, but plaintext instead of an E2E handshake: the host just closes.
        const grant = yield* signGrant({
          hostIdentitySeed: keypair.seed,
          alg: signer.alg,
          devicePublicKey: signer.publicKey,
          now: yield* Clock.currentTimeMillis,
          nonce: "plaintext-attempt-nonce01",
        });
        const plaintext = yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* relayClientSocket(
              `${host.relayUrl}/v1/client/${host.hostId}`,
              clientAuthFrame(host.hostId, signer, grant),
            );
            const reader = yield* socket.reader;
            const writer = yield* socket.writer;
            yield* writer.write("GET /relay-probe HTTP/1.1\r\n\r\n");
            return yield* reader.pull.pipe(Effect.forever, Effect.flip);
          }),
        ).pipe(Effect.timeout("10 seconds"));
        expect(Socket.isSocketError(plaintext)).toBe(true);
        const state = yield* RelayConnector.RelayConnector.pipe(
          Effect.flatMap((connector) => connector.state),
        );
        expect(state.activeSessions).toBe(0);
      }).pipe(Effect.provide(layerHost({ relayUrl: url })));
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("renews a grant with under 30 days left, inside the E2E channel", () =>
    Effect.gen(function* () {
      const { url } = yield* startRelay;
      yield* Effect.gen(function* () {
        const host = yield* hostView(url);
        const signer = yield* newDevice;
        const paired = yield* pairDevice(host, signer);
        const keypair = yield* (yield* ServerE2eeIdentity.ServerE2eeIdentity).getKeypair;
        const aging = yield* signGrant({
          hostIdentitySeed: keypair.seed,
          alg: signer.alg,
          devicePublicKey: signer.publicKey,
          now: (yield* Clock.currentTimeMillis) - 80 * 86_400_000,
          nonce: "aging-grant-nonce-0000001",
        });
        const renewed = yield* Effect.scoped(
          Effect.gen(function* () {
            const { fetch } = yield* openDeviceSession(host, signer, aging);
            return yield* Effect.promise(async () =>
              (await fetch("/api/relay/grant", { method: "POST" })).json(),
            );
          }),
        );
        const record: DevicePairingRecord = { ...paired.record, grant: aging };
        const next = acceptRenewedGrant(record, {
          grant: (renewed as { grant: unknown }).grant,
          alg: signer.alg,
          devicePublicKey: signer.publicKey,
          now: yield* Clock.currentTimeMillis,
        });
        expect(next).not.toBeNull();
        expect(next!.grant.expiresAt).toBeGreaterThan(aging.expiresAt);
      }).pipe(Effect.provide(layerHost({ relayUrl: url })));
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("RelayConnector routes through the mux (spec §12)", () => {
  it.live(
    "assets and uploads by device-bound handle, never by signed URL; media tickets and media routes refused",
    () =>
      Effect.gen(function* () {
        const { url } = yield* startRelay;
        yield* Effect.gen(function* () {
          const host = yield* hostView(url);
          const phone = yield* newDevice;
          const laptop = yield* newDevice;
          const pairedPhone = yield* pairDevice(host, phone, "Phone");
          const pairedLaptop = yield* pairDevice(host, laptop, "Laptop");
          const bytes = Uint8Array.from({ length: 300_000 }, (_, index) => (index * 7) % 256);

          const issued = yield* Effect.scoped(
            Effect.gen(function* () {
              const { client, fetch } = yield* openDeviceSession(
                host,
                phone,
                pairedPhone.record.grant,
              );
              const { rpc, accessToken, dpop } = yield* signInAndCallRpc(
                client,
                pairedPhone.bootstrapToken,
              );

              // The upload slot is a handle under the relay prefix, not a signed token.
              const upload = yield* rpc["relayProbe.uploadUrl"]({
                name: "photo.png",
                mimeType: "image/png",
                sizeBytes: bytes.byteLength,
              });
              expect(upload.relativeUrl).toMatch(
                /^\/api\/attachments\/upload\/relay\/[A-Za-z0-9_-]{32}$/u,
              );
              const stored = yield* Effect.promise(async () => {
                const response = await fetch(upload.relativeUrl, {
                  method: "POST",
                  headers: { "content-length": String(bytes.byteLength) },
                  body: bytes,
                });
                return response.status;
              });
              expect(stored).toBe(204);

              const asset = yield* rpc["relayProbe.assetUrl"]({
                attachmentId: upload.attachmentId!,
              });
              expect(asset.relativeUrl).toMatch(/^\/api\/assets\/file\/[A-Za-z0-9_-]{32}\/[^/]+$/u);
              // No `payload.signature` token anywhere before the file name.
              expect(asset.relativeUrl.split("/")[4]).not.toContain(".");
              const fetched = yield* Effect.promise(async () => {
                const response = await fetch(asset.relativeUrl);
                return {
                  status: response.status,
                  bytes: new Uint8Array(await response.arrayBuffer()),
                };
              });
              expect(fetched.status).toBe(200);
              expect(fetched.bytes).toEqual(bytes);

              // A signed URL for the same file, as a LAN client would get, is refused here.
              const signed = yield* issueAssetUrl({
                resource: { _tag: "attachment", attachmentId: upload.attachmentId! },
              });
              expect(signed.relativeUrl).toMatch(/^\/api\/assets\/[^/]+\.[^/]+\//u);
              const refusedSigned = yield* Effect.promise(async () => {
                const response = await fetch(signed.relativeUrl);
                return { status: response.status, body: await response.json() };
              });
              expect(refusedSigned).toMatchObject({
                status: 403,
                body: { code: "relay-unsupported", feature: "signed-url" },
              });

              // Media tickets are credentials in URLs: not through the relay.
              const iat = yield* nowSeconds;
              const mediaTicket = yield* Effect.promise(async () => {
                const ticketUrl = `${ORIGIN}/api/auth/websocket-ticket/media`;
                const response = await fetch("/api/auth/websocket-ticket/media", {
                  method: "POST",
                  headers: {
                    authorization: `DPoP ${accessToken}`,
                    dpop: dpop.sign({ method: "POST", url: ticketUrl, token: accessToken, iat }),
                  },
                });
                return { status: response.status, body: await response.json() };
              });
              expect(mediaTicket).toMatchObject({
                status: 403,
                body: { code: "relay-unsupported", feature: "media-ticket" },
              });

              for (const [path, feature] of [
                ["/api/preview/tunnel?port=3000", "preview-tunnel"],
                ["/api/device-hub/api/devices", "device-hub"],
                ["/api/preview-stream/ws?tabId=x", "preview-stream"],
                ["/ws/voice", "voice-input"],
                ["/api/guest/session?share=x", "guest-share"],
              ] as const) {
                const refusal = yield* Effect.promise(async () => {
                  const response = await fetch(path);
                  return { status: response.status, body: await response.json() };
                });
                expect(refusal).toMatchObject({
                  status: 403,
                  body: { code: "relay-unsupported", feature },
                });
              }
              return asset.relativeUrl;
            }),
          );

          // The phone's handle is no use to another paired device.
          const stolen = yield* Effect.scoped(
            Effect.gen(function* () {
              const { fetch } = yield* openDeviceSession(host, laptop, pairedLaptop.record.grant);
              return yield* Effect.promise(async () => (await fetch(issued)).status);
            }),
          );
          expect(stolen).toBe(404);
        }).pipe(Effect.provide(layerHost({ relayUrl: url })));
      }).pipe(Effect.provide(layerTest)),
  );
});

describe("RelayConnector: a device removes itself", () => {
  it.live("only its own entry, whatever it names, and never another session's device", () =>
    Effect.gen(function* () {
      const { url } = yield* startRelay;
      yield* Effect.gen(function* () {
        const host = yield* hostView(url);
        const connector = yield* RelayConnector.RelayConnector;
        const ledger = yield* RelayDeviceLedger.RelayDeviceLedger;
        const phone = yield* newDevice;
        const laptop = yield* newDevice;
        const pairedPhone = yield* pairDevice(host, phone, "Phone");
        yield* pairDevice(host, laptop, "Laptop");
        const phoneId = relayDeviceId(phone.alg, phone.publicKey);
        const laptopId = relayDeviceId(laptop.alg, laptop.publicKey);

        // Sessions that are not a relay device's, or a channel of another device: nothing goes.
        const cli = yield* connector
          .forgetSessionDevice({ subject: "cli-issued-session", relayDeviceId: undefined })
          .pipe(Effect.flip);
        expect(cli.failure).toBe("not-a-relay-device");
        const crossed = yield* connector
          .forgetSessionDevice({
            subject: EnvironmentAuth.relayPairedDeviceSubject(phoneId),
            relayDeviceId: laptopId,
          })
          .pipe(Effect.flip);
        expect(crossed.failure).toBe("not-a-relay-device");
        expect((yield* ledger.get(phoneId))?.status).toBe("active");

        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* openDeviceSession(host, phone, pairedPhone.record.grant);
            const { rpc } = yield* signInAndCallRpc(client, pairedPhone.bootstrapToken);
            // The payload names the laptop; the host goes by the session.
            yield* rpc[WS_METHODS.k3RelayForgetThisDevice]({ deviceId: laptopId } as never).pipe(
              Effect.ignore,
            );
          }),
        );
        const state = yield* awaitState((next) =>
          next.devices.some((device) => device.deviceId === phoneId && device.status === "revoked"),
        );
        expect(state.devices.find((device) => device.deviceId === laptopId)?.status).toBe("active");
      }).pipe(Effect.provide(layerHost({ relayUrl: url })));
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("RelayConnector pairing", () => {
  it.live(
    "refuses a wrong secret without closing the window, then rejects on the user's word",
    () =>
      Effect.gen(function* () {
        const { url } = yield* startRelay;
        yield* Effect.gen(function* () {
          const host = yield* hostView(url);
          const connector = yield* RelayConnector.RelayConnector;
          const ledger = yield* RelayDeviceLedger.RelayDeviceLedger;
          const signer = yield* newDevice;

          // No window yet: the relay does not even admit a pairing connection.
          const closed = yield* Effect.scoped(
            Effect.flatMap(
              rawRelaySocket(`${host.relayUrl}/v1/client/${host.hostId}?pairing=1`),
              (raw) => Effect.flatMap(raw.reader, (reader) => reader.pull),
            ),
          ).pipe(Effect.flip, Effect.timeout("10 seconds"));
          expect(Socket.isSocketError(closed)).toBe(true);

          const offer = yield* connector.createPairingOffer;
          // A link whose secret was swapped: the proof fails, the window stays open.
          const forged = offer.link.replace(/#s=.*/u, `#s=${encodeBase64url(new Uint8Array(16))}`);
          const forgedReply = yield* Effect.scoped(
            Effect.gen(function* () {
              const e2ee = yield* wrapClientSocketWithE2eeV2(
                yield* relayClientSocket(`${host.relayUrl}/v1/client/${host.hostId}?pairing=1`),
                { environmentId: host.hostId, expectedServerIdentityKey: host.hostIdentityKey },
              );
              const reader = yield* e2ee.reader;
              const writer = yield* e2ee.writer;
              const info = yield* e2ee.sessionInfo;
              const claim = yield* createPairingClaim(
                startDevicePairing(forged, yield* Clock.currentTimeMillis),
                {
                  transcriptHash: info.transcriptHash,
                  signer,
                  name: "Intruder",
                  now: yield* Clock.currentTimeMillis,
                },
              );
              yield* writer.write(JSON.stringify(claim.claim));
              return parseFrame((yield* reader.pull)[0]);
            }),
          );
          expect(forgedReply).toEqual({ type: "pairing-rejected", reason: "invalid-claim" });
          expect((yield* connector.state).pairing.phase).toBe("open");

          // The real link works; the user rejects instead of approving.
          const reply = yield* Effect.scoped(
            Effect.gen(function* () {
              const e2ee = yield* wrapClientSocketWithE2eeV2(
                yield* relayClientSocket(`${host.relayUrl}/v1/client/${host.hostId}?pairing=1`),
                { environmentId: host.hostId, expectedServerIdentityKey: host.hostIdentityKey },
              );
              const reader = yield* e2ee.reader;
              const writer = yield* e2ee.writer;
              const info = yield* e2ee.sessionInfo;
              const claim = yield* createPairingClaim(
                startDevicePairing(offer.link, yield* Clock.currentTimeMillis),
                {
                  transcriptHash: info.transcriptHash,
                  signer,
                  name: "Somebody's phone",
                  now: yield* Clock.currentTimeMillis,
                },
              );
              yield* writer.write(JSON.stringify(claim.claim));
              yield* awaitState((state) => state.pairing.phase === "awaiting-approval");

              // Only one claim at a time: the relay window closed once the secret was spent.
              const second = yield* Effect.scoped(
                Effect.flatMap(
                  rawRelaySocket(`${host.relayUrl}/v1/client/${host.hostId}?pairing=1`),
                  (raw) => Effect.flatMap(raw.reader, (secondReader) => secondReader.pull),
                ),
              ).pipe(Effect.flip, Effect.timeout("10 seconds"));
              expect(Socket.isSocketError(second)).toBe(true);
              // Approving another device id than the one compared is refused.
              const wrong = yield* connector
                .approvePairing("aaaabbbbccccddddeeeeffffgggghhhh")
                .pipe(Effect.flip);
              expect(wrong.failure).toBe("no-pending-pairing");
              // A QR pairing always compares codes: no code, or another one, approves nothing.
              const waiting = (yield* connector.state).pairing;
              assert(waiting.phase === "awaiting-approval");
              expect(waiting.approval).toBe("compare-code");
              const noCode = yield* connector.approvePairing(waiting.deviceId).pipe(Effect.flip);
              expect(noCode.failure).toBe("confirmation-required");
              const otherCode = yield* connector
                .approvePairing(waiting.deviceId, "AAAA-AAAA")
                .pipe(Effect.flip);
              expect(otherCode.failure).toBe("confirmation-required");
              expect((yield* connector.state).pairing.phase).toBe("awaiting-approval");

              yield* connector.rejectPairing;
              return parseFrame((yield* reader.pull)[0]);
            }),
          );
          expect(reply).toEqual({ type: "pairing-rejected", reason: "rejected" });
          expect(yield* ledger.list).toEqual([]);
          expect((yield* connector.state).pairing).toEqual({ phase: "closed", reason: "rejected" });
        }).pipe(Effect.provide(layerHost({ relayUrl: url })));
      }).pipe(Effect.provide(layerTest)),
  );
});

// ── Off by default and under policy: no socket at all ───────────────────────

const countingListener = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: NodeNet.Server; port: number; connections: () => number }>(
        (resolve) => {
          let connections = 0;
          const server = NodeNet.createServer((socket) => {
            connections += 1;
            socket.destroy();
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address() as NodeNet.AddressInfo;
            resolve({ server, port: address.port, connections: () => connections });
          });
        },
      ),
  ),
  ({ server }) =>
    Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
);

describe("approval of a new device (spec §20.3)", () => {
  const policy = { requireApproval: true, optOut: null } as const;
  const window = (now: number, used = false) => ({
    openedAt: now,
    expiresAt: now + 10 * 60_000,
    openedBy: { kind: "host-user" } as const,
    used,
  });

  it("offers one tap only to the first non-QR device inside the host user's window", () => {
    const opened = window(1_000);
    expect(
      RelayConnector.pairingApprovalMode({ policy, window: opened, route: "account", now: 2_000 }),
    ).toBe("one-tap");
    // QR pairing compares codes, window or not.
    expect(
      RelayConnector.pairingApprovalMode({ policy, window: opened, route: "qr", now: 2_000 }),
    ).toBe("compare-code");
    // Outside the window, or once the window's one tap was spent.
    expect(
      RelayConnector.pairingApprovalMode({
        policy,
        window: opened,
        route: "account",
        now: 1_000 + 10 * 60_000,
      }),
    ).toBe("compare-code");
    expect(
      RelayConnector.pairingApprovalMode({
        policy,
        window: window(1_000, true),
        route: "account",
        now: 2_000,
      }),
    ).toBe("compare-code");
    expect(
      RelayConnector.pairingApprovalMode({ policy, window: null, route: "account", now: 2_000 }),
    ).toBe("compare-code");
    // A window a device opened (an introduction) never gives one tap.
    expect(
      RelayConnector.pairingApprovalMode({
        policy,
        window: {
          ...opened,
          openedBy: { kind: "device", deviceId: "d", permissions: ["devices:invite"] },
        },
        route: "account",
        now: 2_000,
      }),
    ).toBe("compare-code");
  });

  it("asks for the code once a one-tap offer outlives its window", () => {
    const opened = window(1_000);
    expect(RelayConnector.approvalNeedsCode({ mode: "one-tap", window: opened, now: 5_000 })).toBe(
      false,
    );
    expect(
      RelayConnector.approvalNeedsCode({
        mode: "one-tap",
        window: opened,
        now: 1_000 + 10 * 60_000,
      }),
    ).toBe(true);
    expect(
      RelayConnector.approvalNeedsCode({ mode: "compare-code", window: opened, now: 5_000 }),
    ).toBe(true);
  });
});

describe("RelayConnector stays off", () => {
  it.live("opens no socket when the relay is off, which is the default", () =>
    Effect.gen(function* () {
      const listener = yield* countingListener;
      yield* Effect.gen(function* () {
        const connector = yield* RelayConnector.RelayConnector;
        const state = yield* connector.state;
        expect(state).toMatchObject({ enabled: false, status: "disabled", registered: false });
        expect((yield* connector.createPairingOffer.pipe(Effect.flip)).failure).toBe("disabled");
        expect(listener.connections()).toBe(0);
      }).pipe(
        Effect.provide(layerHost({ relayUrl: `ws://127.0.0.1:${listener.port}`, enabled: false })),
      );
      expect(listener.connections()).toBe(0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("never starts when the managed policy disallows the relay, even if enabled", () =>
    Effect.gen(function* () {
      const listener = yield* countingListener;
      yield* Effect.gen(function* () {
        const connector = yield* RelayConnector.RelayConnector;
        const state = yield* connector.state;
        expect(state).toMatchObject({
          enabled: true,
          policyAllowed: false,
          status: "disabled",
          error: "policy-disallowed",
          reachableWhenNetworkAccessOff: false,
        });
        expect((yield* connector.createPairingOffer.pipe(Effect.flip)).failure).toBe(
          "policy-disallowed",
        );
        expect(
          (yield* connector.revokeDevice("aaaabbbbccccddddeeeeffffgggghhhh").pipe(Effect.flip))
            .failure,
        ).toBe("policy-disallowed");
      }).pipe(
        Effect.provide(
          layerHost({
            relayUrl: `ws://127.0.0.1:${listener.port}`,
            policy: { schemaVersion: 1, organization: "Example Corp", limits: { connect: false } },
          }),
        ),
      );
      expect(listener.connections()).toBe(0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("turning the relay off at runtime disconnects it", () =>
    Effect.gen(function* () {
      const { url, relay } = yield* startRelay;
      yield* Effect.gen(function* () {
        yield* awaitConnected;
        expect(relay.metrics.snapshot().controls).toBe(1);
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ relay: { enabled: false } });
        const state = yield* awaitState((next) => next.status === "disabled");
        expect(state.enabled).toBe(false);
        // The relay learns of the close over the network; wait for it, bounded.
        const controls = yield* Effect.sync(() => relay.metrics.snapshot().controls).pipe(
          // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the relay notices the close over a real socket; nothing signals it.
          Effect.repeat({ until: (count) => count === 0, schedule: Schedule.spaced("10 millis") }),
          Effect.timeout("5 seconds"),
        );
        expect(controls).toBe(0);
      }).pipe(Effect.provide(layerHost({ relayUrl: url })));
    }).pipe(Effect.provide(layerTest)),
  );
});
