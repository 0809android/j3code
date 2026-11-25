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
import { encodeBase64url, relayDeviceId, relayHostId } from "./encoding.ts";
import {
  type HostIntroductionState,
  INTRODUCTION_DAILY_LIMIT,
  INTRODUCTION_DAILY_OPEN_LIMIT,
  INTRODUCTION_DAY_MS,
  INTRODUCTION_MAX_FAILED_ATTEMPTS,
  INTRODUCTION_TTL_MS,
  type IntroductionPeer,
  checkIntroductionClaims,
  createIntroductionClaim,
  encodeIntroductionLink,
  encodeIntroductionPeers,
  initialHostIntroductionState,
  introductionCode,
  openIntroduction,
  parseIntroductionLink,
  signIntroductionApproval,
  submitIntroductionClaim,
  verifyIntroductionApproval,
} from "./introduction.ts";
import { type LedgerDevice, makeDeviceLedger, makeMemoryLedgerStore } from "./ledger.ts";

const NOW = 1_800_000_000_000;
const RELAY = "https://relay.k3.kinocode.jp/";
const hostKey = (n: number) => identityPublicKeyFromSeed(new Uint8Array(32).fill(n));
const HK1 = hostKey(1);
const HK2 = hostKey(2);
const HOST1 = relayHostId(HK1);
const HOST2 = relayHostId(HK2);
const SECRET = new Uint8Array(16).fill(0x5a);
const ID = encodeBase64url(new Uint8Array(16).fill(7));
const TH = new Uint8Array(32).fill(0xa1);
const TH_OTHER = new Uint8Array(32).fill(0xb2);

const signer = (alg: E2eeDeviceAlgorithm, n: number): E2eeDeviceSigner => {
  const secretKey = new Uint8Array(32).fill(n);
  return deviceSignerFromKeypair({
    alg,
    secretKey,
    publicKey:
      alg === "ed25519" ? ed25519.getPublicKey(secretKey) : p256.getPublicKey(secretKey, false),
  });
};

const idOf = (s: E2eeDeviceSigner) => relayDeviceId(s.alg, s.publicKey);
const introducer = signer("ed25519", 0x11);
const otherInviter = signer("p256", 0x12);
const plain = signer("ed25519", 0x13);
// The new device's keys, one per host.
const newOn1 = signer("p256", 0x21);
const newOn2 = signer("ed25519", 0x22);
const intruder = signer("ed25519", 0x31);

const peerOf = (hostId: string, s: E2eeDeviceSigner): IntroductionPeer => ({
  hostId,
  alg: s.alg,
  publicKey: s.publicKey,
});
const PEERS = [peerOf(HOST1, newOn1), peerOf(HOST2, newOn2)];

const ledgerEntry = (s: E2eeDeviceSigner, patch: Partial<LedgerDevice> = {}): LedgerDevice => ({
  deviceId: idOf(s),
  alg: s.alg,
  publicKey: encodeBase64url(s.publicKey),
  name: "Device",
  createdAt: NOW - INTRODUCTION_DAY_MS * 10,
  lastSeenAt: null,
  status: "active",
  revokedAt: null,
  ...patch,
});

const LEDGER: ReadonlyArray<LedgerDevice> = [
  ledgerEntry(introducer, { permissions: ["devices:invite"], approvedVia: "qr" }),
  ledgerEntry(otherInviter, { permissions: ["devices:invite"], approvedVia: "qr" }),
  ledgerEntry(plain, { approvedVia: "qr" }),
];

const open = (
  patch: Partial<Parameters<typeof openIntroduction>[0]> = {},
): ReturnType<typeof openIntroduction> =>
  openIntroduction({
    current: initialHostIntroductionState,
    introducerDeviceId: idOf(introducer),
    ledger: LEDGER,
    secret: SECRET,
    id: ID,
    openedToday: 0,
    now: NOW,
    ...patch,
  });

const opened = (): HostIntroductionState => {
  const result = open();
  assert(result.ok);
  return result.state;
};

const claimFor = (s: E2eeDeviceSigner, input: { th?: Uint8Array; peers?: typeof PEERS } = {}) =>
  createIntroductionClaim({
    secret: SECRET,
    transcriptHash: input.th ?? TH,
    signer: s,
    name: "New phone",
    peers: input.peers ?? PEERS,
  });

