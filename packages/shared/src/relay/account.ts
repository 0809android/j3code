import * as Effect from "effect/Effect";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  type E2eeDeviceAlgorithm,
  type E2eeDeviceSigner,
  isCanonicalDevicePublicKey,
  isDeviceAlgorithm,
  labeledMessage,
  verifyDeviceSignature,
} from "../socketE2eeDevice.ts";
import { timingSafeEqual } from "../socketE2eeRecord.ts";
import {
  decodeBase64url,
  encodeBase64url,
  isRelayId,
  relayDeviceId,
  relayHostId,
  relaySigningInput,
} from "./encoding.ts";
import { type AddDeviceWindow, type ApprovalPolicy, approvalRequired } from "./approval.ts";
import { isValidDeviceName } from "./ledger.ts";
import {
  type DevicePairingState,
  type HostPairingState,
  PAIRING_APPROVAL_TIMEOUT_MS,
  type PairingRejectReason,
  PairingError,
  cancelPairing,
  confirmationCode,
  tickPairing,
} from "./pairing.ts";

/**
 * Accounts (spec §20), shared by host and device: relay tickets, signed account calls, and the
 * claim a device sends inside E2EE when it comes through an account. The host still asks its
 * user (§20.3), so a lying relay gets as far as the approval screen and no further.
 */

