import {
  K3_RELAY_DEVICE_REVOKE_PATH,
  K3_RELAY_INTRODUCTION_APPROVE_PATH,
  K3_RELAY_INTRODUCTION_CANCEL_PATH,
  K3_RELAY_INTRODUCTION_CLAIM_PATH,
  K3_RELAY_INTRODUCTION_PATH,
  K3_RELAY_PROVISIONAL_ORIGIN,
  K3RelayIntroductionClaimResponse,
  K3RelayIntroductionErrorResponse,
  K3RelayIntroductionFailure,
  K3RelayIntroductionOpenResponse,
} from "@t3tools/contracts";
import {
  type DevicePairingState,
  type IntroductionPeer,
  type VerifiedIntroductionClaim,
  PAIRING_APPROVAL_TIMEOUT_MS,
  checkIntroductionClaims,
  createIntroductionClaim,
  encodeBase64url,
  encodeIntroductionLink,
  introductionCode,
  isIntroductionLink,
  parseIntroductionLink,
  receivePairingReply,
  signIntroductionApproval,
} from "@t3tools/shared/relay";
import { type E2eeDeviceSigner, layerE2eeCrypto } from "@t3tools/shared/socketE2ee";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { K3RelayConnectionProfile } from "../connection/catalog.ts";
import type { ConnectionTransport } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { k3relayTunnelInput } from "./broker.ts";
import { K3RelayTunnels } from "./tunnels.ts";
import { DeviceKeyStore } from "./deviceKeyStore.ts";
import {
  type K3RelayPairedDevice,
  K3RelayPairingError,
  type K3RelayPairingFailureReason,
  decodePairingFrame,
  encodePairingFrame,
} from "./pairing.ts";
import { findK3RelayFailureReason } from "./admission.ts";
import { makeK3RelayE2eeSocket } from "./tunnel.ts";

/**
 * Introductions (spec §18.2, `infra/k3-relay/docs/INTRODUCTION.md`). The introducer opens a
 * window on each of its hosts inside its own tunnels and shows a QR code; the new device claims
 * every host from it, and the introducer approves them all after one comparison of codes.
 */

export const K3RelayIntroductionFailureReason = Schema.Literals([
  ...K3RelayIntroductionFailure.literals,
  "unreachable",
  "unsupported",
  "no-hosts",
  "no-claim",
  "invalid-reply",
]);
export type K3RelayIntroductionFailureReason = typeof K3RelayIntroductionFailureReason.Type;

export class K3RelayIntroductionError extends Schema.TaggedError<K3RelayIntroductionError>()(
  "K3RelayIntroductionError",
  { reason: K3RelayIntroductionFailureReason },
) {
  override get message(): string {
    return `The introduction failed: ${this.reason}.`;
  }
}

const failWith = (reason: K3RelayIntroductionFailureReason) =>
  new K3RelayIntroductionError({ reason });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeError = Schema.decodeUnknownOption(K3RelayIntroductionErrorResponse);
const decodeOpened = Schema.decodeUnknownOption(K3RelayIntroductionOpenResponse);
const decodeClaim = Schema.decodeUnknownOption(K3RelayIntroductionClaimResponse);

/** One `POST` through the tunnel to a device-only route. */
const post = Effect.fn("K3RelayIntroduction.post")(function* (
  transport: ConnectionTransport,
  path: string,
  body: unknown,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      transport.fetch(`${K3_RELAY_PROVISIONAL_ORIGIN}${path}`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: encodeJson(body),
      }),
    catch: () => failWith("unreachable"),
  });
  const json: unknown = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
  if (response.status === 200) return json;
  const refused = decodeError(json);
  if (Option.isSome(refused)) return yield* failWith(refused.value.error);
  // An older host answers from the relayed router, which has no such route.
  if (response.status === 404 || response.status === 405) return yield* failWith("unsupported");
  if (response.status === 403) return yield* failWith("not-permitted");
  return yield* failWith("invalid-reply");
});

// ── The introducer ──────────────────────────────────────────────────────────

