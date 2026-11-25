// @effect-diagnostics nodeBuiltinImport:off -- the relay is a plain Node server.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { AccountHttpError, AccountService, ACCOUNT_LABELS, bindSigningInput } from "./account.ts";
import { base64url, decodeBase64url } from "./bytes.ts";
import { publicLimits, type RelayConfig } from "./config.ts";
import {
  LABELS,
  deviceIdOf,
  hostIdOf,
  isDeviceAlg,
  isId,
  keyLength,
  parseGrant,
  revokeSigningInput,
  signatureLength,
  signingInput,
  verifyGrantSignature,
  verifySignature,
  type DeviceAlg,
  type Grant,
} from "./crypto.ts";
import { createAlertNotifier } from "./alerts.ts";
import { FairScheduler } from "./fair.ts";
import { SelfPing } from "./keepalive.ts";
import { ExpiringSet, PreAuthLimiter, SlidingWindow, ipKey } from "./limits.ts";
import { Metrics, type DisconnectReason } from "./metrics.ts";
import {
  checkSolution,
  issueChallenge,
  registrationSigningInput,
  type ChallengeCheck,
} from "./pow.ts";
import { BufferBudget, Splice, type EarlyMessage } from "./splice.ts";
import { RelayStore, SCHEMA_HASH } from "./store.ts";
import { HostThrottle } from "./throttle.ts";
import { TrafficGuard, type HostPolicy } from "./traffic.ts";
import { UsageMeter } from "./usage.ts";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_EARLY_BYTES = 64 * 1024;
const GRANT_FUTURE_SKEW_MS = 5 * MINUTE_MS;
const REVOKE_SKEW_MS = 5 * MINUTE_MS;
const NONCE_BYTES = 32;
const HOST_ID_PATH = /^\/v1\/client\/([a-z2-7]{32})$/u;
const STATUS_PATH = /^\/v1\/client\/([a-z2-7]{32})\/status$/u;
const DATA_PATH = /^\/v1\/host\/data\/([0-9a-f]{32})$/u;
const ACCOUNT_OAUTH_PATH = /^\/v1\/account\/oauth\/([a-z]{1,16})\/(start|callback)$/u;
const ACCOUNT_API_PATHS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "/v1/account/hosts": [],
  "/v1/account/hosts/add": [],
  "/v1/account/hosts/remove": ["hostId"],
  "/v1/account/hosts/token": ["hostId", "dalg", "dk", "dsig"],
  "/v1/account/delete": [],
};
const CLIENT_NONCE = /^[A-Za-z0-9_-]{16,64}$/u;

// WebSocket close codes the relay itself sends (4xxx is application space).
export const CLOSE = {
  badRequest: 4400,
  unauthorized: 4401,
  revoked: 4403,
  hostOffline: 4404,
  timeout: 4408,
  replaced: 4409,
  grantExpired: 4410,
  blocked: 4423,
  limit: 4429,
} as const;

const UNAUTHORIZED_BODY = JSON.stringify({ error: "unauthorized" });

// A stand-in key so a request for an unknown host costs the same signature checks as a known one.
const DUMMY_HK = NodeCrypto.generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "der" })
  .subarray(-32);

export interface Logger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  error(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}

export const stdoutLogger: Logger = {
  info: (event, fields) =>
    process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields })}\n`),
  error: (event, fields) =>
    process.stderr.write(`${JSON.stringify({ level: "error", event, ...fields })}\n`),
};

export interface RelayOptions {
  readonly config: RelayConfig;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** For the alarm webhook. Tests pass their own. */
  readonly fetch?: typeof fetch;
}

export interface Relay {
  readonly events: NodeEvents.EventEmitter;
  readonly metrics: Metrics;
  readonly store: RelayStore;
  /** Re-reads the blocklist now, and cuts off hosts that were blocked since the last read. */
  syncBlocked(): void;
  listen(): Promise<number>;
  close(): Promise<void>;
}

interface Control {
  readonly hostId: string;
  readonly ws: WebSocket;
  accounted: boolean;
  messages: SlidingWindow;
}

interface Session {
  readonly id: string;
  readonly hostId: string;
  readonly kind: "client" | "pairing" | "account";
  readonly deviceId: string | null;
  readonly token: Buffer;
  tokenSpent: boolean;
  readonly tokenExpiresAt: number;
  readonly client: WebSocket;
  readonly early: EarlyMessage[];
  earlyBytes: number;
  hostWs: WebSocket | null;
  splice: Splice | null;
  ended: boolean;
  setupTimer: NodeJS.Timeout | null;
  lifetimeTimer: NodeJS.Timeout | null;
}

interface PairingState {
  expiresAt: number;
  attempts: number[];
  active: number;
}

type DeviceCheck =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "revoked"; readonly deviceId: string }
  | { readonly kind: "expired"; readonly deviceId: string }
  | { readonly kind: "ok"; readonly deviceId: string; readonly grant: Grant };

interface Liveness {
  alive: boolean;
  readonly onTimeout: () => void;
}

class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(body);
    this.status = status;
    this.body = body;
  }
}

/**
 * `ws` takes `maxPayload` once, per server. The relay starts at the small pre-auth value and
 * raises it for a socket once it has authenticated. If `ws` ever changes this internal, the
 * socket is dropped instead of silently keeping the wrong limit (a test covers it).
 */
function setMaxPayload(ws: WebSocket, bytes: number): boolean {
  const receiver = (ws as unknown as { _receiver?: { _maxPayload?: unknown } })._receiver;
  if (!receiver || typeof receiver._maxPayload !== "number") {
    ws.terminate();
    return false;
  }
  receiver._maxPayload = bytes;
  return true;
}

function rejectUpgrade(socket: NodeStream.Duplex, status: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`,
  );
  socket.destroy();
}

