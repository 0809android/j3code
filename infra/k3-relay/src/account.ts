// @effect-diagnostics nodeBuiltinImport:off -- the relay signs and verifies with node:crypto.
import * as NodeCrypto from "node:crypto";

import { base32, base64url, decodeBase64url, lengthPrefixed } from "./bytes.ts";
import type { AccountProviderConfig, AccountProviderKind, RelayConfig } from "./config.ts";
import {
  deviceIdOf,
  hostIdOf,
  isDeviceAlg,
  isId,
  keyLength,
  signatureLength,
  verifySignature,
  type DeviceAlg,
} from "./crypto.ts";
import { ExpiringSet, SlidingWindow } from "./limits.ts";
import type { RelayStore } from "./store.ts";

/**
 * Accounts (spec section 20). The relay is the OAuth confidential client (BFF); an account is an
 * entrance and a host list, never a permission: the host decides, by asking its user (20.3).
 * Identity is GitHub's numeric `id` or the OIDC `sub`, stored only as an HMAC.
 */

export const ACCOUNT_LABELS = {
  token: "k3relay-v1/account-token",
  code: "k3relay-v1/account-code",
  request: "k3relay-v1/account-request",
  bind: "k3relay-v1/account-bind",
  client: "k3relay-v1/account-client",
  subject: "k3relay-v1/account-subject",
} as const;

export const ACCOUNT_TOKEN_PREFIX = "k3a1";
export const ACCOUNT_CALLBACK_PATH = "/k3relay/account/callback";
export const ACCOUNT_APP_REDIRECT = "k3relay://account/callback";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const ID_TOKEN_SKEW_MS = 60_000;
const ID_TOKEN_FUTURE_IAT_MS = 5 * MINUTE_MS;
const JWKS_TTL_MS = 60 * MINUTE_MS;
const JWKS_MIN_REFRESH_MS = MINUTE_MS;
const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_BODY = 64 * 1024;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const APP_STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const OIDC_ALGS: Record<"google" | "apple", ReadonlyArray<"RS256" | "ES256">> = {
  google: ["RS256"],
  apple: ["ES256", "RS256"],
};

export type AccountUse = "device" | "host";

export interface AccountSessionClaims {
  readonly v: 1;
  readonly typ: "session";
  readonly iss: string;
  readonly sub: string;
  /** The bound key's id: a deviceId for a device, the hostId for a host. */
  readonly kid: string;
  readonly use: AccountUse;
  readonly iat: number;
  readonly exp: number;
}

export interface AccountHostClaims {
  readonly v: 1;
  readonly typ: "host-access";
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly cnf: string;
  readonly iat: number;
  readonly exp: number;
}

export type AccountClaims = AccountSessionClaims | AccountHostClaims;

export class AccountHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, error: string) {
    super(error);
    this.status = status;
    this.body = JSON.stringify({ error });
  }
}

const unauthorized = () => new AccountHttpError(401, "unauthorized");
const invalidGrant = () => new AccountHttpError(400, "invalid-grant");