/** One host the introducer is paired with, reached through its tunnel. */
export interface K3RelayIntroducerHost {
  readonly label: string;
  readonly relayUrl: string;
  readonly hostId: string;
  readonly hostIdentityKey: Uint8Array;
  /** The introducer's own key on this host: it signs this host's approval. */
  readonly signer: E2eeDeviceSigner;
  readonly transport: ConnectionTransport;
}

export interface K3RelayIntroductionWindow {
  readonly host: K3RelayIntroducerHost;
  readonly introductionId: string;
  readonly expiresAt: number;
}

export interface K3RelayIntroductionSession {
  /** `k3relay://introduce?…#s=…`: show as a QR code, in person. */
  readonly link: string;
  readonly secret: Uint8Array;
  readonly expiresAt: number;
  readonly opened: ReadonlyArray<K3RelayIntroductionWindow>;
  readonly refused: ReadonlyArray<{
    readonly host: K3RelayIntroducerHost;
    readonly reason: K3RelayIntroductionFailureReason;
  }>;
}

/** Opens a window on every host that lets this device introduce, and builds the QR link. */
export const openK3RelayIntroduction = Effect.fn("K3RelayIntroduction.open")(function* (
  hosts: ReadonlyArray<K3RelayIntroducerHost>,
) {
  if (hosts.length === 0) return yield* failWith("no-hosts");
  const random = yield* SecureRandom.SecureRandom;
  const secret = Uint8Array.from(yield* random.randomBytes(16));
  const attempts = yield* Effect.forEach(
    hosts,
    (host) =>
      post(host.transport, K3_RELAY_INTRODUCTION_PATH, { secret: encodeBase64url(secret) }).pipe(
        Effect.flatMap((json) =>
          Effect.fromOption(decodeOpened(json)).pipe(
            Effect.mapError(() => failWith("invalid-reply")),
          ),
        ),
        Effect.map((opened) => ({ host, ...opened })),
        Effect.mapError((error) => ({ host, reason: error.reason })),
        Effect.result,
      ),
    { concurrency: "unbounded" },
  );
  const opened: Array<K3RelayIntroductionWindow> = [];
  const refused: Array<K3RelayIntroductionSession["refused"][number]> = [];
  for (const attempt of attempts) {
    if (attempt._tag === "Success") opened.push(attempt.success);
    else refused.push(attempt.failure);
  }
  if (opened.length === 0) return yield* failWith(refused[0]?.reason ?? "no-hosts");
  const expiresAt = Math.min(...opened.map((window) => window.expiresAt));
  return {
    link: encodeIntroductionLink({
      hosts: opened.map(({ host }) => ({
        relayUrl: host.relayUrl,
        hostId: host.hostId,
        hostIdentityKey: host.hostIdentityKey,
      })),
      secret,
      expiresAt,
    }),
    secret,
    expiresAt,
    opened,
    refused,
  } satisfies K3RelayIntroductionSession;
});

/** What the introducer shows for the user to compare with the new device's screen. */
export interface K3RelayIntroductionClaims {
  readonly confirmationCode: string;
  readonly deviceName: string;
  readonly claims: ReadonlyArray<{
    readonly window: K3RelayIntroductionWindow;
    readonly claim: VerifiedIntroductionClaim;
  }>;
  /** Hosts the new device did not reach in time; they are not approved. */
  readonly unclaimed: ReadonlyArray<K3RelayIntroductionWindow>;
}

const pollClaim = Effect.fn("K3RelayIntroduction.pollClaim")(function* (
  window: K3RelayIntroductionWindow,
  first: Deferred.Deferred<void>,
) {
  while (true) {
    const answer = yield* post(window.host.transport, K3_RELAY_INTRODUCTION_CLAIM_PATH, {
      introductionId: window.introductionId,
    }).pipe(
      Effect.map(decodeClaim),
      Effect.catchTags({ K3RelayIntroductionError: () => Effect.succeedNone }),
    );
    if (Option.isNone(answer)) return Option.none();
    if (answer.value.phase === "claimed") {
      yield* Deferred.succeed(first, undefined);
      return Option.some({ window, report: answer.value });
    }
    if ((yield* Clock.currentTimeMillis) >= window.expiresAt) return Option.none();
  }
});

