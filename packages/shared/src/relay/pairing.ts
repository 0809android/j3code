import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  type E2eeDeviceAlgorithm,
  type E2eeDeviceSigner,
  isCanonicalDevicePublicKey,
  isDeviceAlgorithm,
  labeledMessage,
  verifyDeviceSignature,
} from "../socketE2eeDevice.ts";
import { identityPublicKeyFromSeed } from "../socketE2eeV1.ts";
import { timingSafeEqual } from "../socketE2eeRecord.ts";
import {
  decodeBase64url,
  encodeBase64url,
  isRelayId,
  relayDeviceId,
  relayHostId,
} from "./encoding.ts";
import { type RelayGrant, grantRegisterFrame, issueGrant, verifyGrant } from "./grant.ts";
import { type DeviceLedger, type LedgerDevice, isValidDeviceName } from "./ledger.ts";

/**
 * Pairing (spec §8) as pure state machines and messages; the transport supplies the pairing
 * E2EE session's transcript hash `th`. `S` is spent only by a claim whose `proof` (HMAC with
 * `S`) and `keyProof` (signature by `Dk`) both verify, so bad claims cannot close the window.
 */

export const PAIRING_LINK_PROTOCOL = "k3relay:";
export const PAIRING_OFFER_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_FAILED_ATTEMPTS = 10;
/** A verified claim waits this long for the user to compare codes and approve. */
export const PAIRING_APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** 32 symbols without 0, 1, I and O. */
export const CONFIRMATION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const SECRET_BYTES = 16;
const TRANSCRIPT_BYTES = 32;
const SIGNATURE_BYTES = 64;
const HOST_KEY_BYTES = 32;
const LABEL_PROOF = "k3pair";
const LABEL_KEY_PROOF = "k3code-e2ee-v2/pair";
const LABEL_CONFIRMATION = "k3code-e2ee-v2/pair-code";
const LINK_KEYS = ["exp", "hk", "host", "relay", "v"];
const CLAIM_KEYS = ["alg", "dk", "keyProof", "name", "proof", "type"];

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export class PairingError extends Schema.TaggedError<PairingError>()("PairingError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface PairingOffer {
  readonly relayUrl: string;
  readonly hostId: string;
  readonly hostIdentityKey: Uint8Array;
  /** `S`: 128 bits, single use. Travels only in the link fragment or the QR code. */
  readonly secret: Uint8Array;
  readonly expiresAt: number;
}

const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** `https:` relays only (plain `http:` just for loopback development), no credentials. */
const normalizeRelayUrl = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  if (!secure || url.username !== "" || url.password !== "" || url.hash !== "") return null;
  return url.href;
};

/**
 * `k3relay://pair?v=1&relay=…&host=…&hk=…&exp=…#s=…`. `S` sits in the fragment, which browsers
 * and link previews do not send anywhere.
 */
export const encodePairingLink = (offer: PairingOffer): string => {
  const query = new URLSearchParams({
    v: "1",
    relay: offer.relayUrl,
    host: offer.hostId,
    hk: encodeBase64url(offer.hostIdentityKey),
    exp: String(offer.expiresAt),
  });
  return `k3relay://pair?${query.toString()}#s=${encodeBase64url(offer.secret)}`;
};

export type PairingLinkResult =
  | { readonly ok: true; readonly offer: PairingOffer }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "insecure-relay" | "host-mismatch" | "expired";
    };

