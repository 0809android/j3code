import * as SecureRandom from "effect/crypto/SecureRandom";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";

import { deviceIdFromPublicKey } from "../socketE2eeDevice.ts";
import { identityPublicKeyFromSeed } from "../socketE2eeV1.ts";
import {
  decodeBase64url,
  encodeBase64url,
  relayDeviceId,
  relayHostId,
  relaySigningInput,
} from "./encoding.ts";
import {
  GRANT_DEFAULT_TTL_MS,
  GRANT_FUTURE_SKEW_MS,
  GRANT_RENEW_BEFORE_MS,
  type RelayGrant,
  deserializeGrant,
  grantNeedsRenewal,
  grantRegisterFrame,
  grantSigningInput,
  issueGrant,
  parseGrant,
  revocationSigningInput,
  serializeGrant,
  signGrant,
  signRevocation,
  verifyGrant,
} from "./grant.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const seq = (start: number) => Uint8Array.from({ length: 32 }, (_, index) => start + index);

/**
 * Golden vectors produced by the relay's own code (`infra/k3-relay/src/crypto.ts` and
 * `bytes.ts`, signing with `node:crypto`), with the relay testkit's `EPOCH` and 90-day default.
 * Host seed 1..32, Ed25519 device seed 33..64, P-256 device scalar 0x11 × 32, nonce bytes 0..15.
 */
const RELAY = {
  epoch: 1_800_000_000_000,
  hk: "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ",
  hostId: "mw3am46w5weex4a4fqrc3avnub2a6knm",
  ed25519Dk: "5_FioQvsVZr-oZXk3OhLaVaNXSywlj60RsBoXisX8vA",
  p256Dk: "BAIX5hfwtkQ5KCePlpmeaaI6TywVK99tbN9m5bgCgtTtGUp968uXcS0t2jyoWqh2Wlb0X8dYWZZS8ol8ZTBuV5Q",
  nonce: "AAECAwQFBgcICQoLDA0ODw",
  ed25519: {
    grant: {
      v: 1,
      hostId: "mw3am46w5weex4a4fqrc3avnub2a6knm",
      deviceId: "s6smfdoididjwtrkil5cgrbzy67oi3gy",
      alg: "ed25519",
      issuedAt: 1800000000000,
      expiresAt: 1807776000000,
      nonce: "AAECAwQFBgcICQoLDA0ODw",
      sig: "jcMZRnrlXOR1Y04sN0yizS6FdIHFbfv8K_605xTUlQv0dCnYlccWJUS6eusXpx80m6m0WyynraKhve9iOfsrBw",
    },
    signingInputHex:
      "000000106b3372656c61792d76312f6772616e740000000131000000206d7733616d3436773577656578346134667172633361766e75623261366b6e6d000000207336736d66646f696469646a7774726b696c35636772627a7936376f6933677900000007656432353531390000000d313830303030303030303030300000000d313830373737363030303030300000001641414543417751464267634943516f4c4441304f4477",
  },
  p256: {
    grant: {
      v: 1,
      hostId: "mw3am46w5weex4a4fqrc3avnub2a6knm",
      deviceId: "aynmttbs23553txebbjhkk72fpnz67by",
      alg: "p256",
      issuedAt: 1800000000000,
      expiresAt: 1807776000000,
      nonce: "AAECAwQFBgcICQoLDA0ODw",
      sig: "Y5L_bE-5R96xb5flkl9AMhT6ejtQ2OA1JJbgdm9X4M6tNlOYJTewsX1DmpqCYTldbHA5UVPDx6VwMZz48zBcDQ",
    },
    signingInputHex:
      "000000106b3372656c61792d76312f6772616e740000000131000000206d7733616d3436773577656578346134667172633361766e75623261366b6e6d0000002061796e6d74746273323335353374786562626a686b6b373266706e7a3637627900000004703235360000000d313830303030303030303030300000000d313830373737363030303030300000001641414543417751464267634943516f4c4441304f4477",
  },
  revocation: {
    deviceId: "s6smfdoididjwtrkil5cgrbzy67oi3gy",
    issuedAt: 1800000001000,
    sig: "vQdh23URlqN2f-3rQ7xzL057fOEyLlfORtIwZa3XaeWFfV8Tti3T66htLeWt2MGhaMHBN4ZWVlA8nRqpZL6FCQ",
    signingInputHex:
      "000000116b3372656c61792d76312f7265766f6b65000000206d7733616d3436773577656578346134667172633361766e75623261366b6e6d000000207336736d66646f696469646a7774726b696c35636772627a7936376f693367790000000d31383030303030303031303030",
  },
} as const;