function sendJson(res: NodeHttp.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function parseJsonObject(data: Buffer | string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasExactKeys(record: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const actual = Object.keys(record).sort();
  const expected = keys.toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const isMessageText = (data: RawData, isBinary: boolean): Buffer | null =>
  isBinary || !Buffer.isBuffer(data) ? null : data;

export function createRelay(options: RelayOptions): Relay {
  return new RelayServer(options);
}

class RelayServer implements Relay {
  readonly events = new NodeEvents.EventEmitter();
  readonly store: RelayStore;
  readonly metrics: Metrics;
  readonly #config: RelayConfig;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #http: NodeHttp.Server;
  readonly #wss: WebSocketServer;
  readonly #controls = new Map<string, Control>();
  readonly #sessions = new Map<string, Session>();
  readonly #hostSessions = new Map<string, Set<Session>>();
  readonly #deviceSessions = new Map<string, number>();
  readonly #pairing = new Map<string, PairingState>();
  readonly #liveness = new Map<WebSocket, Liveness>();
  readonly #preAuth: PreAuthLimiter;
  readonly #statusLimit: SlidingWindow;
  readonly #registrationsByIp: SlidingWindow;
  readonly #recentRegistrations: SlidingWindow;
  readonly #statusNonces: ExpiringSet;
  readonly #powUsed: ExpiringSet;
  readonly #powSecret: Buffer;
  #blocked: ReadonlySet<string>;
  readonly #policies = new Map<string, HostPolicy & { baseWeight: number; until: number }>();
  readonly #traffic: TrafficGuard;
  readonly #throttle: HostThrottle;
  readonly #selfPing: SelfPing | null;
  readonly #usage: UsageMeter;
  readonly #scheduler: FairScheduler;
  readonly #budget: BufferBudget;
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #sockets = new Set<NodeNet.Socket>();
  readonly #webSockets = new Set<WebSocket>();
  /** Null when no sign-in provider is configured: every account route answers 404 then. */
  readonly #accounts: AccountService | null;
  readonly #accountAdmissions: SlidingWindow;
  #closing = false;

  constructor(options: RelayOptions) {
    this.#config = options.config;
    this.#logger = options.logger ?? stdoutLogger;
    this.#now = options.now ?? (() => Date.now());
    const config = this.#config;
    const now = this.#now;

    this.store = new RelayStore(config.dbPath);
    this.#usage = new UsageMeter(this.store, now);
    this.#budget = new BufferBudget(config.bufferBudgetBytes);
    this.#scheduler = new FairScheduler({
      bytesPerSecond: config.globalBandwidthBytesPerSec,
      burstBytes: config.globalBurstBytes,
      quantumBytes: config.fairQuantumBytes,
      now: () => performance.now(),
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      },
    });
    this.#traffic = new TrafficGuard({
      totalBytes: () => this.#usage.totalBytes(),
      now,
      budgetBytes: config.egressBudgetBytes,
      warnFraction: config.egressWarnFraction,
      degradedFraction: config.egressDegradedFraction,
      degradedHostBytesPerSec: config.degradedHostBytesPerSec,
      pressureWeightFactor: config.pressureWeightFactor,
      onAlert: createAlertNotifier({
        logger: this.#logger,
        webhookUrl: config.alertWebhookUrl,
        fetch: options.fetch ?? fetch,
      }),
      onLevelChange: () => this.#policies.clear(),
    });
    this.#throttle = new HostThrottle({
      capFor: (hostId) => this.#policy(hostId).capBytesPerSec,
      now: () => performance.now(),
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      },
    });
    this.#selfPing = config.selfPingUrl
      ? new SelfPing({
          url: config.selfPingUrl,
          intervalMs: config.selfPingIntervalMs,
          fetch: options.fetch ?? fetch,
          logger: this.#logger,
        })
      : null;
    this.metrics = new Metrics(
      {
        sessions: () => this.#sessions.size,
        waitingSessions: () => [...this.#sessions.values()].filter((s) => !s.splice).length,
        controls: () => this.#controls.size,
        sockets: () => this.#webSockets.size,
        bufferedBytes: () => this.#budget.used,
        traffic: () => this.#traffic.status(),
        selfPing: () => ({
          enabled: this.#selfPing !== null && config.selfPingIntervalMs > 0,
          ok: this.#selfPing?.ok ?? 0,
          failed: this.#selfPing?.failed ?? 0,
        }),
      },
      now,
    );
    this.#preAuth = new PreAuthLimiter(
      config.preAuthMaxConcurrentPerIp,
      config.preAuthPerMinutePerIp,
      now,
    );
    this.#statusLimit = new SlidingWindow(MINUTE_MS, config.statusPerMinutePerDevice, now);
    this.#registrationsByIp = new SlidingWindow(DAY_MS, config.registrationsPerIpPerDay, now);
    this.#recentRegistrations = new SlidingWindow(MINUTE_MS, Number.MAX_SAFE_INTEGER, now);
    this.#statusNonces = new ExpiringSet(now);
    this.#powUsed = new ExpiringSet(now);
    this.#powSecret = config.powSecret
      ? NodeCrypto.createHash("sha256").update(config.powSecret).digest()
      : NodeCrypto.randomBytes(32);
    this.#blocked = new Set([...config.blockedHosts, ...this.store.blockedHosts()]);
    this.#accounts =
      config.accountProviders.length > 0
        ? new AccountService({
            config,
            store: this.store,
            fetch: options.fetch ?? fetch,
            now,
            onProviderError: (provider, step) =>
              this.#logger.error("account-provider-failed", { provider, step }),
          })
        : null;
    this.#accountAdmissions = new SlidingWindow(
      HOUR_MS,
      config.accountAdmissionsPerHostPerHour,
      now,
    );

    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: config.preAuthMaxPayload,
      maxFragments: config.maxFragments,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.#http = NodeHttp.createServer({ maxHeaderSize: 8 * 1024 }, (req, res) =>
      this.#onRequest(req, res),
    );
    this.#http.headersTimeout = 10_000;
    this.#http.requestTimeout = 15_000;
    this.#http.keepAliveTimeout = 5_000;
    this.#http.maxConnections = config.maxControlConnections + config.maxSessions * 2 + 200;
    this.#http.on("upgrade", (req, socket, head) => {
      try {
        this.#onUpgrade(req, socket, head);
      } catch (error) {
        this.#logger.error("upgrade-failed", { code: errorCode(error) });
        socket.destroy();
      }
    });
    this.#http.on("clientError", (_error, socket) => socket.destroy());
    this.#http.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
  }

  async listen(): Promise<number> {
    const config = this.#config;
    await new Promise<void>((resolve, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(config.port, config.host, () => {
        this.#http.off("error", reject);
        resolve();
      });
    });
    this.#every(config.pingIntervalMs, () => this.#heartbeat());
    this.#every(MINUTE_MS, () => this.#sweep());
    this.#every(30_000, () => this.#usage.flush());
    this.#every(HOUR_MS, () => this.#purge());
    this.#every(1_000, () => this.metrics.sample());
    this.#every(config.trafficCheckMs, () => this.#traffic.evaluate());
    this.#every(config.blockedPollMs, () => this.syncBlocked());
    this.#selfPing?.start();
    this.#purge();
    this.#traffic.evaluate();
    const address = this.#http.address();
    this.#logger.info("listening", {
      port: typeof address === "object" && address ? address.port : 0,
    });
    return typeof address === "object" && address ? address.port : 0;
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    for (const timer of this.#timers) clearInterval(timer);
    this.#scheduler.close();
    this.#throttle.close();
    this.#selfPing?.stop();
    for (const session of this.#sessions.values()) {
      this.#endSession(session, "shutdown", 1001, "shutdown");
    }
    for (const ws of this.#webSockets) ws.close(1001, "shutdown");
    const closed = new Promise<void>((resolve) => this.#http.close(() => resolve()));
    this.#http.closeIdleConnections();
    for (const socket of this.#sockets) {
      const timer = setTimeout(() => socket.destroy(), 500);
      timer.unref();
      socket.once("close", () => clearTimeout(timer));
    }
    await closed;
    this.#usage.flush();
    this.store.close();
    this.#logger.info("closed");
  }

  /**
   * The blocklist is the `BLOCKED_HOSTS` setting plus the table that `cli block` writes, so a
   * block reaches a running relay within `blockedPollMs`. Control and data sockets of a newly
   * blocked host are closed at once, and its new connections are refused.
   */
  syncBlocked(): void {
    const next = new Set([...this.#config.blockedHosts, ...this.store.blockedHosts()]);
    const added = [...next].filter((hostId) => !this.#blocked.has(hostId));
    this.#blocked = next;
    for (const hostId of added) this.#cutOff(hostId);
  }

  #cutOff(hostId: string): void {
    for (const session of this.#hostSessions.get(hostId) ?? []) {
      this.#endSession(session, "blocked", CLOSE.blocked, "blocked");
    }
    const control = this.#controls.get(hostId);
    if (control && !control.accounted) {
      control.accounted = true;
      this.metrics.recordDisconnect("blocked");
      control.ws.close(CLOSE.blocked, "blocked");
    }
  }

  /** A throw inside a socket handler must cost that socket, not the process. */
  #guard(ws: WebSocket, work: () => void): void {
    try {
      work();
    } catch (error) {
      this.#logger.error("handler-failed", { code: errorCode(error) });
      ws.terminate();
    }
  }

  #every(ms: number, work: () => void): void {
    const timer = setInterval(() => {
      try {
        work();
      } catch (error) {
        this.#logger.error("timer-failed", { code: errorCode(error) });
      }
    }, ms);
    timer.unref();
    this.#timers.push(timer);
  }

  #clientKey(req: NodeHttp.IncomingMessage): string {
    let address = req.socket.remoteAddress ?? "";
    if (this.#config.trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      const last = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .at(-1);
      if (last) address = last;
    }
    return ipKey(address);
  }

  #sweep(): void {
    this.#preAuth.sweep();
    this.#statusLimit.sweep();
    this.#registrationsByIp.sweep();
    this.#recentRegistrations.sweep();
    this.#statusNonces.sweep();
    this.#powUsed.sweep();
    this.#throttle.sweep();
    this.#accounts?.sweep();
    this.#accountAdmissions.sweep();
    const now = this.#now();
    for (const [hostId, state] of this.#pairing) {
      state.attempts = state.attempts.filter((at) => at > now - HOUR_MS);
      if (state.attempts.length === 0 && state.active === 0 && state.expiresAt <= now) {
        this.#pairing.delete(hostId);
      }
    }
    for (const [hostId, entry] of this.#policies)
      if (entry.until <= now) this.#policies.delete(hostId);
  }

  #purge(): void {
    const result = this.store.purge(this.#now(), {
      hostIdleDays: this.#config.hostIdleRetentionDays,
      grantAfterExpiryDays: this.#config.grantRetentionAfterExpiryDays,
      revocationDays: this.#config.revocationRetentionDays,
      inviteAfterUseDays: this.#config.inviteRetentionAfterUseDays,
    });
    this.#logger.info("purged", { ...result });
  }

  #heartbeat(): void {
    for (const [ws, liveness] of this.#liveness) {
      if (!liveness.alive) {
        liveness.onTimeout();
        continue;
      }
      liveness.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  #track(ws: WebSocket, onTimeout: () => void): void {
    const liveness: Liveness = { alive: true, onTimeout };
    this.#liveness.set(ws, liveness);
    ws.on("pong", () => {
      liveness.alive = true;
    });
    ws.once("close", () => this.#liveness.delete(ws));
  }

  /**
   * How the relay treats a host right now: its weight (age and monthly quota, then squeezed
   * further when the relay as a whole is short of egress) and its ceiling in degraded mode.
   * Kept for 30 seconds, and dropped whenever the traffic level changes.
   */
  #policy(hostId: string): HostPolicy & { baseWeight: number } {
    const now = this.#now();
    const cached = this.#policies.get(hostId);
    if (cached && cached.until > now) return cached;
    const config = this.#config;
    const host = this.store.getHost(hostId);
    let baseWeight = 1;
    if (host && Math.floor(now / DAY_MS) - host.registeredDay < config.newHostAgeDays) {
      baseWeight = config.newHostWeight;
    }
    const overQuota = this.#usage.monthBytes(hostId) > config.monthlyQuotaBytes;
    if (overQuota) baseWeight *= config.overQuotaWeight;
    const policy = {
      ...this.#traffic.policyFor(baseWeight, overQuota),
      baseWeight,
      until: now + 30_000,
    };
    this.#policies.set(hostId, policy);
    return policy;
  }

  #onRequest(req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse): void {
    this.#route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, error.body);
        return;
      }
      this.#logger.error("request-failed", { code: errorCode(error) });
      if (!res.headersSent) sendJson(res, 500, JSON.stringify({ error: "internal" }));
      else res.destroy();
    });
  }

  async #route(req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/health") {
      if (!this.store.ping()) throw new HttpError(503, JSON.stringify({ ok: false }));
      sendJson(res, 200, JSON.stringify({ ok: true }));
      return;
    }
    if (method === "GET" && path === "/.well-known/k3-relay") {
      sendJson(
        res,
        200,
        JSON.stringify({
          name: "k3-relay",
          protocol: 1,
          gitCommit: this.#config.gitCommit,
          imageDigest: this.#config.imageDigest,
          schemaHash: SCHEMA_HASH,
          limits: publicLimits(this.#config),
          ...(this.#accounts
            ? {
                accounts: {
                  providers: this.#accounts.providerKinds(),
                  issuer: this.#accounts.issuer,
                  key: base64url(this.#accounts.tokens.publicKey),
                },
              }
            : {}),
        }),
      );
      return;
    }
    if (method === "GET" && path === "/metrics") {
      if (!this.#isLocalRequest(req))
        throw new HttpError(404, JSON.stringify({ error: "not-found" }));
      sendJson(res, 200, JSON.stringify(this.metrics.snapshot()));
      return;
    }

    const key = this.#clientKey(req);
    if (method === "POST" && path === "/v1/hosts") {
      this.#admitRequest(key);
      await this.#register(req, res, key);
      return;
    }
    if (method === "POST" && path === "/v1/grants/revoke") {
      this.#admitRequest(key);
      await this.#revokeOverHttp(req, res);
      return;
    }
    const status = STATUS_PATH.exec(path);
    if (method === "POST" && status?.[1]) {
      this.#admitRequest(key);
      await this.#status(req, res, status[1]);
      return;
    }
    if (path.startsWith("/v1/account/") && this.#accounts) {
      await this.#accountRoute(this.#accounts, req, res, method, path, key);
      return;
    }
    throw new HttpError(404, JSON.stringify({ error: "not-found" }));
  }

  /** Accounts (spec section 20). Only reached when at least one provider is configured. */
  async #accountRoute(
    accounts: AccountService,
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
    method: string,
    path: string,
    key: string,
  ): Promise<void> {
    const notFound = () => new HttpError(404, JSON.stringify({ error: "not-found" }));
    const wrap = async (work: () => Promise<void>) => {
      try {
        await work();
      } catch (error) {
        if (error instanceof AccountHttpError) throw new HttpError(error.status, error.body);
        throw error;
      }
    };
    if (method === "GET" && path === "/v1/account/providers") {
      sendJson(res, 200, JSON.stringify({ providers: accounts.providerKinds() }));
      return;
    }
    const oauth = ACCOUNT_OAUTH_PATH.exec(path);
    if (oauth) {
      const [, provider = "", step] = oauth;
      if (!accounts.hasProvider(provider)) throw notFound();
      if (step === "start" && method === "POST") {
        this.#admitRequest(key);
        const body = await this.#readJson(req);
        await wrap(async () => {
          const authorizeUrl = accounts.start(provider, body, key);
          sendJson(res, 200, JSON.stringify({ authorizeUrl }));
        });
        return;
      }
      if (step === "callback" && method === "GET") {
        this.#admitRequest(key);
        const query = new URL(req.url ?? "/", "http://relay.invalid").searchParams;
        const result = await accounts.callback(provider, query);
        if (result.kind === "redirect") {
          res.writeHead(302, {
            Location: result.location,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          });
          res.end();
        } else {
          res.writeHead(400, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          });
          res.end("Sign-in failed. Go back to K3 Code and try again.\n");
        }
        return;
      }
      throw notFound();
    }
    if (method === "POST" && path === "/v1/account/token") {
      this.#admitRequest(key);
      const body = await this.#readJson(req);
      await wrap(async () => sendJson(res, 200, JSON.stringify(accounts.redeem(body))));
      return;
    }
    const params = ACCOUNT_API_PATHS[path];
    if (method !== "POST" || params === undefined) throw notFound();
    this.#admitRequest(key);
    const body = await this.#readJson(req);
    await wrap(async () => {
      const caller = accounts.authenticate(path, body, params);
      sendJson(res, 200, JSON.stringify(this.#accountCall(accounts, path, caller)));
    });
  }

  #accountCall(
    accounts: AccountService,
    path: string,
    caller: ReturnType<AccountService["authenticate"]>,
  ): Record<string, unknown> {
    const forbidden = () => new AccountHttpError(403, "forbidden");
    const day = Math.floor(this.#now() / DAY_MS);
    switch (path) {
      case "/v1/account/hosts": {
        // A host's own session (from the host's sign-in) registers it; only devices list hosts.
        if (caller.use !== "device") throw forbidden();
        const hosts = this.store
          .accountHostIds(caller.accountId)
          .map((hostId) => this.store.getHost(hostId))
          .filter((host) => host !== undefined)
          .map((host) => ({ hostId: host.hostId, hk: base64url(host.hk) }));
        return { hosts };
      }
      case "/v1/account/hosts/add": {
        if (caller.use !== "host") throw forbidden();
        const hostId = caller.boundId;
        if (!this.store.getHost(hostId)) throw new AccountHttpError(409, "host-not-registered");
        if (
          !this.store.accountHasHost(caller.accountId, hostId) &&
          this.store.accountHostCount(caller.accountId) >= this.#config.maxHostsPerAccount
        ) {
          throw new AccountHttpError(429, "limit");
        }
        this.store.addAccountHost(caller.accountId, hostId, day);
        return { hostId };
      }
      case "/v1/account/hosts/remove": {
        const [hostId = ""] = caller.values;
        if (!isId(hostId)) throw new AccountHttpError(400, "bad-request");
        // A host can take itself off the list; a device can take any host off its own list.
        if (caller.use === "host" && hostId !== caller.boundId) throw forbidden();
        this.store.removeAccountHost(caller.accountId, hostId);
        return { ok: true };
      }
      case "/v1/account/hosts/token": {
        if (caller.use !== "device") throw forbidden();
        const [hostId = "", dalg = "", dk = "", dsig = ""] = caller.values;
        const host = isId(hostId) ? this.store.getHost(hostId) : undefined;
        if (!host || !this.store.accountHasHost(caller.accountId, hostId)) {
          throw new AccountHttpError(404, "not-found");
        }
        if (!isDeviceAlg(dalg)) throw new AccountHttpError(400, "bad-request");
        const deviceKey = decodeBase64url(dk, keyLength(dalg));
        const deviceSig = decodeBase64url(dsig, signatureLength);
        // The device key the ticket names must have signed for this host itself.
        if (
          !deviceKey ||
          !deviceSig ||
          !verifySignature(dalg, deviceKey, bindSigningInput(hostId, caller.boundId), deviceSig)
        ) {
          throw new AccountHttpError(401, "unauthorized");
        }
        const ticket = accounts.hostToken(caller.accountId, hostId, deviceIdOf(dalg, deviceKey));
        return { ...ticket, hostId, hk: base64url(host.hk) };
      }
      case "/v1/account/delete": {
        this.store.deleteAccount(caller.accountId);
        return { ok: true };
      }
    }
    throw new AccountHttpError(404, "not-found");
  }

  /** `/metrics` is for the machine itself. A proxied request always carries forwarding headers. */
  #isLocalRequest(req: NodeHttp.IncomingMessage): boolean {
    const address = req.socket.remoteAddress ?? "";
    const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
    const proxied =
      req.headers["x-forwarded-for"] !== undefined ||
      req.headers.forwarded !== undefined ||
      req.headers["x-real-ip"] !== undefined;
    return loopback && !proxied;
  }

  #admitRequest(key: string): void {
    if (!this.#preAuth.hit(key)) {
      this.metrics.rejections += 1;
      throw new HttpError(429, JSON.stringify({ error: "rate-limited" }));
    }
  }

  async #readJson(req: NodeHttp.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, JSON.stringify({ error: "too-large" }));
      chunks.push(chunk as Buffer);
    }
    const body = parseJsonObject(Buffer.concat(chunks));
    if (!body) throw new HttpError(400, JSON.stringify({ error: "bad-request" }));
    return body;
  }

  #powDifficulty(): number {
    const config = this.#config;
    const busy = this.#recentRegistrations.count("all") > config.powLoadThresholdPerMinute;
    return Math.min(32, config.powBaseDifficulty + (busy ? config.powLoadExtraDifficulty : 0));
  }

  async #register(
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
    key: string,
  ): Promise<void> {
    const body = await this.#readJson(req);
    const hk = decodeBase64url(body.hk, 32);
    if (!hk) throw new HttpError(400, JSON.stringify({ error: "bad-request" }));
    const now = this.#now();

    if (body.challenge === undefined) {
      const challenge = issueChallenge(this.#powSecret, hk, now, this.#powDifficulty());
      sendJson(res, 428, JSON.stringify({ error: "pow-required", challenge }));
      return;
    }

    if (this.#registrationsByIp.count(key) >= this.#config.registrationsPerIpPerDay) {
      this.metrics.rejections += 1;
      throw new HttpError(429, JSON.stringify({ error: "rate-limited" }));
    }
    const check: ChallengeCheck = checkSolution(
      this.#powSecret,
      hk,
      body.challenge,
      body.nonce,
      now,
      this.#config.powTtlMs,
    );
    if (!check.ok) {
      throw new HttpError(
        check.reason === "malformed" ? 400 : 403,
        JSON.stringify({ error: `pow-${check.reason}` }),
      );
    }
    const sig = decodeBase64url(body.sig, signatureLength);
    if (
      !sig ||
      typeof body.nonce !== "string" ||
      !verifySignature("ed25519", hk, registrationSigningInput(hk, check.mac, body.nonce), sig)
    ) {
      throw new HttpError(401, UNAUTHORIZED_BODY);
    }
    if (!this.#powUsed.add(check.mac, this.#config.powTtlMs * 2)) {
      throw new HttpError(409, JSON.stringify({ error: "pow-replayed" }));
    }

    const hostId = hostIdOf(hk);
    if (this.store.getHost(hostId)) {
      sendJson(res, 200, JSON.stringify({ hostId }));
      return;
    }
    if (this.#config.requireInvite) {
      const invite = typeof body.invite === "string" ? body.invite : "";
      const hash = NodeCrypto.createHash("sha256").update(invite).digest();
      if (invite === "" || !this.store.consumeInvite(hash, now)) {
        throw new HttpError(403, JSON.stringify({ error: "invite-required" }));
      }
    }
    if (this.store.hostCount() >= this.#config.maxHosts) {
      throw new HttpError(503, JSON.stringify({ error: "full" }));
    }
    this.store.insertHost(hostId, hk, Math.floor(now / DAY_MS));
    this.#registrationsByIp.tryHit(key);
    this.#recentRegistrations.tryHit("all");
    sendJson(res, 201, JSON.stringify({ hostId }));
  }

  async #revokeOverHttp(
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
  ): Promise<void> {
    const body = await this.#readJson(req);
    if (!hasExactKeys(body, ["hostId", "deviceId", "issuedAt", "sig"]) || !isId(body.hostId)) {
      throw new HttpError(401, UNAUTHORIZED_BODY);
    }
    if (!this.#applyRevocation(body.hostId, body.deviceId, body.issuedAt, body.sig)) {
      throw new HttpError(401, UNAUTHORIZED_BODY);
    }
    sendJson(res, 200, JSON.stringify({ ok: true }));
  }

  /** Verifies the host's signature and records the revocation. Returns false when invalid. */
  #applyRevocation(hostId: string, deviceId: unknown, issuedAt: unknown, sig: unknown): boolean {
    const now = this.#now();
    const signature = decodeBase64url(sig, signatureLength);
    const parsed =
      isId(deviceId) && typeof issuedAt === "number" && Number.isSafeInteger(issuedAt) && signature
        ? { deviceId, issuedAt, signature }
        : null;
    const host = this.store.getHost(hostId);
    const verified = verifySignature(
      "ed25519",
      host?.hk ?? DUMMY_HK,
      revokeSigningInput(hostId, parsed?.deviceId ?? "", parsed?.issuedAt ?? 0),
      parsed?.signature ?? Buffer.alloc(signatureLength),
    );
    if (!host || !parsed || !verified) return false;
    if (Math.abs(now - parsed.issuedAt) > REVOKE_SKEW_MS) return false;
    this.store.upsertRevocation(
      hostId,
      parsed.deviceId,
      parsed.issuedAt,
      parsed.signature.toString("base64url"),
      now,
    );
    for (const session of this.#hostSessions.get(hostId) ?? []) {
      if (session.deviceId === parsed.deviceId) {
        this.#endSession(session, "revoked", CLOSE.revoked, "revoked");
      }
    }
    return true;
  }

  async #status(
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
    hostId: string,
  ): Promise<void> {
    const body = await this.#readJson(req);
    const fail = () => {
      throw new HttpError(401, UNAUTHORIZED_BODY);
    };
    if (!hasExactKeys(body, ["alg", "dk", "grant", "ts", "nonce", "sig"])) return fail();
    const { alg, ts, nonce } = body;
    if (!isDeviceAlg(alg)) return fail();
    const dk = decodeBase64url(body.dk, keyLength(alg));
    const sig = decodeBase64url(body.sig, signatureLength);
    if (!dk || !sig || typeof ts !== "number" || !Number.isSafeInteger(ts)) return fail();
    if (typeof nonce !== "string" || !CLIENT_NONCE.test(nonce)) return fail();

    if (!this.#statusLimit.tryHit(deviceIdOf(alg, dk))) {
      this.metrics.rejections += 1;
      throw new HttpError(429, JSON.stringify({ error: "rate-limited" }));
    }
    const check = this.#checkDevice(
      hostId,
      alg,
      dk,
      body.grant,
      (deviceId) => signingInput(LABELS.status, hostId, deviceId, String(ts), nonce),
      sig,
    );
    const fresh = Math.abs(this.#now() - ts) <= this.#config.statusMaxSkewMs;
    if (check.kind === "unauthorized" || !fresh) return fail();
    if (
      !this.#statusNonces.add(`${check.deviceId}:${nonce}`, this.#config.statusMaxSkewMs * 2 + 1000)
    ) {
      return fail();
    }
    if (check.kind === "revoked") {
      throw new HttpError(403, JSON.stringify({ error: "revoked" }));
    }
    if (check.kind === "expired") {
      throw new HttpError(403, JSON.stringify({ error: "grant-expired" }));
    }
    sendJson(
      res,
      200,
      JSON.stringify({
        online: this.#controls.has(hostId),
        state: this.#hostState(hostId),
        month: {
          bytes: this.#usage.monthBytes(hostId),
          limit: this.#config.monthlyQuotaBytes,
        },
      }),
    );
  }

  /** What a device may tell its user about why the relay is slow for them, if it is. */
  #hostState(hostId: string): "ok" | "squeezed" | "blocked" {
    if (this.#blocked.has(hostId)) return "blocked";
    return this.#policy(hostId).squeezed ? "squeezed" : "ok";
  }

  /**
   * Device signature plus grant. Both signatures are always checked, whatever the host, so a
   * missing host, a bad signature and a bad grant all take the same path and come back as one
   * `unauthorized`. Revoked and expired are only told to a device that proved itself.
   */
  #checkDevice(
    hostId: string,
    alg: DeviceAlg,
    dk: Buffer,
    rawGrant: unknown,
    message: (deviceId: string) => Buffer,
    sig: Buffer,
  ): DeviceCheck {
    const host = this.store.getHost(hostId);
    const deviceId = deviceIdOf(alg, dk);
    const signatureOk = verifySignature(alg, dk, message(deviceId), sig);
    const grant = parseGrant(rawGrant);
    const grantOk = grant !== null && verifyGrantSignature(grant, host?.hk ?? DUMMY_HK);
    if (
      !host ||
      !signatureOk ||
      !grant ||
      !grantOk ||
      grant.hostId !== hostId ||
      grant.deviceId !== deviceId ||
      grant.alg !== alg
    ) {
      return { kind: "unauthorized" };
    }
    const now = this.#now();
    if (grant.issuedAt > now + GRANT_FUTURE_SKEW_MS) return { kind: "unauthorized" };
    const revokedAt = this.store.getRevokedAt(hostId, deviceId);
    if (revokedAt !== undefined && grant.issuedAt <= revokedAt)
      return { kind: "revoked", deviceId };
    if (grant.expiresAt <= now) return { kind: "expired", deviceId };
    return { kind: "ok", deviceId, grant };
  }

  #onUpgrade(req: NodeHttp.IncomingMessage, socket: NodeStream.Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    if (this.#closing) return rejectUpgrade(socket, 503, "Service Unavailable");
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://relay.invalid");
    } catch {
      return rejectUpgrade(socket, 400, "Bad Request");
    }
    const path = url.pathname;
    const dataMatch = DATA_PATH.exec(path);
    const clientMatch = HOST_ID_PATH.exec(path);
    if (path !== "/v1/host/control" && !dataMatch && !clientMatch) {
      return rejectUpgrade(socket, 404, "Not Found");
    }

    const release = this.#preAuth.admit(this.#clientKey(req));
    if (!release) {
      this.metrics.rejections += 1;
      return rejectUpgrade(socket, 429, "Too Many Requests");
    }
    socket.once("close", release);

    if (path === "/v1/host/control") {
      if (this.#controls.size >= this.#config.maxControlConnections) {
        this.metrics.rejections += 1;
        return rejectUpgrade(socket, 503, "Service Unavailable");
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onControlSocket(ws, release));
      return;
    }

    if (dataMatch?.[1]) {
      const session = this.#sessions.get(dataMatch[1]);
      const token = decodeBase64url(url.searchParams.get("t") ?? "", 16);
      if (!session || !token || !this.#acceptDataToken(session, token)) {
        return rejectUpgrade(socket, 401, "Unauthorized");
      }
      release();
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onDataSocket(ws, session));
      return;
    }

    const hostId = clientMatch?.[1];
    if (!hostId) return rejectUpgrade(socket, 404, "Not Found");
    if (url.searchParams.get("account") === "1") {
      const accounts = this.#accounts;
      if (!accounts || this.#blocked.has(hostId) || !this.store.getHost(hostId)) {
        return rejectUpgrade(socket, 404, "Not Found");
      }
      if (!this.#accountAdmissions.tryHit(hostId)) {
        this.metrics.rejections += 1;
        return rejectUpgrade(socket, 429, "Too Many Requests");
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) =>
        this.#onAccountSocket(ws, accounts, hostId, release),
      );
      return;
    }
    if (url.searchParams.get("pairing") === "1") {
      const admission = this.#pairingAdmission(hostId);
      if (admission !== "ok") {
        this.metrics.rejections += 1;
        return admission === "limit"
          ? rejectUpgrade(socket, 429, "Too Many Requests")
          : rejectUpgrade(socket, 404, "Not Found");
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) =>
        this.#onPairingSocket(ws, hostId, release),
      );
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onClientSocket(ws, hostId, release));
  }

  /** Single use: the token is spent the first time it is presented correctly. */
  #acceptDataToken(session: Session, token: Buffer): boolean {
    if (session.ended || session.tokenSpent || session.splice) return false;
    if (this.#now() > session.tokenExpiresAt) return false;
    if (!NodeCrypto.timingSafeEqual(session.token, token)) return false;
    session.tokenSpent = true;
    return true;
  }

  #pairingAdmission(hostId: string): "ok" | "closed" | "limit" {
    const now = this.#now();
    const state = this.#pairing.get(hostId);
    if (this.#blocked.has(hostId)) return "closed";
    if (!this.#controls.has(hostId) || !state || state.expiresAt <= now) return "closed";
    state.attempts = state.attempts.filter((at) => at > now - HOUR_MS);
    if (state.active >= this.#config.pairingMaxConcurrent) return "limit";
    if (state.attempts.length >= this.#config.pairingAttemptsPerHour) return "limit";
    return "ok";
  }

  #onControlSocket(ws: WebSocket, release: () => void): void {
    this.#webSockets.add(ws);
    ws.on("error", () => {});
    ws.once("close", () => {
      this.#webSockets.delete(ws);
      release();
    });
    const nonce = NodeCrypto.randomBytes(NONCE_BYTES);
    const timer = setTimeout(
      () => this.#closeEarly(ws, CLOSE.timeout, "timeout", "auth-timeout"),
      this.#config.authTimeoutMs,
    );
    ws.once("close", () => clearTimeout(timer));
    ws.send(JSON.stringify({ type: "nonce", nonce: base64url(nonce) }));

    let control: Control | null = null;
    let answered = false;
    ws.on("message", (data, isBinary) =>
      this.#guard(ws, () => {
        if (control) {
          this.#onControlMessage(control, data, isBinary);
          return;
        }
        if (answered) return this.#closeEarly(ws, CLOSE.badRequest, "bad-request", "auth-failed");
        answered = true;
        clearTimeout(timer);
        const hostId = this.#authenticateControl(data, isBinary, nonce);
        if (!hostId) return this.#closeEarly(ws, CLOSE.unauthorized, "unauthorized", "auth-failed");
        if (this.#blocked.has(hostId)) {
          return this.#closeEarly(ws, CLOSE.blocked, "blocked", "blocked");
        }
        control = this.#adoptControl(ws, hostId);
        release();
      }),
    );
  }

  #authenticateControl(data: RawData, isBinary: boolean, nonce: Buffer): string | null {
    const text = isMessageText(data, isBinary);
    const body = text ? parseJsonObject(text) : null;
    const claimed = body && hasExactKeys(body, ["type", "hostId", "sig"]) ? body : null;
    const sig = decodeBase64url(claimed?.sig, signatureLength);
    const hostId =
      claimed && claimed.type === "auth" && isId(claimed.hostId) ? claimed.hostId : null;
    const host = hostId ? this.store.getHost(hostId) : undefined;
    const ok = verifySignature(
      "ed25519",
      host?.hk ?? DUMMY_HK,
      signingInput(LABELS.hostControl, hostId ?? "", nonce),
      sig ?? Buffer.alloc(signatureLength),
    );
    return host && hostId && sig && ok ? hostId : null;
  }

  #adoptControl(ws: WebSocket, hostId: string): Control {
    if (!setMaxPayload(ws, this.#config.controlMaxPayload)) {
      return { hostId, ws, accounted: true, messages: new SlidingWindow(MINUTE_MS, 0, this.#now) };
    }
    const previous = this.#controls.get(hostId);
    const control: Control = {
      hostId,
      ws,
      accounted: false,
      messages: new SlidingWindow(MINUTE_MS, this.#config.controlMessagesPerMinute, this.#now),
    };
    this.#controls.set(hostId, control);
    if (previous) {
      previous.accounted = true;
      this.metrics.recordDisconnect("replaced");
      previous.ws.close(CLOSE.replaced, "replaced");
    }
    this.store.touchHost(hostId, Math.floor(this.#now() / DAY_MS));
    this.#track(ws, () => {
      this.metrics.recordDisconnect("ping-timeout");
      control.accounted = true;
      ws.terminate();
    });
    ws.once("close", () => {
      if (this.#controls.get(hostId) === control) {
        this.#controls.delete(hostId);
        const state = this.#pairing.get(hostId);
        if (state) state.expiresAt = 0;
        for (const session of this.#hostSessions.get(hostId) ?? []) {
          if (!session.splice) {
            this.#endSession(session, "host-offline", CLOSE.hostOffline, "host-offline");
          }
        }
      }
      if (!control.accounted) this.metrics.recordDisconnect("normal");
    });
    ws.send(JSON.stringify({ type: "ready" }));
    return control;
  }

  #onControlMessage(control: Control, data: RawData, isBinary: boolean): void {
    const text = isMessageText(data, isBinary);
    const body = text ? parseJsonObject(text) : null;
    if (!control.messages.tryHit("messages")) {
      this.metrics.rejections += 1;
      return this.#closeControl(control, CLOSE.limit, "limit");
    }
    if (!body || typeof body.type !== "string") {
      return this.#closeControl(control, CLOSE.badRequest, "bad-request");
    }
    switch (body.type) {
      case "pairing-open": {
        const requested = body.expiresAt;
        if (typeof requested !== "number" || !Number.isSafeInteger(requested)) {
          return this.#closeControl(control, CLOSE.badRequest, "bad-request");
        }
        const now = this.#now();
        const state = this.#pairing.get(control.hostId) ?? {
          expiresAt: 0,
          attempts: [],
          active: 0,
        };
        state.expiresAt = Math.min(requested, now + this.#config.pairingWindowMaxMs);
        this.#pairing.set(control.hostId, state);
        return;
      }
      case "pairing-close": {
        const state = this.#pairing.get(control.hostId);
        if (state) state.expiresAt = 0;
        return;
      }
      case "grant-register":
        return this.#registerGrant(control, body);
      case "revoke": {
        const ok = this.#applyRevocation(control.hostId, body.deviceId, body.issuedAt, body.sig);
        if (!ok) control.ws.send(JSON.stringify({ type: "error", code: "invalid-revocation" }));
        return;
      }
      default:
        return this.#closeControl(control, CLOSE.badRequest, "bad-request");
    }
  }

  #registerGrant(control: Control, body: Record<string, unknown>): void {
    const reply = (code: string) => control.ws.send(JSON.stringify({ type: "error", code }));
    const grant = hasExactKeys(body, ["type", "grant", "dk"]) ? parseGrant(body.grant) : null;
    const host = this.store.getHost(control.hostId);
    if (!grant || !host || grant.hostId !== control.hostId) return reply("invalid-grant");
    const dk = decodeBase64url(body.dk, keyLength(grant.alg));
    if (!dk || deviceIdOf(grant.alg, dk) !== grant.deviceId) return reply("invalid-grant");
    if (!verifyGrantSignature(grant, host.hk)) return reply("invalid-grant");
    if (
      !this.store.hasGrant(control.hostId, grant.deviceId) &&
      this.store.grantCount(control.hostId) >= this.#config.maxGrantsPerHost
    ) {
      return reply("limit");
    }
    this.store.upsertGrant({
      hostId: grant.hostId,
      deviceId: grant.deviceId,
      dk,
      alg: grant.alg,
      grantJson: JSON.stringify(grant),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    });
  }

  #closeControl(control: Control, code: number, text: string): void {
    control.ws.close(code, text);
  }

  #closeEarly(ws: WebSocket, code: number, text: string, reason: DisconnectReason): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    this.metrics.recordDisconnect(reason);
    ws.close(code, text);
  }

  #onClientSocket(ws: WebSocket, hostId: string, release: () => void): void {
    this.#webSockets.add(ws);
    ws.on("error", () => {});
    ws.once("close", () => {
      this.#webSockets.delete(ws);
      release();
    });
    const nonce = NodeCrypto.randomBytes(NONCE_BYTES);
    const timer = setTimeout(
      () => this.#closeEarly(ws, CLOSE.timeout, "timeout", "auth-timeout"),
      this.#config.authTimeoutMs,
    );
    ws.once("close", () => clearTimeout(timer));
    ws.send(JSON.stringify({ type: "nonce", nonce: base64url(nonce) }));

    let answered = false;
    ws.on("message", (data, isBinary) =>
      this.#guard(ws, () => {
        if (answered) return this.#closeEarly(ws, CLOSE.badRequest, "bad-request", "auth-failed");
        answered = true;
        clearTimeout(timer);
        const verdict = this.#authenticateClient(hostId, nonce, data, isBinary);
        if (verdict.kind === "bad-request") {
          return this.#closeEarly(ws, CLOSE.badRequest, "bad-request", "auth-failed");
        }
        if (verdict.kind === "unauthorized") {
          return this.#closeEarly(ws, CLOSE.unauthorized, "unauthorized", "auth-failed");
        }
        if (verdict.kind === "revoked") {
          return this.#closeEarly(ws, CLOSE.revoked, "revoked", "revoked");
        }
        if (verdict.kind === "expired") {
          return this.#closeEarly(ws, CLOSE.grantExpired, "grant-expired", "auth-failed");
        }
        release();
        this.#openSession(ws, hostId, "client", verdict.deviceId);
      }),
    );
  }

  #authenticateClient(
    hostId: string,
    nonce: Buffer,
    data: RawData,
    isBinary: boolean,
  ): { kind: "bad-request" } | DeviceCheck {
    const text = isMessageText(data, isBinary);
    const body = text ? parseJsonObject(text) : null;
    if (
      !body ||
      !hasExactKeys(body, ["type", "alg", "dk", "grant", "sig"]) ||
      body.type !== "auth"
    ) {
      return { kind: "bad-request" };
    }
    const alg = body.alg;
    if (!isDeviceAlg(alg)) return { kind: "bad-request" };
    const dk = decodeBase64url(body.dk, keyLength(alg));
    const sig = decodeBase64url(body.sig, signatureLength);
    if (!dk || !sig) return { kind: "bad-request" };
    return this.#checkDevice(
      hostId,
      alg,
      dk,
      body.grant,
      (deviceId) => signingInput(LABELS.client, hostId, deviceId, nonce),
      sig,
    );
  }

  /**
   * `?account=1`: a device that signed in knocks on one of its account's hosts. The relay checks
   * the host-access ticket and the device's signature, then opens an anonymous E2E session like
   * pairing. The host checks the ticket again and asks its user (spec section 20.3).
   */
  #onAccountSocket(
    ws: WebSocket,
    accounts: AccountService,
    hostId: string,
    release: () => void,
  ): void {
    this.#webSockets.add(ws);
    ws.on("error", () => {});
    ws.once("close", () => {
      this.#webSockets.delete(ws);
      release();
    });
    const nonce = NodeCrypto.randomBytes(NONCE_BYTES);
    const timer = setTimeout(
      () => this.#closeEarly(ws, CLOSE.timeout, "timeout", "auth-timeout"),
      this.#config.authTimeoutMs,
    );
    ws.once("close", () => clearTimeout(timer));
    ws.send(JSON.stringify({ type: "nonce", nonce: base64url(nonce) }));
    let answered = false;
    ws.on("message", (data, isBinary) =>
      this.#guard(ws, () => {
        if (answered) return this.#closeEarly(ws, CLOSE.badRequest, "bad-request", "auth-failed");
        answered = true;
        clearTimeout(timer);
        const text = isMessageText(data, isBinary);
        const body = text ? parseJsonObject(text) : null;
        if (
          !body ||
          !hasExactKeys(body, ["type", "alg", "dk", "token", "sig"]) ||
          body.type !== "auth" ||
          !isDeviceAlg(body.alg)
        ) {
          return this.#closeEarly(ws, CLOSE.badRequest, "bad-request", "auth-failed");
        }
        const dk = decodeBase64url(body.dk, keyLength(body.alg));
        const sig = decodeBase64url(body.sig, signatureLength);
        const deviceId = dk ? deviceIdOf(body.alg, dk) : "";
        const signed =
          dk !== null &&
          sig !== null &&
          verifySignature(
            body.alg,
            dk,
            signingInput(ACCOUNT_LABELS.client, hostId, deviceId, nonce),
            sig,
          );
        if (!signed || !accounts.admits(body.token, hostId, deviceId)) {
          return this.#closeEarly(ws, CLOSE.unauthorized, "unauthorized", "auth-failed");
        }
        const waiting = [...(this.#hostSessions.get(hostId) ?? [])].filter(
          (session) => session.kind === "account",
        ).length;
        if (waiting >= this.#config.accountMaxConcurrentPerHost) {
          this.metrics.rejections += 1;
          return this.#closeEarly(ws, CLOSE.limit, "limit", "limit");
        }
        release();
        this.#openSession(ws, hostId, "account", deviceId);
      }),
    );
  }

  #onPairingSocket(ws: WebSocket, hostId: string, release: () => void): void {
    this.#webSockets.add(ws);
    ws.on("error", () => {});
    ws.once("close", () => {
      this.#webSockets.delete(ws);
      release();
    });
    release();
    const state = this.#pairing.get(hostId);
    if (state) state.attempts.push(this.#now());
    this.#openSession(ws, hostId, "pairing", null);
  }

  /** Creates the session for an accepted client, and tells the host to open its data socket. */
  #openSession(
    ws: WebSocket,
    hostId: string,
    kind: Session["kind"],
    deviceId: string | null,
  ): void {
    const config = this.#config;
    if (this.#blocked.has(hostId)) {
      return this.#closeEarly(ws, CLOSE.blocked, "blocked", "blocked");
    }
    const control = this.#controls.get(hostId);
    if (!control || control.ws.readyState !== WebSocket.OPEN) {
      return this.#closeEarly(ws, CLOSE.hostOffline, "host-offline", "host-offline");
    }
    const hostSessions = this.#hostSessions.get(hostId) ?? new Set<Session>();
    const deviceKey = `${hostId}:${deviceId ?? ""}`;
    const state = this.#pairing.get(hostId);
    if (
      this.#sessions.size >= config.maxSessions ||
      hostSessions.size >= config.maxSessionsPerHost ||
      (deviceId !== null &&
        (this.#deviceSessions.get(deviceKey) ?? 0) >= config.maxSessionsPerDevice) ||
      (kind === "pairing" && state && state.active >= config.pairingMaxConcurrent)
    ) {
      this.metrics.rejections += 1;
      return this.#closeEarly(ws, CLOSE.limit, "limit", "limit");
    }
    // Degraded mode (spec section 9): the lowest-priority hosts wait until the month turns.
    if (!this.#traffic.admitsNewSession(this.#policy(hostId).baseWeight)) {
      this.metrics.rejections += 1;
      return this.#closeEarly(ws, CLOSE.limit, "degraded", "degraded");
    }

    const token = NodeCrypto.randomBytes(16);
    const session: Session = {
      id: NodeCrypto.randomBytes(16).toString("hex"),
      hostId,
      kind,
      deviceId,
      token,
      tokenSpent: false,
      tokenExpiresAt: this.#now() + config.dataTokenTtlMs,
      client: ws,
      early: [],
      earlyBytes: 0,
      hostWs: null,
      splice: null,
      ended: false,
      setupTimer: null,
      lifetimeTimer: null,
    };
    this.#sessions.set(session.id, session);
    hostSessions.add(session);
    this.#hostSessions.set(hostId, hostSessions);
    if (deviceId !== null)
      this.#deviceSessions.set(deviceKey, (this.#deviceSessions.get(deviceKey) ?? 0) + 1);
    if (kind === "pairing" && state) state.active += 1;
    this.metrics.recordSessionOpened();

    if (!setMaxPayload(ws, config.postAuthMaxPayload)) {
      this.#finishSession(session, "error");
      return;
    }
    ws.removeAllListeners("message");
    ws.on("message", (data, isBinary) => {
      if (session.splice) return;
      session.earlyBytes += (data as Buffer).length;
      if (session.earlyBytes > MAX_EARLY_BYTES) {
        this.#endSession(session, "oversize", 1009, "too-large");
        return;
      }
      session.early.push({ data: data as Buffer, isBinary });
    });
    ws.once("close", () => {
      if (!session.splice) this.#endSession(session, "normal", 1000, "");
    });
    this.#track(ws, () => this.#endSession(session, "ping-timeout", 1001, "ping-timeout"));

    session.setupTimer = setTimeout(
      () => this.#endSession(session, "setup-timeout", CLOSE.timeout, "timeout"),
      config.sessionSetupMs,
    );
    session.setupTimer.unref();
    if (kind === "pairing" || kind === "account") {
      session.lifetimeTimer = setTimeout(
        () => this.#endSession(session, "normal", 1000, `${kind}-expired`),
        kind === "pairing" ? config.pairingSessionMaxMs : config.accountSessionMaxMs,
      );
      session.lifetimeTimer.unref();
    }

    control.ws.send(
      JSON.stringify({
        type: "session-open",
        sessionId: session.id,
        token: base64url(token),
        kind,
        ...(deviceId === null ? {} : { deviceId }),
      }),
    );
    ws.send(JSON.stringify({ type: "accepted" }));
  }

  #onDataSocket(ws: WebSocket, session: Session): void {
    this.#webSockets.add(ws);
    ws.on("error", () => {});
    ws.once("close", () => {
      this.#webSockets.delete(ws);
    });
    if (session.ended) {
      ws.close(1000, "closed");
      return;
    }
    if (!setMaxPayload(ws, this.#config.postAuthMaxPayload)) return;
    session.hostWs = ws;
    if (session.setupTimer) clearTimeout(session.setupTimer);
    session.setupTimer = null;
    this.#track(ws, () => this.#endSession(session, "ping-timeout", 1001, "ping-timeout"));

    const splice = new Splice(
      {
        config: this.#config,
        scheduler: this.#scheduler,
        throttle: this.#throttle,
        budget: this.#budget,
        usage: this.#usage,
        metrics: this.metrics,
        events: this.events,
        hostWeight: (hostId) => this.#policy(hostId).weight,
      },
      session.id,
      session.hostId,
      session.client,
      ws,
      (reason) => this.#finishSession(session, reason),
    );
    session.splice = splice;
    session.client.removeAllListeners("message");
    splice.start(session.early.splice(0));
    this.events.emit("spliced", { sessionId: session.id });
  }

  /** Ends a session from the relay's side. Safe to call more than once. */
  #endSession(session: Session, reason: DisconnectReason, code: number, text: string): void {
    if (session.ended) return;
    if (session.splice) {
      session.splice.end(reason, code, text);
      return;
    }
    this.#finishSession(session, reason);
    if (session.client.readyState === WebSocket.OPEN) session.client.close(code, text);
    if (session.hostWs && session.hostWs.readyState === WebSocket.OPEN) {
      session.hostWs.close(code, text);
    }
  }

  #finishSession(session: Session, reason: DisconnectReason): void {
    if (session.ended) return;
    session.ended = true;
    this.metrics.recordDisconnect(reason);
    if (session.setupTimer) clearTimeout(session.setupTimer);
    if (session.lifetimeTimer) clearTimeout(session.lifetimeTimer);
    this.#sessions.delete(session.id);
    const hostSessions = this.#hostSessions.get(session.hostId);
    hostSessions?.delete(session);
    if (hostSessions?.size === 0) this.#hostSessions.delete(session.hostId);
    if (session.deviceId !== null) {
      const key = `${session.hostId}:${session.deviceId}`;
      const remaining = (this.#deviceSessions.get(key) ?? 1) - 1;
      if (remaining <= 0) this.#deviceSessions.delete(key);
      else this.#deviceSessions.set(key, remaining);
    }
    if (session.kind === "pairing") {
      const state = this.#pairing.get(session.hostId);
      if (state) state.active = Math.max(0, state.active - 1);
    }
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
}
