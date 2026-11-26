import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttp2 from "node:http2";

import { base64url } from "./bytes.ts";
import { LABELS, deviceIdOf, signingInput } from "./crypto.ts";
import type { ApnsCredentials, FcmCredentials, PushPlatform } from "./push.ts";
import { grantFor, type Signer, type TestHost, type TestRelay } from "./relay.testkit.ts";

/**
 * Stand-ins for APNs (HTTP/2, provider JWT) and FCM (OAuth2 for a service account, then HTTP v1),
 * in this process. They check the credentials the way the real services do, record every request,
 * and answer however a test asks. The relay never reaches the real services in tests.
 */

export interface ApnsRequest {
  readonly path: string;
  readonly headers: NodeHttp2.IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
  readonly jwtValid: boolean;
}

export interface FakeApns {
  readonly credentials: ApnsCredentials;
  readonly requests: ApnsRequest[];
  /** What to answer next; defaults to 200. */
  respond: (request: ApnsRequest) => { status: number; reason?: string };
  close(): Promise<void>;
}

function verifyJwt(token: string, key: NodeCrypto.KeyObject, alg: "ES256" | "RS256"): boolean {
  const [header = "", claims = "", signature = ""] = token.split(".");
  const input = Buffer.from(`${header}.${claims}`);
  const sig = Buffer.from(signature, "base64url");
  return alg === "ES256"
    ? NodeCrypto.verify("sha256", input, { key, dsaEncoding: "ieee-p1363" }, sig)
    : NodeCrypto.verify("sha256", input, key, sig);
}

const jwtClaims = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