const hostSeed = seq(1);
const hk = identityPublicKeyFromSeed(hostSeed);
const edDk = ed25519.getPublicKey(seq(33));
const p256Dk = p256.getPublicKey(new Uint8Array(32).fill(0x11), false);
const otherHostSeed = seq(101);
const otherHk = identityPublicKeyFromSeed(otherHostSeed);
const now = RELAY.epoch;

const randomLayer = SecureRandom.layerWebCrypto;

const fixedGrant = (overrides: { readonly nonce?: string; readonly now?: number } = {}) =>
  signGrant({
    hostIdentitySeed: hostSeed,
    alg: "ed25519",
    devicePublicKey: edDk,
    now: overrides.now ?? now,
    nonce: overrides.nonce ?? RELAY.nonce,
  });

/** Re-signs an arbitrary body with a seed, to build grants the issuer would never produce. */
const resign = (body: Omit<RelayGrant, "sig">, seed: Uint8Array): RelayGrant => ({
  ...body,
  sig: encodeBase64url(ed25519.sign(grantSigningInput(body), seed)),
});

const check = (value: unknown, overrides: Partial<Parameters<typeof verifyGrant>[1]> = {}) =>
  verifyGrant(value, {
    hostIdentityKey: hk,
    alg: "ed25519",
    devicePublicKey: edDk,
    now,
    ...overrides,
  });

describe("relay encoding compatibility", () => {
  it("derives the relay's ids and keys from the fixed seeds", () => {
    assert.strictEqual(encodeBase64url(hk), RELAY.hk);
    assert.strictEqual(encodeBase64url(edDk), RELAY.ed25519Dk);
    assert.strictEqual(encodeBase64url(p256Dk), RELAY.p256Dk);
    assert.strictEqual(relayHostId(hk), RELAY.hostId);
    assert.strictEqual(relayDeviceId("ed25519", edDk), RELAY.ed25519.grant.deviceId);
    assert.strictEqual(relayDeviceId("p256", p256Dk), RELAY.p256.grant.deviceId);
  });

  it("uses u32 length prefixes, so the relay device id is not the E2EE one", () => {
    assert.strictEqual(hex(relaySigningInput("l", "x")), "000000016c0000000178");
    assert.notStrictEqual(relayDeviceId("ed25519", edDk), deviceIdFromPublicKey("ed25519", edDk));
  });

  it.effect("signs grants byte-for-byte like the relay, for both algorithms", () =>
    Effect.gen(function* () {
      for (const [alg, key, expected] of [
        ["ed25519", edDk, RELAY.ed25519],
        ["p256", p256Dk, RELAY.p256],
      ] as const) {
        const grant = yield* signGrant({
          hostIdentitySeed: hostSeed,
          alg,
          devicePublicKey: key,
          now,
          nonce: RELAY.nonce,
        });
        assert.deepStrictEqual(grant, expected.grant);
        assert.strictEqual(hex(grantSigningInput(grant)), expected.signingInputHex);
        assert.deepStrictEqual(
          verifyGrant(expected.grant, { hostIdentityKey: hk, alg, devicePublicKey: key, now }),
          { ok: true, grant: expected.grant },
        );
      }
    }),
  );

  it.effect("signs revocations byte-for-byte like the relay", () =>
    Effect.gen(function* () {
      const { deviceId, issuedAt, sig, signingInputHex } = RELAY.revocation;
      assert.strictEqual(
        hex(revocationSigningInput(RELAY.hostId, deviceId, issuedAt)),
        signingInputHex,
      );
      assert.deepStrictEqual(
        yield* signRevocation({ hostIdentitySeed: hostSeed, deviceId, now: issuedAt }),
        { deviceId, issuedAt, sig },
      );
    }),
  );

  it("decodes base64url only in its canonical, unpadded spelling", () => {
    for (let length = 0; length < 70; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + length) & 0xff);
      const text = encodeBase64url(bytes);
      assert.strictEqual(text, Buffer.from(bytes).toString("base64url"));
      assert.deepStrictEqual(decodeBase64url(text), bytes);
    }
    assert.isNull(decodeBase64url("AB"));
    assert.isNull(decodeBase64url("AA=="));
    assert.isNull(decodeBase64url("+/+/"));
    assert.isNull(decodeBase64url("A"));
    assert.isNull(decodeBase64url("AA", 2));
  });

  it("builds the relay's grant-register control frame", () => {
    const grant = RELAY.ed25519.grant as RelayGrant;
    assert.deepStrictEqual(grantRegisterFrame(grant, edDk), {
      type: "grant-register",
      grant,
      dk: RELAY.ed25519Dk,
    });
  });
});

