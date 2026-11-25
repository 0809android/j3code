import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";

import {
  type E2eeDeviceAlgorithm,
  type E2eeDeviceSigner,
  deviceSignerFromKeypair,
} from "../socketE2eeDevice.ts";
import { identityPublicKeyFromSeed } from "../socketE2eeV1.ts";
import {
  accountKeyProofMessage,
  createAccountClaim,
  decideAccountApproval,
  pkceChallenge,
  readAccountSessionToken,
  submitAccountClaim,
  verifyAccountHostTicket,
} from "./account.ts";
import { defaultApprovalPolicy, disableApproval, openAddDeviceWindow } from "./approval.ts";
import { encodeBase64url, relayDeviceId, relayHostId, relaySigningInput } from "./encoding.ts";
import {
  type HostPairingState,
  confirmationCode,
  openPairingWindow,
  receivePairingReply,
} from "./pairing.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";

const NOW = 1_800_000_000_000;
const ISSUER = "https://relay.k3.kinocode.jp";
const RELAY_URL = "https://relay.k3.kinocode.jp/";
const ACCOUNT = "abcdefghijklmnopqrstuvwxyz234567";
const OTHER_ACCOUNT = "bbcdefghijklmnopqrstuvwxyz234567";
const relaySecret = new Uint8Array(32).fill(0x33);
const relayKey = ed25519.getPublicKey(relaySecret);
const hostSeed = new Uint8Array(32).fill(0x05);
const hk = identityPublicKeyFromSeed(hostSeed);
const hostId = relayHostId(hk);
const th = new Uint8Array(32).fill(0xa1);
const thOther = new Uint8Array(32).fill(0xb2);

const signer = (alg: E2eeDeviceAlgorithm, n: number): E2eeDeviceSigner => {
  const secretKey = new Uint8Array(32).fill(n);
  return deviceSignerFromKeypair({
    alg,
    secretKey,
    publicKey:
      alg === "ed25519" ? ed25519.getPublicKey(secretKey) : p256.getPublicKey(secretKey, false),
  });
};

/** Signs exactly as the relay's `AccountTokens.sign` does (infra/k3-relay/src/account.ts). */
const relayToken = (claims: Record<string, unknown>, secret = relaySecret): string => {
  const payload = new TextEncoder().encode(JSON.stringify(claims));
  const sig = ed25519.sign(relaySigningInput("k3relay-v1/account-token", payload), secret);
  return `k3a1.${encodeBase64url(payload)}.${encodeBase64url(sig)}`;
};

const ticketFor = (device: E2eeDeviceSigner, overrides: Record<string, unknown> = {}) =>
  relayToken({
    v: 1,
    typ: "host-access",
    iss: ISSUER,
    sub: ACCOUNT,
    aud: hostId,
    cnf: relayDeviceId(device.alg, device.publicKey),
    iat: NOW,
    exp: NOW + 300_000,
    ...overrides,
  });

const binding = { issuer: ISSUER, accountId: ACCOUNT, accountKey: relayKey };

const claimFrom = (device: E2eeDeviceSigner, ticket: string, transcript = th) =>
  createAccountClaim({
    transcriptHash: transcript,
    signer: device,
    name: "Kino's Pixel",
    ticket,
    relayUrl: RELAY_URL,
    hostIdentityKey: hk,
  });

const submit = (message: unknown, state: HostPairingState = { phase: "idle" }, transcript = th) =>
  submitAccountClaim(state, {
    transcriptHash: transcript,
    message,
    now: NOW,
    relayUrl: RELAY_URL,
    hostIdentityKey: hk,
    binding,
  });

