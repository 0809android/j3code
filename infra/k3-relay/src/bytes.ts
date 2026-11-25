const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Strict base64url: no padding, no other alphabet, and the text must be the canonical
 * encoding of the bytes, so one value has one spelling.
 */
export function decodeBase64url(text: unknown, expectedLength?: number): Buffer | null {
  if (typeof text !== "string" || text.length > 4096 || !BASE64URL_PATTERN.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) return null;
  if (expectedLength !== undefined && bytes.length !== expectedLength) return null;
  return bytes;
}

const toBytes = (part: string | Uint8Array): Uint8Array =>
  typeof part === "string" ? Buffer.from(part, "utf8") : part;

/** Length-prefixed concatenation: every part is preceded by its length as a u32 big-endian. */
export function lengthPrefixed(...parts: ReadonlyArray<string | Uint8Array>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = toBytes(part);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(bytes.length, 0);
    chunks.push(prefix, Buffer.from(bytes));
  }
  return Buffer.concat(chunks);
}

export function u64be(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value), 0);
  return out;
}
