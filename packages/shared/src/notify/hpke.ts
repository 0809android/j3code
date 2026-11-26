import * as Aead from "effect/crypto/Aead";
import * as Schema from "effect/Schema";
import { x25519 } from "@noble/curves/ed25519.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * HPKE (RFC 9180), base mode only, with one suite: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and
 * ChaCha20-Poly1305 (`kem_id` 0x0020, `kdf_id` 0x0001, `aead_id` 0x0003). It is the suite iOS
 * CryptoKit names `Curve25519_SHA256_ChachaPoly`, so the notification extension opens what this
 * seals. Synchronous, pure TypeScript: it runs on the host, in React Native and in tests alike.
 */

const HPKE_KEM_ID = 0x0020;
const HPKE_KDF_ID = 0x0001;
const HPKE_AEAD_ID = 0x0003;
export const HPKE_ENC_BYTES = 32;
export const HPKE_KEY_BYTES = 32;
export const HPKE_TAG_BYTES = 16;
const NONCE_BYTES = 12;
const MODE_BASE = 0x00;

const chacha = Aead.chacha20Poly1305.implementation!;
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const EMPTY = new Uint8Array(0);

const i2osp = (value: number, length: number): Uint8Array => {
  const out = new Uint8Array(length);
  let rest = value;
  for (let index = length - 1; index >= 0 && rest > 0; index -= 1) {
    out[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
};

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const HPKE_V1 = utf8("HPKE-v1");
const KEM_SUITE_ID = concat(utf8("KEM"), i2osp(HPKE_KEM_ID, 2));
const SUITE_ID = concat(
  utf8("HPKE"),
  i2osp(HPKE_KEM_ID, 2),
  i2osp(HPKE_KDF_ID, 2),
  i2osp(HPKE_AEAD_ID, 2),
);

const labeledExtract = (
  suiteId: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array,
): Uint8Array => extract(sha256, concat(HPKE_V1, suiteId, utf8(label), ikm), salt);

const labeledExpand = (
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Uint8Array =>
  expand(sha256, prk, concat(i2osp(length, 2), HPKE_V1, suiteId, utf8(label), info), length);

export class HpkeError extends Schema.TaggedError<HpkeError>()("HpkeError", {
  reason: Schema.Literals(["invalid-key", "open-failed", "sequence-overflow"]),
}) {
  override get message(): string {
    return `HPKE: ${this.reason}`;
  }
}

/** X25519 that refuses the all-zero output a low-order public key produces (RFC 9180 §7.1.4). */
const dh = (secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array => {
  if (secretKey.length !== HPKE_KEY_BYTES || publicKey.length !== HPKE_KEY_BYTES) {
    throw new HpkeError({ reason: "invalid-key" });
  }
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    throw new HpkeError({ reason: "invalid-key" });
  }
  let bits = 0;
  for (const byte of shared) bits |= byte;
  if (bits === 0) throw new HpkeError({ reason: "invalid-key" });
  return shared;
};

export const hpkePublicKey = (secretKey: Uint8Array): Uint8Array => {
  if (secretKey.length !== HPKE_KEY_BYTES) throw new HpkeError({ reason: "invalid-key" });
  return x25519.getPublicKey(secretKey);
};

/** `DeriveKeyPair(ikm)` for DHKEM(X25519): the secret is `LabeledExpand(dkp_prk, "sk", "", 32)`. */
export const hpkeDeriveKeyPair = (
  ikm: Uint8Array,
): { readonly secretKey: Uint8Array; readonly publicKey: Uint8Array } => {
  const prk = labeledExtract(KEM_SUITE_ID, EMPTY, "dkp_prk", ikm);
  const secretKey = labeledExpand(KEM_SUITE_ID, prk, "sk", EMPTY, HPKE_KEY_BYTES);
  return { secretKey, publicKey: hpkePublicKey(secretKey) };
};

export const hpkeGenerateKeyPair = (): {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
} => {
  const secretKey = x25519.utils.randomPrivateKey();
  return { secretKey, publicKey: hpkePublicKey(secretKey) };
};

const extractAndExpand = (dhOutput: Uint8Array, kemContext: Uint8Array): Uint8Array => {
  const prk = labeledExtract(KEM_SUITE_ID, EMPTY, "eae_prk", dhOutput);
  return labeledExpand(KEM_SUITE_ID, prk, "shared_secret", kemContext, 32);
};

export interface HpkeSchedule {
  readonly sharedSecret: Uint8Array;
  readonly key: Uint8Array;
  readonly baseNonce: Uint8Array;
  readonly exporterSecret: Uint8Array;
}

const keySchedule = (sharedSecret: Uint8Array, info: Uint8Array): HpkeSchedule => {
  const pskIdHash = labeledExtract(SUITE_ID, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(SUITE_ID, EMPTY, "info_hash", info);
  const context = concat(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
  const secret = labeledExtract(SUITE_ID, sharedSecret, "secret", EMPTY);
  return {
    sharedSecret,
    key: labeledExpand(SUITE_ID, secret, "key", context, HPKE_KEY_BYTES),
    baseNonce: labeledExpand(SUITE_ID, secret, "base_nonce", context, NONCE_BYTES),
    exporterSecret: labeledExpand(SUITE_ID, secret, "exp", context, 32),
  };
};

/**
 * One HPKE context. `seal` and `open` advance the sequence number, so a nonce is never used
 * twice under one key; notifications use a fresh context, and so sequence 0, every time.
 */
export interface HpkeContext {
  readonly schedule: HpkeSchedule;
  readonly seal: (plaintext: Uint8Array, aad?: Uint8Array) => Uint8Array;
  readonly open: (ciphertext: Uint8Array, aad?: Uint8Array) => Uint8Array;
  readonly export: (exporterContext: Uint8Array, length: number) => Uint8Array;
}

const makeContext = (schedule: HpkeSchedule): HpkeContext => {
  let sequence = 0;
  const nonce = () => {
    if (sequence >= Number.MAX_SAFE_INTEGER) throw new HpkeError({ reason: "sequence-overflow" });
    const out = i2osp(sequence, NONCE_BYTES);
    for (let index = 0; index < NONCE_BYTES; index += 1) {
      out[index] = (out[index] ?? 0) ^ (schedule.baseNonce[index] ?? 0);
    }
    return out;
  };
  return {
    schedule,
    seal: (plaintext, aad = EMPTY) => {
      const sealed = chacha.encrypt(schedule.key, nonce(), plaintext, aad);
      sequence += 1;
      return sealed;
    },
    open: (ciphertext, aad = EMPTY) => {
      const opened = chacha.decrypt(schedule.key, nonce(), ciphertext, aad);
      if (opened === undefined) throw new HpkeError({ reason: "open-failed" });
      sequence += 1;
      return opened;
    },
    export: (exporterContext, length) =>
      labeledExpand(SUITE_ID, schedule.exporterSecret, "sec", exporterContext, length),
  };
};

/**
 * `SetupBaseS(pkR, info)`. `ephemeralSecretKey` exists for the RFC test vectors only; leave it out
 * and a fresh ephemeral key is drawn from the platform's CSPRNG.
 */
export const hpkeSetupBaseSender = (input: {
  readonly recipientPublicKey: Uint8Array;
  readonly info: Uint8Array;
  readonly ephemeralSecretKey?: Uint8Array;
}): { readonly enc: Uint8Array; readonly context: HpkeContext } => {
  const ephemeral = input.ephemeralSecretKey ?? x25519.utils.randomPrivateKey();
  const enc = hpkePublicKey(ephemeral);
  const shared = extractAndExpand(
    dh(ephemeral, input.recipientPublicKey),
    concat(enc, input.recipientPublicKey),
  );
  return { enc, context: makeContext(keySchedule(shared, input.info)) };
};

/** `SetupBaseR(enc, skR, info)`. */
export const hpkeSetupBaseRecipient = (input: {
  readonly enc: Uint8Array;
  readonly recipientSecretKey: Uint8Array;
  readonly info: Uint8Array;
}): HpkeContext => {
  if (input.enc.length !== HPKE_ENC_BYTES) throw new HpkeError({ reason: "invalid-key" });
  const shared = extractAndExpand(
    dh(input.recipientSecretKey, input.enc),
    concat(input.enc, hpkePublicKey(input.recipientSecretKey)),
  );
  return makeContext(keySchedule(shared, input.info));
};

/** Single-shot `Seal`: a fresh ephemeral key, sequence 0. */
export const hpkeSeal = (input: {
  readonly recipientPublicKey: Uint8Array;
  readonly info: Uint8Array;
  readonly aad: Uint8Array;
  readonly plaintext: Uint8Array;
}): { readonly enc: Uint8Array; readonly ciphertext: Uint8Array } => {
  const { enc, context } = hpkeSetupBaseSender(input);
  return { enc, ciphertext: context.seal(input.plaintext, input.aad) };
};

/** Single-shot `Open`. Throws `HpkeError` when the key or the ciphertext is wrong. */
export const hpkeOpen = (input: {
  readonly enc: Uint8Array;
  readonly recipientSecretKey: Uint8Array;
  readonly info: Uint8Array;
  readonly aad: Uint8Array;
  readonly ciphertext: Uint8Array;
}): Uint8Array => hpkeSetupBaseRecipient(input).open(input.ciphertext, input.aad);