const claimed = Effect.gen(function* () {
  const message = yield* claimFor(newOn1);
  const result = submitIntroductionClaim(opened(), {
    hostId: HOST1,
    transcriptHash: TH,
    message,
    now: NOW + 1,
  });
  assert(result.outcome.kind === "claimed");
  return result.state;
});

const verifiedClaim = (
  hostId: string,
  s: E2eeDeviceSigner,
  expiresAt = NOW + INTRODUCTION_TTL_MS,
) => ({
  hostId,
  introductionId: ID,
  expiresAt,
  device: { alg: s.alg, publicKey: s.publicKey, deviceId: idOf(s), name: "New phone" },
});

const approval = (
  by: E2eeDeviceSigner = introducer,
  claim = verifiedClaim(HOST1, newOn1),
  code = introductionCode(SECRET, PEERS),
) => signIntroductionApproval(by, claim, code);

const verify = (
  state: HostIntroductionState,
  message: unknown,
  patch: Partial<Parameters<typeof verifyIntroductionApproval>[1]> = {},
) =>
  verifyIntroductionApproval(state, {
    hostId: HOST1,
    sessionDeviceId: idOf(introducer),
    introducer: LEDGER[0],
    message,
    now: NOW + 2,
    ...patch,
  });

describe("introduction links", () => {
  it("round-trips hosts and the secret, recomputing host ids from Hk", () => {
    const link = encodeIntroductionLink({
      hosts: [
        { relayUrl: RELAY, hostId: HOST1, hostIdentityKey: HK1 },
        { relayUrl: RELAY, hostId: HOST2, hostIdentityKey: HK2 },
      ],
      secret: SECRET,
      expiresAt: NOW + INTRODUCTION_TTL_MS,
    });
    const parsed = parseIntroductionLink(link, NOW);
    assert(parsed.ok);
    assert.deepStrictEqual(
      parsed.offer.hosts.map((host) => host.hostId),
      [HOST1, HOST2],
    );
    assert.deepStrictEqual(parsed.offer.secret, SECRET);
  });

  it("refuses expired, insecure, duplicated, oversized and extended links", () => {
    const base = {
      hosts: [{ relayUrl: RELAY, hostId: HOST1, hostIdentityKey: HK1 }],
      secret: SECRET,
      expiresAt: NOW + 1000,
    };
    const link = encodeIntroductionLink(base);
    assert.deepStrictEqual(parseIntroductionLink(link, NOW + 1000), {
      ok: false,
      reason: "expired",
    });
    const insecure = encodeIntroductionLink({
      ...base,
      hosts: [{ ...base.hosts[0]!, relayUrl: "http://relay.example/" }],
    });
    assert.deepStrictEqual(parseIntroductionLink(insecure, NOW), {
      ok: false,
      reason: "insecure-relay",
    });
    const twice = encodeIntroductionLink({ ...base, hosts: [base.hosts[0]!, base.hosts[0]!] });
    assert.isFalse(parseIntroductionLink(twice, NOW).ok);
    const many = encodeIntroductionLink({
      ...base,
      hosts: Array.from({ length: 9 }, (_, n) => ({
        relayUrl: RELAY,
        hostId: relayHostId(hostKey(n + 1)),
        hostIdentityKey: hostKey(n + 1),
      })),
    });
    assert.isFalse(parseIntroductionLink(many, NOW).ok);
    assert.isFalse(parseIntroductionLink(link.replace("#s=", "&x=1#s="), NOW).ok);
    assert.isFalse(parseIntroductionLink(link.replace("#s=", "#s=AA"), NOW).ok);
  });
});