export async function startFakeApns(): Promise<FakeApns> {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const requests: ApnsRequest[] = [];
  const server = NodeHttp2.createServer();
  const fake: FakeApns = {
    credentials: null as unknown as ApnsCredentials,
    requests,
    respond: () => ({ status: 200 }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const authorization = String(headers.authorization ?? "");
      const token = authorization.startsWith("bearer ") ? authorization.slice(7) : "";
      const jwtValid =
        token !== "" &&
        verifyJwt(token, publicKey, "ES256") &&
        jwtClaims(token).iss === "TEAM123456";
      const request: ApnsRequest = {
        path: String(headers[":path"] ?? ""),
        headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        jwtValid,
      };
      requests.push(request);
      const answer = jwtValid
        ? fake.respond(request)
        : { status: 403, reason: "InvalidProviderToken" };
      stream.respond({ ":status": answer.status, "content-type": "application/json" });
      stream.end(answer.status === 200 ? "" : JSON.stringify({ reason: answer.reason ?? "" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  (fake as { credentials: ApnsCredentials }).credentials = {
    keyId: "KEY1234567",
    teamId: "TEAM123456",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    topic: "jp.kinocode.k3code",
    url: origin,
    sandboxUrl: origin,
  };
  return fake;
}

export interface FcmRequest {
  readonly path: string;
  readonly authorization: string;
  readonly body: Record<string, unknown>;
}

export interface FakeFcm {
  readonly credentials: FcmCredentials;
  readonly requests: FcmRequest[];
  readonly tokenRequests: number[];
  respond: (request: FcmRequest) => { status: number; body?: unknown };
  close(): Promise<void>;
}

export async function startFakeFcm(): Promise<FakeFcm> {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests: FcmRequest[] = [];
  const tokenRequests: number[] = [];
  const accessToken = base64url(NodeCrypto.randomBytes(24));
  let origin = "";
  const server = NodeHttp.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/token") {
        const form = new URLSearchParams(text);
        const assertion = form.get("assertion") ?? "";
        const claims = assertion ? jwtClaims(assertion) : {};
        const ok =
          form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" &&
          verifyJwt(assertion, publicKey, "RS256") &&
          claims.iss === "relay@example.iam.gserviceaccount.com" &&
          claims.aud === `${origin}/token` &&
          claims.scope === "https://www.googleapis.com/auth/firebase.messaging";
        tokenRequests.push(ok ? 200 : 401);
        if (!ok) return reply(401, { error: "invalid_grant" });
        return reply(200, { access_token: accessToken, expires_in: 3599, token_type: "Bearer" });
      }
      const request: FcmRequest = {
        path: req.url ?? "",
        authorization: String(req.headers.authorization ?? ""),
        body: JSON.parse(text) as Record<string, unknown>,
      };
      requests.push(request);
      if (request.authorization !== `Bearer ${accessToken}`) {
        return reply(401, { error: { status: "UNAUTHENTICATED" } });
      }
      const answer = fake.respond(request);
      return reply(answer.status, answer.body ?? { name: "projects/p/messages/1" });
    });
  });
  const fake: FakeFcm = {
    credentials: null as unknown as FcmCredentials,
    requests,
    tokenRequests,
    respond: () => ({ status: 200 }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  (fake as { credentials: FcmCredentials }).credentials = {
    projectId: "k3-test",
    clientEmail: "relay@example.iam.gserviceaccount.com",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    url: origin,
    tokenUrl: `${origin}/token`,
  };
  return fake;
}

/** FCM's answer for a token that no longer reaches an app. */
export const FCM_UNREGISTERED = {
  status: 404,
  body: {
    error: {
      code: 404,
      status: "NOT_FOUND",
      details: [
        {
          "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
          errorCode: "UNREGISTERED",
        },
      ],
    },
  },
};

export const APNS_TOKEN = "a1".repeat(32);
export const FCM_TOKEN = `fcm-token:${"Z9_-".repeat(30)}`;

export interface PushRegistrationOptions {
  readonly platform?: PushPlatform;
  readonly token?: string;
  readonly ts?: number;
  readonly nonce?: string;
  readonly signWith?: Signer;
  readonly remove?: boolean;
}

/** A device's signed push registration (or removal) for one host. */
export function pushRegistrationBody(
  host: TestHost,
  device: Signer,
  now: number,
  options: PushRegistrationOptions = {},
): Record<string, unknown> {
  const ts = options.ts ?? now;
  const nonce = options.nonce ?? base64url(NodeCrypto.randomBytes(16));
  const deviceId = deviceIdOf(device.alg, device.pub);
  const platform = options.platform ?? "ios";
  const token = options.token ?? (platform === "android" ? FCM_TOKEN : APNS_TOKEN);
  const message = options.remove
    ? signingInput(LABELS.pushRemove, host.hostId, deviceId, String(ts), nonce)
    : signingInput(LABELS.pushRegister, host.hostId, deviceId, String(ts), nonce, platform, token);
  const sig = (options.signWith ?? device).sign(message);
  return {
    alg: device.alg,
    dk: base64url(device.pub),
    grant: grantFor(host, device, now),
    ts,
    nonce,
    ...(options.remove ? {} : { platform, token }),
    sig: base64url(sig),
  };
}

export interface PushSendOptions {
  readonly ts?: number;
  readonly nonce?: string;
  readonly hostId?: string;
  readonly signWith?: Signer;
}

/** The host's signed hand-over of one sealed envelope for one of its devices. */
export function pushSendBody(
  host: TestHost,
  deviceId: string,
  envelope: Buffer,
  now: number,
  options: PushSendOptions = {},
): Record<string, unknown> {
  const ts = options.ts ?? now;
  const nonce = options.nonce ?? base64url(NodeCrypto.randomBytes(16));
  const hostId = options.hostId ?? host.hostId;
  const sig = (options.signWith ?? host.signer).sign(
    signingInput(LABELS.pushSend, hostId, deviceId, String(ts), nonce, envelope),
  );
  return { hostId, deviceId, ts, nonce, envelope: base64url(envelope), sig: base64url(sig) };
}

export const registerPush = (
  relay: TestRelay,
  host: TestHost,
  device: Signer,
  options: PushRegistrationOptions = {},
) =>
  relay.http(
    "POST",
    `/v1/client/${host.hostId}/push${options.remove ? "/remove" : ""}`,
    pushRegistrationBody(host, device, relay.clock.now, options),
  );

export const sendPush = (
  relay: TestRelay,
  host: TestHost,
  deviceId: string,
  envelope: Buffer,
  options: PushSendOptions = {},
) =>
  relay.http(
    "POST",
    "/v1/push/send",
    pushSendBody(host, deviceId, envelope, relay.clock.now, options),
  );
