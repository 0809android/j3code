import * as Aead from "effect/crypto/Aead";
import type * as CryptoError from "effect/crypto/CryptoError";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Socket from "effect/socket/Socket";

/** Byte helpers, errors, and counter-ordered XChaCha20-Poly1305 records shared by v1 and v2. */

export const KEY_LENGTH = 32;
export const NONCE_LENGTH = 32;
export const SIGNATURE_LENGTH = 64;
const RECORD_COUNTER_LENGTH = 8;
export const RECORD_HEADER_LENGTH = 1 + RECORD_COUNTER_LENGTH;
export const TAG_LENGTH = 16;
export const DIRECTION_C2S = 0x01;
export const DIRECTION_S2C = 0x02;
export const CLIENT_HELLO_TYPE = 0xc1;
export const SERVER_HELLO_TYPE = 0xc2;
/** Nonce for XChaCha20-Poly1305: a zero prefix followed by the record counter. */
const NONCE_PREFIX_LENGTH = 16;
/** Rekeying is out of scope; close long before the counter space thins. */
const MAX_RECORD_COUNTER = 2 ** 32 - 1;

export class E2eeProtocolError extends Schema.TaggedError<E2eeProtocolError>()(
  "E2eeProtocolError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const E2EE_IDENTITY_MISMATCH_CODE = "E2EE_IDENTITY_MISMATCH";

/** The server identity key differs from the pinned one: a re-paired server, or a MITM. */
export class E2eeIdentityMismatchError extends Schema.TaggedError<E2eeIdentityMismatchError>()(
  "E2eeIdentityMismatchError",
  {
    pinnedFingerprint: Schema.String,
    receivedFingerprint: Schema.String,
  },
) {
  override get message(): string {
    return `${E2EE_IDENTITY_MISMATCH_CODE}: the server's identity key changed from ${this.pinnedFingerprint} to ${this.receivedFingerprint}.`;
  }
}

export type E2eeHandshakeError = E2eeProtocolError | E2eeIdentityMismatchError;

export const E2eeRejectionReason = Schema.Literals([
  "revoked",
  "unknown-device",
  "key-mismatch",
  "grant-expired",
  "host-policy",
  "limit",
]);
export type E2eeRejectionReason = typeof E2eeRejectionReason.Type;

/** The host refused this device, delivered over the authenticated channel. */
export class E2eeRejectedError extends Schema.TaggedError<E2eeRejectedError>()(
  "E2eeRejectedError",
  { reason: E2eeRejectionReason },
) {
  override get message(): string {
    return `The host refused the E2EE session: ${this.reason}.`;
  }
}

/** Everything a handshake or record step can fail with. */
export type E2eeFailure =
  | E2eeHandshakeError
  | E2eeRejectedError
  | CryptoError.CryptoError
  | Socket.SocketError;

export const isProtocolError = Schema.is(E2eeProtocolError);
export const isRejectedError = Schema.is(E2eeRejectedError);

/** The service shape the wrappers run their records against. */
export type AeadService = Aead.Aead["Service"];

export const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const bigEndianCounter = (counter: number): Uint8Array => {
  const bytes = new Uint8Array(RECORD_COUNTER_LENGTH);
  let value = counter;
  for (let index = RECORD_COUNTER_LENGTH - 1; index >= 0; index -= 1) {
    bytes[index] = value % 256;
    value = Math.floor(value / 256);
  }
  return bytes;
};

const readBigEndianCounter = (bytes: Uint8Array, offset: number): number => {
  let value = 0;
  for (let index = 0; index < RECORD_COUNTER_LENGTH; index += 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  return value;
};

/** A 16-bit big-endian length followed by the bytes. */
export const lengthPrefixedBytes = (value: Uint8Array): Uint8Array => {
  if (value.length > 0xffff) {
    throw new E2eeProtocolError({ detail: "An E2EE field is too long to length-prefix." });
  }
  return concatBytes(new Uint8Array([value.length >> 8, value.length & 0xff]), value);
};

export const timingSafeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

export interface E2eeSession {
  readonly sendKey: Aead.Key;
  readonly recvKey: Aead.Key;
  sendCounter: number;
  recvCounter: number;
}

const nextNonce = (counter: number): Uint8Array => {
  const nonce = new Uint8Array(NONCE_PREFIX_LENGTH + RECORD_COUNTER_LENGTH);
  nonce.set(bigEndianCounter(counter), NONCE_PREFIX_LENGTH);
  return nonce;
};

const aad = (recordVersion: number, direction: number, counter: number): Uint8Array =>
  concatBytes(new Uint8Array([recordVersion, direction]), bigEndianCounter(counter));

/** Encrypts under the next send counter and returns the whole wire record. */
export const sealRecord = Effect.fnUntraced(function* (
  session: E2eeSession,
  aead: AeadService,
  plaintext: Uint8Array,
  direction: number,
  recordVersion: number,
) {
  if (session.sendCounter >= MAX_RECORD_COUNTER) {
    return yield* new E2eeProtocolError({
      detail: "The E2EE session reached its record limit. Reconnect for fresh keys.",
    });
  }
  const counter = session.sendCounter;
  session.sendCounter += 1;
  const ciphertext = yield* aead.encrypt(session.sendKey, plaintext, {
    nonce: nextNonce(counter),
    aad: aad(recordVersion, direction, counter),
  });
  return concatBytes(new Uint8Array([recordVersion]), bigEndianCounter(counter), ciphertext);
});

export const openRecord = Effect.fnUntraced(function* (
  session: E2eeSession,
  aead: AeadService,
  frame: Uint8Array,
  direction: number,
  recordVersion: number,
) {
  if (frame.length < RECORD_HEADER_LENGTH + TAG_LENGTH) {
    return yield* new E2eeProtocolError({ detail: "E2EE record is too short." });
  }
  if (frame[0] !== recordVersion) {
    return yield* new E2eeProtocolError({ detail: "Unknown E2EE record version." });
  }
  const counter = readBigEndianCounter(frame, 1);
  if (counter !== session.recvCounter) {
    return yield* new E2eeProtocolError({
      detail:
        counter < session.recvCounter
          ? "E2EE record replayed."
          : "E2EE record arrived out of order.",
    });
  }
  const plaintext = yield* aead.decrypt(session.recvKey, frame.slice(RECORD_HEADER_LENGTH), {
    nonce: nextNonce(counter),
    aad: aad(recordVersion, direction, counter),
  });
  session.recvCounter += 1;
  return plaintext;
});
