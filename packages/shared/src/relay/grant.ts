import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ed25519 } from "@noble/curves/ed25519.js";

import {
  type E2eeDeviceAlgorithm,
  isCanonicalDevicePublicKey,
  isDeviceAlgorithm,
} from "../socketE2eeDevice.ts";
import { identityPublicKeyFromSeed } from "../socketE2eeV1.ts";
import {
  decodeBase64url,
  encodeBase64url,
  isRelayId,
  relayDeviceId,
  relayHostId,
  relaySigningInput,
} from "./encoding.ts";

/**
 * Relay grants (spec §5): a ticket, signed by the host key `Hk`, that only lets a device into
 * the relay. It never carries a device name or permissions; the host's ledger decides access.
 * The encoding and every check mirror `infra/k3-relay/src/crypto.ts` and the relay's client
 * authentication, which are the source of truth.
 */

export const GRANT_LABEL = "k3relay-v1/grant";
export const REVOKE_LABEL = "k3relay-v1/revoke";

const DAY_MS = 86_400_000;
export const GRANT_DEFAULT_TTL_MS = 90 * DAY_MS;
/** Grants never outlive the default; renewal issues a new one instead. */
export const GRANT_MAX_TTL_MS = GRANT_DEFAULT_TTL_MS;
/** A device that connects with less than this left gets a fresh grant inside the E2E channel. */
export const GRANT_RENEW_BEFORE_MS = 30 * DAY_MS;
/** The relay refuses grants issued further than this in its future. */
export const GRANT_FUTURE_SKEW_MS = 5 * 60_000;

const SIGNATURE_LENGTH = 64;
const NONCE_BYTES = 16;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const GRANT_KEYS = ["alg", "deviceId", "expiresAt", "hostId", "issuedAt", "nonce", "sig", "v"];

export interface RelayGrant {
  readonly v: 1;
  readonly hostId: string;
  readonly deviceId: string;
  readonly alg: E2eeDeviceAlgorithm;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  /** base64url Ed25519 signature by `Hk` over `grantSigningInput`. */
  readonly sig: string;
}

export class RelayGrantError extends Schema.TaggedError<RelayGrantError>()("RelayGrantError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * Strict shape check, identical to the relay's `parseGrant`. Unknown keys are refused so a
 * grant can never carry a name or scopes.
 */
export const parseGrant = (value: unknown): RelayGrant | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== GRANT_KEYS.length || keys.some((key, index) => key !== GRANT_KEYS[index])) {
    return null;
  }
  const { v, hostId, deviceId, alg, issuedAt, expiresAt, nonce, sig } = record;
  if (v !== 1 || !isRelayId(hostId) || !isRelayId(deviceId)) return null;
  if (typeof alg !== "string" || !isDeviceAlgorithm(alg)) return null;
  if (!isTimestamp(issuedAt) || !isTimestamp(expiresAt) || expiresAt <= issuedAt) return null;
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) return null;
  if (typeof sig !== "string" || decodeBase64url(sig, SIGNATURE_LENGTH) === null) return null;
  return { v: 1, hostId, deviceId, alg, issuedAt, expiresAt, nonce, sig };
};

export const grantSigningInput = (grant: Omit<RelayGrant, "sig">): Uint8Array =>
  relaySigningInput(
    GRANT_LABEL,
    String(grant.v),
    grant.hostId,
    grant.deviceId,
    grant.alg,
    String(grant.issuedAt),
    String(grant.expiresAt),
    grant.nonce,
  );

export const verifyGrantSignature = (grant: RelayGrant, hostIdentityKey: Uint8Array): boolean => {
  const sig = decodeBase64url(grant.sig, SIGNATURE_LENGTH);
  if (sig === null || hostIdentityKey.length !== 32) return false;
  try {
    return ed25519.verify(sig, grantSigningInput(grant), hostIdentityKey, { zip215: false });
  } catch {
    return false;
  }
};

export interface IssueGrantInput {
  /** The host's Ed25519 identity seed, whose public key is `Hk`. */
  readonly hostIdentitySeed: Uint8Array;
  readonly alg: E2eeDeviceAlgorithm;
  readonly devicePublicKey: Uint8Array;
  readonly now: number;
  /** Defaults to 90 days; never longer. */
  readonly ttlMs?: number | undefined;
}

const HOST_SEED_LENGTH = 32;

/** Builds and signs a grant from explicit parts, so tests can pin the nonce. */
export const signGrant = Effect.fn("relay.signGrant")(function* (
  input: IssueGrantInput & { readonly nonce: string },
) {
  const ttlMs = input.ttlMs ?? GRANT_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > GRANT_MAX_TTL_MS) {
    return yield* new RelayGrantError({ detail: "A grant must expire within 90 days." });
  }
  if (!isTimestamp(input.now)) {
    return yield* new RelayGrantError({ detail: "A grant needs a valid issue time." });
  }
  if (!isCanonicalDevicePublicKey(input.alg, input.devicePublicKey)) {
    return yield* new RelayGrantError({ detail: "The device key is not canonical." });
  }
  if (!NONCE_PATTERN.test(input.nonce)) {
    return yield* new RelayGrantError({ detail: "The grant nonce is malformed." });
  }
  if (input.hostIdentitySeed.length !== HOST_SEED_LENGTH) {
    return yield* new RelayGrantError({ detail: "The host identity seed must be 32 bytes." });
  }
  const hostIdentityKey = identityPublicKeyFromSeed(input.hostIdentitySeed);
  const body = {
    v: 1 as const,
    hostId: relayHostId(hostIdentityKey),
    deviceId: relayDeviceId(input.alg, input.devicePublicKey),
    alg: input.alg,
    issuedAt: input.now,
    expiresAt: input.now + ttlMs,
    nonce: input.nonce,
  };
  const sig = ed25519.sign(grantSigningInput(body), input.hostIdentitySeed);
  return { ...body, sig: encodeBase64url(sig) } satisfies RelayGrant;
});