describe("opening an introduction", () => {
  it("needs devices:invite on this host; plain, revoked, unknown and introduced devices cannot", () => {
    assert.isTrue(open().ok);
    for (const ledger of [
      LEDGER.map((device) =>
        device.deviceId === idOf(introducer)
          ? { ...device, status: "revoked" as const, revokedAt: NOW }
          : device,
      ),
      LEDGER.filter((device) => device.deviceId !== idOf(introducer)),
      LEDGER.map((device) =>
        device.deviceId === idOf(introducer)
          ? { ...device, approvedVia: "introduction" as const, introducedBy: idOf(otherInviter) }
          : device,
      ),
    ]) {
      assert.deepStrictEqual(open({ ledger }), { ok: false, reason: "not-permitted" });
    }
    assert.deepStrictEqual(open({ introducerDeviceId: idOf(plain) }), {
      ok: false,
      reason: "not-permitted",
    });
  });

  it("stops at three introductions in 24 hours, and at ten windows", () => {
    const introduced = (n: number, createdAt: number) =>
      ledgerEntry(signer("ed25519", 0x40 + n), {
        approvedVia: "introduction",
        introducedBy: idOf(introducer),
        createdAt,
      });
    const full = [
      ...LEDGER,
      ...Array.from({ length: INTRODUCTION_DAILY_LIMIT }, (_, n) => introduced(n, NOW - 1000)),
    ];
    assert.deepStrictEqual(open({ ledger: full }), { ok: false, reason: "limit" });
    const old = [
      ...LEDGER,
      ...Array.from({ length: INTRODUCTION_DAILY_LIMIT }, (_, n) =>
        introduced(n, NOW - INTRODUCTION_DAY_MS),
      ),
    ];
    assert.isTrue(open({ ledger: old }).ok);
    assert.deepStrictEqual(open({ openedToday: INTRODUCTION_DAILY_OPEN_LIMIT }), {
      ok: false,
      reason: "limit",
    });
  });

  it("keeps another introducer's live window, but lets the same introducer start over", () => {
    const first = opened();
    assert.deepStrictEqual(open({ current: first, introducerDeviceId: idOf(otherInviter) }), {
      ok: false,
      reason: "busy",
    });
    assert.isTrue(open({ current: first }).ok);
    assert.isTrue(
      open({
        current: first,
        introducerDeviceId: idOf(otherInviter),
        now: NOW + INTRODUCTION_TTL_MS,
      }).ok,
    );
  });
});

describe("introduction claims", () => {
  it.effect("accepts a claim that proves S and its key and names this host in its peers", () =>
    Effect.gen(function* () {
      const state = yield* claimed;
      assert(state.phase === "claimed");
      assert.strictEqual(state.device.deviceId, idOf(newOn1));
      assert.strictEqual(state.confirmationCode, introductionCode(SECRET, PEERS));
    }),
  );

  it.effect(
    "counts forged claims and closes the window after ten, without spending it before",
    () =>
      Effect.gen(function* () {
        const good = yield* claimFor(newOn1);
        const forged: ReadonlyArray<unknown> = [
          { ...good, name: "Other" },
          { ...good, proof: encodeBase64url(new Uint8Array(32)) },
          yield* claimFor(newOn1, { th: TH_OTHER }),
          // A key the peers give for another host.
          yield* claimFor(newOn2),
          { ...good, peers: encodeIntroductionPeers([peerOf(HOST2, newOn2)]) },
          { ...good, extra: true },
        ];
        let state = opened();
        for (const message of forged) {
          const result = submitIntroductionClaim(state, {
            hostId: HOST1,
            transcriptHash: TH,
            message,
            now: NOW + 1,
          });
          assert.deepStrictEqual(result.outcome, { kind: "rejected", reason: "invalid-claim" });
          state = result.state;
        }
        assert.strictEqual(state.phase, "open");
        for (let n = forged.length; n < INTRODUCTION_MAX_FAILED_ATTEMPTS; n += 1) {
          state = submitIntroductionClaim(state, {
            hostId: HOST1,
            transcriptHash: TH,
            message: {},
            now: NOW + 1,
          }).state;
        }
        assert.deepStrictEqual(state, { phase: "closed", reason: "too-many-attempts" });
      }),
  );

  it.effect("takes one claim per window, and none after it expires", () =>
    Effect.gen(function* () {
      const state = yield* claimed;
      const again = submitIntroductionClaim(state, {
        hostId: HOST1,
        transcriptHash: TH,
        message: yield* claimFor(intruder, { peers: [peerOf(HOST1, intruder)] }),
        now: NOW + 2,
      });
      assert.deepStrictEqual(again.outcome, { kind: "rejected", reason: "busy" });
      const late = submitIntroductionClaim(opened(), {
        hostId: HOST1,
        transcriptHash: TH,
        message: yield* claimFor(newOn1),
        now: NOW + INTRODUCTION_TTL_MS,
      });
      assert.deepStrictEqual(late.outcome, { kind: "rejected", reason: "expired" });
    }),
  );
});