/**
 * Waits for the new device's claims. Once the first arrives, the others get `settleMs` to follow
 * (the new device claims every host at once). Every host must report the same keys and name, or
 * nothing is shown: someone else claimed at least one of them.
 */
export const collectK3RelayIntroductionClaims = Effect.fn("K3RelayIntroduction.collect")(function* (
  session: K3RelayIntroductionSession,
  options?: { readonly settleMs?: number },
) {
  const first = yield* Deferred.make<void>();
  const settle = Deferred.await(first).pipe(
    Effect.andThen(Effect.sleep(options?.settleMs ?? 3_000)),
    Effect.as(Option.none()),
  );
  const results = yield* Effect.forEach(
    session.opened,
    (window) => Effect.raceFirst(pollClaim(window, first), settle),
    { concurrency: "unbounded" },
  );
  const arrived = results.flatMap((result) => (Option.isSome(result) ? [result.value] : []));
  if (arrived.length === 0) return yield* failWith("no-claim");
  const checked = checkIntroductionClaims({
    secret: session.secret,
    openedHostIds: session.opened.map((window) => window.host.hostId),
    reports: arrived.map(({ window, report }) => ({
      hostId: window.host.hostId,
      introductionId: report.introductionId,
      expiresAt: report.expiresAt,
      device: report.device,
      peers: report.peers,
    })),
  });
  if (!checked.ok) return yield* failWith("mismatch");
  return {
    confirmationCode: checked.confirmationCode,
    deviceName: checked.name,
    claims: checked.claims.map((claim) => ({
      window: arrived.find(({ window }) => window.host.hostId === claim.hostId)!.window,
      claim,
    })),
    unclaimed: session.opened.filter((window) => !arrived.some((entry) => entry.window === window)),
  } satisfies K3RelayIntroductionClaims;
});

export interface K3RelayIntroductionApproval {
  readonly host: K3RelayIntroducerHost;
  readonly result:
    | { readonly ok: true; readonly deviceId: string }
    | { readonly ok: false; readonly reason: K3RelayIntroductionFailureReason };
}

/**
 * The user compared the codes and approved: signs each host's approval with this device's key
 * there. `confirmationCode` is the code the user saw; the hosts refuse any other.
 */
export const approveK3RelayIntroduction = Effect.fn("K3RelayIntroduction.approve")(function* (
  claims: K3RelayIntroductionClaims,
  confirmationCode: string,
) {
  return yield* Effect.forEach(
    claims.claims,
    ({ window, claim }) =>
      signIntroductionApproval(window.host.signer, claim, confirmationCode).pipe(
        Effect.mapError(() => failWith("internal")),
        Effect.flatMap((approval) =>
          post(window.host.transport, K3_RELAY_INTRODUCTION_APPROVE_PATH, approval),
        ),
        Effect.match({
          onFailure: (error) => ({
            host: window.host,
            result: { ok: false, reason: error.reason },
          }),
          onSuccess: () => ({
            host: window.host,
            result: { ok: true, deviceId: claim.device.deviceId },
          }),
        }),
      ),
    { concurrency: "unbounded" },
  ) satisfies Effect.Effect<ReadonlyArray<K3RelayIntroductionApproval>, never, never>;
});

/** Withdraws every window; a new device waiting on one is refused. */
export const cancelK3RelayIntroduction = (session: K3RelayIntroductionSession) =>
  Effect.forEach(
    session.opened,
    (window) =>
      post(window.host.transport, K3_RELAY_INTRODUCTION_CANCEL_PATH, {
        introductionId: window.introductionId,
      }).pipe(Effect.ignore),
    { concurrency: "unbounded", discard: true },
  );

