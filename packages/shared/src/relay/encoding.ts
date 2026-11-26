import {
  type E2eeDeviceAlgorithm,
  deviceIdFromPublicKey,
  hostIdFromIdentityKey,
} from "../socketE2eeDevice.ts";

/**
 * The relay's wire encodings (`infra/k3-relay/src/bytes.ts` and `crypto.ts` are the source of
 * truth). Relay signing inputs length-prefix every part with a u32 big-endian length, unlike the
 * E2EE signing inputs, which use a u16. Device and host ids follow the relay in both layers.
 */

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;
const MAX_BASE64URL_TEXT = 4096;
const ID_PATTERN = /^[a-z2-7]{32}$/u;

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export const encodeBase64url = (bytes: Uint8Array): string => {
  let out = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const n =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out +=
      BASE64URL_ALPHABET.charAt((n >>> 18) & 63) +
      BASE64URL_ALPHABET.charAt((n >>> 12) & 63) +
      BASE64URL_ALPHABET.charAt((n >>> 6) & 63) +
      BASE64URL_ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const n = (bytes[index] ?? 0) << 16;
    out += BASE64URL_ALPHABET.charAt((n >>> 18) & 63) + BASE64URL_ALPHABET.charAt((n >>> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    out +=
      BASE64URL_ALPHABET.charAt((n >>> 18) & 63) +
      BASE64URL_ALPHABET.charAt((n >>> 12) & 63) +
      BASE64URL_ALPHABET.charAt((n >>> 6) & 63);
  }
  return out;
};

/**
 * Strict base64url, as the relay decodes it: no padding, no other alphabet, and only the
 * canonical spelling of the bytes, so one value has one text.
 */
export const decodeBase64url = (text: unknown, expectedLength?: number): Uint8Array | null => {
  if (typeof text !== "string" || text.length > MAX_BASE64URL_TEXT) return null;
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of text) {
    buffer = ((buffer << 6) | BASE64URL_ALPHABET.indexOf(char)) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset] = (buffer >>> bits) & 0xff;
      offset += 1;
    }
  }
  if (encodeBase64url(out) !== text) return null;
  if (expectedLength !== undefined && out.length !== expectedLength) return null;
  return out;
};

/** Every part preceded by its length as a u32 big-endian, the relay's `lengthPrefixed`. */
export const relayLengthPrefixed = (...parts: ReadonlyArray<string | Uint8Array>): Uint8Array => {
  const encoded = parts.map((part) => (typeof part === "string" ? utf8(part) : part));
  const out = new Uint8Array(encoded.reduce((total, part) => total + 4 + part.length, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of encoded) {
    view.setUint32(offset, part.length, false);
    out.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return out;
};

/** `signingInput("k3relay-v1/x", a, b)`: the label first, then every part, all length-prefixed. */
export const relaySigningInput = (
  label: string,
  ...parts: ReadonlyArray<string | Uint8Array>
): Uint8Array => relayLengthPrefixed(label, ...parts);

export const isRelayId = (value: unknown): value is string =>
  typeof value === "string" && ID_PATTERN.test(value);

/** `base32(sha256(Hk))`, first 32 characters. Same as the E2EE host id. */
export const relayHostId = (hostIdentityKey: Uint8Array): string =>
  hostIdFromIdentityKey(hostIdentityKey);

/**
 * `base32(sha256(lp32(alg) ‖ lp32(Dk)))`, first 32 characters: the id the relay computes and
 * the one grants and the host ledger carry. The E2EE layer derives the same id.
 */
export const relayDeviceId = (alg: E2eeDeviceAlgorithm, devicePublicKey: Uint8Array): string =>
  deviceIdFromPublicKey(alg, devicePublicKey);