export const ACCOUNT_TOKEN_PREFIX = "k3a1";
export const ACCOUNT_APP_REDIRECT = "k3relay://account/callback";
export const ACCOUNT_LOOPBACK_PATH = "/k3relay/account/callback";
export const ACCOUNT_PROVIDERS = ["github", "google", "apple"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

const LABEL_TOKEN = "k3relay-v1/account-token";
const LABEL_CODE = "k3relay-v1/account-code";
const LABEL_REQUEST = "k3relay-v1/account-request";
const LABEL_BIND = "k3relay-v1/account-bind";
const LABEL_CLIENT = "k3relay-v1/account-client";
const LABEL_CLAIM_KEY_PROOF = "k3code-e2ee-v2/account-claim";
const TICKET_FUTURE_SKEW_MS = 5 * 60_000;
const CLAIM_KEYS = ["alg", "dk", "keyProof", "name", "ticket", "type"];
const MAX_TICKET_CHARS = 2048;

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export const isAccountProvider = (value: unknown): value is AccountProvider =>
  typeof value === "string" && (ACCOUNT_PROVIDERS as ReadonlyArray<string>).includes(value);

// ── Relay API signing ─────────────────────────────────────────────────────────

/** What the bound key signs to redeem the one-time K3 code at `/v1/account/token`. */
export const accountCodeSigningInput = (code: string, ts: number): Uint8Array =>
  relaySigningInput(LABEL_CODE, code, String(ts));

/** What the bound key signs on every account call: path, token, time, nonce and parameters. */
export const accountRequestSigningInput = (
  path: string,
  token: string,
  ts: number,
  nonce: string,
  values: ReadonlyArray<string>,
): Uint8Array => relaySigningInput(LABEL_REQUEST, path, token, String(ts), nonce, ...values);

/** What a new per-host device key signs to be named in that host's ticket. */
export const accountBindSigningInput = (hostId: string, sessionKeyId: string): Uint8Array =>
  relaySigningInput(LABEL_BIND, hostId, sessionKeyId);

/** What the device key signs to knock on `/v1/client/<hostId>?account=1`. */
export const accountClientSigningInput = (
  hostId: string,
  deviceId: string,
  nonce: Uint8Array,
): Uint8Array => relaySigningInput(LABEL_CLIENT, hostId, deviceId, nonce);

/** The PKCE S256 challenge for a verifier. */
export const pkceChallenge = (verifier: string): string => encodeBase64url(sha256(utf8(verifier)));

// ── Tickets ───────────────────────────────────────────────────────────────────

export interface AccountHostTicket {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly cnf: string;
  readonly iat: number;
  readonly exp: number;
}

export interface AccountSessionClaims {
  readonly iss: string;
  readonly sub: string;
  readonly kid: string;
  readonly use: "device" | "host";
  readonly iat: number;
  readonly exp: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Reads a token's payload after checking the relay's signature. Null for anything else. */
const readSignedPayload = (
  token: unknown,
  accountKey: Uint8Array,
): Record<string, unknown> | null => {
  if (typeof token !== "string" || token.length > MAX_TICKET_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== ACCOUNT_TOKEN_PREFIX) return null;
  const payload = decodeBase64url(parts[1]);
  const sig = decodeBase64url(parts[2], 64);
  if (payload === null || sig === null || accountKey.length !== 32) return null;
  if (!verifyDeviceSignature("ed25519", accountKey, labeledMessage(LABEL_TOKEN, payload), sig)) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(payload));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

export type TicketVerdict =
  | { readonly ok: true; readonly ticket: AccountHostTicket }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "signature" | "expired" | "audience" | "account" | "key";
    };

/**
 * The host's own check of a device's ticket: signed with the account key this host learned when
 * it signed in, from the same relay, for this host, for this device's key, for the account this
 * host is on, and current.
 */
export const verifyAccountHostTicket = (
  token: unknown,
  expected: {
    readonly accountKey: Uint8Array;
    readonly issuer: string;
    readonly hostId: string;
    readonly accountId: string;
    readonly deviceId: string;
    readonly now: number;
  },
): TicketVerdict => {
  const payload = readSignedPayload(token, expected.accountKey);
  if (payload === null) return { ok: false, reason: "signature" };
  if (
    !hasExactKeys(payload, ["v", "typ", "iss", "sub", "aud", "cnf", "iat", "exp"]) ||
    payload.v !== 1 ||
    payload.typ !== "host-access" ||
    typeof payload.iss !== "string" ||
    !isRelayId(payload.sub) ||
    !isRelayId(payload.aud) ||
    !isRelayId(payload.cnf) ||
    !isTime(payload.iat) ||
    !isTime(payload.exp)
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp <= expected.now || payload.iat > expected.now + TICKET_FUTURE_SKEW_MS) {
    return { ok: false, reason: "expired" };
  }
  if (payload.iss !== expected.issuer || payload.aud !== expected.hostId) {
    return { ok: false, reason: "audience" };
  }
  if (payload.sub !== expected.accountId) return { ok: false, reason: "account" };
  if (payload.cnf !== expected.deviceId) return { ok: false, reason: "key" };
  return {
    ok: true,
    ticket: {
      iss: payload.iss,
      sub: payload.sub,
      aud: payload.aud,
      cnf: payload.cnf,
      iat: payload.iat,
      exp: payload.exp,
    },
  };
};

/**
 * Reads a session token the relay just returned, to learn the account id (`sub`) and the bound
 * key. The caller already holds the relay's key from `/.well-known/k3-relay`.
 */
export const readAccountSessionToken = (
  token: unknown,
  accountKey: Uint8Array,
): AccountSessionClaims | null => {
  const payload = readSignedPayload(token, accountKey);
  if (
    payload === null ||
    !hasExactKeys(payload, ["v", "typ", "iss", "sub", "kid", "use", "iat", "exp"]) ||
    payload.v !== 1 ||
    payload.typ !== "session" ||
    typeof payload.iss !== "string" ||
    !isRelayId(payload.sub) ||
    !isRelayId(payload.kid) ||
    (payload.use !== "device" && payload.use !== "host") ||
    !isTime(payload.iat) ||
    !isTime(payload.exp)
  ) {
    return null;
  }
  return {
    iss: payload.iss,
    sub: payload.sub,
    kid: payload.kid,
    use: payload.use,
    iat: payload.iat,
    exp: payload.exp,
  };
};

// ── The account claim, inside the E2EE channel ────────────────────────────────

export interface AccountClaimMessage {
  readonly type: "account-claim";
  readonly alg: E2eeDeviceAlgorithm;
  readonly dk: string;
  readonly name: string;
  readonly keyProof: string;
  readonly ticket: string;
}

/** `sign_Dk(lp(label) ‖ lp(th) ‖ lp(alg) ‖ lp(Dk))`: proves `Dk` in this very handshake. */
export const accountKeyProofMessage = (
  transcriptHash: Uint8Array,
  alg: E2eeDeviceAlgorithm,
  devicePublicKey: Uint8Array,
): Uint8Array => labeledMessage(LABEL_CLAIM_KEY_PROOF, transcriptHash, utf8(alg), devicePublicKey);

export interface HostAccountBinding {
  readonly issuer: string;
  readonly accountId: string;
  readonly accountKey: Uint8Array;
}

/** How the host treats a verified account device, given its approval policy (§20.3). */
export type AccountApproval =
  /** Show the code on both sides; the user compares and approves. The default. */
  | { readonly kind: "compare-code" }
  /** The host's user opened "Add device" and this is the first device in it: one tap. */
  | { readonly kind: "one-tap" }
  /** The user turned approval off, with the risk shown and the choice recorded. */
  | { readonly kind: "auto-approve" };

/**
 * Unlike QR pairing, an account device may arrive without an open window: it still waits for the
 * user, with codes to compare. Only a recorded opt-out skips the user; a window the host's user
 * opened lets the first device through with one tap.
 */
export const decideAccountApproval = (input: {
  readonly policy: ApprovalPolicy;
  readonly window: AddDeviceWindow | null;
  readonly now: number;
}): AccountApproval => {
  if (!approvalRequired(input.policy)) return { kind: "auto-approve" };
  const window = input.window;
  if (
    window !== null &&
    window.openedBy.kind === "host-user" &&
    !window.used &&
    input.now >= window.openedAt &&
    input.now < window.expiresAt
  ) {
    return { kind: "one-tap" };
  }
  return { kind: "compare-code" };
};

export type AccountClaimRejectReason = PairingRejectReason | "not-on-account";

export type AccountClaimOutcome =
  | {
      readonly kind: "awaiting-approval";
      readonly state: Extract<HostPairingState, { phase: "awaiting-approval" }>;
    }
  | { readonly kind: "rejected"; readonly reason: AccountClaimRejectReason };

const parseClaim = (value: unknown) => {
  if (!hasExactKeys(value, CLAIM_KEYS) || value.type !== "account-claim") return null;
  const { alg, dk, name, keyProof, ticket } = value;
  if (typeof alg !== "string" || !isDeviceAlgorithm(alg) || !isValidDeviceName(name)) return null;
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET_CHARS) return null;
  const publicKey = decodeBase64url(dk);
  const proof = decodeBase64url(keyProof, 64);
  if (publicKey === null || proof === null || !isCanonicalDevicePublicKey(alg, publicKey)) {
    return null;
  }
  return { alg, publicKey, name, proof, ticket };
};