/** A device with `devices:invite` revokes a lost device on this host (never another inviter). */
export const revokeK3RelayDeviceAsIntroducer = (transport: ConnectionTransport, deviceId: string) =>
  post(transport, K3_RELAY_DEVICE_REVOKE_PATH, { deviceId }).pipe(Effect.asVoid);

// ── The new device ──────────────────────────────────────────────────────────

export type K3RelayIntroducedProgress =
  | { readonly phase: "connecting"; readonly hosts: number }
  | { readonly phase: "awaiting-approval"; readonly confirmationCode: string }
  | { readonly phase: "redeeming" };

export interface K3RelayIntroducedHostResult {
  readonly hostId: string;
  readonly relayUrl: string;
  readonly result: Exit.Exit<K3RelayPairedDevice, K3RelayPairingError>;
}

const pairingFailure = (reason: K3RelayPairingFailureReason, detail: string) =>
  new K3RelayPairingError({ reason, detail });

/**
 * Claims every host the introduction names, with a new key for each, and waits for the
 * introducer's approval. One code for all of them; each host answers on its own, so one that is
 * offline or refuses does not stop the others. Keys of hosts that did not pair are removed.
 */
export const runK3RelayIntroducedPairing = Effect.fn("K3Relay.runIntroducedPairing")(function* (
  input: {
    readonly link: string;
    readonly deviceName: string;
    readonly approvalTimeoutMs?: number;
  },
  onProgress: (progress: K3RelayIntroducedProgress) => Effect.Effect<void>,
) {
  const keys = yield* Effect.serviceOption(DeviceKeyStore);
  if (Option.isNone(keys)) {
    return yield* pairingFailure("device-key-unavailable", "This app cannot store a device key.");
  }
  const parsed = parseIntroductionLink(input.link, yield* Clock.currentTimeMillis);
  if (!parsed.ok)
    return yield* pairingFailure(parsed.reason, "The introduction link is not usable.");
  const { offer } = parsed;
  const random = yield* SecureRandom.SecureRandom;
  const created: Array<{
    readonly host: (typeof offer.hosts)[number];
    readonly keyId: string;
    readonly signer: E2eeDeviceSigner;
  }> = [];
  const removeKeys = (keyIds: ReadonlyArray<string>) =>
    Effect.forEach(keyIds, (keyId) => Effect.ignore(keys.value.remove(keyId)), { discard: true });
  for (const host of offer.hosts) {
    const keyId = `k3relay:${host.hostId}:${encodeBase64url(Uint8Array.from(yield* random.randomBytes(9)))}`;
    const signer = yield* keys.value.create(keyId).pipe(
      Effect.tapError(() => removeKeys(created.map((entry) => entry.keyId))),
      Effect.mapError(() =>
        pairingFailure("device-key-unavailable", "Could not create a device key."),
      ),
    );
    created.push({ host, keyId, signer });
  }
  const peers: ReadonlyArray<IntroductionPeer> = created.map(({ host, signer }) => ({
    hostId: host.hostId,
    alg: signer.alg,
    publicKey: signer.publicKey,
  }));
  const confirmationCode = introductionCode(offer.secret, peers);
  yield* onProgress({ phase: "connecting", hosts: created.length });
  yield* onProgress({ phase: "awaiting-approval", confirmationCode });

  const claimOne = Effect.fn("K3Relay.claimIntroducedHost")(
    function* (entry: (typeof created)[number]) {
      const { host, signer, keyId } = entry;
      const connectionFailure = (error: unknown) =>
        findK3RelayFailureReason(error) === "key-mismatch"
          ? pairingFailure("key-mismatch", "The host answered with a different key than the link.")
          : findK3RelayFailureReason(error) === "host-offline"
            ? pairingFailure("host-offline", "The host is offline or not connected to the relay.")
            : pairingFailure("no-window", "The host is not waiting for this introduction.");
      const socket = yield* makeK3RelayE2eeSocket({
        relayUrl: host.relayUrl,
        hostId: host.hostId,
        hostIdentityKey: host.hostIdentityKey,
        admission: { kind: "pairing" },
      });
      const reader = yield* socket.reader.pipe(Effect.mapError(connectionFailure));
      const writer = yield* socket.writer;
      const info = yield* socket.sessionInfo.pipe(Effect.mapError(connectionFailure));
      const claim = yield* createIntroductionClaim({
        secret: offer.secret,
        transcriptHash: info.transcriptHash,
        signer,
        name: input.deviceName,
        peers,
      }).pipe(Effect.mapError((error) => pairingFailure("invalid-claim", error.detail)));
      yield* writer.write(encodePairingFrame(claim)).pipe(Effect.mapError(connectionFailure));
      const [frame] = yield* reader.pull.pipe(
        Effect.mapError(() =>
          pairingFailure("host-offline", "The connection closed before the introduction ended."),
        ),
        Effect.timeoutOrElse({
          duration: input.approvalTimeoutMs ?? PAIRING_APPROVAL_TIMEOUT_MS,
          orElse: () => Effect.fail(pairingFailure("timeout", "Nobody approved in time.")),
        }),
      );
      const waiting: DevicePairingState = {
        phase: "awaiting-approval",
        relayUrl: host.relayUrl,
        hostId: host.hostId,
        hostIdentityKey: host.hostIdentityKey,
        alg: signer.alg,
        publicKey: signer.publicKey,
        confirmationCode,
      };
      const reply = receivePairingReply(
        waiting,
        decodePairingFrame(frame),
        yield* Clock.currentTimeMillis,
      );
      if (reply.phase === "failed") {
        return yield* pairingFailure(
          reply.reason as K3RelayPairingFailureReason,
          "The host did not add this device.",
        );
      }
      if (reply.phase !== "paired") {
        return yield* pairingFailure("invalid-reply", "The host's reply is invalid.");
      }
      return {
        record: reply.record,
        bootstrapToken: reply.bootstrapToken,
        keyId,
        signer,
      } satisfies K3RelayPairedDevice;
    },
    (effect, entry) =>
      effect.pipe(
        Effect.scoped,
        Effect.provide(layerE2eeCrypto),
        Effect.onError(() => Effect.ignore(keys.value.remove(entry.keyId))),
        Effect.exit,
      ),
  );

  const results = yield* Effect.forEach(created, claimOne, { concurrency: "unbounded" });
  return created.map(
    ({ host }, index) =>
      ({
        hostId: host.hostId,
        relayUrl: host.relayUrl,
        result: results[index]!,
      }) satisfies K3RelayIntroducedHostResult,
  );
});