/** Strict parse: one of every field, nothing else, and a host id that matches `Hk`. */
export const parsePairingLink = (link: string, now: number): PairingLinkResult => {
  const malformed = { ok: false, reason: "malformed" } as const;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return malformed;
  }
  if (url.protocol !== PAIRING_LINK_PROTOCOL || url.host !== "pair" || url.pathname !== "") {
    return malformed;
  }
  if (url.username !== "" || url.password !== "" || url.port !== "") return malformed;
  const params = [...url.searchParams.keys()];
  if (params.length !== LINK_KEYS.length || [...params].sort().some((k, i) => k !== LINK_KEYS[i])) {
    return malformed;
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  if ([...fragment.keys()].join(",") !== "s") return malformed;
  const hostIdentityKey = decodeBase64url(url.searchParams.get("hk"), HOST_KEY_BYTES);
  const secret = decodeBase64url(fragment.get("s"), SECRET_BYTES);
  const hostId = url.searchParams.get("host");
  const exp = url.searchParams.get("exp") ?? "";
  const expiresAt = /^[1-9][0-9]{0,15}$/u.test(exp) ? Number(exp) : Number.NaN;
  if (
    url.searchParams.get("v") !== "1" ||
    hostIdentityKey === null ||
    secret === null ||
    !isRelayId(hostId) ||
    !Number.isSafeInteger(expiresAt)
  ) {
    return malformed;
  }
  const relayUrl = normalizeRelayUrl(url.searchParams.get("relay") ?? "");
  if (relayUrl === null) return { ok: false, reason: "insecure-relay" };
  if (relayHostId(hostIdentityKey) !== hostId) return { ok: false, reason: "host-mismatch" };
  if (expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, offer: { relayUrl, hostId, hostIdentityKey, secret, expiresAt } };
};

export const pairingProof = (input: {
  readonly secret: Uint8Array;
  readonly transcriptHash: Uint8Array;
  readonly alg: E2eeDeviceAlgorithm;
  readonly devicePublicKey: Uint8Array;
  readonly name: string;
}): Uint8Array =>
  hmac(
    sha256,
    input.secret,
    labeledMessage(
      LABEL_PROOF,
      input.transcriptHash,
      utf8(input.alg),
      input.devicePublicKey,
      utf8(input.name),
    ),
  );

export const keyProofMessage = (
  transcriptHash: Uint8Array,
  alg: E2eeDeviceAlgorithm,
  devicePublicKey: Uint8Array,
): Uint8Array => labeledMessage(LABEL_KEY_PROOF, transcriptHash, utf8(alg), devicePublicKey);

/**
 * `K7QM-2XFD`: 40 bits of `sha256(lp(label) ‖ lp(th) ‖ lp(Hk))`. Both sides show it; a relay
 * or a swapped link produces a different `th` (and `Hk`), so the codes differ.
 */
