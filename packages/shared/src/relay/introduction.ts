import * as Effect from "effect/Effect";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  type E2eeDeviceAlgorithm,
  type E2eeDeviceSigner,
  isCanonicalDevicePublicKey,
  isDeviceAlgorithm,
  labeledMessage,
  verifyDeviceSignature,
} from "../socketE2eeDevice.ts";
import { timingSafeEqual } from "../socketE2eeRecord.ts";
import {
  decodeBase64url,
  encodeBase64url,
  isRelayId,
  relayDeviceId,
  relayHostId,
  relayLengthPrefixed,
  relaySigningInput,
} from "./encoding.ts";
import { type LedgerDevice, deviceCanInvite, isValidDeviceName } from "./ledger.ts";
import {
  PAIRING_LINK_PROTOCOL,
  PairingError,
  type PairingRejectReason,
  type PendingPairingDevice,
  formatConfirmationCode,
  normalizeRelayUrl,
} from "./pairing.ts";

/**
 * Introductions (spec §18.2, `infra/k3-relay/docs/INTRODUCTION.md`). The new device keeps one
 * `Dk` per host; the code covers all of them, and the introducer signs each host's approval.
 */

const INTRODUCTION_LINK_HOST = "introduce";
export const INTRODUCTION_TTL_MS = 5 * 60_000;
/** Devices a host approves by introduction in any 24 hours. */
export const INTRODUCTION_DAILY_LIMIT = 3;
/** Windows a host opens in any 24 hours, approved or not. */
export const INTRODUCTION_DAILY_OPEN_LIMIT = 10;
export const INTRODUCTION_DAY_MS = 24 * 60 * 60_000;
const INTRODUCTION_MAX_HOSTS = 8;
export const INTRODUCTION_MAX_FAILED_ATTEMPTS = 10;
const INTRODUCTION_CODE_LABEL = "k3relay-v1/introduction-code";
const INTRODUCTION_APPROVAL_LABEL = "k3relay-v1/introduction-approval";

const SECRET_BYTES = 16;
const TRANSCRIPT_BYTES = 32;
const SIGNATURE_BYTES = 64;
const HOST_KEY_BYTES = 32;
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const LABEL_PROOF = "k3intro";
const LABEL_KEY_PROOF = "k3code-e2ee-v2/intro";
const CLAIM_KEYS = ["alg", "dk", "keyProof", "name", "peers", "proof", "type"];
const PEER_KEYS = ["alg", "dk", "host"];
const APPROVAL_KEYS = ["confirmationCode", "deviceId", "introductionId", "sig"];

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const hasExactKeys = (
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
};

/** A 16-byte random introduction id, base64url: what the host hands out and later consumes. */
const isIntroductionId = (value: unknown): value is string =>
  typeof value === "string" && ID_PATTERN.test(value);

const isIntroductionSecret = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.length === SECRET_BYTES;

export const decodeIntroductionSecret = (value: unknown): Uint8Array | null =>
  decodeBase64url(value, SECRET_BYTES);

// ── Link ─────────────────────────────────────────────────────────────────────

export interface IntroductionHost {
  readonly relayUrl: string;
  readonly hostId: string;
  readonly hostIdentityKey: Uint8Array;
}

export interface IntroductionOffer {
  readonly hosts: ReadonlyArray<IntroductionHost>;
  /** `S`: 128 bits, single use. Only in the link fragment, and to each host inside E2E. */
  readonly secret: Uint8Array;
  readonly expiresAt: number;
}

/**
 * `k3relay://introduce?v=1&exp=…&h=<Hk>,<relayUrl>&h=…#s=…`. The host list travels only in the QR
 * code; the relay never sees it. Host ids are recomputed from `Hk`.
 */
export const encodeIntroductionLink = (offer: IntroductionOffer): string => {
  const query = new URLSearchParams({ v: "1", exp: String(offer.expiresAt) });
  for (const host of offer.hosts) {
    query.append("h", `${encodeBase64url(host.hostIdentityKey)},${host.relayUrl}`);
  }
  return `${PAIRING_LINK_PROTOCOL}//${INTRODUCTION_LINK_HOST}?${query.toString()}#s=${encodeBase64url(offer.secret)}`;
};

