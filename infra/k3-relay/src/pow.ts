// @effect-diagnostics nodeBuiltinImport:off -- the relay computes HMAC and SHA-256 natively.
import * as NodeCrypto from "node:crypto";

import { base64url, decodeBase64url, u64be } from "./bytes.ts";
import { LABELS, signingInput } from "./crypto.ts";

/**
 * A stateless proof-of-work challenge. The relay signs (HMAC) the issue time, the difficulty
 * and a salt, together with the host key, so the challenge only works for that key and
 * the relay keeps nothing between issuing and checking it.
 */
export interface PowChallenge {
  readonly ts: number;
  readonly difficulty: number;
  readonly salt: string;
  readonly mac: string;
}

export const MAX_DIFFICULTY = 32;
const SALT_LENGTH = 16;
const MAC_LENGTH = 32;
const MAX_SOLUTION_LENGTH = 32;

function challengeMac(
  secret: Buffer,
  hk: Uint8Array,
  ts: number,
  difficulty: number,
  salt: Buffer,
) {
  return NodeCrypto.createHmac("sha256", secret)
    .update(signingInput(LABELS.powChallenge, hk, salt, u64be(ts), Buffer.from([difficulty])))
    .digest();
}

export function issueChallenge(
  secret: Buffer,
  hk: Uint8Array,
  now: number,
  difficulty: number,
): PowChallenge {
  const salt = NodeCrypto.randomBytes(SALT_LENGTH);
  return {
    ts: now,
    difficulty,
    salt: base64url(salt),
    mac: base64url(challengeMac(secret, hk, now, difficulty, salt)),
  };
}

export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export function powDigest(hk: Uint8Array, mac: string, solution: Uint8Array): Buffer {
  return NodeCrypto.createHash("sha256")
    .update(signingInput(LABELS.pow, hk, mac, solution))
    .digest();
}

export type ChallengeCheck =
  | { readonly ok: true; readonly mac: string }
  | { readonly ok: false; readonly reason: "malformed" | "expired" | "forged" | "work" };

/** Checks the relay's own MAC, the age of the challenge, and the work in the solution. */
export function checkSolution(
  secret: Buffer,
  hk: Uint8Array,
  challenge: unknown,
  solution: unknown,
  now: number,
  ttlMs: number,
): ChallengeCheck {
  if (typeof challenge !== "object" || challenge === null)
    return { ok: false, reason: "malformed" };
  const { ts, difficulty, salt, mac } = challenge as Record<string, unknown>;
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0) {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof difficulty !== "number" ||
    !Number.isInteger(difficulty) ||
    difficulty < 0 ||
    difficulty > MAX_DIFFICULTY
  ) {
    return { ok: false, reason: "malformed" };
  }
  const saltBytes = decodeBase64url(salt, SALT_LENGTH);
  const macBytes = decodeBase64url(mac, MAC_LENGTH);
  const solutionBytes = decodeBase64url(solution);
  if (
    saltBytes === null ||
    macBytes === null ||
    solutionBytes === null ||
    typeof mac !== "string" ||
    solutionBytes.length === 0 ||
    solutionBytes.length > MAX_SOLUTION_LENGTH
  ) {
    return { ok: false, reason: "malformed" };
  }
  const expected = challengeMac(secret, hk, ts, difficulty, saltBytes);
  if (!NodeCrypto.timingSafeEqual(expected, macBytes)) return { ok: false, reason: "forged" };
  if (now - ts > ttlMs || ts - now > 5_000) return { ok: false, reason: "expired" };
  if (leadingZeroBits(powDigest(hk, mac, solutionBytes)) < difficulty) {
    return { ok: false, reason: "work" };
  }
  return { ok: true, mac };
}

/** The client side of the work, used by hosts and by the tests. */
export function solveChallenge(hk: Uint8Array, challenge: PowChallenge): string {
  const solution = Buffer.alloc(8);
  for (let counter = 0; ; counter += 1) {
    solution.writeBigUInt64BE(BigInt(counter), 0);
    if (leadingZeroBits(powDigest(hk, challenge.mac, solution)) >= challenge.difficulty) {
      return base64url(solution);
    }
  }
}

export function registrationSigningInput(hk: Uint8Array, mac: string, solution: string): Buffer {
  return signingInput(LABELS.register, hk, mac, solution);
}