/**
 * Checks a claim that arrived in an anonymous E2EE session opened through `?account=1`. The
 * device must hold `Dk` in this handshake and carry a ticket for this host, this key and this
 * host's account. A verified claim waits for approval exactly like a QR claim, so the existing
 * approve and reject paths apply. A pending QR offer is cancelled: one decision at a time.
 */
export const submitAccountClaim = (
  current: HostPairingState,
  input: {
    readonly transcriptHash: Uint8Array;
    readonly message: unknown;
    readonly now: number;
    readonly relayUrl: string;
    readonly hostIdentityKey: Uint8Array;
    readonly binding: HostAccountBinding | null;
  },
): { readonly state: HostPairingState; readonly outcome: AccountClaimOutcome } => {
  const state = tickPairing(current, input.now);
  const rejected = (reason: AccountClaimRejectReason) => ({
    state,
    outcome: { kind: "rejected", reason } as const,
  });
  if (state.phase === "awaiting-approval") return rejected("busy");
  if (input.binding === null) return rejected("not-on-account");
  if (input.transcriptHash.length !== 32) return rejected("invalid-claim");
  const claim = parseClaim(input.message);
  if (claim === null) return rejected("invalid-claim");
  if (
    !verifyDeviceSignature(
      claim.alg,
      claim.publicKey,
      accountKeyProofMessage(input.transcriptHash, claim.alg, claim.publicKey),
      claim.proof,
    )
  ) {
    return rejected("invalid-claim");
  }
  const deviceId = relayDeviceId(claim.alg, claim.publicKey);
  const verdict = verifyAccountHostTicket(claim.ticket, {
    accountKey: input.binding.accountKey,
    issuer: input.binding.issuer,
    hostId: relayHostId(input.hostIdentityKey),
    accountId: input.binding.accountId,
    deviceId,
    now: input.now,
  });
  if (!verdict.ok)
    return rejected(verdict.reason === "account" ? "not-on-account" : "invalid-claim");
  const next: Extract<HostPairingState, { phase: "awaiting-approval" }> = {
    phase: "awaiting-approval",
    relayUrl: input.relayUrl,
    hostIdentityKey: input.hostIdentityKey,
    device: { alg: claim.alg, publicKey: claim.publicKey, deviceId, name: claim.name },
    confirmationCode: confirmationCode(input.transcriptHash, input.hostIdentityKey),
    approvalDeadline: input.now + PAIRING_APPROVAL_TIMEOUT_MS,
  };
  // Closing an open QR offer zeroes its secret.
  cancelPairing(state);
  return { state: next, outcome: { kind: "awaiting-approval", state: next } };
};

/**
 * The device's claim, for the anonymous session pinned to the `Hk` the account listed. The
 * returned state accepts the host's reply through `receivePairingReply`, like QR pairing.
 */
export const createAccountClaim = Effect.fn("relay.createAccountClaim")(function* (input: {
  readonly transcriptHash: Uint8Array;
  readonly signer: E2eeDeviceSigner;
  readonly name: string;
  readonly ticket: string;
  readonly relayUrl: string;
  readonly hostIdentityKey: Uint8Array;
}) {
  if (input.transcriptHash.length !== 32 || !isValidDeviceName(input.name)) {
    return yield* new PairingError({ detail: "The account claim is malformed." });
  }
  if (input.hostIdentityKey.length !== 32) {
    return yield* new PairingError({ detail: "The host key is invalid." });
  }
  const { alg, publicKey } = input.signer;
  const keyProof = yield* input.signer
    .sign(accountKeyProofMessage(input.transcriptHash, alg, publicKey))
    .pipe(Effect.mapError(() => new PairingError({ detail: "The device key could not sign." })));
  const claim: AccountClaimMessage = {
    type: "account-claim",
    alg,
    dk: encodeBase64url(publicKey),
    name: input.name,
    keyProof: encodeBase64url(keyProof),
    ticket: input.ticket,
  };
  const code = confirmationCode(input.transcriptHash, input.hostIdentityKey);
  const state: DevicePairingState = {
    phase: "awaiting-approval",
    relayUrl: input.relayUrl,
    hostId: relayHostId(input.hostIdentityKey),
    hostIdentityKey: input.hostIdentityKey,
    alg,
    publicKey,
    confirmationCode: code,
  };
  return { state, claim, confirmationCode: code };
});

/** Constant-time comparison of two relay key encodings. */
export const sameAccountKey = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && timingSafeEqual(a, b);