export type IntroductionLinkResult =
  | { readonly ok: true; readonly offer: IntroductionOffer }
  | { readonly ok: false; readonly reason: "malformed" | "insecure-relay" | "expired" };

export const isIntroductionLink = (link: string): boolean =>
  link.trim().startsWith(`${PAIRING_LINK_PROTOCOL}//${INTRODUCTION_LINK_HOST}?`);

/** Strict parse: `v`, `exp`, 1–8 distinct hosts, the secret, nothing else. */
export const parseIntroductionLink = (link: string, now: number): IntroductionLinkResult => {
  const malformed = { ok: false, reason: "malformed" } as const;
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return malformed;
  }
  if (
    url.protocol !== PAIRING_LINK_PROTOCOL ||
    url.host !== INTRODUCTION_LINK_HOST ||
    url.pathname !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return malformed;
  }
  const keys = [...new Set(url.searchParams.keys())].sort();
  if (keys.join(",") !== "exp,h,v") return malformed;
  if (url.searchParams.getAll("v").length !== 1 || url.searchParams.get("v") !== "1") {
    return malformed;
  }
  const exps = url.searchParams.getAll("exp");
  const exp = exps.length === 1 ? (exps[0] ?? "") : "";
  const expiresAt = /^[1-9][0-9]{0,15}$/u.test(exp) ? Number(exp) : Number.NaN;
  if (!Number.isSafeInteger(expiresAt)) return malformed;
  const fragment = new URLSearchParams(url.hash.slice(1));
  if ([...fragment.keys()].join(",") !== "s") return malformed;
  const secret = decodeIntroductionSecret(fragment.get("s"));
  if (secret === null) return malformed;
  const entries = url.searchParams.getAll("h");
  if (entries.length === 0 || entries.length > INTRODUCTION_MAX_HOSTS) return malformed;
  const hosts: Array<IntroductionHost> = [];
  for (const entry of entries) {
    const comma = entry.indexOf(",");
    if (comma <= 0) return malformed;
    const hostIdentityKey = decodeBase64url(entry.slice(0, comma), HOST_KEY_BYTES);
    if (hostIdentityKey === null) return malformed;
    const relayUrl = normalizeRelayUrl(entry.slice(comma + 1));
    if (relayUrl === null) return { ok: false, reason: "insecure-relay" };
    const hostId = relayHostId(hostIdentityKey);
    if (hosts.some((host) => host.hostId === hostId)) return malformed;
    hosts.push({ relayUrl, hostId, hostIdentityKey });
  }
  if (expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, offer: { hosts, secret, expiresAt } };
};

// ── Peers and the confirmation code ─────────────────────────────────────────

/** One of the new device's keys: the one it presents to `hostId`. */
export interface IntroductionPeer {
  readonly hostId: string;
  readonly alg: E2eeDeviceAlgorithm;
  readonly publicKey: Uint8Array;
}

export interface IntroductionPeerWire {
  readonly host: string;
  readonly alg: E2eeDeviceAlgorithm;
  readonly dk: string;
}

/** Sorted by host id, the one order both sides hash in. */
const sortIntroductionPeers = (
  peers: ReadonlyArray<IntroductionPeer>,
): ReadonlyArray<IntroductionPeer> =>
  [...peers].sort((a, b) => (a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0));

export const encodeIntroductionPeers = (
  peers: ReadonlyArray<IntroductionPeer>,
): ReadonlyArray<IntroductionPeerWire> =>
  sortIntroductionPeers(peers).map((peer) => ({
    host: peer.hostId,
    alg: peer.alg,
    dk: encodeBase64url(peer.publicKey),
  }));

