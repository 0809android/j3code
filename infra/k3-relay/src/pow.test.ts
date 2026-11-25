import { describe, expect, it } from "vite-plus/test";

import { checkSolution, issueChallenge, leadingZeroBits, solveChallenge } from "./pow.ts";

const secret = Buffer.alloc(32, 9);
const hk = Buffer.alloc(32, 1);
const now = 1_800_000_000_000;
const TTL = 300_000;

describe("proof of work", () => {
  it("counts leading zero bits", () => {
    expect(leadingZeroBits(Buffer.from([0, 0, 0x10]))).toBe(19);
    expect(leadingZeroBits(Buffer.from([0x80]))).toBe(0);
    expect(leadingZeroBits(Buffer.from([0, 0]))).toBe(16);
  });

  it("accepts a solved challenge issued for this key", () => {
    const challenge = issueChallenge(secret, hk, now, 8);
    const solution = solveChallenge(hk, challenge);
    expect(checkSolution(secret, hk, challenge, solution, now + 1000, TTL)).toEqual({
      ok: true,
      mac: challenge.mac,
    });
  });

  it("binds the challenge to the host key, the difficulty and the issue time", () => {
    const challenge = issueChallenge(secret, hk, now, 8);
    const solution = solveChallenge(hk, challenge);
    const otherKey = Buffer.alloc(32, 2);
    expect(checkSolution(secret, otherKey, challenge, solution, now, TTL)).toMatchObject({
      reason: "forged",
    });
    expect(
      checkSolution(secret, hk, { ...challenge, difficulty: 0 }, solution, now, TTL),
    ).toMatchObject({ reason: "forged" });
    expect(
      checkSolution(secret, hk, { ...challenge, ts: now + 1 }, solution, now, TTL),
    ).toMatchObject({ reason: "forged" });
    expect(checkSolution(Buffer.alloc(32, 3), hk, challenge, solution, now, TTL)).toMatchObject({
      reason: "forged",
    });
  });

  it("expires old challenges and rejects work that is too small", () => {
    const challenge = issueChallenge(secret, hk, now, 12);
    const solution = solveChallenge(hk, challenge);
    expect(checkSolution(secret, hk, challenge, solution, now + TTL + 1, TTL)).toMatchObject({
      reason: "expired",
    });
    const easy = issueChallenge(secret, hk, now, 16);
    expect(checkSolution(secret, hk, easy, "AAAAAAAAAAA", now, TTL)).toMatchObject({
      reason: "work",
    });
  });

  it("rejects malformed input without throwing", () => {
    const challenge = issueChallenge(secret, hk, now, 4);
    expect(checkSolution(secret, hk, null, "AA", now, TTL)).toMatchObject({ reason: "malformed" });
    expect(
      checkSolution(secret, hk, { ...challenge, difficulty: 99 }, "AA", now, TTL),
    ).toMatchObject({
      reason: "malformed",
    });
    expect(checkSolution(secret, hk, challenge, 5, now, TTL)).toMatchObject({
      reason: "malformed",
    });
    expect(checkSolution(secret, hk, challenge, "", now, TTL)).toMatchObject({
      reason: "malformed",
    });
  });
});