const sha256 = (data: Uint8Array | string): Buffer =>
  NodeCrypto.createHash("sha256").update(data).digest();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasExactKeys(record: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const actual = Object.keys(record).sort();
  const expected = keys.toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const timingSafeTextEqual = (a: string, b: string): boolean => {
  const left = sha256(a);
  const right = sha256(b);
  return NodeCrypto.timingSafeEqual(left, right) && a === b;
};

// ── Account tokens ────────────────────────────────────────────────────────────

/**
 * `k3a1.<payload>.<sig>`: the payload is JSON, the signature is Ed25519 over
 * `lp("k3relay-v1/account-token") ‖ lp(payload bytes)`. The key is the relay's account key,
 * published at `/.well-known/k3-relay` so hosts can check a device's ticket themselves.
 */
export class AccountTokens {
  readonly publicKey: Buffer;
  readonly #privateKey: NodeCrypto.KeyObject;

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error("the account token seed must be 32 bytes");
    // PKCS#8 for a raw Ed25519 seed.
    const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
    this.#privateKey = NodeCrypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    this.publicKey = Buffer.from(
      NodeCrypto.createPublicKey(this.#privateKey)
        .export({ type: "spki", format: "der" })
        .subarray(-32),
    );
  }

  sign(claims: AccountClaims): string {
    const payload = Buffer.from(JSON.stringify(claims), "utf8");
    const sig = NodeCrypto.sign(
      null,
      lengthPrefixed(ACCOUNT_LABELS.token, payload),
      this.#privateKey,
    );
    return `${ACCOUNT_TOKEN_PREFIX}.${base64url(payload)}.${base64url(sig)}`;
  }

  /** Signature, shape and expiry. Returns null for anything else. */
  verify(token: unknown, now: number): AccountClaims | null {
    if (typeof token !== "string" || token.length > 2048) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== ACCOUNT_TOKEN_PREFIX) return null;
    const payload = decodeBase64url(parts[1]);
    const sig = decodeBase64url(parts[2], signatureLength);
    if (!payload || !sig) return null;
    if (
      !verifySignature(
        "ed25519",
        this.publicKey,
        lengthPrefixed(ACCOUNT_LABELS.token, payload),
        sig,
      )
    )
      return null;
    const claims = parseAccountClaims(payload);
    if (!claims || claims.exp <= now || claims.iat > now + ID_TOKEN_FUTURE_IAT_MS) return null;
    return claims;
  }
}

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function parseAccountClaims(payload: Buffer): AccountClaims | null {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1 || typeof value.iss !== "string") return null;
  if (!isId(value.sub) || !isTime(value.iat) || !isTime(value.exp)) return null;
  if (value.typ === "session") {
    if (!hasExactKeys(value, ["v", "typ", "iss", "sub", "kid", "use", "iat", "exp"])) return null;
    if (!isId(value.kid) || (value.use !== "device" && value.use !== "host")) return null;
    return value as unknown as AccountSessionClaims;
  }
  if (value.typ === "host-access") {
    if (!hasExactKeys(value, ["v", "typ", "iss", "sub", "aud", "cnf", "iat", "exp"])) return null;
    if (!isId(value.aud) || !isId(value.cnf)) return null;
    return value as unknown as AccountHostClaims;
  }
  return null;
}

// ── OIDC id_token verification ────────────────────────────────────────────────

interface Jwk {
  readonly kid?: unknown;
  readonly kty?: unknown;
  readonly alg?: unknown;
  readonly use?: unknown;
}

/** A provider's key set, cached for an hour and re-read (at most once a minute) for a new `kid`. */
export class JwksCache {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #keys = new Map<string, { key: NodeCrypto.KeyObject; kty: string }>();
  #fetchedAt = 0;
  #inflight: Promise<void> | null = null;

  constructor(url: string, fetchImpl: typeof fetch, now: () => number) {
    this.#url = url;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async get(kid: string): Promise<{ key: NodeCrypto.KeyObject; kty: string } | null> {
    const now = this.#now();
    const fresh = now - this.#fetchedAt < JWKS_TTL_MS;
    const known = this.#keys.get(kid);
    if (known && fresh) return known;
    if (now - this.#fetchedAt >= JWKS_MIN_REFRESH_MS || this.#fetchedAt === 0) {
      this.#inflight ??= this.#refresh().finally(() => {
        this.#inflight = null;
      });
      await this.#inflight;
    }
    return this.#keys.get(kid) ?? null;
  }

  async #refresh(): Promise<void> {
    this.#fetchedAt = this.#now();
    const body = await fetchJson(this.#fetch, this.#url, { method: "GET" });
    const list = isRecord(body) && Array.isArray(body.keys) ? (body.keys as Jwk[]) : [];
    const next = new Map<string, { key: NodeCrypto.KeyObject; kty: string }>();
    for (const jwk of list) {
      if (!isRecord(jwk) || typeof jwk.kid !== "string" || (jwk.use ?? "sig") !== "sig") continue;
      if (jwk.kty !== "RSA" && jwk.kty !== "EC") continue;
      try {
        const key = NodeCrypto.createPublicKey({
          key: jwk as NodeCrypto.JsonWebKey,
          format: "jwk",
        });
        next.set(jwk.kid, { key, kty: jwk.kty });
      } catch {
        // A key we cannot read is a key we do not accept.
      }
    }
    if (next.size > 0) this.#keys = next;
  }
}

export interface IdTokenCheck {
  readonly issuers: ReadonlyArray<string>;
  readonly clientId: string;
  readonly nonce: string;
  readonly algs: ReadonlyArray<"RS256" | "ES256">;
  readonly now: number;
}

/**
 * Signature (RS256 / ES256 from the provider's key set; never `none`, never HMAC), `iss`, `aud`
 * (and `azp` when `aud` is a list), `exp`, `iat` and `nonce`. Returns the `sub`, or null.
 */