describe("introduction approvals", () => {
  it.effect("accepts the introducer's signature over this host, window, device and code", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(verify(yield* claimed, yield* approval()), { ok: true });
    }),
  );

  it.effect("refuses tampered, reused, late, misdirected and unconfirmed approvals", () =>
    Effect.gen(function* () {
      const state = yield* claimed;
      const good = yield* approval();
      const flipped = good.sig.startsWith("A") ? `B${good.sig.slice(1)}` : `A${good.sig.slice(1)}`;
      assert.deepStrictEqual(verify(state, { ...good, sig: flipped }), {
        ok: false,
        reason: "bad-signature",
      });
      // Signed for the other host: the signing input names the host.
      const forHost2 = yield* approval(introducer, verifiedClaim(HOST2, newOn1));
      assert.deepStrictEqual(verify(state, forHost2), { ok: false, reason: "bad-signature" });
      // Signed for another new device.
      const forIntruder = yield* approval(introducer, verifiedClaim(HOST1, intruder));
      assert.deepStrictEqual(verify(state, forIntruder), { ok: false, reason: "mismatch" });
      assert.deepStrictEqual(verify(state, { ...forIntruder, deviceId: idOf(newOn1) }), {
        ok: false,
        reason: "bad-signature",
      });
      // A different deadline than the host's window.
      const stretched = yield* approval(introducer, verifiedClaim(HOST1, newOn1, NOW + 1e9));
      assert.deepStrictEqual(verify(state, stretched), { ok: false, reason: "bad-signature" });
      // Without the compared code, or with another code.
      assert.deepStrictEqual(verify(state, { ...good, confirmationCode: "AAAA-AAAA" }), {
        ok: false,
        reason: "code-mismatch",
      });
      const otherCode = yield* approval(introducer, verifiedClaim(HOST1, newOn1), "AAAA-AAAA");
      assert.deepStrictEqual(verify(state, otherCode), { ok: false, reason: "code-mismatch" });
      const { confirmationCode: _omitted, ...noCode } = good;
      assert.deepStrictEqual(verify(state, noCode), { ok: false, reason: "invalid-request" });
      // Another window's id.
      assert.deepStrictEqual(
        verify(state, { ...good, introductionId: encodeBase64url(new Uint8Array(16)) }),
        { ok: false, reason: "mismatch" },
      );
      assert.deepStrictEqual(verify(state, good, { now: NOW + INTRODUCTION_TTL_MS }), {
        ok: false,
        reason: "expired",
      });
      // Once closed (approved, rejected), the same approval does nothing.
      assert.deepStrictEqual(verify({ phase: "closed", reason: "approved" }, good), {
        ok: false,
        reason: "no-introduction",
      });
    }),
  );

  it.effect("refuses a signature from anyone but the window's introducer, as it stands now", () =>
    Effect.gen(function* () {
      const state = yield* claimed;
      const good = yield* approval();
      // Another inviter, with a valid signature of its own, through its own session.
      const byOther = yield* approval(otherInviter);
      assert.deepStrictEqual(
        verify(state, byOther, { sessionDeviceId: idOf(otherInviter), introducer: LEDGER[1] }),
        { ok: false, reason: "not-introducer" },
      );
      // The introducer's session, but the other inviter's key and ledger entry.
      assert.deepStrictEqual(verify(state, byOther, { introducer: LEDGER[1] }), {
        ok: false,
        reason: "not-permitted",
      });
      // Revoked, or lost devices:invite, since the window opened.
      const revoked = { ...LEDGER[0]!, status: "revoked" as const, revokedAt: NOW + 1 };
      assert.deepStrictEqual(verify(state, good, { introducer: revoked }), {
        ok: false,
        reason: "not-permitted",
      });
      assert.deepStrictEqual(
        verify(state, good, { introducer: { ...LEDGER[0]!, permissions: [] } }),
        {
          ok: false,
          reason: "not-permitted",
        },
      );
      assert.deepStrictEqual(verify(state, good, { introducer: undefined }), {
        ok: false,
        reason: "not-permitted",
      });
    }),
  );
});

