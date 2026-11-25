// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalFetch:off globalJsonInEffect:off - drives a real Node relay and its wall clock.
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

import { makeMuxHandler, makeMuxHost, type MuxHandler } from "@t3tools/shared/mux";
import {
  type DeviceLedger,
  type HostPairingState,
  type RelayGrant,
  approvePairing,
  encodePairingLink,
  initialHostPairingState,
  issueGrant,
  ledgerVerifyDevice,
  makeDeviceLedger,
  makeMemoryLedgerStore,
  openPairingWindow,
  rejectPairing,
  relayDeviceId,
  relayHostId,
  submitPairingClaim,
} from "@t3tools/shared/relay";
import {
  type E2eeDeviceSigner,
  E2eeRejectedError,
  type E2eeRejectionReason,
  identityPublicKeyFromSeed,
  layerE2eeCrypto,
  requireAuthenticatedDevice,
  wrapServerSocketWithE2eeV2,
} from "@t3tools/shared/socketE2ee";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";

/** The subset of `infra/k3-relay/src/relay.testkit.ts` used here. Imported at run time so this
 * package's type check does not pull in the relay's Node-only sources. */
interface RelayPeer {
  readonly closed: Promise<{ code: number; reason: string }>;
  json(): Promise<Record<string, unknown>>;
  send(data: string): Promise<void>;
  close(code?: number, reason?: string): void;
}
interface RelaySigner {
  readonly alg: "ed25519";
  readonly pub: Buffer;
  sign(message: Uint8Array): Buffer;
}
interface TestRelay {
  readonly relay: { listen(): Promise<number>; close(): Promise<void> };
  readonly port: number;
  readonly clock: { now: number };
  readonly logs: Array<string>;
  readonly dbPath: string;
  wsUrl(path: string): string;
  http(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{
    status: number;
    text: string;
    json: Record<string, unknown> | null;
    headers: Headers;
  }>;
}
interface RelayTestkit {
  readonly TEST_CONFIG: Record<string, unknown> & { readonly dbPath: string };
  registerHost(
    relay: TestRelay,
    host: { readonly signer: RelaySigner; readonly hostId: string },
  ): Promise<{ status: number }>;
  connectControl(
    relay: TestRelay,
    host: { readonly signer: RelaySigner; readonly hostId: string },
  ): Promise<{ readonly peer: RelayPeer }>;
}
interface RelayServerModule {
  createRelay(options: {
    readonly config: unknown;
    readonly logger: {
      info(event: string, fields?: Record<string, unknown>): void;
      error(event: string, fields?: Record<string, unknown>): void;
    };
    readonly now: () => number;
  }): TestRelay["relay"];
}
const relaySource = (file: string) =>
  NodeURL.fileURLToPath(new URL(`../../../../infra/k3-relay/src/${file}`, import.meta.url));
const loadRelay = Effect.promise(async () => ({
  server: (await import(/* @vite-ignore */ relaySource("server.ts"))) as RelayServerModule,
  testkit: (await import(/* @vite-ignore */ relaySource("relay.testkit.ts"))) as RelayTestkit,
}));
import { k3RelayE2eeEnvironmentId } from "@t3tools/contracts";

import { decodePairingFrame, encodePairingFrame } from "./pairing.ts";

/**
 * A real `infra/k3-relay` server in this process, and a small host behind it: E2EE v2 server,
 * a device ledger, pairing, and a mux host with whatever handler the test gives. The host's
 * real connector lives in `apps/server`; this one is only as much as the client needs.
 */

export const layerWebSocketGlobal = Layer.succeed(
  Socket.WebSocketConstructor,
  (url, options) =>
    new globalThis.WebSocket(
      url,
      typeof options === "string" || Array.isArray(options) ? options : undefined,
    ) as unknown as Socket.WebSocketLike,
);

export const layerTestCrypto = layerE2eeCrypto;

export interface TestRelayHandle {
  readonly testRelay: TestRelay;
  readonly relayUrl: string;
  readonly testkit: RelayTestkit;
}

/** Starts a relay on an ephemeral port for the scope. Its clock is the wall clock. */
export const startTestRelay = Effect.acquireRelease(
  Effect.flatMap(loadRelay, ({ server, testkit }) =>
    Effect.promise(async () => {
      const { createRelay } = server;
      const logs: Array<string> = [];
      const config = { ...testkit.TEST_CONFIG };
      const clock = { now: Date.now() };
      const relay = createRelay({
        config,
        logger: {
          info: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
          error: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
        },
        now: () => Date.now(),
      });
      const port = await relay.listen();
      const testRelay: TestRelay = {
        relay,
        port,
        clock,
        logs,
        dbPath: config.dbPath,
        wsUrl: (path) => `ws://127.0.0.1:${port}${path}`,
        http: async (method, path, body, headers) => {
          const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            ...(headers ? { headers } : {}),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const text = await response.text();
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = null;
          }
          return { status: response.status, text, json, headers: response.headers };
        },
      };
      return {
        testRelay,
        relayUrl: `http://127.0.0.1:${port}/`,
        testkit,
      } satisfies TestRelayHandle;
    }),
  ),
  (handle) => Effect.promise(() => handle.testRelay.relay.close()),
);

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const nodeSignerFromSeed = (seed: Uint8Array) => {
  const key = NodeCrypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  return {
    alg: "ed25519" as const,
    pub: Buffer.from(identityPublicKeyFromSeed(seed)),
    sign: (message: Uint8Array) => NodeCrypto.sign(null, message, key),
  };
};