describe("account tickets", () => {
  const device = signer("ed25519", 7);
  const deviceId = relayDeviceId(device.alg, device.publicKey);
  const expected = {
    accountKey: relayKey,
    issuer: ISSUER,
    hostId,
    accountId: ACCOUNT,
    deviceId,
    now: NOW,
  };

  it("accepts a ticket the relay signed for this host, account and key", () => {
    assert.isTrue(verifyAccountHostTicket(ticketFor(device), expected).ok);
  });

  it("refuses a ticket from another key, host, account, device, issuer, or an old one", () => {
    const reason = (token: string) => {
      const verdict = verifyAccountHostTicket(token, expected);
      return verdict.ok ? "ok" : verdict.reason;
    };
    assert.strictEqual(reason(relayToken({}, new Uint8Array(32).fill(9))), "signature");
    assert.strictEqual(reason(ticketFor(device, { aud: "a".repeat(32) })), "audience");
    assert.strictEqual(reason(ticketFor(device, { iss: "https://evil.example" })), "audience");
    assert.strictEqual(reason(ticketFor(device, { sub: OTHER_ACCOUNT })), "account");
    assert.strictEqual(reason(ticketFor(signer("ed25519", 8))), "key");
    assert.strictEqual(reason(ticketFor(device, { exp: NOW })), "expired");
    assert.strictEqual(reason(ticketFor(device, { typ: "session" })), "malformed");
    assert.strictEqual(reason(ticketFor(device, { extra: "name" })), "malformed");
    const token = ticketFor(device);
    assert.strictEqual(reason(`${token.slice(0, -2)}AA`), "signature");
  });

  it("refuses a token signed over the E2EE layer's framing instead of the relay's", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        typ: "host-access",
        iss: ISSUER,
        sub: ACCOUNT,
        aud: hostId,
        cnf: relayDeviceId(device.alg, device.publicKey),
        iat: NOW,
        exp: NOW + 1,
      }),
    );
    const label = new TextEncoder().encode("k3relay-v1/account-token");
    const u16 = (bytes: Uint8Array) => [bytes.length >> 8, bytes.length & 0xff, ...bytes];
    const sig = ed25519.sign(Uint8Array.from([...u16(label), ...u16(payload)]), relaySecret);
    const token = `k3a1.${encodeBase64url(payload)}.${encodeBase64url(sig)}`;
    assert.isFalse(verifyAccountHostTicket(token, expected).ok);
  });

  it("reads a session token only with the relay's key", () => {
    const session = relayToken({
      v: 1,
      typ: "session",
      iss: ISSUER,
      sub: ACCOUNT,
      kid: hostId,
      use: "host",
      iat: NOW,
      exp: NOW + 1,
    });
    assert.strictEqual(readAccountSessionToken(session, relayKey)?.sub, ACCOUNT);
    assert.isNull(readAccountSessionToken(session, ed25519.getPublicKey(new Uint8Array(32))));
  });

  it("computes the PKCE S256 challenge as the relay checks it (base64url of SHA-256)", () => {
    assert.strictEqual(
      pkceChallenge("dBjftJeZ4CVP-mJ92K9N1N1Qp5g5Xc_GkS4M7Ti5k0w"),
      "LRwFtMB4XfJFoqxYAny8aqaOWdgNHpvpajnkvWrBDzY",
    );
  });
});