/** Issues a fresh grant with a random nonce. Hosts call this on approval and on renewal. */
export const issueGrant = Effect.fn("relay.issueGrant")(function* (input: IssueGrantInput) {
  const random = yield* SecureRandom.SecureRandom;
  const nonce = encodeBase64url(Uint8Array.from(yield* random.randomBytes(NONCE_BYTES)));
  return yield* signGrant({ ...input, nonce });
});

export type GrantVerdict =
  | { readonly ok: true; readonly grant: RelayGrant }
  | {
      readonly ok: false;
      readonly reason:
        | "malformed"
        | "bad-signature"
        | "wrong-host"
        | "wrong-device"
        | "not-yet-valid"
        | "revoked"
        | "expired";
    };

export interface VerifyGrantInput {
  /** The pinned or own `Hk`; the grant's host id must be derived from it. */
  readonly hostIdentityKey: Uint8Array;
  readonly alg: E2eeDeviceAlgorithm;
  readonly devicePublicKey: Uint8Array;
  readonly now: number;
  /** A revocation time: grants issued at or before it are revoked, as at the relay. */
  readonly revokedAt?: number | undefined;
}

/** The relay's full admission check for a grant, for hosts and devices. */
export const verifyGrant = (value: unknown, input: VerifyGrantInput): GrantVerdict => {
  const grant = parseGrant(value);
  if (grant === null) return { ok: false, reason: "malformed" };
  if (!verifyGrantSignature(grant, input.hostIdentityKey)) {
    return { ok: false, reason: "bad-signature" };
  }
  if (grant.hostId !== relayHostId(input.hostIdentityKey)) {
    return { ok: false, reason: "wrong-host" };
  }
  if (
    grant.alg !== input.alg ||
    !isCanonicalDevicePublicKey(input.alg, input.devicePublicKey) ||
    grant.deviceId !== relayDeviceId(input.alg, input.devicePublicKey)
  ) {
    return { ok: false, reason: "wrong-device" };
  }
  if (grant.issuedAt > input.now + GRANT_FUTURE_SKEW_MS) {
    return { ok: false, reason: "not-yet-valid" };
  }
  if (input.revokedAt !== undefined && grant.issuedAt <= input.revokedAt) {
    return { ok: false, reason: "revoked" };
  }
  if (grant.expiresAt <= input.now) return { ok: false, reason: "expired" };
  return { ok: true, grant };
};

/** True once less than 30 days remain (or the grant already lapsed). */
export const grantNeedsRenewal = (grant: RelayGrant, now: number): boolean =>
  grant.expiresAt - now < GRANT_RENEW_BEFORE_MS;

/** Canonical JSON for storage, in a fixed key order. */
export const serializeGrant = (grant: RelayGrant): string =>
  JSON.stringify({
    v: grant.v,
    hostId: grant.hostId,
    deviceId: grant.deviceId,
    alg: grant.alg,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    nonce: grant.nonce,
    sig: grant.sig,
  });

export const deserializeGrant = (text: string): RelayGrant | null => {
  try {
    return parseGrant(JSON.parse(text));
  } catch {
    return null;
  }
};

export interface RelayRevocation {
  readonly deviceId: string;
  readonly issuedAt: number;
  readonly sig: string;
}

export const revocationSigningInput = (
  hostId: string,
  deviceId: string,
  issuedAt: number,
): Uint8Array => relaySigningInput(REVOKE_LABEL, hostId, deviceId, String(issuedAt));

/**
 * The relay's advisory copy of a revocation (control `revoke` or `POST /v1/grants/revoke`).
 * The host ledger stays authoritative; the relay just stops admitting older grants.
 */
export const signRevocation = Effect.fn("relay.signRevocation")(function* (input: {
  readonly hostIdentitySeed: Uint8Array;
  readonly deviceId: string;
  readonly now: number;
}) {
  if (
    !isRelayId(input.deviceId) ||
    !isTimestamp(input.now) ||
    input.hostIdentitySeed.length !== HOST_SEED_LENGTH
  ) {
    return yield* new RelayGrantError({ detail: "The revocation is malformed." });
  }
  const hostId = relayHostId(identityPublicKeyFromSeed(input.hostIdentitySeed));
  const sig = ed25519.sign(
    revocationSigningInput(hostId, input.deviceId, input.now),
    input.hostIdentitySeed,
  );
  return {
    deviceId: input.deviceId,
    issuedAt: input.now,
    sig: encodeBase64url(sig),
  } satisfies RelayRevocation;
});

/** The control frame that hands the relay a grant (without a name) after approval. */
export const grantRegisterFrame = (grant: RelayGrant, devicePublicKey: Uint8Array) => ({
  type: "grant-register" as const,
  grant,
  dk: encodeBase64url(devicePublicKey),
});
