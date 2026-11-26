// @effect-diagnostics nodeBuiltinImport:off -- the relay talks HTTP/2 to APNs and signs its JWTs natively.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import type { RelayConfig } from "./config.ts";

/**
 * The push gateway (spec §13, P4). It hands an envelope the host sealed to the device's `Nk` to
 * APNs or FCM as an opaque string: the relay cannot open it, keeps no copy, and logs neither the
 * envelope nor the token. A platform is off unless all of its credentials are configured.
 */

export type PushPlatform = "ios" | "ios-sandbox" | "android";
export const PUSH_PLATFORMS: ReadonlyArray<PushPlatform> = ["ios", "ios-sandbox", "android"];
export const isPushPlatform = (value: unknown): value is PushPlatform =>
  value === "ios" || value === "ios-sandbox" || value === "android";

/** `ok` delivered; `gone` the token is dead and must be dropped; the rest are worth a retry. */
export type PushResult = "ok" | "gone" | "unavailable" | "failed";

export interface ApnsCredentials {
  readonly keyId: string;
  readonly teamId: string;
  readonly privateKeyPem: string;
  readonly topic: string;
  readonly url: string;
  readonly sandboxUrl: string;
}

export interface FcmCredentials {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKeyPem: string;
  readonly url: string;
  readonly tokenUrl: string;
}

/** Tokens as APNs (hex) and FCM (a registration token) spell them. Anything else is refused. */
const APNS_TOKEN = /^[0-9a-fA-F]{64,200}$/u;
const FCM_TOKEN = /^[A-Za-z0-9_:-]{32,512}$/u;

export function isPushToken(platform: PushPlatform, token: unknown): token is string {
  return typeof token === "string" && (platform === "android" ? FCM_TOKEN : APNS_TOKEN).test(token);
}

/** The text iOS shows if the extension cannot open the envelope. Fixed, so it says nothing. */
const APNS_FALLBACK_ALERT = { title: "K3 Code", body: "New activity" };
const APNS_JWT_TTL_MS = 50 * 60_000;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const REQUEST_TIMEOUT_MS = 10_000;
const NOTIFICATION_TTL_SECONDS = 24 * 60 * 60;

const b64urlJson = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function signJwt(
  header: object,
  claims: object,
  key: NodeCrypto.KeyObject,
  alg: "ES256" | "RS256",
): string {
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const signature =
    alg === "ES256"
      ? NodeCrypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" })
      : NodeCrypto.sign("sha256", Buffer.from(input), key);
  return `${input}.${signature.toString("base64url")}`;
}

export interface PushGatewayOptions {
  readonly apns: ApnsCredentials | null;
  readonly fcm: FcmCredentials | null;
  readonly now: () => number;
  readonly fetch: typeof fetch;
  /** Only a platform and an HTTP status reach it: never a token, an id or the envelope. */
  readonly onUpstreamError: (platform: PushPlatform, status: number) => void;
}

export class PushGateway {
  readonly #apns: ApnsCredentials | null;
  readonly #fcm: FcmCredentials | null;
  readonly #apnsKey: NodeCrypto.KeyObject | null;
  readonly #fcmKey: NodeCrypto.KeyObject | null;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  readonly #onUpstreamError: PushGatewayOptions["onUpstreamError"];
  readonly #sessions = new Map<string, NodeHttp2.ClientHttp2Session>();
  #apnsJwt: { readonly token: string; readonly expiresAt: number } | null = null;
  #fcmAccess: { readonly token: string; readonly expiresAt: number } | null = null;

  constructor(options: PushGatewayOptions) {
    this.#apns = options.apns;
    this.#fcm = options.fcm;
    // A malformed key is a configuration error: fail at start, not at the first notification.
    this.#apnsKey = options.apns ? NodeCrypto.createPrivateKey(options.apns.privateKeyPem) : null;
    this.#fcmKey = options.fcm ? NodeCrypto.createPrivateKey(options.fcm.privateKeyPem) : null;
    this.#now = options.now;
    this.#fetch = options.fetch;
    this.#onUpstreamError = options.onUpstreamError;
  }

  get enabled(): boolean {
    return this.#apns !== null || this.#fcm !== null;
  }

  platforms(): PushPlatform[] {
    return PUSH_PLATFORMS.filter((platform) => this.supports(platform));
  }

  supports(platform: PushPlatform): boolean {
    return platform === "android" ? this.#fcm !== null : this.#apns !== null;
  }

  async send(platform: PushPlatform, token: string, envelope: string): Promise<PushResult> {
    if (!this.supports(platform)) return "unavailable";
    try {
      return platform === "android"
        ? await this.#sendFcm(token, envelope)
        : await this.#sendApns(platform === "ios-sandbox", token, envelope);
    } catch {
      this.#onUpstreamError(platform, 0);
      return "failed";
    }
  }

  close(): void {
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
  }

