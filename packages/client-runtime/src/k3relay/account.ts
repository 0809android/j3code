import {
  ACCOUNT_APP_REDIRECT,
  type AccountProvider,
  PAIRING_APPROVAL_TIMEOUT_MS,
  accountBindSigningInput,
  accountCodeSigningInput,
  accountRequestSigningInput,
  createAccountClaim,
  decodeBase64url,
  encodeBase64url,
  isAccountProvider,
  isRelayId,
  pkceChallenge,
  readAccountSessionToken,
  receivePairingReply,
  relayHostId,
} from "@t3tools/shared/relay";
import {
  type E2eeDeviceSigner,
  deviceIdFromPublicKey,
  layerE2eeCrypto,
} from "@t3tools/shared/socketE2ee";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { DeviceKeyStore } from "./deviceKeyStore.ts";
import {
  type K3RelayPairedDevice,
  type K3RelayPairingProgress,
  decodePairingFrame,
  encodePairingFrame,
} from "./pairing.ts";
import { findK3RelayFailureReason } from "./admission.ts";
import { makeK3RelayE2eeSocket } from "./tunnel.ts";

/**
 * Signing in on a device (spec §20): the relay runs the provider's OAuth and returns a code bound
 * to this app's PKCE verifier and key. The session lists the account's hosts; a host still has its
 * user approve the device before it gets a grant, exactly as after QR pairing.
 */

export const K3RelayAccountFailureReason = Schema.Literals([
  "accounts-unavailable",
  "provider-unavailable",
  "relay-unreachable",
  "sign-in-cancelled",
  "sign-in-failed",
  "session-expired",
  "device-key-unavailable",
  "host-offline",
  "key-mismatch",
  "rejected",
  "timeout",
  "invalid-reply",
]);
export type K3RelayAccountFailureReason = typeof K3RelayAccountFailureReason.Type;