describe("grant verification refuses forgeries", () => {
  it.effect("detects any changed field", () =>
    Effect.gen(function* () {
      const grant = yield* fixedGrant();
      const changed: ReadonlyArray<RelayGrant> = [
        { ...grant, expiresAt: grant.expiresAt + 1 },
        { ...grant, issuedAt: grant.issuedAt - 1 },
        { ...grant, deviceId: relayDeviceId("p256", p256Dk) },
        { ...grant, alg: "p256" },
        { ...grant, nonce: "BBECAwQFBgcICQoLDA0ODw" },
        { ...grant, hostId: relayHostId(otherHk) },
      ];
      for (const candidate of changed) {
        assert.isFalse(check(candidate).ok);
      }
      const sig = decodeBase64url(grant.sig, 64) ?? new Uint8Array(64);
      sig[5] = (sig[5] ?? 0) ^ 1;
      assert.deepStrictEqual(check({ ...grant, sig: encodeBase64url(sig) }), {
        ok: false,
        reason: "bad-signature",
      });
    }),
  );

  it.effect("refuses a grant that carries a name, scopes or any other field", () =>
    Effect.gen(function* () {
      const grant = yield* fixedGrant();
      for (const extra of [{ name: "Kino's iPhone" }, { scopes: ["admin"] }, { sig2: "" }]) {
        assert.deepStrictEqual(check({ ...grant, ...extra }), { ok: false, reason: "malformed" });
      }
      assert.isNull(parseGrant({ ...grant, v: 2 }));
      assert.isNull(parseGrant({ ...grant, expiresAt: grant.issuedAt }));
      assert.isNull(parseGrant({ ...grant, issuedAt: 1.5 }));
      assert.isNull(parseGrant({ ...grant, sig: `${grant.sig}=` }));
      assert.isNull(parseGrant([grant]));
    }),
  );

  it.effect("refuses a grant signed by another host's key", () =>
    Effect.gen(function* () {
      const foreign = yield* signGrant({
        hostIdentitySeed: otherHostSeed,
        alg: "ed25519",
        devicePublicKey: edDk,
        now,
        nonce: RELAY.nonce,
      });
      assert.deepStrictEqual(check(foreign), { ok: false, reason: "bad-signature" });
      // Claiming this host's id while signing with another key still fails the signature.
      const { sig: _sig, ...body } = yield* fixedGrant();
      assert.deepStrictEqual(check(resign(body, otherHostSeed)), {
        ok: false,
        reason: "bad-signature",
      });
      // A host key that signs a grant naming another host is not that host's grant.
      assert.deepStrictEqual(check(resign({ ...body, hostId: relayHostId(otherHk) }, hostSeed)), {
        ok: false,
        reason: "wrong-host",
      });
    }),
  );

  it.effect("binds the grant to the device key and algorithm", () =>
    Effect.gen(function* () {
      const grant = yield* fixedGrant();
      assert.deepStrictEqual(check(grant, { devicePublicKey: ed25519.getPublicKey(seq(200)) }), {
        ok: false,
        reason: "wrong-device",
      });
      assert.deepStrictEqual(check(grant, { alg: "p256", devicePublicKey: p256Dk }), {
        ok: false,
        reason: "wrong-device",
      });
    }),
  );

  it.effect("expires at expiresAt and refuses grants from the future", () =>
    Effect.gen(function* () {
      const grant = yield* fixedGrant();
      assert.isTrue(check(grant, { now: grant.expiresAt - 1 }).ok);
      assert.deepStrictEqual(check(grant, { now: grant.expiresAt }), {
        ok: false,
        reason: "expired",
      });
      assert.isTrue(check(grant, { now: now - GRANT_FUTURE_SKEW_MS }).ok);
      assert.deepStrictEqual(check(grant, { now: now - GRANT_FUTURE_SKEW_MS - 1 }), {
        ok: false,
        reason: "not-yet-valid",
      });
    }),
  );

  it.effect("keeps a revoked grant revoked; only a grant issued after it passes", () =>
    Effect.gen(function* () {
      const grant = yield* fixedGrant();
      assert.deepStrictEqual(check(grant, { revokedAt: grant.issuedAt }), {
        ok: false,
        reason: "revoked",
      });
      assert.deepStrictEqual(check(grant, { revokedAt: grant.issuedAt + 1, now: now + 10 }), {
        ok: false,
        reason: "revoked",
      });
      const reissued = yield* fixedGrant({ now: now + 2 });
      assert.isTrue(check(reissued, { revokedAt: grant.issuedAt + 1, now: now + 10 }).ok);
    }),
  );
});