/** Strict: 1–8 peers, canonical keys, host ids strictly ascending (so no duplicates). */
const parseIntroductionPeers = (value: unknown): ReadonlyArray<IntroductionPeer> | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > INTRODUCTION_MAX_HOSTS) {
    return null;
  }
  const peers: Array<IntroductionPeer> = [];
  for (const entry of value as ReadonlyArray<unknown>) {
    if (!hasExactKeys(entry, PEER_KEYS)) return null;
    const { host, alg, dk } = entry;
    if (!isRelayId(host) || typeof alg !== "string" || !isDeviceAlgorithm(alg)) return null;
    const publicKey = decodeBase64url(dk);
    if (publicKey === null || !isCanonicalDevicePublicKey(alg, publicKey)) return null;
    const previous = peers.at(-1);
    if (previous !== undefined && previous.hostId >= host) return null;
    peers.push({ hostId: host, alg, publicKey });
  }
  return peers;
};

const peerParts = (peers: ReadonlyArray<IntroductionPeer>): ReadonlyArray<string | Uint8Array> =>
  sortIntroductionPeers(peers).flatMap((peer) => [peer.hostId, peer.alg, peer.publicKey]);

/**
 * One code for the whole introduction: `S` and every key the new device presents, per host. Any
 * key a host reports that the new device did not make changes it.
 */
export const introductionCode = (
  secret: Uint8Array,
  peers: ReadonlyArray<IntroductionPeer>,
): string =>
  formatConfirmationCode(
    sha256(relaySigningInput(INTRODUCTION_CODE_LABEL, secret, ...peerParts(peers))),
  );

const sameIntroductionPeers = (
  a: ReadonlyArray<IntroductionPeer>,
  b: ReadonlyArray<IntroductionPeer>,
): boolean => {
  if (a.length !== b.length) return false;
  const left = sortIntroductionPeers(a);
  const right = sortIntroductionPeers(b);
  return left.every((peer, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      peer.hostId === other.hostId &&
      peer.alg === other.alg &&
      timingSafeEqual(peer.publicKey, other.publicKey)
    );
  });
};

const introductionProof = (input: {
  readonly secret: Uint8Array;
  readonly transcriptHash: Uint8Array;
  readonly alg: E2eeDeviceAlgorithm;
  readonly devicePublicKey: Uint8Array;
  readonly name: string;
  readonly peers: ReadonlyArray<IntroductionPeer>;
}): Uint8Array =>
  hmac(
    sha256,
    input.secret,
    labeledMessage(
      LABEL_PROOF,
      input.transcriptHash,
      utf8(input.alg),
      input.devicePublicKey,
      utf8(input.name),
      relayLengthPrefixed(...peerParts(input.peers)),
    ),
  );

const introductionKeyProofMessage = (
  transcriptHash: Uint8Array,
  alg: E2eeDeviceAlgorithm,
  devicePublicKey: Uint8Array,
): Uint8Array => labeledMessage(LABEL_KEY_PROOF, transcriptHash, utf8(alg), devicePublicKey);

// ── The claim (new device → host, inside the anonymous E2EE pairing session) ─

export interface IntroductionClaimMessage {
  readonly type: "introduction-claim";
  readonly alg: E2eeDeviceAlgorithm;
  readonly dk: string;
  readonly name: string;
  readonly peers: ReadonlyArray<IntroductionPeerWire>;
  readonly keyProof: string;
  readonly proof: string;
}

export const isIntroductionClaimMessage = (message: unknown): boolean =>
  typeof message === "object" &&
  message !== null &&
  (message as { readonly type?: unknown }).type === "introduction-claim";

export const createIntroductionClaim = Effect.fn("relay.createIntroductionClaim")(
  function* (input: {
    readonly secret: Uint8Array;
    readonly transcriptHash: Uint8Array;
    readonly signer: E2eeDeviceSigner;
    readonly name: string;
    readonly peers: ReadonlyArray<IntroductionPeer>;
  }) {
    if (
      !isIntroductionSecret(input.secret) ||
      input.transcriptHash.length !== TRANSCRIPT_BYTES ||
      !isValidDeviceName(input.name)
    ) {
      return yield* new PairingError({ detail: "The introduction claim is malformed." });
    }
    const { alg, publicKey } = input.signer;
    const keyProof = yield* input.signer
      .sign(introductionKeyProofMessage(input.transcriptHash, alg, publicKey))
      .pipe(Effect.mapError(() => new PairingError({ detail: "The device key could not sign." })));
    return {
      type: "introduction-claim",
      alg,
      dk: encodeBase64url(publicKey),
      name: input.name,
      peers: encodeIntroductionPeers(input.peers),
      keyProof: encodeBase64url(keyProof),
      proof: encodeBase64url(
        introductionProof({
          secret: input.secret,
          transcriptHash: input.transcriptHash,
          alg,
          devicePublicKey: publicKey,
          name: input.name,
          peers: input.peers,
        }),
      ),
    } satisfies IntroductionClaimMessage;
  },
);

