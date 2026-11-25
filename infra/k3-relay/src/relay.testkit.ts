import * as NodeCrypto from "node:crypto";

import { WebSocket, type ClientOptions } from "ws";

import { base64url } from "./bytes.ts";
import { DEFAULT_CONFIG, type RelayConfig } from "./config.ts";
import {
  LABELS,
  deviceIdOf,
  grantSigningInput,
  hostIdOf,
  revokeSigningInput,
  signingInput,
  type DeviceAlg,
  type Grant,
} from "./crypto.ts";
import { registrationSigningInput, solveChallenge, type PowChallenge } from "./pow.ts";
import { createRelay, type Logger, type Relay, type RelayOptions } from "./server.ts";

export const EPOCH = 1_800_000_000_000;

export interface Signer {
  readonly alg: DeviceAlg;
  readonly pub: Buffer;
  sign(message: Uint8Array): Buffer;
}

export function newEd25519(): Signer {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ed25519");
  return {
    alg: "ed25519",
    pub: Buffer.from(publicKey.export({ type: "spki", format: "der" }).subarray(-32)),
    sign: (message) => NodeCrypto.sign(null, message, privateKey),
  };
}

export function newP256(): Signer {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    alg: "p256",
    pub: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x ?? "", "base64url"),
      Buffer.from(jwk.y ?? "", "base64url"),
    ]),
    sign: (message) =>
      NodeCrypto.sign("sha256", message, { key: privateKey, dsaEncoding: "ieee-p1363" }),
  };
}

export interface TestHost {
  readonly signer: Signer;
  readonly hostId: string;
}

export function newHost(): TestHost {
  const signer = newEd25519();
  return { signer, hostId: hostIdOf(signer.pub) };
}

export function grantFor(
  host: TestHost,
  device: Signer,
  now: number,
  overrides: Partial<Omit<Grant, "sig">> = {},
): Grant {
  const body: Omit<Grant, "sig"> = {
    v: 1,
    hostId: host.hostId,
    deviceId: deviceIdOf(device.alg, device.pub),
    alg: device.alg,
    issuedAt: now,
    expiresAt: now + 90 * 86_400_000,
    nonce: base64url(NodeCrypto.randomBytes(16)),
    ...overrides,
  };
  const unsigned: Grant = { ...body, sig: "" };
  return { ...body, sig: base64url(host.signer.sign(grantSigningInput(unsigned))) };
}

export function revocationFor(host: TestHost, deviceId: string, issuedAt: number) {
  const sig = host.signer.sign(revokeSigningInput(host.hostId, deviceId, issuedAt));
  return { deviceId, issuedAt, sig: base64url(sig) };
}

export interface Frame {
  readonly data: Buffer;
  readonly isBinary: boolean;
}

/** A WebSocket that queues what it receives, so tests await frames instead of polling. */
export class Peer {
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #queue: Frame[] = [];
  readonly #waiters: Array<(frame: Frame) => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data, isBinary) => {
      const frame = { data: Buffer.from(data as Buffer), isBinary };
      const waiter = this.#waiters.shift();
      if (waiter) waiter(frame);
      else this.#queue.push(frame);
    });
    ws.on("error", () => {});
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  next(): Promise<Frame> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async json(): Promise<Record<string, unknown>> {
    const frame = await this.next();
    return JSON.parse(frame.data.toString("utf8")) as Record<string, unknown>;
  }

  send(data: string | Buffer, binary = typeof data !== "string"): Promise<void> {
    return new Promise((resolve, reject) =>
      this.ws.send(data, { binary }, (error) => (error ? reject(error) : resolve())),
    );
  }

  close(code = 1000, reason = ""): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(code, reason);
  }
}

export type OpenResult = { readonly peer: Peer } | { readonly status: number };

export function tryOpen(url: string, options: ClientOptions = {}): Promise<OpenResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, ...options });
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    ws.on("error", () => resolve({ status: 0 }));
    ws.on("open", () => resolve({ peer: new Peer(ws) }));
  });
}

export async function open(url: string, options: ClientOptions = {}): Promise<Peer> {
  const result = await tryOpen(url, options);
  if (!("peer" in result)) throw new Error(`upgrade refused with status ${result.status}`);
  return result.peer;
}

