// @effect-diagnostics nodeBuiltinImport:off -- a fake OAuth / OIDC provider for tests, in plain Node.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import {
  ACCOUNT_APP_REDIRECT,
  accountCodeSigningInput,
  accountRequestSigningInput,
  bindSigningInput,
} from "./account.ts";
import { base64url } from "./bytes.ts";
import type { AccountProviderConfig, AccountProviderKind, RelayConfig } from "./config.ts";
import { deviceIdOf, hostIdOf } from "./crypto.ts";
import type { Signer, TestRelay } from "./relay.testkit.ts";

/**
 * A fake GitHub / Google / Apple in the same process. It behaves like the real ones where the
 * relay depends on them: the redirect URI must match exactly, codes are single use, PKCE is
 * checked, ID tokens are signed with a key from its JWKS, and GitHub's token check names the app.
 * Tests reach in to forge bad answers.
 */

export const PUBLIC_URL = "https://relay.test";
export const TEST_SEED = base64url(Buffer.alloc(32, 7));
export const TEST_HMAC_KEY = "test-hmac-key-0123456789abcdef-0123456789";

export interface FakeUser {
  /** GitHub: the numeric id. OIDC: the `sub`. */
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly login: string;
  readonly avatar: string;
}

interface PendingAuth {
  readonly provider: AccountProviderKind;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string | null;
  readonly user: FakeUser;
  used: boolean;
}

export interface FakeProvider {
  readonly origin: string;
  /** Who signs in at the next authorization. */
  user: FakeUser;
  /** Rewrites the ID token claims (and header) before signing, for forgeries. */
  forgeIdToken: ((claims: Record<string, unknown>, header: Record<string, unknown>) => void) | null;
  /** Signs the ID token with a key that is not in the JWKS. */
  signWithStrangerKey: boolean;
  /** GitHub's token check answers for another app. */
  githubAppClientId: string | null;
  /** Adds `iss` to the redirect (RFC 9207). */
  redirectIss: string | null;
  /** The provider's clock (ms), so ID tokens agree with the relay's test clock. */
  nowMs: () => number;
  readonly revokedTokens: string[];
  readonly tokenRequests: URLSearchParams[];
  /** What the relay sends to each endpoint, to prove the secrets travel only to the provider. */
  config(
    kind: AccountProviderKind,
    overrides?: Partial<AccountProviderConfig>,
  ): AccountProviderConfig;
  close(): Promise<void>;
}

const CLIENT_SECRETS: Record<AccountProviderKind, string> = {
  github: "gh-secret-DO-NOT-LOG",
  google: "google-secret-DO-NOT-LOG",
  apple: "",
};