describe("account claims", () => {
  it.effect("puts a verified claim in front of the user, with the same code on both sides", () =>
    Effect.gen(function* () {
      const device = signer("p256", 3);
      const created = yield* claimFrom(device, ticketFor(device));
      const result = submit(created.claim);
      assert.strictEqual(result.outcome.kind, "awaiting-approval");
      assert.strictEqual(result.state.phase, "awaiting-approval");
      if (result.state.phase !== "awaiting-approval") return;
      assert.strictEqual(result.state.confirmationCode, created.confirmationCode);
      assert.strictEqual(result.state.confirmationCode, confirmationCode(th, hk));
      assert.strictEqual(result.state.device.name, "Kino's Pixel");
    }),
  );

  it.effect("refuses a key proof from another handshake (a relayed claim)", () =>
    Effect.gen(function* () {
      const device = signer("ed25519", 4);
      const created = yield* claimFrom(device, ticketFor(device), thOther);
      assert.deepStrictEqual(submit(created.claim).outcome, {
        kind: "rejected",
        reason: "invalid-claim",
      });
    }),
  );

  it.effect("refuses a ticket for another key, account or host", () =>
    Effect.gen(function* () {
      const device = signer("ed25519", 4);
      const other = signer("ed25519", 5);
      const wrongKey = yield* claimFrom(device, ticketFor(other));
      assert.deepStrictEqual(submit(wrongKey.claim).outcome, {
        kind: "rejected",
        reason: "invalid-claim",
      });
      const wrongAccount = yield* claimFrom(device, ticketFor(device, { sub: OTHER_ACCOUNT }));
      assert.deepStrictEqual(submit(wrongAccount.claim).outcome, {
        kind: "rejected",
        reason: "not-on-account",
      });
      const wrongHost = yield* claimFrom(device, ticketFor(device, { aud: "c".repeat(32) }));
      assert.strictEqual(submit(wrongHost.claim).outcome.kind, "rejected");
    }),
  );

  it.effect("refuses everything when this host is not on an account", () =>
    Effect.gen(function* () {
      const device = signer("ed25519", 4);
      const created = yield* claimFrom(device, ticketFor(device));
      const result = submitAccountClaim(
        { phase: "idle" },
        {
          transcriptHash: th,
          message: created.claim,
          now: NOW,
          relayUrl: RELAY_URL,
          hostIdentityKey: hk,
          binding: null,
        },
      );
      assert.deepStrictEqual(result.outcome, { kind: "rejected", reason: "not-on-account" });
    }),
  );

  it.effect("takes one decision at a time, and cancels a pending QR offer", () =>
    Effect.gen(function* () {
      const device = signer("ed25519", 4);
      const created = yield* claimFrom(device, ticketFor(device));
      const first = submit(created.claim);
      assert.deepStrictEqual(submit(created.claim, first.state).outcome, {
        kind: "rejected",
        reason: "busy",
      });
      const opened = yield* openPairingWindow({
        hostIdentitySeed: hostSeed,
        relayUrl: RELAY_URL,
        now: NOW,
      }).pipe(Effect.provide(SecureRandom.layerWebCrypto));
      const secret = opened.offer.secret;
      const replaced = submit(created.claim, opened.state);
      assert.strictEqual(replaced.state.phase, "awaiting-approval");
      assert.isTrue(secret.every((byte) => byte === 0));
    }),
  );

  it.effect("refuses extra fields, a device name with controls, and a forged proof", () =>
    Effect.gen(function* () {
      const device = signer("ed25519", 4);
      const created = yield* claimFrom(device, ticketFor(device));
      assert.strictEqual(submit({ ...created.claim, scopes: ["admin"] }).outcome.kind, "rejected");
      assert.strictEqual(submit({ ...created.claim, name: "a\u0000b" }).outcome.kind, "rejected");
      const forgedProof = encodeBase64url(
        ed25519.sign(accountKeyProofMessage(th, "ed25519", device.publicKey), new Uint8Array(32)),
      );
      assert.strictEqual(
        submit({ ...created.claim, keyProof: forgedProof }).outcome.kind,
        "rejected",
      );
    }),
  );

  it.effect("lets the device accept the host's grant through the pairing reply", () =>
    Effect.gen(function* () {
      const device = signer("ed25519", 4);
      const created = yield* claimFrom(device, ticketFor(device));
      const reply = receivePairingReply(
        created.state,
        { type: "pairing-rejected", reason: "rejected" },
        NOW,
      );
      assert.deepStrictEqual(reply, { phase: "failed", reason: "rejected" });
    }),
  );
});

describe("account approval", () => {
  it("compares codes by default, even with no window open", () => {
    assert.deepStrictEqual(
      decideAccountApproval({ policy: defaultApprovalPolicy, window: null, now: NOW }),
      { kind: "compare-code" },
    );
  });

  it("lets the first device in a window the host's user opened through with one tap", () => {
    const window = openAddDeviceWindow({ kind: "host-user" }, NOW);
    assert.deepStrictEqual(
      decideAccountApproval({ policy: defaultApprovalPolicy, window, now: NOW + 1 }),
      { kind: "one-tap" },
    );
    assert.deepStrictEqual(
      decideAccountApproval({
        policy: defaultApprovalPolicy,
        window: window && { ...window, used: true },
        now: NOW + 1,
      }),
      { kind: "compare-code" },
    );
    assert.deepStrictEqual(
      decideAccountApproval({ policy: defaultApprovalPolicy, window, now: NOW + 11 * 60_000 }),
      { kind: "compare-code" },
    );
    const byDevice = openAddDeviceWindow(
      { kind: "device", deviceId: "d", permissions: ["devices:invite"] },
      NOW,
    );
    assert.deepStrictEqual(
      decideAccountApproval({ policy: defaultApprovalPolicy, window: byDevice, now: NOW + 1 }),
      { kind: "compare-code" },
    );
  });

  it("skips the user only after a recorded opt-out", () => {
    assert.deepStrictEqual(
      decideAccountApproval({ policy: disableApproval(NOW), window: null, now: NOW }),
      { kind: "auto-approve" },
    );
    assert.deepStrictEqual(
      decideAccountApproval({
        policy: { requireApproval: false, optOut: null },
        window: null,
        now: NOW,
      }),
      { kind: "compare-code" },
    );
  });
});