export class K3RelayAccountClientError extends Schema.TaggedError<K3RelayAccountClientError>()(
  "K3RelayAccountClientError",
  { reason: K3RelayAccountFailureReason, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const failure = (reason: K3RelayAccountFailureReason, detail: string) =>
  new K3RelayAccountClientError({ reason, detail });

/** `wss://relay…` (as settings spell it) to the relay's HTTPS origin. */
const k3relayHttpOrigin = (relayUrl: string): string | null => {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const protocol =
    url.protocol === "wss:" || url.protocol === "https:"
      ? "https:"
      : (url.protocol === "ws:" || url.protocol === "http:") && loopback
        ? "http:"
        : null;
  if (protocol === null || url.username !== "" || url.password !== "") return null;
  return `${protocol}//${url.host}`;
};

export interface K3RelayAccountOffer {
  readonly relayUrl: string;
  readonly providers: ReadonlyArray<AccountProvider>;
  readonly issuer: string;
  readonly accountKey: Uint8Array;
}

/** A sign-in waiting for the browser to come back with `?code&state`. Memory only. */
export interface K3RelayAccountPendingSignIn {
  readonly offer: K3RelayAccountOffer;
  readonly provider: AccountProvider;
  readonly verifier: string;
  readonly appState: string;
  readonly redirect: string;
  readonly keyId: string;
  readonly signer: E2eeDeviceSigner;
}

/** An hour's account session, bound to `signer`. Memory only; signing in again is cheap. */
export interface K3RelayAccountSession {
  readonly offer: K3RelayAccountOffer;
  readonly token: string;
  readonly expiresAt: number;
  readonly keyId: string;
  readonly signer: E2eeDeviceSigner;
}

export interface K3RelayAccountHost {
  readonly hostId: string;
  readonly hostIdentityKey: Uint8Array;
}

const parseUrl = (text: string): URL | null => {
  try {
    return new URL(text);
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const randomText = (bytes: number) =>
  Effect.flatMap(SecureRandom.SecureRandom, (random) => random.randomBytes(bytes)).pipe(
    Effect.map((value) => encodeBase64url(Uint8Array.from(value))),
  );

const requestJson = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.flatMap(HttpClient.HttpClient, (http) => http.execute(request)).pipe(
    Effect.flatMap((response) =>
      Effect.map(
        Effect.orElseSucceed(response.json, () => null),
        (json) => ({
          status: response.status,
          json: isRecord(json) ? json : null,
        }),
      ),
    ),
    Effect.mapError(() => failure("relay-unreachable", "The relay could not be reached.")),
  );

const postJson = (url: string, body: unknown) =>
  requestJson(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)));

/** What the relay offers (`/.well-known/k3-relay`), including the key its tickets are signed with. */
export const fetchK3RelayAccountOffer = Effect.fn("K3RelayAccount.fetchOffer")(function* (
  relayUrl: string,
) {
  const origin = k3relayHttpOrigin(relayUrl);
  if (origin === null) return yield* failure("relay-unreachable", "The relay URL is not usable.");
  const known = yield* requestJson(HttpClientRequest.get(`${origin}/.well-known/k3-relay`));
  const accounts = known.json?.accounts;
  if (known.status !== 200 || !isRecord(accounts)) {
    return yield* failure("accounts-unavailable", "This relay does not offer sign-in.");
  }
  const key = decodeBase64url(accounts.key, 32);
  const providers = Array.isArray(accounts.providers)
    ? accounts.providers.filter(isAccountProvider)
    : [];
  if (key === null || typeof accounts.issuer !== "string" || providers.length === 0) {
    return yield* failure("accounts-unavailable", "This relay does not offer sign-in.");
  }
  return { relayUrl: origin, providers, issuer: accounts.issuer, accountKey: key };
});

/**
 * Starts a sign-in. Open `authorizeUrl` in the system browser; it returns to `redirect`
 * (`k3relay://account/callback` by default, or a loopback or web address the relay allows).
 */
export const startK3RelayAccountSignIn = Effect.fn("K3RelayAccount.startSignIn")(function* (input: {
  readonly relayUrl: string;
  readonly provider: AccountProvider;
  readonly redirect?: string;
}) {
  const keys = yield* Effect.serviceOption(DeviceKeyStore);
  if (Option.isNone(keys)) {
    return yield* failure("device-key-unavailable", "This app cannot store a device key.");
  }
  const offer = yield* fetchK3RelayAccountOffer(input.relayUrl);
  if (!offer.providers.includes(input.provider)) {
    return yield* failure("provider-unavailable", "This relay does not offer that sign-in.");
  }
  const verifier = yield* randomText(32);
  const appState = yield* randomText(24);
  const keyId = `k3relay-account:${yield* randomText(9)}`;
  const signer = yield* keys.value
    .create(keyId)
    .pipe(Effect.mapError(() => failure("device-key-unavailable", "Could not create a key.")));
  const redirect = input.redirect ?? ACCOUNT_APP_REDIRECT;
  const started = yield* postJson(`${offer.relayUrl}/v1/account/oauth/${input.provider}/start`, {
    use: "device",
    alg: signer.alg,
    key: encodeBase64url(signer.publicKey),
    challenge: pkceChallenge(verifier),
    redirect,
    state: appState,
  }).pipe(Effect.onError(() => Effect.ignore(keys.value.remove(keyId))));
  const authorizeUrl = started.json?.authorizeUrl;
  if (started.status !== 200 || typeof authorizeUrl !== "string") {
    yield* Effect.ignore(keys.value.remove(keyId));
    return yield* failure(
      started.status === 404 ? "provider-unavailable" : "sign-in-failed",
      "The relay did not start the sign-in.",
    );
  }
  const pending: K3RelayAccountPendingSignIn = {
    offer,
    provider: input.provider,
    verifier,
    appState,
    redirect,
    keyId,
    signer,
  };
  return { authorizeUrl, pending };
});

/**
 * The browser came back to `callbackUrl`. Only a callback for this very sign-in (`state`) is
 * redeemed; the code is useless without this app's verifier and key, so a caught link is too.
 */
export const completeK3RelayAccountSignIn = Effect.fn("K3RelayAccount.completeSignIn")(function* (
  pending: K3RelayAccountPendingSignIn,
  callbackUrl: string,
) {
  const url = parseUrl(callbackUrl);
  if (url === null) return yield* failure("sign-in-failed", "The sign-in link is not usable.");
  if (url.searchParams.get("state") !== pending.appState) {
    return yield* failure("sign-in-failed", "The sign-in link is not for this sign-in.");
  }
  if (url.searchParams.get("error") !== null) {
    return yield* failure("sign-in-cancelled", "Signing in was cancelled.");
  }
  const code = url.searchParams.get("code") ?? "";
  const ts = yield* Clock.currentTimeMillis;
  const sig = yield* pending.signer
    .sign(accountCodeSigningInput(code, ts))
    .pipe(Effect.mapError(() => failure("device-key-unavailable", "The key could not sign.")));
  const redeemed = yield* postJson(`${pending.offer.relayUrl}/v1/account/token`, {
    code,
    verifier: pending.verifier,
    redirect: pending.redirect,
    ts,
    sig: encodeBase64url(sig),
  });
  const token = redeemed.json?.token;
  const claims = readAccountSessionToken(token, pending.offer.accountKey);
  if (
    redeemed.status !== 200 ||
    typeof token !== "string" ||
    claims === null ||
    claims.use !== "device" ||
    claims.iss !== pending.offer.issuer ||
    claims.kid !== deviceIdFromPublicKey(pending.signer.alg, pending.signer.publicKey)
  ) {
    return yield* failure("sign-in-failed", "The relay did not accept the sign-in.");
  }
  return {
    offer: pending.offer,
    token,
    expiresAt: claims.exp,
    keyId: pending.keyId,
    signer: pending.signer,
  } satisfies K3RelayAccountSession;
});

/** A signed call to the relay's account API. */
const accountCall = Effect.fn("K3RelayAccount.call")(function* (
  session: K3RelayAccountSession,
  path: string,
  params: ReadonlyArray<readonly [string, string]> = [],
) {
  const ts = yield* Clock.currentTimeMillis;
  if (session.expiresAt <= ts) {
    return yield* failure("session-expired", "The sign-in expired. Sign in again.");
  }
  const nonce = yield* randomText(18);
  const sig = yield* session.signer
    .sign(
      accountRequestSigningInput(
        path,
        session.token,
        ts,
        nonce,
        params.map(([, value]) => value),
      ),
    )
    .pipe(Effect.mapError(() => failure("device-key-unavailable", "The key could not sign.")));
  const reply = yield* postJson(`${session.offer.relayUrl}${path}`, {
    token: session.token,
    alg: session.signer.alg,
    key: encodeBase64url(session.signer.publicKey),
    ts,
    nonce,
    sig: encodeBase64url(sig),
    ...Object.fromEntries(params),
  });
  if (reply.status === 401) {
    return yield* failure("session-expired", "The sign-in expired. Sign in again.");
  }
  return reply;
});

/** The account's hosts: ids and public keys only. Host names come from each host, over E2EE. */
export const listK3RelayAccountHosts = Effect.fn("K3RelayAccount.listHosts")(function* (
  session: K3RelayAccountSession,
) {
  const reply = yield* accountCall(session, "/v1/account/hosts");
  const hosts = reply.json?.hosts;
  if (reply.status !== 200 || !Array.isArray(hosts)) {
    return yield* failure("invalid-reply", "The relay's host list is not usable.");
  }
  const result: K3RelayAccountHost[] = [];
  for (const entry of hosts) {
    if (!isRecord(entry) || !isRelayId(entry.hostId)) continue;
    const key = decodeBase64url(entry.hk, 32);
    // A listed key must hash to its id; anything else is dropped, never shown.
    if (key === null || relayHostId(key) !== entry.hostId) continue;
    result.push({ hostId: entry.hostId, hostIdentityKey: key });
  }
  return result;
});

/**
 * Knocks on one host with a fresh per-host key and waits for its user. The confirmation code
 * shows up through `onProgress`; compare it with the host's screen. On approval the result is a
 * paired device, for `redeemK3RelayPairing` as after QR pairing.
 */
export const connectK3RelayAccountHost = Effect.fn("K3RelayAccount.connectHost")(function* (
  session: K3RelayAccountSession,
  host: K3RelayAccountHost,
  input: { readonly deviceName: string; readonly approvalTimeoutMs?: number },
  onProgress: (progress: K3RelayPairingProgress) => Effect.Effect<void>,
) {
  const keys = yield* Effect.serviceOption(DeviceKeyStore);
  if (Option.isNone(keys)) {
    return yield* failure("device-key-unavailable", "This app cannot store a device key.");
  }
  if (relayHostId(host.hostIdentityKey) !== host.hostId) {
    return yield* failure("key-mismatch", "The listed host key does not match its id.");
  }
  const keyId = `k3relay:${host.hostId}:${yield* randomText(9)}`;
  const signer = yield* keys.value
    .create(keyId)
    .pipe(Effect.mapError(() => failure("device-key-unavailable", "Could not create a key.")));

  const connected = Effect.gen(function* () {
    const sessionKeyId = deviceIdFromPublicKey(session.signer.alg, session.signer.publicKey);
    const dsig = yield* signer
      .sign(accountBindSigningInput(host.hostId, sessionKeyId))
      .pipe(Effect.mapError(() => failure("device-key-unavailable", "The key could not sign.")));
    const issued = yield* accountCall(session, "/v1/account/hosts/token", [
      ["hostId", host.hostId],
      ["dalg", signer.alg],
      ["dk", encodeBase64url(signer.publicKey)],
      ["dsig", encodeBase64url(dsig)],
    ]);
    const ticket = issued.json?.token;
    if (issued.status !== 200 || typeof ticket !== "string") {
      return yield* failure("rejected", "The relay did not hand out a ticket for this host.");
    }
    yield* onProgress({ phase: "connecting", relayUrl: session.offer.relayUrl });
    const socket = yield* makeK3RelayE2eeSocket({
      relayUrl: session.offer.relayUrl,
      hostId: host.hostId,
      hostIdentityKey: host.hostIdentityKey,
      admission: { kind: "account", hostId: host.hostId, signer, ticket },
    });
    const connectionFailure = (error: unknown) =>
      findK3RelayFailureReason(error) === "key-mismatch"
        ? failure("key-mismatch", "The host answered with a different key than the account lists.")
        : failure("host-offline", "The host is offline or not connected to the relay.");
    const reader = yield* socket.reader.pipe(Effect.mapError(connectionFailure));
    const writer = yield* socket.writer;
    const info = yield* socket.sessionInfo.pipe(Effect.mapError(connectionFailure));
    const created = yield* createAccountClaim({
      transcriptHash: info.transcriptHash,
      signer,
      name: input.deviceName,
      ticket,
      relayUrl: session.offer.relayUrl,
      hostIdentityKey: host.hostIdentityKey,
    }).pipe(Effect.mapError((error) => failure("invalid-reply", error.detail)));
    yield* writer.write(encodePairingFrame(created.claim)).pipe(Effect.mapError(connectionFailure));
    yield* onProgress({ phase: "awaiting-approval", confirmationCode: created.confirmationCode });
    const [frame] = yield* reader.pull.pipe(
      Effect.mapError(() => failure("host-offline", "The connection closed before an answer.")),
      Effect.timeoutOrElse({
        duration: input.approvalTimeoutMs ?? PAIRING_APPROVAL_TIMEOUT_MS,
        orElse: () => Effect.fail(failure("timeout", "The host did not answer in time.")),
      }),
    );
    const reply = receivePairingReply(
      created.state,
      decodePairingFrame(frame),
      yield* Clock.currentTimeMillis,
    );
    if (reply.phase === "failed") {
      return yield* failure(
        reply.reason === "invalid-reply" ? "invalid-reply" : "rejected",
        "The host did not let this device in.",
      );
    }
    if (reply.phase !== "paired") {
      return yield* failure("invalid-reply", "The host's reply is invalid.");
    }
    return {
      record: reply.record,
      bootstrapToken: reply.bootstrapToken,
      keyId,
      signer,
    } satisfies K3RelayPairedDevice;
  });

  return yield* connected.pipe(
    Effect.scoped,
    Effect.provide(layerE2eeCrypto),
    Effect.onError(() => Effect.ignore(keys.value.remove(keyId))),
  );
});

/** The sentence a screen shows for a sign-in or account connection that did not finish. */
export function k3relayAccountFailureText(
  reason: K3RelayAccountFailureReason,
  resolve: MFunctionType = mFallback,
): string {
  switch (reason) {
    case "accounts-unavailable":
      return resolve(msg("This relay does not offer sign-in. Pair with a QR code instead."));
    case "provider-unavailable":
      return resolve(msg("This relay does not offer that sign-in."));
    case "relay-unreachable":
      return resolve(msg("This device can't reach the relay."));
    case "sign-in-cancelled":
      return resolve(msg("Signing in was cancelled."));
    case "sign-in-failed":
      return resolve(msg("Signing in did not finish. Try again."));
    case "session-expired":
      return resolve(msg("The sign-in expired. Sign in again."));
    case "device-key-unavailable":
      return resolve(msg("This device cannot store a key for the relay."));
    case "host-offline":
      return resolve(msg("The host is offline or not connected to the relay."));
    case "key-mismatch":
      return resolve(
        msg(
          "The host answered with a different key than the account lists. Someone may be intercepting the connection. Nothing was sent.",
        ),
      );
    case "rejected":
      return resolve(msg("The host did not let this device in."));
    case "timeout":
      return resolve(msg("Nobody approved this device in time. Try again."));
    case "invalid-reply":
      return resolve(msg("The answer could not be verified. Nothing was saved."));
  }
}