/** The sentence a screen shows for an introduction the introducer could not finish. */
export function k3relayIntroductionFailureText(
  reason: K3RelayIntroductionFailureReason,
  resolve: MFunctionType = mFallback,
): string {
  switch (reason) {
    case "not-permitted":
      return resolve(
        msg("This device may not introduce devices to this host. Ask the host to allow it."),
      );
    case "limit":
      return resolve(msg("This host already added three devices by introduction today."));
    case "busy":
      return resolve(msg("Another device is introducing a device to this host right now."));
    case "mismatch":
      return resolve(
        msg(
          "Someone other than the new device answered the QR code. Nothing was approved. Start again.",
        ),
      );
    case "no-claim":
      return resolve(msg("The new device did not answer. Start again."));
    case "expired":
      return resolve(msg("The introduction expired. Start again."));
    case "code-mismatch":
    case "bad-signature":
      return resolve(msg("The host did not accept the approval. Start again."));
    case "disabled":
      return resolve(msg("The relay is turned off on this host."));
    case "unsupported":
      return resolve(msg("This host's K3 Code is too old for introductions."));
    case "unreachable":
      return resolve(msg("This device can't reach the host."));
    case "protected-device":
      return resolve(msg("Devices that may introduce devices can only be removed on the host."));
    case "unknown-device":
      return resolve(msg("That device is not on this host."));
    case "no-hosts":
      return resolve(msg("This device is not paired with any host through the relay."));
    case "no-introduction":
    case "not-introducer":
    case "invalid-request":
    case "invalid-reply":
    case "internal":
      return resolve(msg("The introduction could not be completed. Start again."));
  }
}