export interface TestRelay {
  readonly relay: Relay;
  readonly port: number;
  readonly clock: { now: number };
  readonly logs: string[];
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

export const TEST_CONFIG: RelayConfig = {
  ...DEFAULT_CONFIG,
  host: "127.0.0.1",
  port: 0,
  dbPath: ":memory:",
  powBaseDifficulty: 4,
  pingIntervalMs: 3_600_000,
  authTimeoutMs: 2_000,
  sessionSetupMs: 2_000,
  backpressureCloseMs: 2_000,
  globalBandwidthBytesPerSec: 1_000_000_000,
  // Timers that tests do not need run once an hour; tests that do need them set their own.
  trafficCheckMs: 3_600_000,
  blockedPollMs: 3_600_000,
};

/** Starts a relay on an ephemeral port, runs `work`, and always shuts the relay down. */
export async function withRelay<T>(
  overrides: Partial<RelayConfig>,
  work: (relay: TestRelay) => Promise<T>,
  extra: Pick<RelayOptions, "fetch"> = {},
): Promise<T> {
  const clock = { now: EPOCH };
  const logs: string[] = [];
  const logger: Logger = {
    info: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    error: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
  };
  const config = { ...TEST_CONFIG, ...overrides };
  const relay = createRelay({ config, logger, now: () => clock.now, ...extra });
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
  try {
    return await work(testRelay);
  } finally {
    await relay.close();
  }
}

export async function registerHost(
  relay: TestRelay,
  host: TestHost,
): Promise<{ status: number; hostId?: string }> {
  const hk = base64url(host.signer.pub);
  const first = await relay.http("POST", "/v1/hosts", { hk });
  const challenge = first.json?.challenge as PowChallenge;
  const nonce = solveChallenge(host.signer.pub, challenge);
  const sig = base64url(
    host.signer.sign(registrationSigningInput(host.signer.pub, challenge.mac, nonce)),
  );
  const second = await relay.http("POST", "/v1/hosts", { hk, challenge, nonce, sig });
  return {
    status: second.status,
    ...(second.json?.hostId ? { hostId: String(second.json.hostId) } : {}),
  };
}

export interface ControlLink {
  readonly peer: Peer;
}

/** Opens `/v1/host/control` and completes the nonce signature. */
export async function connectControl(relay: TestRelay, host: TestHost): Promise<ControlLink> {
  const peer = await open(relay.wsUrl("/v1/host/control"));
  const challenge = await peer.json();
  const nonce = Buffer.from(String(challenge.nonce), "base64url");
  const sig = host.signer.sign(signingInput(LABELS.hostControl, host.hostId, nonce));
  await peer.send(JSON.stringify({ type: "auth", hostId: host.hostId, sig: base64url(sig) }));
  const ready = await peer.json();
  if (ready.type !== "ready") throw new Error(`control not ready: ${JSON.stringify(ready)}`);
  return { peer };
}

export interface ClientAuthOptions {
  readonly grant?: Grant;
  readonly signWith?: Signer;
  readonly sendAs?: Record<string, unknown>;
  readonly nonceOverride?: Buffer;
}

/** Sends the client `auth` frame for a nonce the relay already issued on `peer`. */
export async function sendClientAuth(
  peer: Peer,
  host: TestHost,
  device: Signer,
  now: number,
  options: ClientAuthOptions = {},
): Promise<string> {
  const challenge = await peer.json();
  const nonce = options.nonceOverride ?? Buffer.from(String(challenge.nonce), "base64url");
  const grant = options.grant ?? grantFor(host, device, now);
  const signer = options.signWith ?? device;
  const sig = signer.sign(
    signingInput(LABELS.client, host.hostId, deviceIdOf(device.alg, device.pub), nonce),
  );
  const frame = JSON.stringify({
    type: "auth",
    alg: device.alg,
    dk: base64url(device.pub),
    grant,
    sig: base64url(sig),
    ...options.sendAs,
  });
  await peer.send(frame);
  return frame;
}

export interface LiveSession {
  readonly client: Peer;
  readonly hostData: Peer;
  readonly sessionId: string;
}

/** A complete session: client authenticated, host control told, host data connected. */
export async function openSession(
  relay: TestRelay,
  host: TestHost,
  control: ControlLink,
  device: Signer,
): Promise<LiveSession> {
  const client = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
  await sendClientAuth(client, host, device, relay.clock.now);
  const opened = await control.peer.json();
  if (opened.type !== "session-open")
    throw new Error(`expected session-open: ${JSON.stringify(opened)}`);
  const hostData = await open(
    relay.wsUrl(`/v1/host/data/${String(opened.sessionId)}?t=${String(opened.token)}`),
  );
  const accepted = await client.json();
  if (accepted.type !== "accepted") throw new Error(`not accepted: ${JSON.stringify(accepted)}`);
  return { client, hostData, sessionId: String(opened.sessionId) };
}

export function eventOnce(relay: Relay, name: string): Promise<unknown> {
  return new Promise((resolve) => relay.events.once(name, resolve));
}

export interface StatusOptions {
  readonly ts?: number;
  readonly nonce?: string;
  readonly grant?: Grant;
  readonly signWith?: Signer;
}

export function statusBody(
  host: TestHost,
  device: Signer,
  now: number,
  options: StatusOptions = {},
): Record<string, unknown> {
  const ts = options.ts ?? now;
  const nonce = options.nonce ?? base64url(NodeCrypto.randomBytes(16));
  const deviceId = deviceIdOf(device.alg, device.pub);
  const sig = (options.signWith ?? device).sign(
    signingInput(LABELS.status, host.hostId, deviceId, String(ts), nonce),
  );
  return {
    alg: device.alg,
    dk: base64url(device.pub),
    grant: options.grant ?? grantFor(host, device, now),
    ts,
    nonce,
    sig: base64url(sig),
  };
}

/** Messages on a control connection are handled in order, so the reply to a bad one proves earlier ones ran. */
export async function barrier(control: ControlLink): Promise<void> {
  await control.peer.send(JSON.stringify({ type: "grant-register", grant: {}, dk: "" }));
  const reply = await control.peer.json();
  if (reply.type !== "error") throw new Error(`unexpected control reply: ${JSON.stringify(reply)}`);
}

export async function openPairingWindow(control: ControlLink, expiresAt: number): Promise<void> {
  await control.peer.send(JSON.stringify({ type: "pairing-open", expiresAt }));
  await barrier(control);
}

export async function closePairingWindow(control: ControlLink): Promise<void> {
  await control.peer.send(JSON.stringify({ type: "pairing-close" }));
  await barrier(control);
}