describe("the introducer's check of the claims", () => {
  const report = (hostId: string, s: E2eeDeviceSigner, peers = PEERS, name = "New phone") => ({
    hostId,
    introductionId: ID,
    expiresAt: NOW + INTRODUCTION_TTL_MS,
    device: { alg: s.alg, dk: encodeBase64url(s.publicKey), name },
    peers: encodeIntroductionPeers(peers),
  });

  it("gives the new device's code when every host reports the same peers", () => {
    const checked = checkIntroductionClaims({
      secret: SECRET,
      openedHostIds: [HOST1, HOST2],
      reports: [report(HOST1, newOn1), report(HOST2, newOn2)],
    });
    assert(checked.ok);
    assert.strictEqual(checked.confirmationCode, introductionCode(SECRET, PEERS));
    assert.strictEqual(checked.claims.length, 2);
  });

  it("refuses a host whose claim came from someone else, or that disagrees with the others", () => {
    const check = (reports: ReadonlyArray<ReturnType<typeof report>>) =>
      checkIntroductionClaims({ secret: SECRET, openedHostIds: [HOST1, HOST2], reports });
    // An intruder who saw the QR code raced the new device to host 2.
    const racedPeers = [peerOf(HOST1, newOn1), peerOf(HOST2, intruder)];
    assert.deepStrictEqual(check([report(HOST1, newOn1), report(HOST2, intruder, racedPeers)]), {
      ok: false,
      reason: "mismatch",
    });
    assert.deepStrictEqual(check([report(HOST1, newOn1), report(HOST2, intruder)]), {
      ok: false,
      reason: "mismatch",
    });
    assert.deepStrictEqual(
      check([report(HOST1, newOn1), report(HOST2, newOn2, PEERS, "Other name")]),
      { ok: false, reason: "mismatch" },
    );
    const stranger = relayHostId(hostKey(9));
    assert.deepStrictEqual(
      check([report(HOST1, newOn1, [peerOf(HOST1, newOn1), peerOf(stranger, newOn2)])]),
      { ok: false, reason: "mismatch" },
    );
  });

  it("gives a different code when an intruder's keys replace the new device's everywhere", () => {
    const intruderPeers = [peerOf(HOST1, intruder), peerOf(HOST2, signer("p256", 0x32))];
    const checked = checkIntroductionClaims({
      secret: SECRET,
      openedHostIds: [HOST1, HOST2],
      reports: [report(HOST1, intruder, intruderPeers)],
    });
    assert(checked.ok);
    assert.notStrictEqual(checked.confirmationCode, introductionCode(SECRET, PEERS));
  });
});

describe("ledger permissions", () => {
  it.effect("adds every device without permissions and never lets an introduced one invite", () =>
    Effect.gen(function* () {
      const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
      const owner = yield* ledger.add({
        alg: introducer.alg,
        publicKey: introducer.publicKey,
        name: "Phone",
        now: NOW,
        approvedVia: "qr",
      });
      assert.deepStrictEqual(owner.permissions, []);
      const granted = yield* ledger.setPermissions(owner.deviceId, ["devices:invite"]);
      assert.deepStrictEqual(granted.permissions, ["devices:invite"]);
      const introduced = yield* ledger.add({
        alg: newOn1.alg,
        publicKey: newOn1.publicKey,
        name: "New phone",
        now: NOW,
        approvedVia: "introduction",
        introducedBy: owner.deviceId,
      });
      assert.deepStrictEqual(
        [introduced.approvedVia, introduced.introducedBy, introduced.permissions],
        ["introduction", owner.deviceId, []],
      );
      const refused = yield* Effect.flip(
        ledger.setPermissions(introduced.deviceId, ["devices:invite"]),
      );
      assert.strictEqual(
        refused._tag === "DeviceLedgerError" && refused.reason,
        "introduced-device",
      );
      const unnamed = yield* Effect.flip(
        ledger.add({
          alg: newOn2.alg,
          publicKey: newOn2.publicKey,
          name: "X",
          now: NOW,
          approvedVia: "introduction",
        }),
      );
      assert.strictEqual(unnamed._tag === "DeviceLedgerError" && unnamed.reason, "invalid-route");
    }),
  );
});