export function appleTestKey(): { teamId: string; keyId: string; privateKeyPem: string } {
  const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const readBody = async (req: NodeHttp.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

export async function startFakeProvider(): Promise<FakeProvider> {
  const rsa = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const stranger = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pending = new Map<string, PendingAuth>();
  const githubTokens = new Map<string, FakeUser>();
  let origin = "";
  const registered = new Map<AccountProviderKind, string>();

  const fake: FakeProvider = {
    origin: "",
    user: {
      id: "583231",
      email: "kino@example.com",
      name: "Kino Kinoshita",
      login: "kino-octo",
      avatar: "https://avatars.example.com/u/583231",
    },
    forgeIdToken: null,
    signWithStrangerKey: false,
    githubAppClientId: null,
    redirectIss: null,
    nowMs: () => Date.now(),
    revokedTokens: [],
    tokenRequests: [],
    config: (kind, overrides = {}) => {
      const base: AccountProviderConfig = {
        kind,
        clientId: `${kind}-client-id`,
        clientSecret: kind === "apple" ? null : CLIENT_SECRETS[kind],
        appleKey: kind === "apple" ? appleTestKey() : null,
        authorizeUrl: `${origin}/${kind}/authorize`,
        tokenUrl: `${origin}/${kind}/token`,
        issuers: kind === "github" ? [] : [`${origin}/${kind}`],
        jwksUrl: kind === "github" ? null : `${origin}/${kind}/jwks`,
        apiUrl: kind === "github" ? `${origin}/github/api` : null,
      };
      registered.set(kind, `${PUBLIC_URL}/v1/account/oauth/${kind}/callback`);
      return { ...base, ...overrides };
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  } as FakeProvider;
  const mutable = fake as { -readonly [K in keyof FakeProvider]: FakeProvider[K] };

  const signIdToken = (provider: AccountProviderKind, auth: PendingAuth): string => {
    const alg = provider === "apple" ? "ES256" : "RS256";
    const header: Record<string, unknown> = {
      alg,
      kid: alg === "RS256" ? "rsa-1" : "ec-1",
      typ: "JWT",
    };
    const now = Math.floor(fake.nowMs() / 1000);
    const claims: Record<string, unknown> = {
      iss: `${origin}/${provider}`,
      aud: auth.clientId,
      sub: auth.user.id,
      email: auth.user.email,
      email_verified: true,
      name: auth.user.name,
      picture: auth.user.avatar,
      nonce: auth.nonce,
      iat: now,
      exp: now + 3600,
    };
    fake.forgeIdToken?.(claims, header);
    const signed = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(claims)))}`;
    const key = fake.signWithStrangerKey
      ? stranger.privateKey
      : header.alg === "ES256"
        ? ec.privateKey
        : rsa.privateKey;
    const sig =
      header.alg === "ES256"
        ? NodeCrypto.sign("sha256", Buffer.from(signed), { key, dsaEncoding: "ieee-p1363" })
        : header.alg === "HS256"
          ? NodeCrypto.createHmac("sha256", "guess").update(signed).digest()
          : header.alg === "none"
            ? Buffer.alloc(0)
            : NodeCrypto.sign("sha256", Buffer.from(signed), key);
    return `${signed}.${base64url(sig)}`;
  };

  const json = (res: NodeHttp.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = NodeHttp.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake.invalid");
      const [, kindText = "", ...rest] = url.pathname.split("/");
      const kind = kindText as AccountProviderKind;
      const route = rest.join("/");
      if (req.method === "GET" && route === "authorize") {
        // Like the real providers: an unregistered redirect URI stops here, nothing is sent back.
        if (url.searchParams.get("redirect_uri") !== registered.get(kind)) {
          json(res, 400, { error: "redirect_uri_mismatch" });
          return;
        }
        const code = base64url(NodeCrypto.randomBytes(16));
        pending.set(code, {
          provider: kind,
          clientId: url.searchParams.get("client_id") ?? "",
          redirectUri: url.searchParams.get("redirect_uri") ?? "",
          challenge: url.searchParams.get("code_challenge") ?? "",
          nonce: url.searchParams.get("nonce"),
          user: fake.user,
          used: false,
        });
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        if (fake.redirectIss !== null) back.searchParams.set("iss", fake.redirectIss);
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }
      if (req.method === "POST" && route === "token") {
        const form = new URLSearchParams(await readBody(req));
        fake.tokenRequests.push(form);
        const auth = pending.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const expectedSecret = CLIENT_SECRETS[kind];
        const secretOk =
          kind === "apple"
            ? (form.get("client_secret") ?? "").split(".").length === 3
            : form.get("client_secret") === expectedSecret;
        if (
          !auth ||
          auth.used ||
          auth.provider !== kind ||
          form.get("client_id") !== auth.clientId ||
          !secretOk ||
          form.get("redirect_uri") !== auth.redirectUri ||
          form.get("redirect_uri") !== registered.get(kind) ||
          base64url(NodeCrypto.createHash("sha256").update(verifier).digest()) !== auth.challenge
        ) {
          if (auth) auth.used = true;
          json(res, 400, { error: "invalid_grant" });
          return;
        }
        auth.used = true;
        if (kind === "github") {
          const token = `gho_${base64url(NodeCrypto.randomBytes(12))}`;
          githubTokens.set(token, auth.user);
          json(res, 200, { access_token: token, token_type: "bearer", scope: "" });
          return;
        }
        json(res, 200, { access_token: "ya29.x", id_token: signIdToken(kind, auth) });
        return;
      }
      if (req.method === "GET" && route === "jwks") {
        const jwk = (key: NodeCrypto.KeyObject, kid: string, alg: string) => ({
          ...key.export({ format: "jwk" }),
          kid,
          alg,
          use: "sig",
        });
        json(res, 200, {
          keys: [jwk(rsa.publicKey, "rsa-1", "RS256"), jwk(ec.publicKey, "ec-1", "ES256")],
        });
        return;
      }
      const tokenCheck = /^api\/applications\/([^/]+)\/token$/u.exec(route);
      if (kind === "github" && tokenCheck) {
        const clientId = decodeURIComponent(tokenCheck[1] ?? "");
        const basic = Buffer.from(`${clientId}:${CLIENT_SECRETS.github}`).toString("base64");
        if (req.headers.authorization !== `Basic ${basic}`) {
          json(res, 401, { message: "Bad credentials" });
          return;
        }
        const body = JSON.parse(await readBody(req)) as { access_token?: string };
        const user = githubTokens.get(body.access_token ?? "");
        if (req.method === "DELETE") {
          if (body.access_token) fake.revokedTokens.push(body.access_token);
          githubTokens.delete(body.access_token ?? "");
          res.writeHead(204);
          res.end();
          return;
        }
        if (!user) {
          json(res, 404, { message: "Not Found" });
          return;
        }
        json(res, 200, {
          app: { client_id: fake.githubAppClientId ?? clientId, name: "K3 Code" },
          user: {
            id: Number(user.id),
            login: user.login,
            email: user.email,
            name: user.name,
            avatar_url: user.avatar,
          },
        });
        return;
      }
      json(res, 404, { message: "Not Found" });
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  mutable.origin = origin;
  return fake;
}

/** Relay settings with accounts on, pointed at the fake provider. */
export function accountConfig(
  fake: FakeProvider,
  kinds: ReadonlyArray<AccountProviderKind> = ["github", "google", "apple"],
  extra: Partial<RelayConfig> = {},
): Partial<RelayConfig> {
  return {
    publicUrl: PUBLIC_URL,
    accountTokenSeed: TEST_SEED,
    accountHmacKey: TEST_HMAC_KEY,
    accountProviders: kinds.map((kind) => fake.config(kind)),
    ...extra,
  };
}

// ── The app's side, as a test client ──────────────────────────────────────────

export interface AppFlow {
  readonly provider: AccountProviderKind;
  readonly signer: Signer;
  readonly use: "device" | "host";
  readonly verifier: string;
  readonly appState: string;
  readonly redirect: string;
  readonly authorizeUrl: string;
}

export async function startAppFlow(
  relay: TestRelay,
  provider: AccountProviderKind,
  signer: Signer,
  options: { use?: "device" | "host"; redirect?: string } = {},
): Promise<AppFlow> {
  const use = options.use ?? "device";
  const redirect = options.redirect ?? ACCOUNT_APP_REDIRECT;
  const verifier = base64url(NodeCrypto.randomBytes(32));
  const appState = base64url(NodeCrypto.randomBytes(16));
  const response = await relay.http("POST", `/v1/account/oauth/${provider}/start`, {
    use,
    alg: signer.alg,
    key: base64url(signer.pub),
    challenge: base64url(NodeCrypto.createHash("sha256").update(verifier).digest()),
    redirect,
    state: appState,
  });
  if (response.status !== 200) {
    throw new Error(`start failed: ${response.status} ${response.text}`);
  }
  return {
    provider,
    signer,
    use,
    verifier,
    appState,
    redirect,
    authorizeUrl: String(response.json?.authorizeUrl),
  };
}

export interface ProviderVisit {
  /** The provider's redirect to the relay, as a path on the test relay. */
  readonly relayCallback: string;
  readonly query: URLSearchParams;
}

/** The browser at the provider: signs in and gets sent back to the relay's callback. */
export async function visitProvider(authorizeUrl: string): Promise<ProviderVisit> {
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  if (response.status !== 302) throw new Error(`provider refused: ${response.status}`);
  const location = new URL(response.headers.get("location") ?? "");
  if (location.origin !== PUBLIC_URL) throw new Error(`unexpected redirect ${location.origin}`);
  return { relayCallback: `${location.pathname}${location.search}`, query: location.searchParams };
}

export type CallbackOutcome =
  | { readonly kind: "app"; readonly url: URL }
  | { readonly kind: "failed"; readonly status: number; readonly text: string };

/** The browser at the relay's callback. */
export async function relayCallback(relay: TestRelay, path: string): Promise<CallbackOutcome> {
  const response = await fetch(`http://127.0.0.1:${relay.port}${path}`, { redirect: "manual" });
  if (response.status === 302) {
    return { kind: "app", url: new URL(response.headers.get("location") ?? "") };
  }
  return { kind: "failed", status: response.status, text: await response.text() };
}

export async function redeemCode(
  relay: TestRelay,
  flow: AppFlow,
  code: string,
  overrides: Record<string, unknown> = {},
) {
  const ts = relay.clock.now;
  const sig = base64url(flow.signer.sign(accountCodeSigningInput(code, ts)));
  return relay.http("POST", "/v1/account/token", {
    code,
    verifier: flow.verifier,
    redirect: flow.redirect,
    ts,
    sig,
    ...overrides,
  });
}

export interface AccountSession {
  readonly token: string;
  readonly signer: Signer;
  readonly use: "device" | "host";
}

/** The whole sign-in: start, provider, relay callback, code for a token. */
export async function signIn(
  relay: TestRelay,
  provider: AccountProviderKind,
  signer: Signer,
  options: { use?: "device" | "host"; redirect?: string } = {},
): Promise<AccountSession> {
  const flow = await startAppFlow(relay, provider, signer, options);
  const visit = await visitProvider(flow.authorizeUrl);
  const back = await relayCallback(relay, visit.relayCallback);
  if (back.kind !== "app") throw new Error(`callback failed: ${back.status}`);
  if (back.url.searchParams.get("state") !== flow.appState) throw new Error("state mismatch");
  const code = back.url.searchParams.get("code") ?? "";
  const redeemed = await redeemCode(relay, flow, code);
  if (redeemed.status !== 200) throw new Error(`redeem failed: ${redeemed.text}`);
  return { token: String(redeemed.json?.token), signer, use: flow.use };
}

let requestCounter = 0;

export function accountRequestBody(
  relay: TestRelay,
  session: AccountSession,
  path: string,
  params: Record<string, string> = {},
  order: ReadonlyArray<string> = Object.keys(params),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const ts = relay.clock.now;
  requestCounter += 1;
  const nonce = base64url(
    NodeCrypto.createHash("sha256").update(`n${requestCounter}${Math.random()}`).digest(),
  ).slice(0, 22);
  const values = order.map((name) => params[name] ?? "");
  const sig = base64url(
    session.signer.sign(accountRequestSigningInput(path, session.token, ts, nonce, values)),
  );
  return {
    token: session.token,
    alg: session.signer.alg,
    key: base64url(session.signer.pub),
    ts,
    nonce,
    sig,
    ...params,
    ...overrides,
  };
}

export function accountCall(
  relay: TestRelay,
  session: AccountSession,
  path: string,
  params: Record<string, string> = {},
  order?: ReadonlyArray<string>,
) {
  return relay.http("POST", path, accountRequestBody(relay, session, path, params, order));
}

/** A device asks for a ticket to one host, for a fresh per-host device key. */
export function hostTicket(
  relay: TestRelay,
  session: AccountSession,
  hostId: string,
  deviceKey: Signer,
) {
  const sessionKeyId =
    session.use === "host"
      ? hostIdOf(session.signer.pub)
      : deviceIdOf(session.signer.alg, session.signer.pub);
  const dsig = base64url(deviceKey.sign(bindSigningInput(hostId, sessionKeyId)));
  return accountCall(
    relay,
    session,
    "/v1/account/hosts/token",
    { hostId, dalg: deviceKey.alg, dk: base64url(deviceKey.pub), dsig },
    ["hostId", "dalg", "dk", "dsig"],
  );
}