// ── Host ─────────────────────────────────────────────────────────────────────

export type IntroductionCloseReason =
  | "approved"
  | "rejected"
  | "expired"
  | "too-many-attempts"
  | "cancelled";

interface IntroductionWindow {
  readonly id: string;
  readonly introducerDeviceId: string;
  readonly secret: Uint8Array;
  readonly expiresAt: number;
}

/** At most one window per host. Its secret is wiped whenever it closes. */
export type HostIntroductionState =
  | { readonly phase: "idle" }
  | (IntroductionWindow & { readonly phase: "open"; readonly failedAttempts: number })
  | (IntroductionWindow & {
      readonly phase: "claimed";
      readonly device: PendingPairingDevice;
      readonly peers: ReadonlyArray<IntroductionPeer>;
      readonly confirmationCode: string;
    })
  | { readonly phase: "closed"; readonly reason: IntroductionCloseReason };

export const initialHostIntroductionState: HostIntroductionState = { phase: "idle" };

export const closeIntroduction = (
  state: HostIntroductionState,
  reason: IntroductionCloseReason,
): HostIntroductionState => {
  if (state.phase === "open" || state.phase === "claimed") {
    state.secret.fill(0);
    return { phase: "closed", reason };
  }
  return state;
};

export const tickIntroduction = (
  state: HostIntroductionState,
  now: number,
): HostIntroductionState =>
  (state.phase === "open" || state.phase === "claimed") && now >= state.expiresAt
    ? closeIntroduction(state, "expired")
    : state;

export const isIntroductionLive = (
  state: HostIntroductionState,
): state is Extract<HostIntroductionState, { readonly phase: "open" | "claimed" }> =>
  state.phase === "open" || state.phase === "claimed";

/** Devices this ledger approved by introduction in the 24 hours before `now`. */
export const introductionsApprovedSince = (
  devices: ReadonlyArray<LedgerDevice>,
  now: number,
): number =>
  devices.filter(
    (device) =>
      device.approvedVia === "introduction" && device.createdAt > now - INTRODUCTION_DAY_MS,
  ).length;

export type IntroductionOpenRefusal = "not-permitted" | "limit" | "busy" | "invalid-request";

/**
 * Opens a window for `introducerDeviceId`, the E2E-authenticated device asking. It needs
 * `devices:invite` in this host's ledger, room under the daily limits, and no other introducer's
 * live window. The same introducer asking again replaces its own window.
 */
export const openIntroduction = (input: {
  readonly current: HostIntroductionState;
  readonly introducerDeviceId: string;
  readonly ledger: ReadonlyArray<LedgerDevice>;
  readonly secret: Uint8Array | null;
  readonly id: string;
  /** Windows opened in the last 24 hours. */
  readonly openedToday: number;
  readonly now: number;
}):
  | { readonly ok: true; readonly state: HostIntroductionState; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: IntroductionOpenRefusal } => {
  const introducer = input.ledger.find((device) => device.deviceId === input.introducerDeviceId);
  if (!deviceCanInvite(introducer)) return { ok: false, reason: "not-permitted" };
  if (input.secret === null || !isIntroductionSecret(input.secret) || !isIntroductionId(input.id)) {
    return { ok: false, reason: "invalid-request" };
  }
  const current = tickIntroduction(input.current, input.now);
  if (isIntroductionLive(current) && current.introducerDeviceId !== input.introducerDeviceId) {
    return { ok: false, reason: "busy" };
  }
  if (
    introductionsApprovedSince(input.ledger, input.now) >= INTRODUCTION_DAILY_LIMIT ||
    input.openedToday >= INTRODUCTION_DAILY_OPEN_LIMIT
  ) {
    return { ok: false, reason: "limit" };
  }
  closeIntroduction(current, "cancelled");
  const expiresAt = input.now + INTRODUCTION_TTL_MS;
  return {
    ok: true,
    expiresAt,
    state: {
      phase: "open",
      id: input.id,
      introducerDeviceId: input.introducerDeviceId,
      secret: Uint8Array.from(input.secret),
      expiresAt,
      failedAttempts: 0,
    },
  };
};