export type PairingDecision =
  | { readonly kind: "approve"; readonly bootstrapToken: string }
  | { readonly kind: "reject" }
  | { readonly kind: "ignore" };

export interface TestHostOptions {
  readonly handler?: MuxHandler<unknown, never>;
  /** Overrides the ledger's verdict, to test refusals. */
  readonly refuse?: () => E2eeRejectionReason | null;
  /** Called with the host's confirmation code once a pairing claim verifies. */
  readonly decidePairing?: (code: string) => Effect.Effect<PairingDecision>;
  /** Sends something other than a proper reply, to test the device's checks. */
  readonly tamperReply?: (reply: unknown) => unknown;
  /** Answers the E2EE handshake with another key than the registered one (a relay swapping hosts). */
  readonly impostorSeed?: Uint8Array;
  /** Registers with the relay but never connects its control socket. */
  readonly offline?: boolean;
}

export interface TestHost {
  readonly seed: Uint8Array;
  readonly hostIdentityKey: Uint8Array;
  readonly hostId: string;
  readonly ledger: DeviceLedger;
  /** Host-side confirmation codes, in the order claims verified. */
  readonly codes: Queue.Queue<string>;
  readonly issueGrantFor: (signer: E2eeDeviceSigner, now?: number) => Effect.Effect<RelayGrant>;
  /** Adds `signer` to the ledger and returns a grant for it, as an approval would. */
  readonly approveDevice: (signer: E2eeDeviceSigner) => Effect.Effect<RelayGrant>;
  readonly revoke: (signer: E2eeDeviceSigner) => Effect.Effect<void>;
  /** Opens a pairing window and returns the offer link. */
  readonly openPairing: Effect.Effect<string>;
}