  #apnsToken(): string {
    const now = this.#now();
    if (this.#apnsJwt && this.#apnsJwt.expiresAt > now) return this.#apnsJwt.token;
    const apns = this.#apns!;
    const token = signJwt(
      { alg: "ES256", kid: apns.keyId },
      { iss: apns.teamId, iat: Math.floor(now / 1000) },
      this.#apnsKey!,
      "ES256",
    );
    this.#apnsJwt = { token, expiresAt: now + APNS_JWT_TTL_MS };
    return token;
  }

  #session(origin: string): NodeHttp2.ClientHttp2Session {
    const existing = this.#sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = NodeHttp2.connect(origin);
    session.on("error", () => this.#sessions.delete(origin));
    session.on("goaway", () => this.#sessions.delete(origin));
    session.on("close", () => this.#sessions.delete(origin));
    session.unref();
    this.#sessions.set(origin, session);
    return session;
  }

  async #sendApns(sandbox: boolean, token: string, envelope: string): Promise<PushResult> {
    const apns = this.#apns!;
    const body = JSON.stringify({
      aps: { alert: APNS_FALLBACK_ALERT, "mutable-content": 1, sound: "default" },
      k3: envelope,
    });
    const origin = sandbox ? apns.sandboxUrl : apns.url;
    const { status, reason } = await new Promise<{ status: number; reason: string }>(
      (resolve, reject) => {
        const request = this.#session(origin).request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${this.#apnsToken()}`,
          "apns-topic": apns.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(this.#now() / 1000) + NOTIFICATION_TTL_SECONDS),
          "content-type": "application/json",
        });
        request.setTimeout(REQUEST_TIMEOUT_MS, () =>
          request.close(NodeHttp2.constants.NGHTTP2_CANCEL),
        );
        let status = 0;
        const chunks: Buffer[] = [];
        request.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        request.on("data", (chunk: Buffer) => {
          if (chunks.reduce((total, part) => total + part.length, 0) < 4096) chunks.push(chunk);
        });
        request.on("end", () => {
          let reason = "";
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              reason?: unknown;
            };
            reason = typeof parsed.reason === "string" ? parsed.reason : "";
          } catch {
            reason = "";
          }
          resolve({ status, reason });
        });
        request.on("error", reject);
        // A cancelled or reset stream ends without "end"; whichever comes first settles it.
        request.on("close", () => resolve({ status, reason: "" }));
        request.end(body);
      },
    );
    if (status === 200) return "ok";
    // 410: the app is gone from the device. These two 400s mean the token can never work here.
    if (status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") {
      return "gone";
    }
    if (status === 403 && reason === "ExpiredProviderToken") this.#apnsJwt = null;
    this.#onUpstreamError(sandbox ? "ios-sandbox" : "ios", status);
    return "failed";
  }

  async #fcmAccessToken(): Promise<string | null> {
    const now = this.#now();
    if (this.#fcmAccess && this.#fcmAccess.expiresAt > now) return this.#fcmAccess.token;
    const fcm = this.#fcm!;
    const iat = Math.floor(now / 1000);
    const assertion = signJwt(
      { alg: "RS256", typ: "JWT" },
      { iss: fcm.clientEmail, scope: FCM_SCOPE, aud: fcm.tokenUrl, iat, exp: iat + 3600 },
      this.#fcmKey!,
      "RS256",
    );
    const response = await this.#fetch(fcm.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (!response.ok || typeof parsed?.access_token !== "string") {
      this.#onUpstreamError("android", response.status);
      return null;
    }
    const lifetime = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
    this.#fcmAccess = {
      token: parsed.access_token,
      expiresAt: now + Math.max(60, lifetime - 60) * 1000,
    };
    return parsed.access_token;
  }

  async #sendFcm(token: string, envelope: string): Promise<PushResult> {
    const fcm = this.#fcm!;
    const access = await this.#fcmAccessToken();
    if (access === null) return "failed";
    // Data only: the app's own service opens the envelope and builds the notification.
    const response = await this.#fetch(
      `${fcm.url}/v1/projects/${encodeURIComponent(fcm.projectId)}/messages:send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            data: { k3: envelope },
            android: { priority: "high", ttl: `${NOTIFICATION_TTL_SECONDS}s` },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (response.ok) {
      await response.body?.cancel();
      return "ok";
    }
    const parsed = (await response.json().catch(() => null)) as {
      error?: { status?: unknown; details?: ReadonlyArray<{ errorCode?: unknown }> };
    } | null;
    const unregistered =
      parsed?.error?.details?.some((detail) => detail.errorCode === "UNREGISTERED") === true ||
      (response.status === 404 && parsed?.error?.status === "NOT_FOUND");
    if (unregistered) return "gone";
    if (response.status === 401) this.#fcmAccess = null;
    this.#onUpstreamError("android", response.status);
    return "failed";
  }
}

export function createPushGateway(
  config: RelayConfig,
  options: Pick<PushGatewayOptions, "now" | "fetch" | "onUpstreamError">,
): PushGateway {
  return new PushGateway({ apns: config.apns, fcm: config.fcm, ...options });
}
