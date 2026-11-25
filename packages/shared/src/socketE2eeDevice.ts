import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  E2eeProtocolError,
  KEY_LENGTH,
  SIGNATURE_LENGTH,
  concatBytes,
  lengthPrefixedBytes,
} from "./socketE2eeRecord.ts";

/**
 * Device identity keys (`Dk`) for E2EE v2: Ed25519 or P-256, in one canonical
 * encoding each, and the ids derived from them. Every signature covers a
 * role label first, so a signature made for one role never verifies in another.
 */

export type E2eeDeviceAlgorithm = "ed25519" | "p256";

export const E2EE_DEVICE_ALGORITHMS: ReadonlyArray<E2eeDeviceAlgorithm> = ["ed25519", "p256"];

/** P-256 public keys are uncompressed X9.63 points. */
const P256_PUBLIC_KEY_LENGTH = 65;
const P256_UNCOMPRESSED_PREFIX = 0x04;
const ID_LENGTH = 32;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export interface E2eeDeviceIdentity {
  readonly alg: E2eeDeviceAlgorithm;
  readonly publicKey: Uint8Array;
  readonly deviceId: string;
}

/** Signs the exact bytes it is given; keys may live outside the process. */
export interface E2eeDeviceSigner {
  readonly alg: E2eeDeviceAlgorithm;
  readonly publicKey: Uint8Array;
  readonly sign: (message: Uint8Array) => Effect.Effect<Uint8Array, E2eeProtocolError>;
}

export interface E2eeDeviceKeypair {
  readonly alg: E2eeDeviceAlgorithm;
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export const isDeviceAlgorithm = (value: string): value is E2eeDeviceAlgorithm =>
  value === "ed25519" || value === "p256";

/** RFC 4648 base32, lowercase, unpadded. */
const base32 = (bytes: Uint8Array): string => {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
};

/** The concatenation every signature and key derivation uses: each part length-prefixed. */
export const labeledMessage = (label: string, ...parts: ReadonlyArray<Uint8Array>): Uint8Array =>
  concatBytes(lengthPrefixedBytes(utf8(label)), ...parts.map(lengthPrefixedBytes));

export const isCanonicalDevicePublicKey = (
  alg: E2eeDeviceAlgorithm,
  publicKey: Uint8Array,
): boolean => {
  if (alg === "ed25519") return publicKey.length === KEY_LENGTH;
  if (publicKey.length !== P256_PUBLIC_KEY_LENGTH || publicKey[0] !== P256_UNCOMPRESSED_PREFIX) {
    return false;
  }
  try {
    p256.ProjectivePoint.fromHex(publicKey).assertValidity();
    return true;
  } catch {
    return false;
  }
};

/** `base32(sha256(lp(alg) ‖ lp(Dk)))`, first 32 characters. */
export const deviceIdFromPublicKey = (alg: E2eeDeviceAlgorithm, publicKey: Uint8Array): string =>
  base32(sha256(concatBytes(lengthPrefixedBytes(utf8(alg)), lengthPrefixedBytes(publicKey)))).slice(
    0,
    ID_LENGTH,
  );

/** `base32(sha256(Hk))`, first 32 characters. */
export const hostIdFromIdentityKey = (identityPublicKey: Uint8Array): string =>
  base32(sha256(identityPublicKey)).slice(0, ID_LENGTH);

export const deviceIdentity = (
  alg: E2eeDeviceAlgorithm,
  publicKey: Uint8Array,
): E2eeDeviceIdentity => ({ alg, publicKey, deviceId: deviceIdFromPublicKey(alg, publicKey) });

/** Strict verification: raw 64-byte signatures only, never DER. */
export const verifyDeviceSignature = (
  alg: E2eeDeviceAlgorithm,
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean => {
  if (signature.length !== SIGNATURE_LENGTH || !isCanonicalDevicePublicKey(alg, publicKey)) {
    return false;
  }
  try {
    return alg === "ed25519"
      ? ed25519.verify(signature, message, publicKey, { zip215: false })
      : // WebCrypto and secure enclaves do not normalize s, so both halves verify.
        p256.verify(signature, message, publicKey, {
          prehash: true,
          lowS: false,
          format: "compact",
        });
  } catch {
    return false;
  }
};

export const devicePublicKeyFromSecretKey = (
  alg: E2eeDeviceAlgorithm,
  secretKey: Uint8Array,
): Uint8Array =>
  alg === "ed25519" ? ed25519.getPublicKey(secretKey) : p256.getPublicKey(secretKey, false);

export const generateDeviceKeypair = Effect.fn("socketE2ee.generateDeviceKeypair")(function* (
  alg: E2eeDeviceAlgorithm,
) {
  const random = yield* SecureRandom.SecureRandom;
  while (true) {
    const secretKey = Uint8Array.from(yield* random.randomBytes(KEY_LENGTH));
    if (alg === "p256" && !p256.utils.isValidPrivateKey(secretKey)) continue;
    return {
      alg,
      secretKey,
      publicKey: devicePublicKeyFromSecretKey(alg, secretKey),
    } satisfies E2eeDeviceKeypair;
  }
});

/** A signer over an in-memory secret key (ECDSA-SHA256 with r‖s output for P-256). */
export const deviceSignerFromKeypair = (keypair: E2eeDeviceKeypair): E2eeDeviceSigner => ({
  alg: keypair.alg,
  publicKey: keypair.publicKey,
  sign: (message) =>
    Effect.try({
      try: () =>
        keypair.alg === "ed25519"
          ? ed25519.sign(message, keypair.secretKey)
          : p256.sign(message, keypair.secretKey, { prehash: true }).toCompactRawBytes(),
      catch: () => new E2eeProtocolError({ detail: "The device key could not sign." }),
    }),
});