export type IntroductionClaimOutcome =
  | {
      readonly kind: "claimed";
      readonly device: PendingPairingDevice;
      readonly peers: ReadonlyArray<IntroductionPeer>;
      readonly confirmationCode: string;
    }
  | { readonly kind: "rejected"; readonly reason: PairingRejectReason };

/**
 * A claim that arrived in an anonymous pairing session (transcript hash `th`) at host `hostId`.
 * Only a claim with a valid `proof` and `keyProof`, naming this host and key in its peers, takes
 * the window; anything else counts as a failed attempt.
 */
export const submitIntroductionClaim = (
  current: HostIntroductionState,
  input: {
    readonly hostId: string;
    readonly transcriptHash: Uint8Array;
    readonly message: unknown;
    readonly now: number;
  },
): { readonly state: HostIntroductionState; readonly outcome: IntroductionClaimOutcome } => {
  const state = tickIntroduction(current, input.now);
  const reject = (next: HostIntroductionState, reason: PairingRejectReason) => ({
    state: next,
    outcome: { kind: "rejected", reason } as const,
  });
  if (state.phase === "claimed") return reject(state, "busy");
  if (state.phase !== "open") {
    return reject(
      state,
      state.phase === "closed" && state.reason === "expired" ? "expired" : "no-window",
    );
  }
  const fail = () => {
    const failedAttempts = state.failedAttempts + 1;
    return failedAttempts >= INTRODUCTION_MAX_FAILED_ATTEMPTS
      ? reject(closeIntroduction(state, "too-many-attempts"), "too-many-attempts")
      : reject({ ...state, failedAttempts }, "invalid-claim");
  };
  if (input.transcriptHash.length !== TRANSCRIPT_BYTES) return fail();
  const message = input.message;
  if (!hasExactKeys(message, CLAIM_KEYS) || message.type !== "introduction-claim") return fail();
  const { alg, dk, name, keyProof, proof } = message;
  if (typeof alg !== "string" || !isDeviceAlgorithm(alg) || !isValidDeviceName(name)) {
    return fail();
  }
  const publicKey = decodeBase64url(dk);
  const keyProofBytes = decodeBase64url(keyProof, SIGNATURE_BYTES);
  const proofBytes = decodeBase64url(proof, 32);
  const peers = parseIntroductionPeers(message.peers);
  if (
    publicKey === null ||
    keyProofBytes === null ||
    proofBytes === null ||
    peers === null ||
    !isCanonicalDevicePublicKey(alg, publicKey)
  ) {
    return fail();
  }
  const own = peers.find((peer) => peer.hostId === input.hostId);
  if (own === undefined || own.alg !== alg || !timingSafeEqual(own.publicKey, publicKey)) {
    return fail();
  }
  const expected = introductionProof({
    secret: state.secret,
    transcriptHash: input.transcriptHash,
    alg,
    devicePublicKey: publicKey,
    name,
    peers,
  });
  if (!timingSafeEqual(expected, proofBytes)) return fail();
  if (
    !verifyDeviceSignature(
      alg,
      publicKey,
      introductionKeyProofMessage(input.transcriptHash, alg, publicKey),
      keyProofBytes,
    )
  ) {
    return fail();
  }
  const device: PendingPairingDevice = {
    alg,
    publicKey,
    deviceId: relayDeviceId(alg, publicKey),
    name,
  };
  const confirmationCode = introductionCode(state.secret, peers);
  return {
    state: {
      phase: "claimed",
      id: state.id,
      introducerDeviceId: state.introducerDeviceId,
      secret: state.secret,
      expiresAt: state.expiresAt,
      device,
      peers,
      confirmationCode,
    },
    outcome: { kind: "claimed", device, peers, confirmationCode },
  };
};