export const confirmationCode = (
  transcriptHash: Uint8Array,
  hostIdentityKey: Uint8Array,
): string => {
  const digest = sha256(labeledMessage(LABEL_CONFIRMATION, transcriptHash, hostIdentityKey));
  let bits = 0;
  let buffer = 0;
  let code = "";
  for (const byte of digest.subarray(0, 5)) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      code += CONFIRMATION_CODE_ALPHABET.charAt((buffer >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};

// ── Messages ──────────────────────────────────────────────────────────────────

export interface PairingClaimMessage {
  readonly type: "pairing-claim";
  readonly alg: E2eeDeviceAlgorithm;
  readonly dk: string;
  readonly name: string;
  readonly keyProof: string;
  readonly proof: string;
}

export type PairingRejectReason =
  | "no-window"
  | "expired"
  | "busy"
  | "too-many-attempts"
  | "invalid-claim"
  | "rejected";

const MAX_BOOTSTRAP_TOKEN_CHARS = 1024;

const isBootstrapToken = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_BOOTSTRAP_TOKEN_CHARS;

export type PairingReplyMessage =
  | {
      readonly type: "pairing-accepted";
      readonly grant: RelayGrant;
      readonly bootstrapToken: string;
    }
  | { readonly type: "pairing-rejected"; readonly reason: PairingRejectReason };

interface ParsedClaim {
  readonly alg: E2eeDeviceAlgorithm;
  readonly publicKey: Uint8Array;
  readonly name: string;
  readonly keyProof: Uint8Array;
  readonly proof: Uint8Array;
}

const hasExactKeys = (
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
};

const parseClaim = (value: unknown): ParsedClaim | null => {
  if (!hasExactKeys(value, CLAIM_KEYS) || value.type !== "pairing-claim") return null;
  const { alg, dk, name, keyProof, proof } = value;
  if (typeof alg !== "string" || !isDeviceAlgorithm(alg) || !isValidDeviceName(name)) return null;
  const publicKey = decodeBase64url(dk);
  const keyProofBytes = decodeBase64url(keyProof, SIGNATURE_BYTES);
  const proofBytes = decodeBase64url(proof, 32);
  if (publicKey === null || keyProofBytes === null || proofBytes === null) return null;
  if (!isCanonicalDevicePublicKey(alg, publicKey)) return null;
  return { alg, publicKey, name, keyProof: keyProofBytes, proof: proofBytes };
};

// ── Host ──────────────────────────────────────────────────────────────────────

export interface PendingPairingDevice {
  readonly alg: E2eeDeviceAlgorithm;
  readonly publicKey: Uint8Array;
  readonly deviceId: string;
  readonly name: string;
}

export type PairingCloseReason =
  | "approved"
  | "rejected"
  | "expired"
  | "too-many-attempts"
  | "cancelled";

/** At most one window per host: opening a new one replaces the old offer and its `S`. */
export type HostPairingState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "open";
      readonly offer: PairingOffer;
      readonly failedAttempts: number;
    }
  | {
      readonly phase: "awaiting-approval";
      readonly relayUrl: string;
      readonly hostIdentityKey: Uint8Array;
      readonly device: PendingPairingDevice;
      readonly confirmationCode: string;
      readonly approvalDeadline: number;
    }
  | { readonly phase: "closed"; readonly reason: PairingCloseReason };

export const initialHostPairingState: HostPairingState = { phase: "idle" };

const close = (state: HostPairingState, reason: PairingCloseReason): HostPairingState => {
  if (state.phase === "open") state.offer.secret.fill(0);
  return { phase: "closed", reason };
};

/** Opens the 5-minute window with a fresh `S`. The relay is told via `pairingOpenFrame`. */
export const openPairingWindow = Effect.fn("relay.openPairingWindow")(function* (input: {
  readonly hostIdentitySeed: Uint8Array;
  readonly relayUrl: string;
  readonly now: number;
  readonly previous?: HostPairingState | undefined;
}) {
  const relayUrl = normalizeRelayUrl(input.relayUrl);
  if (relayUrl === null) {
    return yield* new PairingError({ detail: "The relay URL must use https." });
  }
  if (input.hostIdentitySeed.length !== HOST_KEY_BYTES) {
    return yield* new PairingError({ detail: "The host identity seed must be 32 bytes." });
  }
  if (input.previous !== undefined) close(input.previous, "cancelled");
  const random = yield* SecureRandom.SecureRandom;
  const hostIdentityKey = identityPublicKeyFromSeed(input.hostIdentitySeed);
  const offer: PairingOffer = {
    relayUrl,
    hostId: relayHostId(hostIdentityKey),
    hostIdentityKey,
    secret: Uint8Array.from(yield* random.randomBytes(SECRET_BYTES)),
    expiresAt: input.now + PAIRING_OFFER_TTL_MS,
  };
  const state: HostPairingState = { phase: "open", offer, failedAttempts: 0 };
  return { state, offer, link: encodePairingLink(offer) };
});

export const cancelPairing = (state: HostPairingState): HostPairingState =>
  state.phase === "open" || state.phase === "awaiting-approval" ? close(state, "cancelled") : state;

/** Applies the clock: an open window lapses at `expiresAt`, a pending approval at its deadline. */
export const tickPairing = (state: HostPairingState, now: number): HostPairingState => {
  if (state.phase === "open" && now >= state.offer.expiresAt) return close(state, "expired");
  if (state.phase === "awaiting-approval" && now >= state.approvalDeadline) {
    return close(state, "expired");
  }
  return state;
};

export type ClaimOutcome =
  | {
      readonly kind: "awaiting-approval";
      readonly device: PendingPairingDevice;
      readonly confirmationCode: string;
    }
  | {
      readonly kind: "rejected";
      readonly reason: PairingRejectReason;
      readonly reply: PairingReplyMessage;
    };

const rejected = (
  state: HostPairingState,
  reason: PairingRejectReason,
): { readonly state: HostPairingState; readonly outcome: ClaimOutcome } => ({
  state,
  outcome: { kind: "rejected", reason, reply: { type: "pairing-rejected", reason } },
});

/**
 * Checks a claim that arrived inside the pairing E2EE session whose transcript hash is `th`.
 * Only a claim with a valid `proof` and `keyProof` spends `S`; any other claim counts as a
 * failed attempt, and the window closes once the limit is reached.
 */
export const submitPairingClaim = (
  current: HostPairingState,
  input: { readonly transcriptHash: Uint8Array; readonly message: unknown; readonly now: number },
): { readonly state: HostPairingState; readonly outcome: ClaimOutcome } => {
  const state = tickPairing(current, input.now);
  if (state.phase === "awaiting-approval") return rejected(state, "busy");
  if (state.phase !== "open") {
    return rejected(
      state,
      state.phase === "closed" && state.reason === "expired" ? "expired" : "no-window",
    );
  }
  if (input.transcriptHash.length !== TRANSCRIPT_BYTES) return rejected(state, "invalid-claim");

  const fail = () => {
    const failedAttempts = state.failedAttempts + 1;
    return failedAttempts >= PAIRING_MAX_FAILED_ATTEMPTS
      ? rejected(close(state, "too-many-attempts"), "too-many-attempts")
      : rejected({ ...state, failedAttempts }, "invalid-claim");
  };

  const claim = parseClaim(input.message);
  if (claim === null) return fail();
  const expected = pairingProof({
    secret: state.offer.secret,
    transcriptHash: input.transcriptHash,
    alg: claim.alg,
    devicePublicKey: claim.publicKey,
    name: claim.name,
  });
  if (!timingSafeEqual(expected, claim.proof)) return fail();
  if (
    !verifyDeviceSignature(
      claim.alg,
      claim.publicKey,
      keyProofMessage(input.transcriptHash, claim.alg, claim.publicKey),
      claim.keyProof,
    )
  ) {
    return fail();
  }

  const device: PendingPairingDevice = {
    alg: claim.alg,
    publicKey: claim.publicKey,
    deviceId: relayDeviceId(claim.alg, claim.publicKey),
    name: claim.name,
  };
  const code = confirmationCode(input.transcriptHash, state.offer.hostIdentityKey);
  const { relayUrl, hostIdentityKey } = state.offer;
  state.offer.secret.fill(0);
  return {
    state: {
      phase: "awaiting-approval",
      relayUrl,
      hostIdentityKey,
      device,
      confirmationCode: code,
      approvalDeadline: input.now + PAIRING_APPROVAL_TIMEOUT_MS,
    },
    outcome: { kind: "awaiting-approval", device, confirmationCode: code },
  };
};

/**
 * The user compared the codes and approved: issue the grant, register the device in the
 * ledger, and return the reply for the device and the frame for the relay (grant, no name).
 * A device that is already active keeps its ledger entry and just gets a fresh grant.
 */
export const approvePairing = Effect.fn("relay.approvePairing")(function* (
  current: HostPairingState,
  input: {
    readonly hostIdentitySeed: Uint8Array;
    readonly ledger: Pick<DeviceLedger, "add" | "get">;
    readonly bootstrapToken: string;
    readonly now: number;
  },
) {
  const state = tickPairing(current, input.now);
  if (state.phase !== "awaiting-approval") {
    return yield* new PairingError({ detail: "No verified pairing is waiting for approval." });
  }
  if (!isBootstrapToken(input.bootstrapToken)) {
    return yield* new PairingError({ detail: "The bootstrap credential is empty or too long." });
  }
  if (
    input.hostIdentitySeed.length !== HOST_KEY_BYTES ||
    !timingSafeEqual(identityPublicKeyFromSeed(input.hostIdentitySeed), state.hostIdentityKey)
  ) {
    return yield* new PairingError({ detail: "The host key changed during pairing." });
  }
  const { device } = state;
  const grant = yield* issueGrant({
    hostIdentitySeed: input.hostIdentitySeed,
    alg: device.alg,
    devicePublicKey: device.publicKey,
    now: input.now,
  });
  const existing = yield* input.ledger.get(device.deviceId);
  const entry: LedgerDevice =
    existing?.status === "active"
      ? existing
      : yield* input.ledger.add({
          alg: device.alg,
          publicKey: device.publicKey,
          name: device.name,
          now: input.now,
        });
  return {
    state: close(state, "approved"),
    device: entry,
    grant,
    reply: {
      type: "pairing-accepted",
      grant,
      bootstrapToken: input.bootstrapToken,
    } satisfies PairingReplyMessage,
    relayFrame: grantRegisterFrame(grant, device.publicKey),
  };
});

export const rejectPairing = (
  state: HostPairingState,
): { readonly state: HostPairingState; readonly reply: PairingReplyMessage } => ({
  state: state.phase === "closed" || state.phase === "idle" ? state : close(state, "rejected"),
  reply: { type: "pairing-rejected", reason: "rejected" },
});

/** Control frames that open and close the relay's pairing window for this host. */
export const pairingOpenFrame = (offer: PairingOffer) => ({
  type: "pairing-open" as const,
  expiresAt: offer.expiresAt,
});
export const pairingCloseFrame = () => ({ type: "pairing-close" as const });

// ── Device ────────────────────────────────────────────────────────────────────

/** What a paired device keeps per host. `S` is never stored. */
export interface DevicePairingRecord {
  readonly relayUrl: string;
  readonly hostId: string;
  /** The pinned `Hk`, base64url. Every later handshake must present exactly this key. */
  readonly hostIdentityKey: string;
  readonly grant: RelayGrant;
}

export type DevicePairingState =
  | { readonly phase: "offer"; readonly offer: PairingOffer }
  | {
      readonly phase: "awaiting-approval";
      readonly relayUrl: string;
      readonly hostId: string;
      readonly hostIdentityKey: Uint8Array;
      readonly alg: E2eeDeviceAlgorithm;
      readonly publicKey: Uint8Array;
      readonly confirmationCode: string;
    }
  | {
      readonly phase: "paired";
      readonly record: DevicePairingRecord;
      readonly bootstrapToken: string;
    }
  | {
      readonly phase: "failed";
      readonly reason:
        | Exclude<PairingLinkResult, { ok: true }>["reason"]
        | PairingRejectReason
        | "invalid-reply";
    };

/** Reads a scanned or opened link. The transport must pin `offer.hostIdentityKey`. */
export const startDevicePairing = (link: string, now: number): DevicePairingState => {
  const parsed = parsePairingLink(link, now);
  return parsed.ok
    ? { phase: "offer", offer: parsed.offer }
    : { phase: "failed", reason: parsed.reason };
};

/**
 * Builds the claim for the pairing E2EE session (transcript hash `th`) and the confirmation
 * code to show next to the host's.
 */
export const createPairingClaim = Effect.fn("relay.createPairingClaim")(function* (
  state: DevicePairingState,
  input: {
    readonly transcriptHash: Uint8Array;
    readonly signer: E2eeDeviceSigner;
    readonly name: string;
    readonly now: number;
  },
) {
  if (state.phase !== "offer") {
    return yield* new PairingError({ detail: "There is no pairing offer to claim." });
  }
  const { offer } = state;
  if (input.now >= offer.expiresAt) {
    return yield* new PairingError({ detail: "The pairing offer expired." });
  }
  if (input.transcriptHash.length !== TRANSCRIPT_BYTES || !isValidDeviceName(input.name)) {
    return yield* new PairingError({ detail: "The pairing claim is malformed." });
  }
  const { alg, publicKey } = input.signer;
  const keyProof = yield* input.signer
    .sign(keyProofMessage(input.transcriptHash, alg, publicKey))
    .pipe(Effect.mapError(() => new PairingError({ detail: "The device key could not sign." })));
  const proof = pairingProof({
    secret: offer.secret,
    transcriptHash: input.transcriptHash,
    alg,
    devicePublicKey: publicKey,
    name: input.name,
  });
  const claim: PairingClaimMessage = {
    type: "pairing-claim",
    alg,
    dk: encodeBase64url(publicKey),
    name: input.name,
    keyProof: encodeBase64url(keyProof),
    proof: encodeBase64url(proof),
  };
  const code = confirmationCode(input.transcriptHash, offer.hostIdentityKey);
  offer.secret.fill(0);
  const next: DevicePairingState = {
    phase: "awaiting-approval",
    relayUrl: offer.relayUrl,
    hostId: offer.hostId,
    hostIdentityKey: offer.hostIdentityKey,
    alg,
    publicKey,
    confirmationCode: code,
  };
  return { state: next, claim, confirmationCode: code };
});

const REJECT_REASONS: ReadonlyArray<string> = [
  "no-window",
  "expired",
  "busy",
  "too-many-attempts",
  "invalid-claim",
  "rejected",
];

/**
 * Handles the host's reply. A grant is kept only if the pinned `Hk` signed it for this
 * device's own key and it is currently valid.
 */
export const receivePairingReply = (
  state: DevicePairingState,
  message: unknown,
  now: number,
): DevicePairingState => {
  if (state.phase !== "awaiting-approval") return { phase: "failed", reason: "invalid-reply" };
  if (hasExactKeys(message, ["reason", "type"]) && message.type === "pairing-rejected") {
    const reason = message.reason;
    return typeof reason === "string" && REJECT_REASONS.includes(reason)
      ? { phase: "failed", reason: reason as PairingRejectReason }
      : { phase: "failed", reason: "invalid-reply" };
  }
  if (
    !hasExactKeys(message, ["bootstrapToken", "grant", "type"]) ||
    message.type !== "pairing-accepted" ||
    !isBootstrapToken(message.bootstrapToken)
  ) {
    return { phase: "failed", reason: "invalid-reply" };
  }
  const verdict = verifyGrant(message.grant, {
    hostIdentityKey: state.hostIdentityKey,
    alg: state.alg,
    devicePublicKey: state.publicKey,
    now,
  });
  if (!verdict.ok) return { phase: "failed", reason: "invalid-reply" };
  return {
    phase: "paired",
    record: {
      relayUrl: state.relayUrl,
      hostId: state.hostId,
      hostIdentityKey: encodeBase64url(state.hostIdentityKey),
      grant: verdict.grant,
    },
    bootstrapToken: message.bootstrapToken,
  };
};

/** Swaps in a renewed grant only if the pinned host signed it for this device's key. */
export const acceptRenewedGrant = (
  record: DevicePairingRecord,
  input: {
    readonly grant: unknown;
    readonly alg: E2eeDeviceAlgorithm;
    readonly devicePublicKey: Uint8Array;
    readonly now: number;
  },
): DevicePairingRecord | null => {
  const hostIdentityKey = decodeBase64url(record.hostIdentityKey, HOST_KEY_BYTES);
  if (hostIdentityKey === null) return null;
  const verdict = verifyGrant(input.grant, {
    hostIdentityKey,
    alg: input.alg,
    devicePublicKey: input.devicePublicKey,
    now: input.now,
  });
  if (!verdict.ok || verdict.grant.hostId !== record.hostId) return null;
  return verdict.grant.issuedAt > record.grant.issuedAt
    ? { ...record, grant: verdict.grant }
    : null;
};