describe("issuing and renewing", () => {
  it.effect("issues grants with fresh nonces that verify", () =>
    Effect.gen(function* () {
      const input = {
        hostIdentitySeed: hostSeed,
        alg: "p256",
        devicePublicKey: p256Dk,
        now,
      } as const;
      const first = yield* issueGrant(input);
      const second = yield* issueGrant(input);
      assert.notStrictEqual(first.nonce, second.nonce);
      assert.strictEqual(first.expiresAt - first.issuedAt, GRANT_DEFAULT_TTL_MS);
      assert.isTrue(
        verifyGrant(first, { hostIdentityKey: hk, alg: "p256", devicePublicKey: p256Dk, now }).ok,
      );
    }).pipe(Effect.provide(randomLayer)),
  );

  it.effect("refuses lifetimes past 90 days and non-canonical device keys", () =>
    Effect.gen(function* () {
      const base = {
        hostIdentitySeed: hostSeed,
        alg: "ed25519",
        devicePublicKey: edDk,
        now,
      } as const;
      for (const input of [
        { ...base, ttlMs: GRANT_DEFAULT_TTL_MS + 1 },
        { ...base, ttlMs: 0 },
        { ...base, devicePublicKey: edDk.subarray(0, 31) },
        {
          ...base,
          alg: "p256" as const,
          devicePublicKey: p256Dk.map((byte, i) => (i === 64 ? byte ^ 1 : byte)),
        },
        { ...base, hostIdentitySeed: seq(1).subarray(0, 16) },
      ]) {
        const exit = yield* Effect.exit(issueGrant(input));
        assert.isTrue(Exit.isFailure(exit));
      }
    }).pipe(Effect.provide(randomLayer)),
  );

  it.effect("asks for renewal once less than 30 days remain", () =>
    Effect.gen(function* () {
      const grant = yield* fixedGrant();
      assert.isFalse(grantNeedsRenewal(grant, grant.expiresAt - GRANT_RENEW_BEFORE_MS));
      assert.isTrue(grantNeedsRenewal(grant, grant.expiresAt - GRANT_RENEW_BEFORE_MS + 1));
    }),
  );

  it.effect("stores grants as canonical JSON and refuses tampered copies", () =>
    Effect.gen(function* () {
      const grant = yield* fixedGrant();
      const text = serializeGrant(grant);
      assert.deepStrictEqual(deserializeGrant(text), grant);
      assert.isNull(deserializeGrant("{"));
      assert.isNull(deserializeGrant(text.replace('"v":1', '"v":1,"name":"x"')));
    }),
  );
});
