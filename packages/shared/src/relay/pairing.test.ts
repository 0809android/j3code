import * as SecureRandom from "effect/crypto/SecureRandom";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";

import {
  type E2eeDeviceAlgorithm,
  type E2eeDeviceSigner,
  deviceIdentity,
  deviceSignerFromKeypair,
} from "../socketE2eeDevice.ts";
import { identityPublicKeyFromSeed } from "../socketE2eeV1.ts";
import { decodeBase64url, encodeBase64url, relayDeviceId, relayHostId } from "./encoding.ts";
import { signGrant, verifyGrant } from "./grant.ts";
import { ledgerVerifyDevice, makeDeviceLedger, makeMemoryLedgerStore } from "./ledger.ts";
import {
  CONFIRMATION_CODE_ALPHABET,
  type DevicePairingState,
  type HostPairingState,
  PAIRING_APPROVAL_TIMEOUT_MS,
  PAIRING_MAX_FAILED_ATTEMPTS,
  PAIRING_OFFER_TTL_MS,
  type PairingClaimMessage,
  type PairingOffer,
  acceptRenewedGrant,
  approvePairing,
  confirmationCode,
  createPairingClaim,
  encodePairingLink,
  keyProofMessage,
  openPairingWindow,
  pairingCloseFrame,
  pairingOpenFrame,
  pairingProof,
  parsePairingLink,
  receivePairingReply,
  rejectPairing,
  startDevicePairing,
  submitPairingClaim,
  tickPairing,
} from "./pairing.ts";

const NOW = 1_800_000_000_000;
const RELAY_URL = "https://relay.k3.kinocode.jp/";
const seq = (start: number) =>
  Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
const hostSeed = seq(1);
const hk = identityPublicKeyFromSeed(hostSeed);
const thA = new Uint8Array(32).fill(0xa1);
const thB = new Uint8Array(32).fill(0xb2);

const signer = (alg: E2eeDeviceAlgorithm, n: number): E2eeDeviceSigner => {
  const secretKey = new Uint8Array(32).fill(n);
  return deviceSignerFromKeypair({
    alg,
    secretKey,
    publicKey:
      alg === "ed25519" ? ed25519.getPublicKey(secretKey) : p256.getPublicKey(secretKey, false),
  });
};
const phone = signer("ed25519", 7);
const attacker = signer("ed25519", 8);
const browser = signer("p256", 9);

const open = (now = NOW, previous?: HostPairingState) =>
  openPairingWindow({ hostIdentitySeed: hostSeed, relayUrl: RELAY_URL, now, previous });

/** The device side up to its claim, from the link the host showed. */
const deviceClaim = (
  link: string,
  options: { th?: Uint8Array; device?: E2eeDeviceSigner; now?: number; name?: string } = {},
) =>
  createPairingClaim(startDevicePairing(link, options.now ?? NOW), {
    transcriptHash: options.th ?? thA,
    signer: options.device ?? phone,
    name: options.name ?? "Kino's phone",
    now: options.now ?? NOW,
  });

/** A claim built by hand, for attackers that know or guess some of the inputs. */
const forgeClaim = (input: {
  readonly secret: Uint8Array;
  readonly th: Uint8Array;
  readonly claimedKey: E2eeDeviceSigner;
  readonly keySigner: E2eeDeviceSigner;
  readonly name?: string;
}) =>
  Effect.gen(function* () {
    const name = input.name ?? "Kino's phone";
    const { alg, publicKey } = input.claimedKey;
    const keyProof = yield* input.keySigner.sign(keyProofMessage(input.th, alg, publicKey));
    return {
      type: "pairing-claim",
      alg,
      dk: encodeBase64url(publicKey),
      name,
      keyProof: encodeBase64url(keyProof),
      proof: encodeBase64url(
        pairingProof({
          secret: input.secret,
          transcriptHash: input.th,
          alg,
          devicePublicKey: publicKey,
          name,
        }),
      ),
    } satisfies PairingClaimMessage;
  });

const secretOf = (link: string): Uint8Array => {
  const parsed = parsePairingLink(link, NOW);
  if (!parsed.ok) throw new Error(`unparseable link: ${parsed.reason}`);
  return parsed.offer.secret;
};