export async function verifyIdToken(
  idToken: unknown,
  jwks: JwksCache,
  check: IdTokenCheck,
): Promise<string | null> {
  if (typeof idToken !== "string" || idToken.length > 16 * 1024) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [headerPart = "", payloadPart = "", sigPart = ""] = parts;
  const header = parseJsonPart(headerPart);
  const payload = parseJsonPart(payloadPart);
  const sig = decodeBase64url(sigPart);
  if (!header || !payload || !sig) return null;
  const alg = header.alg;
  if ((alg !== "RS256" && alg !== "ES256") || !check.algs.includes(alg)) return null;
  if (typeof header.kid !== "string" || header.kid.length > 256) return null;
  const entry = await jwks.get(header.kid);
  if (!entry || entry.kty !== (alg === "RS256" ? "RSA" : "EC")) return null;
  const signed = Buffer.from(`${headerPart}.${payloadPart}`, "ascii");
  let valid = false;
  try {
    valid =
      alg === "RS256"
        ? NodeCrypto.verify("sha256", signed, entry.key, sig)
        : NodeCrypto.verify("sha256", signed, { key: entry.key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    valid = false;
  }
  if (!valid) return null;

  if (typeof payload.iss !== "string" || !check.issuers.includes(payload.iss)) return null;
  const aud = payload.aud;
  if (typeof aud === "string") {
    if (aud !== check.clientId) return null;
  } else if (Array.isArray(aud)) {
    if (!aud.includes(check.clientId) || payload.azp !== check.clientId) return null;
  } else {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= check.now - ID_TOKEN_SKEW_MS) {
    return null;
  }
  if (typeof payload.iat !== "number" || payload.iat * 1000 > check.now + ID_TOKEN_FUTURE_IAT_MS) {
    return null;
  }
  if (typeof payload.nonce !== "string" || !timingSafeTextEqual(payload.nonce, check.nonce)) {
    return null;
  }
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) return null;
  return sub;
}

function parseJsonPart(part: string): Record<string, unknown> | null {
  const bytes = decodeBase64url(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const text = await response.text();
  if (text.length > MAX_PROVIDER_BODY) throw new Error("provider answer too large");
  if (!response.ok) {
    const error = new Error("provider refused") as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return JSON.parse(text) as unknown;
}

// ── Flows ─────────────────────────────────────────────────────────────────────

interface BoundKey {
  readonly use: AccountUse;
  readonly alg: DeviceAlg;
  readonly key: Buffer;
  /** deviceId for a device, hostId for a host. */
  readonly id: string;
}

interface Flow {
  readonly provider: AccountProviderKind;
  readonly verifier: string;
  readonly nonce: string;
  readonly appChallenge: string;
  readonly appRedirect: string;
  readonly appState: string;
  readonly bound: BoundKey;
  readonly ipKey: string;
  readonly expiresAt: number;
}

interface IssuedCode {
  readonly accountId: string;
  readonly appChallenge: string;
  readonly appRedirect: string;
  readonly bound: BoundKey;
  readonly expiresAt: number;
}

export interface AccountServiceOptions {
  readonly config: RelayConfig;
  readonly store: RelayStore;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly onProviderError: (provider: AccountProviderKind, step: string) => void;
}

export type CallbackResult =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "failed" };

const LOOPBACK_REDIRECT =
  /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):([0-9]{1,5})\/k3relay\/account\/callback$/u;

/**
 * Where the relay may send the one-time code: the app's own scheme, a loopback listener on this
 * machine (RFC 8252; any port, a fixed path) and, for the browser client, exact addresses the
 * operator listed. A host may only use loopback: a code for a host has to come back to the
 * machine that asked for it.
 */
export function isAllowedAppRedirect(
  redirect: string,
  use: AccountUse,
  webRedirects: ReadonlyArray<string>,
): boolean {
  if (redirect.length > 512) return false;
  const loopback = LOOPBACK_REDIRECT.exec(redirect);
  if (loopback) {
    const port = Number(loopback[2]);
    return port > 0 && port < 65536;
  }
  if (use === "host") return false;
  return redirect === ACCOUNT_APP_REDIRECT || webRedirects.includes(redirect);
}

export class AccountService {
  readonly tokens: AccountTokens;
  readonly #config: RelayConfig;
  readonly #store: RelayStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #onProviderError: AccountServiceOptions["onProviderError"];
  readonly #providers: ReadonlyMap<AccountProviderKind, AccountProviderConfig>;
  readonly #jwks = new Map<AccountProviderKind, JwksCache>();
  readonly #hmacKey: Buffer;
  readonly #flows = new Map<string, Flow>();
  readonly #codes = new Map<string, IssuedCode>();
  readonly #starts: SlidingWindow;
  readonly #accountsByIp: SlidingWindow;
  readonly #requestNonces: ExpiringSet;

  constructor(options: AccountServiceOptions) {
    const { config } = options;
    this.#config = config;
    this.#store = options.store;
    this.#fetch = options.fetch;
    this.#now = options.now;
    this.#onProviderError = options.onProviderError;
    const seed = decodeBase64url(config.accountTokenSeed ?? "", 32);
    if (!seed || !config.accountHmacKey || !config.publicUrl) {
      throw new Error("accounts need a public URL, a token seed and an HMAC key");
    }
    this.tokens = new AccountTokens(seed);
    this.#hmacKey = sha256(config.accountHmacKey);
    this.#providers = new Map(config.accountProviders.map((p) => [p.kind, p]));
    for (const provider of config.accountProviders) {
      if (provider.jwksUrl) {
        this.#jwks.set(provider.kind, new JwksCache(provider.jwksUrl, options.fetch, options.now));
      }
    }
    this.#starts = new SlidingWindow(MINUTE_MS, config.accountStartsPerMinutePerIp, options.now);
    this.#accountsByIp = new SlidingWindow(DAY_MS, config.accountsPerIpPerDay, options.now);
    this.#requestNonces = new ExpiringSet(options.now);
  }

  get issuer(): string {
    return this.#config.publicUrl!;
  }

  providerKinds(): AccountProviderKind[] {
    return [...this.#providers.keys()];
  }

  hasProvider(kind: string): kind is AccountProviderKind {
    return this.#providers.has(kind as AccountProviderKind);
  }

  callbackUrl(kind: AccountProviderKind): string {
    return `${this.#config.publicUrl}/v1/account/oauth/${kind}/callback`;
  }

  sweep(): void {
    const now = this.#now();
    for (const [state, flow] of this.#flows) if (flow.expiresAt <= now) this.#flows.delete(state);
    for (const [hash, code] of this.#codes) if (code.expiresAt <= now) this.#codes.delete(hash);
    this.#starts.sweep();
    this.#accountsByIp.sweep();
    this.#requestNonces.sweep();
  }

  get pendingFlows(): number {
    return this.#flows.size;
  }

  // ── Start ───────────────────────────────────────────────────────────────────

  /**
   * `POST /v1/account/oauth/<provider>/start` with
   * `{use, alg, key, challenge, redirect, state}`. Returns the provider's authorization URL.
   */
  start(kind: AccountProviderKind, body: Record<string, unknown>, ipKey: string): string {
    const provider = this.#providers.get(kind);
    if (!provider) throw new AccountHttpError(404, "not-found");
    if (!hasExactKeys(body, ["use", "alg", "key", "challenge", "redirect", "state"])) {
      throw new AccountHttpError(400, "bad-request");
    }
    const { use, alg, challenge, redirect, state } = body;
    if ((use !== "device" && use !== "host") || !isDeviceAlg(alg)) {
      throw new AccountHttpError(400, "bad-request");
    }
    if (use === "host" && alg !== "ed25519") throw new AccountHttpError(400, "bad-request");
    const key = decodeBase64url(body.key, keyLength(alg));
    if (!key || typeof challenge !== "string" || !CHALLENGE_PATTERN.test(challenge)) {
      throw new AccountHttpError(400, "bad-request");
    }
    if (typeof state !== "string" || !APP_STATE_PATTERN.test(state)) {
      throw new AccountHttpError(400, "bad-request");
    }
    if (
      typeof redirect !== "string" ||
      !isAllowedAppRedirect(redirect, use, this.#config.accountWebRedirects)
    ) {
      throw new AccountHttpError(400, "redirect-not-allowed");
    }
    if (!this.#starts.tryHit(ipKey)) throw new AccountHttpError(429, "rate-limited");
    if (this.#flows.size >= this.#config.maxPendingAccountFlows) {
      this.sweep();
      if (this.#flows.size >= this.#config.maxPendingAccountFlows) {
        throw new AccountHttpError(503, "busy");
      }
    }
    const bound: BoundKey = {
      use,
      alg,
      key,
      id: use === "host" ? hostIdOf(key) : deviceIdOf(alg, key),
    };
    const relayState = base64url(NodeCrypto.randomBytes(32));
    const verifier = base64url(NodeCrypto.randomBytes(32));
    const nonce = base64url(NodeCrypto.randomBytes(24));
    this.#flows.set(relayState, {
      provider: kind,
      verifier,
      nonce,
      appChallenge: challenge,
      appRedirect: redirect,
      appState: state,
      bound,
      ipKey,
      expiresAt: this.#now() + this.#config.accountFlowTtlMs,
    });

    const url = new URL(provider.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("redirect_uri", this.callbackUrl(kind));
    url.searchParams.set("state", relayState);
    url.searchParams.set("code_challenge", base64url(sha256(verifier)));
    url.searchParams.set("code_challenge_method", "S256");
    if (kind === "github") {
      // No scope: the public profile is enough to read the numeric id, and no e-mail is asked for.
      url.searchParams.set("allow_signup", "true");
    } else {
      url.searchParams.set("scope", "openid");
      url.searchParams.set("nonce", nonce);
      if (kind === "google") url.searchParams.set("prompt", "select_account");
    }
    return url.toString();
  }

  // ── Callback ────────────────────────────────────────────────────────────────

  /**
   * `GET /v1/account/oauth/<provider>/callback`. The `state` is single use and belongs to one
   * provider; an `iss` parameter (RFC 9207) must name that provider. Every failure looks the
   * same to the browser.
   */
  async callback(kind: string, query: URLSearchParams): Promise<CallbackResult> {
    const state = query.get("state") ?? "";
    const flow = this.#flows.get(state);
    if (flow) this.#flows.delete(state);
    const provider = this.#providers.get(kind as AccountProviderKind);
    if (!flow || !provider || flow.provider !== kind || flow.expiresAt <= this.#now()) {
      return { kind: "failed" };
    }
    const iss = query.get("iss");
    if (iss !== null && !provider.issuers.includes(iss)) return { kind: "failed" };
    const back = new URL(flow.appRedirect);
    if (query.get("error") !== null) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("state", flow.appState);
      return { kind: "redirect", location: back.toString() };
    }
    const code = query.get("code");
    if (!code || code.length > 2048) return { kind: "failed" };

    let subject: string | null;
    try {
      subject = await this.#exchange(provider, flow, code);
    } catch {
      this.#onProviderError(provider.kind, "exchange");
      return { kind: "failed" };
    }
    if (subject === null) {
      this.#onProviderError(provider.kind, "verify");
      return { kind: "failed" };
    }

    const subjectMac = NodeCrypto.createHmac("sha256", this.#hmacKey)
      .update(lengthPrefixed(ACCOUNT_LABELS.subject, provider.kind, subject))
      .digest();
    let accountId = this.#store.findAccount(provider.kind, subjectMac);
    if (accountId === undefined) {
      if (!this.#accountsByIp.tryHit(flow.ipKey)) return { kind: "failed" };
      accountId = base32(NodeCrypto.randomBytes(20)).slice(0, 32);
      this.#store.createAccount(
        accountId,
        provider.kind,
        subjectMac,
        Math.floor(this.#now() / DAY_MS),
      );
    }
    const oneTime = base64url(NodeCrypto.randomBytes(32));
    this.#codes.set(sha256(oneTime).toString("hex"), {
      accountId,
      appChallenge: flow.appChallenge,
      appRedirect: flow.appRedirect,
      bound: flow.bound,
      expiresAt: this.#now() + this.#config.accountCodeTtlMs,
    });
    back.searchParams.set("code", oneTime);
    back.searchParams.set("state", flow.appState);
    return { kind: "redirect", location: back.toString() };
  }

  /** Returns the provider's stable subject: GitHub's numeric id, or the OIDC `sub`. */
  async #exchange(
    provider: AccountProviderConfig,
    flow: Flow,
    code: string,
  ): Promise<string | null> {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.callbackUrl(provider.kind),
      client_id: provider.clientId,
      client_secret: this.#clientSecret(provider),
      code_verifier: flow.verifier,
    });
    const answer = await fetchJson(this.#fetch, provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
    if (!isRecord(answer)) return null;

    if (provider.kind === "github") {
      const accessToken = answer.access_token;
      if (typeof accessToken !== "string" || accessToken.length === 0) return null;
      return this.#githubSubject(provider, accessToken);
    }
    const jwks = this.#jwks.get(provider.kind);
    if (!jwks) return null;
    return verifyIdToken(answer.id_token, jwks, {
      issuers: provider.issuers,
      clientId: provider.clientId,
      nonce: flow.nonce,
      algs: OIDC_ALGS[provider.kind],
      now: this.#now(),
    });
  }

  /**
   * GitHub has no OIDC. The token is checked against this app (`POST /applications/{id}/token`,
   * which also names the user), the numeric `id` is kept, and the token is revoked at once.
   * The login name is never used: GitHub lets it be renamed and reused.
   */
  async #githubSubject(
    provider: AccountProviderConfig,
    accessToken: string,
  ): Promise<string | null> {
    const url = `${provider.apiUrl}/applications/${encodeURIComponent(provider.clientId)}/token`;
    const headers = {
      authorization: `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret ?? ""}`).toString("base64")}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    };
    const body = JSON.stringify({ access_token: accessToken });
    try {
      const checked = await fetchJson(this.#fetch, url, { method: "POST", headers, body });
      if (!isRecord(checked) || !isRecord(checked.app) || !isRecord(checked.user)) return null;
      if (checked.app.client_id !== provider.clientId) return null;
      const id = checked.user.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
      return String(id);
    } finally {
      await this.#fetch(url, {
        method: "DELETE",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      }).then(
        (response) => response.body?.cancel(),
        () => this.#onProviderError(provider.kind, "revoke"),
      );
    }
  }

  /** Apple wants a short ES256 JWT, signed with the team's key, as its client secret. */
  #clientSecret(provider: AccountProviderConfig): string {
    if (provider.clientSecret !== null) return provider.clientSecret;
    const apple = provider.appleKey;
    if (!apple) throw new Error("no client secret");
    const iat = Math.floor(this.#now() / 1000);
    const header = base64url(Buffer.from(JSON.stringify({ alg: "ES256", kid: apple.keyId })));
    const payload = base64url(
      Buffer.from(
        JSON.stringify({
          iss: apple.teamId,
          iat,
          exp: iat + 300,
          aud: "https://appleid.apple.com",
          sub: provider.clientId,
        }),
      ),
    );
    const sig = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
      key: apple.privateKeyPem,
      dsaEncoding: "ieee-p1363",
    });
    return `${header}.${payload}.${base64url(sig)}`;
  }

  // ── Token ───────────────────────────────────────────────────────────────────

  /**
   * `POST /v1/account/token` with `{code, verifier, redirect, ts, sig}`. The code is spent on its
   * first presentation, right or wrong. `verifier` must hash to the app's challenge, `redirect`
   * must be the one the flow started with, and `sig` must come from the bound key.
   */
  redeem(body: Record<string, unknown>): { token: string; expiresAt: number; use: AccountUse } {
    if (!hasExactKeys(body, ["code", "verifier", "redirect", "ts", "sig"])) throw invalidGrant();
    const { code, verifier, redirect, ts } = body;
    if (typeof code !== "string" || code.length > 128) throw invalidGrant();
    const hash = sha256(code).toString("hex");
    const issued = this.#codes.get(hash);
    this.#codes.delete(hash);
    const now = this.#now();
    if (!issued || issued.expiresAt <= now) throw invalidGrant();
    if (typeof verifier !== "string" || !VERIFIER_PATTERN.test(verifier)) throw invalidGrant();
    if (!timingSafeTextEqual(base64url(sha256(verifier)), issued.appChallenge))
      throw invalidGrant();
    if (typeof redirect !== "string" || redirect !== issued.appRedirect) throw invalidGrant();
    if (!isTime(ts) || Math.abs(now - ts) > this.#config.statusMaxSkewMs) throw invalidGrant();
    const sig = decodeBase64url(body.sig, signatureLength);
    const message = lengthPrefixed(ACCOUNT_LABELS.code, code, String(ts));
    if (!sig || !verifySignature(issued.bound.alg, issued.bound.key, message, sig)) {
      throw invalidGrant();
    }
    if (!this.#store.accountExists(issued.accountId)) throw invalidGrant();
    const expiresAt = now + this.#config.accountTokenTtlMs;
    const token = this.tokens.sign({
      v: 1,
      typ: "session",
      iss: this.issuer,
      sub: issued.accountId,
      kid: issued.bound.id,
      use: issued.bound.use,
      iat: now,
      exp: expiresAt,
    });
    return { token, expiresAt, use: issued.bound.use };
  }

  // ── Signed account requests ─────────────────────────────────────────────────

  /**
   * Every account call carries `{token, alg, key, ts, nonce, sig, ...params}`: a session token
   * bound to `key`, and a signature by that key over the path, the token, the time, a one-time
   * nonce and the parameters in order. A stolen token alone does nothing.
   */
  authenticate(
    path: string,
    body: Record<string, unknown>,
    params: ReadonlyArray<string>,
  ): { accountId: string; use: AccountUse; boundId: string; values: string[] } {
    if (!hasExactKeys(body, ["token", "alg", "key", "ts", "nonce", "sig", ...params])) {
      throw unauthorized();
    }
    const now = this.#now();
    const claims = this.tokens.verify(body.token, now);
    if (!claims || claims.typ !== "session" || claims.iss !== this.issuer) throw unauthorized();
    const { alg, ts, nonce } = body;
    if (!isDeviceAlg(alg) || (claims.use === "host" && alg !== "ed25519")) throw unauthorized();
    const key = decodeBase64url(body.key, keyLength(alg));
    if (!key) throw unauthorized();
    const boundId = claims.use === "host" ? hostIdOf(key) : deviceIdOf(alg, key);
    if (boundId !== claims.kid) throw unauthorized();
    if (!isTime(ts) || Math.abs(now - ts) > this.#config.statusMaxSkewMs) throw unauthorized();
    if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) throw unauthorized();
    const values = params.map((name) => body[name]);
    if (
      !values.every((value): value is string => typeof value === "string" && value.length <= 1024)
    ) {
      throw unauthorized();
    }
    const sig = decodeBase64url(body.sig, signatureLength);
    const message = lengthPrefixed(
      ACCOUNT_LABELS.request,
      path,
      body.token as string,
      String(ts),
      nonce,
      ...values,
    );
    if (!sig || !verifySignature(alg, key, message, sig)) throw unauthorized();
    if (
      !this.#requestNonces.add(`${claims.kid}:${nonce}`, this.#config.statusMaxSkewMs * 2 + 1000)
    ) {
      throw unauthorized();
    }
    if (!this.#store.accountExists(claims.sub)) throw unauthorized();
    return { accountId: claims.sub, use: claims.use, boundId, values };
  }

  /** A ticket for one host, bound to the key the device will knock with. Device sessions only. */
  hostToken(
    accountId: string,
    hostId: string,
    deviceId: string,
  ): { token: string; expiresAt: number } {
    const now = this.#now();
    const expiresAt = now + this.#config.accountHostTokenTtlMs;
    const token = this.tokens.sign({
      v: 1,
      typ: "host-access",
      iss: this.issuer,
      sub: accountId,
      aud: hostId,
      cnf: deviceId,
      iat: now,
      exp: expiresAt,
    });
    return { token, expiresAt };
  }

  /**
   * The relay's entrance check for `?account=1`: a host-access ticket for this host, bound to
   * this device's key, from an account that still lists the host. The host checks the same
   * ticket again inside the E2E channel, and then asks its user.
   */
  admits(token: unknown, hostId: string, deviceId: string): boolean {
    const claims = this.tokens.verify(token, this.#now());
    return (
      claims !== null &&
      claims.typ === "host-access" &&
      claims.iss === this.issuer &&
      claims.aud === hostId &&
      claims.cnf === deviceId &&
      this.#store.accountHasHost(claims.sub, hostId)
    );
  }
}

/**
 * What a new device key signs to be named in a host ticket: the host, and the id of the key the
 * account session is bound to. Only the holder of both keys can ask for the ticket.
 */
export function bindSigningInput(hostId: string, sessionKeyId: string): Buffer {
  return lengthPrefixed(ACCOUNT_LABELS.bind, hostId, sessionKeyId);
}

export function accountRequestSigningInput(
  path: string,
  token: string,
  ts: number,
  nonce: string,
  values: ReadonlyArray<string>,
): Buffer {
  return lengthPrefixed(ACCOUNT_LABELS.request, path, token, String(ts), nonce, ...values);
}

export function accountCodeSigningInput(code: string, ts: number): Buffer {
  return lengthPrefixed(ACCOUNT_LABELS.code, code, String(ts));
}
