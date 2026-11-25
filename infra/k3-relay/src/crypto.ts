// @effect-diagnostics nodeBuiltinImport:off -- the relay verifies Ed25519 and P-256 signatures natively.
import * as NodeCrypto from "node:crypto";

import { base32, decodeBase64url, lengthPrefixed } from "./bytes.ts";

export type DeviceAlg = "ed25519" | "p256";

export const LABELS = {
  hostControl: "k3relay-v1/host-control",
  client: "k3relay-v1/client",
  grant: "k3relay-v1/grant",
  revoke: "k3relay-v1/revoke",
  status: "k3relay-v1/status",
  register: "k3relay-v1/register",
  pow: "k3relay-v1/pow",
  powChallenge: "k3relay-v1/pow-challenge",
} as const;

const KEY_LENGTHS: Record<DeviceAlg, number> = { ed25519: 32, p256: 65 };
const SIGNATURE_LENGTH = 64;
const ID_PATTERN = /^[a-z2-7]{32}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

// SubjectPublicKeyInfo prefixes for raw keys: Ed25519, and an uncompressed P-256 point.
const SPKI_PREFIX: Record<DeviceAlg, Buffer> = {
  ed25519: Buffer.from("302a300506032b6570032100", "hex"),
  p256: Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
};

export const isDeviceAlg = (value: unknown): value is DeviceAlg =>
  value === "ed25519" || value === "p256";

export const isId = (value: unknown): value is string =>
  typeof value === "string" && ID_PATTERN.test(value);

export const keyLength = (alg: DeviceAlg): number => KEY_LENGTHS[alg];

export const signatureLength = SIGNATURE_LENGTH;

/** `signingInput("k3relay-v1/x", a, b)`: the label first, then every part, all length-prefixed. */
export function signingInput(label: string, ...parts: ReadonlyArray<string | Uint8Array>): Buffer {
  return lengthPrefixed(label, ...parts);
}

export function hostIdOf(hk: Uint8Array): string {
  return base32(NodeCrypto.createHash("sha256").update(hk).digest()).slice(0, 32);
}

export function deviceIdOf(alg: DeviceAlg, dk: Uint8Array): string {
  const digest = NodeCrypto.createHash("sha256").update(lengthPrefixed(alg, dk)).digest();
  return base32(digest).slice(0, 32);
}

const keyCache = new Map<string, NodeCrypto.KeyObject>();
const KEY_CACHE_LIMIT = 512;

function publicKeyObject(alg: DeviceAlg, key: Uint8Array): NodeCrypto.KeyObject | null {
  if (key.length !== KEY_LENGTHS[alg]) return null;
  const cacheKey = `${alg}:${Buffer.from(key).toString("base64")}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  try {
    const object = NodeCrypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX[alg], key]),
      format: "der",
      type: "spki",
    });
    if (keyCache.size >= KEY_CACHE_LIMIT) keyCache.clear();
    keyCache.set(cacheKey, object);
    return object;
  } catch {
    return null;
  }
}

/** Ed25519 (raw 32-byte key, 64-byte signature) or P-256 (X9.63 key, r||s signature). */
export function verifySignature(
  alg: DeviceAlg,
  key: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signature.length !== SIGNATURE_LENGTH) return false;
  const object = publicKeyObject(alg, key);
  if (!object) return false;
  try {
    return alg === "ed25519"
      ? NodeCrypto.verify(null, message, object, signature)
      : NodeCrypto.verify("sha256", message, { key: object, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}

export interface Grant {
  readonly v: 1;
  readonly hostId: string;
  readonly deviceId: string;
  readonly alg: DeviceAlg;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly sig: string;
}

const GRANT_KEYS = ["alg", "deviceId", "expiresAt", "hostId", "issuedAt", "nonce", "sig", "v"];

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * Strict shape check. Unknown keys are rejected so a grant can never carry a device name or
 * permissions, and so the relay never stores one.
 */
export function parseGrant(value: unknown): Grant | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== GRANT_KEYS.length || keys.some((key, index) => key !== GRANT_KEYS[index])) {
    return null;
  }
  const { v, hostId, deviceId, alg, issuedAt, expiresAt, nonce, sig } = record;
  if (v !== 1 || !isId(hostId) || !isId(deviceId) || !isDeviceAlg(alg)) return null;
  if (!isTimestamp(issuedAt) || !isTimestamp(expiresAt) || expiresAt <= issuedAt) return null;
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) return null;
  if (typeof sig !== "string" || decodeBase64url(sig, SIGNATURE_LENGTH) === null) return null;
  return { v: 1, hostId, deviceId, alg, issuedAt, expiresAt, nonce, sig };
}

export function grantSigningInput(grant: Grant): Buffer {
  return signingInput(
    LABELS.grant,
    String(grant.v),
    grant.hostId,
    grant.deviceId,
    grant.alg,
    String(grant.issuedAt),
    String(grant.expiresAt),
    grant.nonce,
  );
}

export function verifyGrantSignature(grant: Grant, hk: Uint8Array): boolean {
  const sig = decodeBase64url(grant.sig, SIGNATURE_LENGTH);
  return sig !== null && verifySignature("ed25519", hk, grantSigningInput(grant), sig);
}

export function revokeSigningInput(hostId: string, deviceId: string, issuedAt: number): Buffer {
  return signingInput(LABELS.revoke, hostId, deviceId, String(issuedAt));
}