const reason = (result: ReturnType<typeof submitPairingClaim>) =>
  result.outcome.kind === "rejected" ? result.outcome.reason : result.outcome.kind;

it.layer(SecureRandom.layerWebCrypto)("pairing", (it) => {
  describe("end to end", () => {
    it.effect("pairs a device: matching codes, grant, ledger entry, and a stored pin", () =>
      Effect.gen(function* () {
        const host = yield* open();
        assert.deepStrictEqual(pairingOpenFrame(host.offer), {
          type: "pairing-open",
          expiresAt: NOW + PAIRING_OFFER_TTL_MS,
        });
        const device = yield* deviceClaim(host.link, { device: browser });
        const submitted = submitPairingClaim(host.state, {
          transcriptHash: thA,
          message: device.claim,
          now: NOW + 1,
        });
        assert.strictEqual(submitted.state.phase, "awaiting-approval");
        assert.deepStrictEqual(submitted.outcome, {
          kind: "awaiting-approval",
          confirmationCode: device.confirmationCode,
          device: {
            alg: "p256",
            publicKey: browser.publicKey,
            deviceId: relayDeviceId("p256", browser.publicKey),
            name: "Kino's phone",
          },
        });
        // S is spent on both sides.
        assert.isTrue(host.offer.secret.every((byte) => byte === 0));

        const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
        const approved = yield* approvePairing(submitted.state, {
          hostIdentitySeed: hostSeed,
          ledger,
          now: NOW + 2,
        });
        assert.deepStrictEqual(approved.state, { phase: "closed", reason: "approved" });
        assert.strictEqual(approved.device.name, "Kino's phone");
        assert.deepStrictEqual(approved.relayFrame, {
          type: "grant-register",
          grant: approved.grant,
          dk: encodeBase64url(browser.publicKey),
        });
        assert.notProperty(approved.grant, "name");
        yield* ledgerVerifyDevice(ledger)(deviceIdentity("p256", browser.publicKey));

        const paired = receivePairingReply(device.state, approved.reply, NOW + 3);
        assert.strictEqual(paired.phase, "paired");
        if (paired.phase !== "paired") return;
        assert.deepStrictEqual(paired.record, {
          relayUrl: RELAY_URL,
          hostId: relayHostId(hk),
          hostIdentityKey: encodeBase64url(hk),
          grant: approved.grant,
        });
        assert.notProperty(paired.record, "secret");
        assert.deepStrictEqual(pairingCloseFrame(), { type: "pairing-close" });
      }),
    );

    it.effect("rejects: no grant, no ledger entry, and the device learns why", () =>
      Effect.gen(function* () {
        const host = yield* open();
        const device = yield* deviceClaim(host.link);
        const submitted = submitPairingClaim(host.state, {
          transcriptHash: thA,
          message: device.claim,
          now: NOW,
        });
        const { state, reply } = rejectPairing(submitted.state);
        assert.deepStrictEqual(state, { phase: "closed", reason: "rejected" });
        assert.deepStrictEqual(receivePairingReply(device.state, reply, NOW), {
          phase: "failed",
          reason: "rejected",
        });
        const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              approvePairing(state, { hostIdentitySeed: hostSeed, ledger, now: NOW }),
            ),
          ),
        );
        assert.deepStrictEqual(yield* ledger.list, []);
      }),
    );
  });

  describe("the pairing secret S", () => {
    it.effect("survives invalid claims, so they cannot close the window", () =>
      Effect.gen(function* () {
        const host = yield* open();
        const wrongSecret = yield* forgeClaim({
          secret: new Uint8Array(16).fill(1),
          th: thA,
          claimedKey: attacker,
          keySigner: attacker,
        });
        let state: HostPairingState = host.state;
        for (const message of [wrongSecret, { ...wrongSecret, proof: "x" }, null, "claim"]) {
          const result = submitPairingClaim(state, { transcriptHash: thA, message, now: NOW });
          assert.strictEqual(reason(result), "invalid-claim");
          state = result.state;
        }
        assert.strictEqual(state.phase === "open" && state.failedAttempts, 4);
        assert.isFalse(host.offer.secret.every((byte) => byte === 0));
        const device = yield* deviceClaim(host.link);
        const result = submitPairingClaim(state, {
          transcriptHash: thA,
          message: device.claim,
          now: NOW,
        });
        assert.strictEqual(reason(result), "awaiting-approval");
      }),
    );

    it.effect("closes the window after the attempt limit", () =>
      Effect.gen(function* () {
        const host = yield* open();
        const bad = yield* forgeClaim({
          secret: new Uint8Array(16),
          th: thA,
          claimedKey: attacker,
          keySigner: attacker,
        });
        let state: HostPairingState = host.state;
        for (let attempt = 1; attempt < PAIRING_MAX_FAILED_ATTEMPTS; attempt += 1) {
          state = submitPairingClaim(state, { transcriptHash: thA, message: bad, now: NOW }).state;
        }
        assert.strictEqual(state.phase, "open");
        const last = submitPairingClaim(state, { transcriptHash: thA, message: bad, now: NOW });
        assert.strictEqual(reason(last), "too-many-attempts");
        assert.deepStrictEqual(last.state, { phase: "closed", reason: "too-many-attempts" });
        assert.isTrue(host.offer.secret.every((byte) => byte === 0));
        const device = yield* deviceClaim(host.link);
        assert.strictEqual(
          reason(
            submitPairingClaim(last.state, {
              transcriptHash: thA,
              message: device.claim,
              now: NOW,
            }),
          ),
          "no-window",
        );
      }),
    );

    it.effect("expires after five minutes on both sides", () =>
      Effect.gen(function* () {
        const host = yield* open();
        const device = yield* deviceClaim(host.link);
        const late = submitPairingClaim(host.state, {
          transcriptHash: thA,
          message: device.claim,
          now: NOW + PAIRING_OFFER_TTL_MS,
        });
        assert.strictEqual(reason(late), "expired");
        assert.deepStrictEqual(parsePairingLink(host.link, NOW + PAIRING_OFFER_TTL_MS), {
          ok: false,
          reason: "expired",
        });
        const offer = startDevicePairing(host.link, NOW);
        const exit = yield* Effect.exit(
          createPairingClaim(offer, {
            transcriptHash: thA,
            signer: phone,
            name: "P",
            now: NOW + PAIRING_OFFER_TTL_MS,
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
      }),
    );

    it.effect("refuses a keyProof without S, even for a key the claimant owns", () =>
      Effect.gen(function* () {
        const host = yield* open();
        const guessed = yield* forgeClaim({
          secret: new Uint8Array(16),
          th: thA,
          claimedKey: attacker,
          keySigner: attacker,
        });
        assert.strictEqual(
          reason(
            submitPairingClaim(host.state, { transcriptHash: thA, message: guessed, now: NOW }),
          ),
          "invalid-claim",
        );
      }),
    );

    it.effect("refuses a keyProof made by another key, even with S", () =>
      Effect.gen(function* () {
        const host = yield* open();
        const secret = secretOf(host.link);
        // Claims the phone's key but cannot sign for it.
        const borrowed = yield* forgeClaim({
          secret,
          th: thA,
          claimedKey: phone,
          keySigner: attacker,
        });
        // Swaps in its own key under a proof that names the phone's key.
        const real = yield* deviceClaim(host.link);
        const swapped = { ...real.claim, dk: encodeBase64url(attacker.publicKey) };
        for (const message of [borrowed, swapped]) {
          assert.strictEqual(
            reason(submitPairingClaim(host.state, { transcriptHash: thA, message, now: NOW })),
            "invalid-claim",
          );
        }
      }),
    );

    it.effect("binds the claim to its handshake: a replay into another session fails", () =>
      Effect.gen(function* () {
        const host = yield* open();
        const device = yield* deviceClaim(host.link, { th: thA });
        assert.strictEqual(
          reason(
            submitPairingClaim(host.state, {
              transcriptHash: thB,
              message: device.claim,
              now: NOW,
            }),
          ),
          "invalid-claim",
        );
        // The device name is covered too.
        const renamed = { ...device.claim, name: "Attacker" };
        assert.strictEqual(
          reason(
            submitPairingClaim(host.state, { transcriptHash: thA, message: renamed, now: NOW }),
          ),
          "invalid-claim",
        );
      }),
    );

    it.effect("replaces the old window, and its S, when a new one opens", () =>
      Effect.gen(function* () {
        const first = yield* open();
        const second = yield* open(NOW + 1, first.state);
        assert.isTrue(first.offer.secret.every((byte) => byte === 0));
        const stale = yield* deviceClaim(first.link);
        assert.strictEqual(
          reason(
            submitPairingClaim(second.state, {
              transcriptHash: thA,
              message: stale.claim,
              now: NOW + 2,
            }),
          ),
          "invalid-claim",
        );
      }),
    );
  });

  describe("approval", () => {
    it.effect("holds one verified claim at a time and lets it lapse after ten minutes", () =>
      Effect.gen(function* () {
        const host = yield* open();
        const device = yield* deviceClaim(host.link);
        const pending = submitPairingClaim(host.state, {
          transcriptHash: thA,
          message: device.claim,
          now: NOW,
        });
        assert.strictEqual(
          reason(
            submitPairingClaim(pending.state, {
              transcriptHash: thB,
              message: device.claim,
              now: NOW,
            }),
          ),
          "busy",
        );
        const deadline = NOW + PAIRING_APPROVAL_TIMEOUT_MS;
        assert.strictEqual(tickPairing(pending.state, deadline - 1).phase, "awaiting-approval");
        assert.deepStrictEqual(tickPairing(pending.state, deadline), {
          phase: "closed",
          reason: "expired",
        });
        const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
        const exit = yield* Effect.exit(
          approvePairing(pending.state, { hostIdentitySeed: hostSeed, ledger, now: deadline }),
        );
        assert.isTrue(Exit.isFailure(exit));
      }),
    );

    it.effect("refuses approval with a different host key than the one offered", () =>
      Effect.gen(function* () {
        const host = yield* open();
        const device = yield* deviceClaim(host.link);
        const pending = submitPairingClaim(host.state, {
          transcriptHash: thA,
          message: device.claim,
          now: NOW,
        });
        const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
        const exit = yield* Effect.exit(
          approvePairing(pending.state, { hostIdentitySeed: seq(90), ledger, now: NOW }),
        );
        assert.isTrue(Exit.isFailure(exit));
      }),
    );

    it.effect("re-pairs an already registered device with a fresh grant", () =>
      Effect.gen(function* () {
        const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
        yield* ledger.add({
          alg: "ed25519",
          publicKey: phone.publicKey,
          name: "Old name",
          now: NOW - 10,
        });
        const host = yield* open();
        const device = yield* deviceClaim(host.link);
        const pending = submitPairingClaim(host.state, {
          transcriptHash: thA,
          message: device.claim,
          now: NOW,
        });
        const approved = yield* approvePairing(pending.state, {
          hostIdentitySeed: hostSeed,
          ledger,
          now: NOW,
        });
        assert.strictEqual(approved.device.name, "Old name");
        assert.strictEqual((yield* ledger.list).length, 1);
      }),
    );
  });

  describe("confirmation codes", () => {
    it("look like K7QM-2XFD and use no confusable characters", () => {
      const code = confirmationCode(thA, hk);
      assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
      assert.strictEqual(new Set(CONFIRMATION_CODE_ALPHABET).size, 32);
      assert.notMatch(CONFIRMATION_CODE_ALPHABET, /[01IO]/u);
      assert.strictEqual(confirmationCode(thA, hk), code);
    });

    it("differ when the transcript differs, or when the host key differs", () => {
      assert.notStrictEqual(confirmationCode(thA, hk), confirmationCode(thB, hk));
      assert.notStrictEqual(
        confirmationCode(thA, hk),
        confirmationCode(thA, identityPublicKeyFromSeed(seq(50))),
      );
    });

    it.effect("do not match when the link was swapped for one with another host key", () =>
      Effect.gen(function* () {
        const real = yield* open();
        // The attacker shows its own offer; the device pins the attacker's key and handshakes
        // with it, while the attacker runs a separate handshake with the real host.
        const fake = yield* openPairingWindow({
          hostIdentitySeed: seq(60),
          relayUrl: RELAY_URL,
          now: NOW,
        });
        const device = yield* deviceClaim(fake.link, { th: thA });
        const relayed = yield* forgeClaim({
          secret: secretOf(real.link),
          th: thB,
          claimedKey: attacker,
          keySigner: attacker,
        });
        const atHost = submitPairingClaim(real.state, {
          transcriptHash: thB,
          message: relayed,
          now: NOW,
        });
        assert.strictEqual(atHost.outcome.kind, "awaiting-approval");
        if (atHost.outcome.kind !== "awaiting-approval") return;
        assert.notStrictEqual(atHost.outcome.confirmationCode, device.confirmationCode);
        // Even if the attacker forced the same transcript hash, the host keys differ.
        assert.notStrictEqual(
          confirmationCode(thA, hk),
          confirmationCode(thA, fake.offer.hostIdentityKey),
        );
      }),
    );
  });

  describe("links", () => {
    it.effect("carry S only in the fragment and parse back exactly", () =>
      Effect.gen(function* () {
        const host = yield* open();
        const url = new URL(host.link);
        assert.strictEqual(url.protocol, "k3relay:");
        assert.isFalse(url.searchParams.has("s"));
        assert.isTrue(url.hash.startsWith("#s="));
        const parsed = parsePairingLink(host.link, NOW);
        assert.isTrue(parsed.ok);
        if (!parsed.ok) return;
        assert.deepStrictEqual(parsed.offer, {
          relayUrl: RELAY_URL,
          hostId: relayHostId(hk),
          hostIdentityKey: hk,
          secret: host.offer.secret,
          expiresAt: NOW + PAIRING_OFFER_TTL_MS,
        } satisfies PairingOffer);
      }),
    );

    it.effect("refuse anything but one well-formed copy of every field", () =>
      Effect.gen(function* () {
        const { link, offer } = yield* open();
        const [head = "", fragment = ""] = link.split("#");
        const otherHk = encodeBase64url(identityPublicKeyFromSeed(seq(70)));
        const cases: ReadonlyArray<[string, string]> = [
          [`${head}&v=1#${fragment}`, "malformed"],
          [`${head}&x=1#${fragment}`, "malformed"],
          [head, "malformed"],
          [`${head}#${fragment}&t=1`, "malformed"],
          [`${head}#s=${encodeBase64url(new Uint8Array(15))}`, "malformed"],
          [link.replace("k3relay://pair", "k3relay://pairx"), "malformed"],
          [link.replace("k3relay:", "https:"), "malformed"],
          [link.replace("v=1", "v=2"), "malformed"],
          [link.replace(/exp=\d+/u, "exp=1e12"), "malformed"],
          [link.replace(/hk=[^&]+/u, `hk=${otherHk}`), "host-mismatch"],
          [
            link.replace(
              encodeURIComponent(RELAY_URL),
              encodeURIComponent("http://relay.example/"),
            ),
            "insecure-relay",
          ],
          [
            link.replace(
              encodeURIComponent(RELAY_URL),
              encodeURIComponent("https://u:p@relay.example/"),
            ),
            "insecure-relay",
          ],
          ["not a url", "malformed"],
        ];
        for (const [candidate, expected] of cases) {
          const parsed = parsePairingLink(candidate, NOW);
          assert.deepStrictEqual(parsed.ok ? "ok" : parsed.reason, expected, candidate);
        }
        assert.isTrue(
          parsePairingLink(encodePairingLink({ ...offer, relayUrl: "http://127.0.0.1:8080/" }), NOW)
            .ok,
        );
      }),
    );

    it.effect("are refused by openPairingWindow when the relay is not https", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          openPairingWindow({
            hostIdentitySeed: hostSeed,
            relayUrl: "http://relay.example/",
            now: NOW,
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
      }),
    );
  });

  describe("device side", () => {
    const awaiting = (link: string) => Effect.map(deviceClaim(link), (claimed) => claimed.state);

    it.effect("keeps only a grant the pinned host signed for its own key", () =>
      Effect.gen(function* () {
        const host = yield* open();
        const state: DevicePairingState = yield* awaiting(host.link);
        const forged = [
          yield* signGrant({
            hostIdentitySeed: seq(80),
            alg: "ed25519",
            devicePublicKey: phone.publicKey,
            now: NOW,
            nonce: "AAECAwQFBgcICQoLDA0ODw",
          }),
          yield* signGrant({
            hostIdentitySeed: hostSeed,
            alg: "ed25519",
            devicePublicKey: attacker.publicKey,
            now: NOW,
            nonce: "AAECAwQFBgcICQoLDA0ODw",
          }),
          yield* signGrant({
            hostIdentitySeed: hostSeed,
            alg: "ed25519",
            devicePublicKey: phone.publicKey,
            now: NOW - 91 * 86_400_000,
            nonce: "AAECAwQFBgcICQoLDA0ODw",
          }),
        ];
        for (const grant of forged) {
          assert.deepStrictEqual(
            receivePairingReply(state, { type: "pairing-accepted", grant }, NOW),
            { phase: "failed", reason: "invalid-reply" },
          );
        }
        const genuine = yield* signGrant({
          hostIdentitySeed: hostSeed,
          alg: "ed25519",
          devicePublicKey: phone.publicKey,
          now: NOW,
          nonce: "AAECAwQFBgcICQoLDA0ODw",
        });
        for (const reply of [
          { type: "pairing-accepted", grant: genuine, bootstrap: "x" },
          { type: "pairing-rejected", reason: "because" },
          { type: "pairing-accepted" },
        ]) {
          assert.deepStrictEqual(receivePairingReply(state, reply, NOW), {
            phase: "failed",
            reason: "invalid-reply",
          });
        }
        assert.strictEqual(
          receivePairingReply(state, { type: "pairing-accepted", grant: genuine }, NOW).phase,
          "paired",
        );
      }),
    );

    it.effect("accepts a renewed grant only from the pinned host, for itself, and newer", () =>
      Effect.gen(function* () {
        const nonce = "AAECAwQFBgcICQoLDA0ODw";
        const grantAt = (seed: Uint8Array, now: number, key = phone.publicKey) =>
          signGrant({ hostIdentitySeed: seed, alg: "ed25519", devicePublicKey: key, now, nonce });
        const record = {
          relayUrl: RELAY_URL,
          hostId: relayHostId(hk),
          hostIdentityKey: encodeBase64url(hk),
          grant: yield* grantAt(hostSeed, NOW),
        };
        const renew = (grant: unknown, now = NOW + 1000) =>
          acceptRenewedGrant(record, {
            grant,
            alg: "ed25519",
            devicePublicKey: phone.publicKey,
            now,
          });
        const newer = yield* grantAt(hostSeed, NOW + 500);
        assert.deepStrictEqual(renew(newer)?.grant, newer);
        assert.isNull(renew(yield* grantAt(seq(81), NOW + 500)));
        assert.isNull(renew(yield* grantAt(hostSeed, NOW + 500, attacker.publicKey)));
        assert.isNull(renew(record.grant));
        assert.isTrue(
          verifyGrant(newer, {
            hostIdentityKey: decodeBase64url(record.hostIdentityKey) ?? hk,
            alg: "ed25519",
            devicePublicKey: phone.publicKey,
            now: NOW + 1000,
          }).ok,
        );
      }),
    );

    it.effect("will not claim from a failed or used offer", () =>
      Effect.gen(function* () {
        const failed = startDevicePairing("k3relay://pair?v=1", NOW);
        assert.deepStrictEqual(failed, { phase: "failed", reason: "malformed" });
        const exit = yield* Effect.exit(
          createPairingClaim(failed, { transcriptHash: thA, signer: phone, name: "P", now: NOW }),
        );
        assert.isTrue(Exit.isFailure(exit));
        const host = yield* open();
        const claimed = yield* deviceClaim(host.link);
        const again = yield* Effect.exit(
          createPairingClaim(claimed.state, {
            transcriptHash: thA,
            signer: phone,
            name: "P",
            now: NOW,
          }),
        );
        assert.isTrue(Exit.isFailure(again));
      }),
    );
  });
});