export const startTestHost = Effect.fn("K3RelayTestHost.start")(function* (
  relay: TestRelayHandle,
  options: TestHostOptions = {},
): Effect.fn.Return<TestHost, never, Scope.Scope> {
  const seed = Uint8Array.from(NodeCrypto.randomBytes(32));
  const hostIdentityKey = identityPublicKeyFromSeed(seed);
  const hostId = relayHostId(hostIdentityKey);
  const signer = nodeSignerFromSeed(seed);
  const registered = yield* Effect.promise(() =>
    relay.testkit.registerHost(relay.testRelay, { signer, hostId }),
  );
  if (registered.status !== 201 && registered.status !== 200) {
    return yield* Effect.die(new Error(`host registration failed: ${registered.status}`));
  }
  const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
  const codes = yield* Queue.unbounded<string>();
  const issueGrantFor = (device: E2eeDeviceSigner, now = Date.now()) =>
    issueGrant({
      hostIdentitySeed: seed,
      alg: device.alg,
      devicePublicKey: device.publicKey,
      now,
    }).pipe(Effect.provide(layerE2eeCrypto), Effect.orDie);
  const approveDevice = Effect.fnUntraced(function* (device: E2eeDeviceSigner) {
    yield* ledger
      .add({ alg: device.alg, publicKey: device.publicKey, name: "Test device", now: Date.now() })
      .pipe(Effect.orDie);
    return yield* issueGrantFor(device);
  });
  const revoke = (device: E2eeDeviceSigner) =>
    ledger.revoke(relayDeviceId(device.alg, device.publicKey), Date.now()).pipe(Effect.orDie);
  if (options.offline === true) {
    return {
      seed,
      hostIdentityKey,
      hostId,
      ledger,
      codes,
      issueGrantFor,
      approveDevice,
      revoke: (device) => Effect.asVoid(revoke(device)),
      openPairing: Effect.die(new Error("the host is offline")),
    } satisfies TestHost;
  }
  const control = yield* Effect.acquireRelease(
    Effect.promise(() => relay.testkit.connectControl(relay.testRelay, { signer, hostId })),
    (link) => Effect.sync(() => link.peer.close()),
  );
  const controlErrors = yield* Queue.unbounded<Record<string, unknown>>();
  let pairing: HostPairingState = initialHostPairingState;
  const sendControl = (frame: unknown) =>
    Effect.promise(() => control.peer.send(JSON.stringify(frame)));

  const verifyDevice = (identity: Parameters<ReturnType<typeof ledgerVerifyDevice>>[0]) => {
    const refusal = options.refuse?.() ?? null;
    return refusal === null
      ? ledgerVerifyDevice(ledger)(identity)
      : Effect.fail(new E2eeRejectedError({ reason: refusal }));
  };

  const serveClient = (socket: Socket.Socket) =>
    Effect.gen(function* () {
      const e2ee = yield* wrapServerSocketWithE2eeV2(socket, {
        environmentId: k3RelayE2eeEnvironmentId(hostId),
        identitySeed: options.impostorSeed ?? seed,
        verifyDevice,
        requireGrant: true,
      });
      const session = yield* makeMuxHost({
        socket: requireAuthenticatedDevice(e2ee),
        handler: options.handler ?? makeMuxHandler({}),
      });
      yield* session.closed;
    });

  const servePairing = (socket: Socket.Socket) =>
    Effect.gen(function* () {
      const e2ee = yield* wrapServerSocketWithE2eeV2(socket, {
        environmentId: k3RelayE2eeEnvironmentId(hostId),
        identitySeed: options.impostorSeed ?? seed,
        verifyDevice,
        requireDeviceAuth: false,
      });
      const reader = yield* e2ee.reader;
      const writer = yield* e2ee.writer;
      const info = yield* e2ee.sessionInfo;
      const [frame] = yield* reader.pull;
      const submitted = submitPairingClaim(pairing, {
        transcriptHash: info.transcriptHash,
        message: decodePairingFrame(frame),
        now: Date.now(),
      });
      pairing = submitted.state;
      const send = (reply: unknown) =>
        writer.write(encodePairingFrame(options.tamperReply?.(reply) ?? reply));
      if (submitted.outcome.kind === "rejected") return yield* send(submitted.outcome.reply);
      yield* Queue.offer(codes, submitted.outcome.confirmationCode);
      const decision = yield* (
        options.decidePairing?.(submitted.outcome.confirmationCode) ??
          Effect.succeed<PairingDecision>({ kind: "ignore" })
      );
      if (decision.kind === "ignore") return yield* Effect.never.pipe(Effect.asVoid);
      if (decision.kind === "reject") {
        const rejected = rejectPairing(pairing);
        pairing = rejected.state;
        return yield* send(rejected.reply);
      }
      const approved = yield* approvePairing(pairing, {
        hostIdentitySeed: seed,
        ledger,
        bootstrapToken: decision.bootstrapToken,
        now: Date.now(),
      });
      pairing = approved.state;
      yield* sendControl(approved.relayFrame);
      yield* send(approved.reply);
      // Let the reply drain before the relay sees the host side close.
      return yield* Effect.never.pipe(Effect.asVoid);
    });

  yield* Effect.gen(function* () {
    while (true) {
      const message = yield* Effect.promise(() => control.peer.json());
      if (message.type === "error") yield* Queue.offer(controlErrors, message);
      if (message.type !== "session-open") continue;
      const url = relay.testRelay.wsUrl(
        `/v1/host/data/${String(message.sessionId)}?t=${String(message.token)}`,
      );
      const socket = yield* Socket.makeWebSocket(url);
      const serve =
        message.kind === "pairing"
          ? Effect.ignoreCause(servePairing(socket))
          : Effect.ignoreCause(serveClient(socket));
      yield* serve.pipe(Effect.scoped, Effect.forkScoped);
    }
  }).pipe(Effect.provide(Layer.mergeAll(layerWebSocketGlobal, layerE2eeCrypto)), Effect.forkScoped);

  /** Control messages are handled in order: the error for a bad frame proves the earlier ones ran. */
  const barrier = Effect.gen(function* () {
    yield* sendControl({ type: "grant-register", grant: {}, dk: "" });
    yield* Queue.take(controlErrors);
  });

  return {
    seed,
    hostIdentityKey,
    hostId,
    ledger,
    codes,
    issueGrantFor,
    approveDevice,
    revoke: (device) => Effect.asVoid(revoke(device)),
    openPairing: Effect.gen(function* () {
      const opened = yield* openPairingWindow({
        hostIdentitySeed: seed,
        relayUrl: relay.relayUrl,
        now: Date.now(),
        previous: pairing,
      }).pipe(Effect.provide(layerE2eeCrypto), Effect.orDie);
      pairing = opened.state;
      yield* sendControl({ type: "pairing-open", expiresAt: opened.offer.expiresAt });
      yield* barrier;
      return encodePairingLink(opened.offer);
    }),
  } satisfies TestHost;
});