/** What the introducer signs for one host (spec §18.2): bound to everything it approved. */
const introductionApprovalMessage = (input: {
  readonly hostId: string;
  readonly introductionId: string;
  readonly introducerDeviceId: string;
  readonly device: {
    readonly alg: E2eeDeviceAlgorithm;
    readonly publicKey: Uint8Array;
    readonly name: string;
  };
  readonly confirmationCode: string;
  readonly expiresAt: number;
}): Uint8Array =>
  relaySigningInput(
    INTRODUCTION_APPROVAL_LABEL,
    input.hostId,
    input.introductionId,
    input.introducerDeviceId,
    relayDeviceId(input.device.alg, input.device.publicKey),
    input.device.alg,
    input.device.publicKey,
    input.device.name,
    input.confirmationCode,
    String(input.expiresAt),
  );

export interface IntroductionApprovalMessage {
  readonly introductionId: string;
  readonly deviceId: string;
  readonly confirmationCode: string;
  readonly sig: string;
}

export type IntroductionApprovalRefusal =
  | "no-introduction"
  | "expired"
  | "not-introducer"
  | "not-permitted"
  | "invalid-request"
  | "mismatch"
  | "code-mismatch"
  | "bad-signature";

/**
 * Checks an approval from `sessionDeviceId`, the E2E-authenticated device that sent it. The
 * introducer must still be active with `devices:invite` in `introducer` (the ledger now), and its
 * ledger key must have signed this host, window, device, name, code and deadline.
 */
export const verifyIntroductionApproval = (
  current: HostIntroductionState,
  input: {
    readonly hostId: string;
    readonly sessionDeviceId: string;
    readonly introducer: LedgerDevice | undefined;
    readonly message: unknown;
    readonly now: number;
  },
): { readonly ok: true } | { readonly ok: false; readonly reason: IntroductionApprovalRefusal } => {
  const state = tickIntroduction(current, input.now);
  if (state.phase === "closed" && state.reason === "expired") {
    return { ok: false, reason: "expired" };
  }
  if (state.phase !== "claimed") return { ok: false, reason: "no-introduction" };
  if (input.sessionDeviceId !== state.introducerDeviceId) {
    return { ok: false, reason: "not-introducer" };
  }
  const introducer = input.introducer;
  if (
    introducer === undefined ||
    introducer.deviceId !== state.introducerDeviceId ||
    !deviceCanInvite(introducer)
  ) {
    return { ok: false, reason: "not-permitted" };
  }
  const message = input.message;
  if (!hasExactKeys(message, APPROVAL_KEYS)) return { ok: false, reason: "invalid-request" };
  const sig = decodeBase64url(message.sig, SIGNATURE_BYTES);
  const introducerKey = decodeBase64url(introducer.publicKey);
  if (
    !isIntroductionId(message.introductionId) ||
    typeof message.deviceId !== "string" ||
    typeof message.confirmationCode !== "string" ||
    sig === null ||
    introducerKey === null
  ) {
    return { ok: false, reason: "invalid-request" };
  }
  if (message.introductionId !== state.id || message.deviceId !== state.device.deviceId) {
    return { ok: false, reason: "mismatch" };
  }
  if (message.confirmationCode !== state.confirmationCode) {
    return { ok: false, reason: "code-mismatch" };
  }
  const signed = introductionApprovalMessage({
    hostId: input.hostId,
    introductionId: state.id,
    introducerDeviceId: state.introducerDeviceId,
    device: state.device,
    confirmationCode: state.confirmationCode,
    expiresAt: state.expiresAt,
  });
  if (!verifyDeviceSignature(introducer.alg, introducerKey, signed, sig)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true };
};

// ── Introducer ───────────────────────────────────────────────────────────────