// ── The app's introducer ────────────────────────────────────────────────────

const isK3RelayProfile = Schema.is(K3RelayConnectionProfile);

/** What a pasted or scanned `k3relay://` link is, before anything is sent. */
export type K3RelayLinkPreview =
  | { readonly kind: "introduction"; readonly hosts: number; readonly expiresAt: number }
  | { readonly kind: "other" };

export const previewK3RelayIntroductionLink = (link: string, now: number) => {
  if (!isIntroductionLink(link)) return { kind: "other" } as const satisfies K3RelayLinkPreview;
  const parsed = parseIntroductionLink(link, now);
  return parsed.ok
    ? ({
        kind: "introduction",
        hosts: parsed.offer.hosts.length,
        expiresAt: parsed.offer.expiresAt,
      } as const satisfies K3RelayLinkPreview)
    : parsed.reason;
};

/**
 * This device as an introducer: every host it is paired with through the relay, reached through
 * the tunnels its connections already use. A host that is offline is left out of the QR code.
 */
export class K3RelayIntroducer extends Context.Service<
  K3RelayIntroducer,
  {
    readonly open: Effect.Effect<K3RelayIntroductionSession, K3RelayIntroductionError>;
    readonly collect: (
      session: K3RelayIntroductionSession,
      options?: { readonly settleMs?: number },
    ) => Effect.Effect<K3RelayIntroductionClaims, K3RelayIntroductionError>;
    readonly approve: (
      claims: K3RelayIntroductionClaims,
      confirmationCode: string,
    ) => Effect.Effect<ReadonlyArray<K3RelayIntroductionApproval>>;
    readonly cancel: (session: K3RelayIntroductionSession) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/k3relay/introduction/K3RelayIntroducer") {}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const tunnels = yield* Effect.serviceOption(K3RelayTunnels);
  const keys = yield* Effect.serviceOption(DeviceKeyStore);

  const hosts = Effect.gen(function* () {
    if (Option.isNone(tunnels) || Option.isNone(keys)) return [];
    const profiles = new Map<string, K3RelayConnectionProfile>();
    for (const entry of (yield* SubscriptionRef.get(registry.entries)).values()) {
      if (!entry.enabled) continue;
      for (const route of [entry, ...(entry.alternateRoutes ?? [])]) {
        const profile = Option.getOrUndefined(route.profile);
        if (isK3RelayProfile(profile) && !profiles.has(profile.hostId)) {
          profiles.set(profile.hostId, profile);
        }
      }
    }
    const reached = yield* Effect.forEach(
      [...profiles.values()],
      (profile) =>
        Effect.gen(function* () {
          const input = yield* k3relayTunnelInput(profile);
          const tunnel = yield* tunnels.value.acquire(profile.connectionId, input);
          return Option.some({
            label: profile.label,
            relayUrl: profile.relayUrl,
            hostId: profile.hostId,
            hostIdentityKey: input.hostIdentityKey,
            signer: input.signer,
            transport: tunnel.transport,
          } satisfies K3RelayIntroducerHost);
        }).pipe(
          Effect.provideService(DeviceKeyStore, keys.value),
          Effect.orElseSucceed(() => Option.none<K3RelayIntroducerHost>()),
        ),
      { concurrency: "unbounded" },
    );
    return reached.flatMap((host) => (Option.isSome(host) ? [host.value] : []));
  });

  return K3RelayIntroducer.of({
    open: hosts.pipe(
      Effect.flatMap(openK3RelayIntroduction),
      Effect.provide(SecureRandom.layerWebCrypto),
      Effect.withSpan("K3RelayIntroducer.open"),
    ),
    collect: collectK3RelayIntroductionClaims,
    approve: approveK3RelayIntroduction,
    cancel: cancelK3RelayIntroduction,
  });
});

export const layer = Layer.effect(K3RelayIntroducer, make);