/** A host's report of the claim it holds, as the introducer reads it. */
export interface IntroductionClaimReport {
  readonly hostId: string;
  readonly introductionId: string;
  readonly expiresAt: number;
  readonly device: { readonly alg: unknown; readonly dk: unknown; readonly name: unknown };
  readonly peers: unknown;
}

export interface VerifiedIntroductionClaim {
  readonly hostId: string;
  readonly introductionId: string;
  readonly expiresAt: number;
  readonly device: {
    readonly alg: E2eeDeviceAlgorithm;
    readonly publicKey: Uint8Array;
    readonly deviceId: string;
    readonly name: string;
  };
}

/**
 * The introducer's check before it shows a code: every host reports the same name and the same
 * peers, those peers name only hosts this introduction opened, and each host's key is the one
 * the peers give for it. The code then covers every key the new device made.
 */
export const checkIntroductionClaims = (input: {
  readonly secret: Uint8Array;
  readonly openedHostIds: ReadonlyArray<string>;
  readonly reports: ReadonlyArray<IntroductionClaimReport>;
}):
  | {
      readonly ok: true;
      readonly confirmationCode: string;
      readonly name: string;
      readonly claims: ReadonlyArray<VerifiedIntroductionClaim>;
    }
  | { readonly ok: false; readonly reason: "mismatch" | "malformed" } => {
  let reference: ReadonlyArray<IntroductionPeer> | undefined;
  let name: string | undefined;
  const claims: Array<VerifiedIntroductionClaim> = [];
  if (input.reports.length === 0) return { ok: false, reason: "malformed" };
  for (const report of input.reports) {
    const peers = parseIntroductionPeers(report.peers);
    const { alg, dk } = report.device;
    const publicKey = decodeBase64url(dk);
    if (
      peers === null ||
      typeof alg !== "string" ||
      !isDeviceAlgorithm(alg) ||
      publicKey === null ||
      !isCanonicalDevicePublicKey(alg, publicKey) ||
      !isValidDeviceName(report.device.name) ||
      !isIntroductionId(report.introductionId)
    ) {
      return { ok: false, reason: "malformed" };
    }
    if (peers.some((peer) => !input.openedHostIds.includes(peer.hostId))) {
      return { ok: false, reason: "mismatch" };
    }
    if (reference !== undefined && !sameIntroductionPeers(reference, peers)) {
      return { ok: false, reason: "mismatch" };
    }
    if (name !== undefined && name !== report.device.name) return { ok: false, reason: "mismatch" };
    const own = peers.find((peer) => peer.hostId === report.hostId);
    if (own === undefined || own.alg !== alg || !timingSafeEqual(own.publicKey, publicKey)) {
      return { ok: false, reason: "mismatch" };
    }
    reference = peers;
    name = report.device.name;
    claims.push({
      hostId: report.hostId,
      introductionId: report.introductionId,
      expiresAt: report.expiresAt,
      device: { alg, publicKey, deviceId: relayDeviceId(alg, publicKey), name },
    });
  }
  if (reference === undefined || name === undefined) return { ok: false, reason: "malformed" };
  return {
    ok: true,
    confirmationCode: introductionCode(input.secret, reference),
    name,
    claims,
  };
};

/** The introducer's signed approval for one host, with its key for that host. */
export const signIntroductionApproval = Effect.fn("relay.signIntroductionApproval")(function* (
  signer: E2eeDeviceSigner,
  claim: VerifiedIntroductionClaim,
  confirmationCode: string,
) {
  const introducerDeviceId = relayDeviceId(signer.alg, signer.publicKey);
  const sig = yield* signer
    .sign(
      introductionApprovalMessage({
        hostId: claim.hostId,
        introductionId: claim.introductionId,
        introducerDeviceId,
        device: claim.device,
        confirmationCode,
        expiresAt: claim.expiresAt,
      }),
    )
    .pipe(Effect.mapError(() => new PairingError({ detail: "The device key could not sign." })));
  return {
    introductionId: claim.introductionId,
    deviceId: claim.device.deviceId,
    confirmationCode,
    sig: encodeBase64url(sig),
  } satisfies IntroductionApprovalMessage;
});
