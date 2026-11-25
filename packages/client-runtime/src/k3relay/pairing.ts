import { type EnvironmentId, K3_RELAY_PROVISIONAL_ORIGIN } from "@t3tools/contracts";
import {
  type DevicePairingRecord,
  type DevicePairingState,
  PAIRING_APPROVAL_TIMEOUT_MS,
  createPairingClaim,
  decodeBase64url,
  receivePairingReply,
  startDevicePairing,
} from "@t3tools/shared/relay";
import {
  type E2eeDeviceSigner,
  deviceIdFromPublicKey,
  layerE2eeCrypto,
} from "@t3tools/shared/socketE2ee";
import { encodeBase64url } from "@t3tools/shared/relay";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as HttpClient from "effect/http/HttpClient";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { exchangeRemoteDpopAccessToken } from "../authorization/remote.ts";
import {
  DpopConnectionCredential,
  K3RelayConnectionProfile,
  K3RelayConnectionRegistration,
} from "../connection/catalog.ts";
import { type ConnectionAttemptError, K3RelayConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import type * as Persistence from "../platform/persistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { findK3RelayFailureReason } from "./admission.ts";
import { overTransport } from "./broker.ts";
import { DeviceKeyStore } from "./deviceKeyStore.ts";
import { makeK3RelayE2eeSocket, openK3RelayTunnel } from "./tunnel.ts";

/**
 * The device's half of pairing (spec §8): read the offer, reach the host anonymously over E2EE
 * pinned to the offer's `Hk`, send the claim, show the confirmation code while the host
 * decides, then redeem the bootstrap credential over a fresh, device-authenticated tunnel.
 */

export const K3RelayPairingFailureReason = Schema.Literals([
  "malformed",
  "insecure-relay",
  "host-mismatch",
  "expired",
  "no-window",
  "busy",
  "too-many-attempts",
  "invalid-claim",
  "rejected",
  "invalid-reply",
  "timeout",
  "host-offline",
  "relay-unreachable",
  "key-mismatch",
  "device-key-unavailable",
  "dpop-unavailable",
  "redeem-failed",
]);
export type K3RelayPairingFailureReason = typeof K3RelayPairingFailureReason.Type;

export class K3RelayPairingError extends Schema.TaggedError<K3RelayPairingError>()(
  "K3RelayPairingError",
  { reason: K3RelayPairingFailureReason, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export type K3RelayPairingProgress =
  | { readonly phase: "connecting"; readonly relayUrl: string }
  | { readonly phase: "awaiting-approval"; readonly confirmationCode: string }
  | { readonly phase: "redeeming" };

export interface K3RelayPairingInput {
  readonly link: string;
  /** Shown on the host's approval screen; travels only inside the E2EE channel. */
  readonly deviceName: string;
  readonly approvalTimeoutMs?: number;
}

export interface K3RelayPairedDevice {
  readonly record: DevicePairingRecord;
  readonly bootstrapToken: string;
  readonly keyId: string;
  readonly signer: E2eeDeviceSigner;
}

/** One JSON text frame each way on the anonymous pairing session: the claim, then the reply. */
export const encodePairingFrame = (message: unknown): string => JSON.stringify(message);

export const decodePairingFrame = (frame: string | Uint8Array): unknown => {
  try {
    return JSON.parse(typeof frame === "string" ? frame : new TextDecoder().decode(frame));
  } catch {
    return null;
  }
};

const failure = (reason: K3RelayPairingFailureReason, detail: string) =>
  new K3RelayPairingError({ reason, detail });

/** What the link says, for the screen before anything is sent. Never contains the secret. */
export interface K3RelayOfferPreview {
  readonly relayUrl: string;
  readonly hostId: string;
  readonly expiresAt: number;
}

export const previewK3RelayOffer = (
  link: string,
  now: number,
): K3RelayOfferPreview | K3RelayPairingFailureReason => {
  const state = startDevicePairing(link.trim(), now);
  if (state.phase === "failed") return state.reason;
  if (state.phase !== "offer") return "malformed";
  return {
    relayUrl: state.offer.relayUrl,
    hostId: state.offer.hostId,
    expiresAt: state.offer.expiresAt,
  };
};

const pairingFailureFromConnection = (error: unknown): K3RelayPairingError => {
  const reason = findK3RelayFailureReason(error);
  switch (reason) {
    case "key-mismatch":
      return failure("key-mismatch", "The host answered with a different key than the link.");
    case "host-offline":
      return failure("host-offline", "The host is offline or not connected to the relay.");
    default:
      // The relay answers 404 to a pairing connection without an open window, like an unknown host.
      return failure("no-window", "The relay has no open pairing window for this host.");
  }
};

/** Runs the claim. Fails with the reason to show; the device key is removed on any failure. */
export const runK3RelayDevicePairing = Effect.fn("K3Relay.runDevicePairing")(function* (
  input: K3RelayPairingInput,
  onProgress: (progress: K3RelayPairingProgress) => Effect.Effect<void>,
) {
  const keys = yield* Effect.serviceOption(DeviceKeyStore);
  if (Option.isNone(keys)) {
    return yield* failure("device-key-unavailable", "This app cannot store a device key.");
  }
  const start = startDevicePairing(input.link.trim(), yield* Clock.currentTimeMillis);
  if (start.phase === "failed") {
    return yield* failure(
      start.reason as K3RelayPairingFailureReason,
      "The pairing link is not usable.",
    );
  }
  if (start.phase !== "offer")
    return yield* failure("malformed", "The pairing link is not usable.");
  const { offer } = start;
  const random = yield* SecureRandom.SecureRandom;
  const keyId = `k3relay:${offer.hostId}:${encodeBase64url(Uint8Array.from(yield* random.randomBytes(9)))}`;
  const signer = yield* keys.value
    .create(keyId)
    .pipe(
      Effect.mapError(() => failure("device-key-unavailable", "Could not create a device key.")),
    );

  const claimed = Effect.gen(function* () {
    yield* onProgress({ phase: "connecting", relayUrl: offer.relayUrl });
    const socket = yield* makeK3RelayE2eeSocket({
      relayUrl: offer.relayUrl,
      hostId: offer.hostId,
      hostIdentityKey: offer.hostIdentityKey,
      admission: { kind: "pairing" },
    });
    const reader = yield* socket.reader.pipe(Effect.mapError(pairingFailureFromConnection));
    const writer = yield* socket.writer;
    const info = yield* socket.sessionInfo.pipe(Effect.mapError(pairingFailureFromConnection));
    const created = yield* createPairingClaim(start, {
      transcriptHash: info.transcriptHash,
      signer,
      name: input.deviceName,
      now: yield* Clock.currentTimeMillis,
    }).pipe(
      Effect.mapError((error) =>
        failure(error.detail.includes("expired") ? "expired" : "invalid-claim", error.detail),
      ),
    );
    yield* writer
      .write(encodePairingFrame(created.claim))
      .pipe(Effect.mapError(pairingFailureFromConnection));
    yield* onProgress({ phase: "awaiting-approval", confirmationCode: created.confirmationCode });
    const [frame] = yield* reader.pull.pipe(
      Effect.mapError(() =>
        failure("host-offline", "The pairing connection closed before the host answered."),
      ),
      Effect.timeoutOrElse({
        duration: input.approvalTimeoutMs ?? PAIRING_APPROVAL_TIMEOUT_MS,
        orElse: () => Effect.fail(failure("timeout", "The host did not answer in time.")),
      }),
    );
    const reply: DevicePairingState = receivePairingReply(
      created.state,
      decodePairingFrame(frame),
      yield* Clock.currentTimeMillis,
    );
    if (reply.phase === "failed") {
      return yield* failure(
        reply.reason as K3RelayPairingFailureReason,
        "The host did not pair this device.",
      );
    }
    if (reply.phase !== "paired")
      return yield* failure("invalid-reply", "The host's reply is invalid.");
    return {
      record: reply.record,
      bootstrapToken: reply.bootstrapToken,
      keyId,
      signer,
    } satisfies K3RelayPairedDevice;
  });

  return yield* claimed.pipe(
    Effect.scoped,
    Effect.provide(layerE2eeCrypto),
    Effect.onError(() => Effect.ignore(keys.value.remove(keyId))),
  );
});

export const k3relayConnectionIdFor = (hostId: string, signer: E2eeDeviceSigner) =>
  `k3relay:${hostId}:${deviceIdFromPublicKey(signer.alg, signer.publicKey)}`;

/** Redeems the bootstrap credential over the new grant's tunnel and builds what gets saved. */
export const redeemK3RelayPairing = Effect.fn("K3Relay.redeemPairing")(function* (
  paired: K3RelayPairedDevice,
) {
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const dpop = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  if (Option.isNone(dpop)) {
    return yield* failure("dpop-unavailable", "This app cannot create a DPoP key.");
  }
  const hostIdentityKey = decodeBase64url(paired.record.hostIdentityKey, 32);
  if (hostIdentityKey === null) return yield* failure("key-mismatch", "The pinned key is invalid.");
  const redeemFailed = (_error: unknown) =>
    failure("redeem-failed", "The host did not accept the pairing credential.");

  return yield* Effect.gen(function* () {
    const tunnel = yield* openK3RelayTunnel({
      relayUrl: paired.record.relayUrl,
      hostId: paired.record.hostId,
      hostIdentityKey,
      signer: paired.signer,
      grant: paired.record.grant,
    }).pipe(Effect.mapError(pairingFailureFromConnection));
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: K3_RELAY_PROVISIONAL_ORIGIN,
    }).pipe(overTransport(tunnel.transport), Effect.mapError(redeemFailed));
    const proof = yield* dpop.value
      .createProof({
        method: "POST",
        url: environmentEndpointUrl(K3_RELAY_PROVISIONAL_ORIGIN, "/oauth/token"),
      })
      .pipe(Effect.mapError(() => failure("dpop-unavailable", "Could not sign a DPoP proof.")));
    const access = yield* exchangeRemoteDpopAccessToken({
      httpBaseUrl: K3_RELAY_PROVISIONAL_ORIGIN,
      credential: paired.bootstrapToken,
      clientMetadata: presentation.metadata,
      dpopProof: proof,
    }).pipe(overTransport(tunnel.transport), Effect.mapError(redeemFailed));
    const connectionId = k3relayConnectionIdFor(paired.record.hostId, paired.signer);
    const target = new K3RelayConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    });
    return new K3RelayConnectionRegistration({
      target,
      profile: new K3RelayConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        relayUrl: paired.record.relayUrl,
        hostId: paired.record.hostId,
        hostIdentityKey: paired.record.hostIdentityKey,
        deviceKeyId: paired.keyId,
        deviceAlg: paired.signer.alg,
        devicePublicKey: encodeBase64url(paired.signer.publicKey),
        grant: paired.record.grant,
      }),
      credential: new DpopConnectionCredential({
        accessToken: access.access_token,
        expiresAtEpochMs: (yield* Clock.currentTimeMillis) + access.expires_in * 1_000,
      }),
    });
  }).pipe(Effect.scoped, Effect.provide(layerE2eeCrypto));
});

/** The sentence a screen shows for a pairing that did not finish. */
export function k3relayPairingFailureText(
  reason: K3RelayPairingFailureReason,
  resolve: MFunctionType = mFallback,
): string {
  switch (reason) {
    case "malformed":
      return resolve(msg("This is not a K3 Relay pairing link."));
    case "insecure-relay":
      return resolve(msg("The pairing link names a relay without HTTPS. It was not used."));
    case "host-mismatch":
      return resolve(
        msg("The pairing link was altered: its host key does not match its host. It was not used."),
      );
    case "expired":
      return resolve(msg("The pairing link expired. Create a new one on the host."));
    case "no-window":
      return resolve(
        msg(
          "The host is not waiting for a device, or another device is pairing right now. Try again, or create a new pairing link on the host.",
        ),
      );
    case "busy":
      return resolve(msg("Another device is pairing with the host. Try again in a moment."));
    case "too-many-attempts":
      return resolve(msg("Too many pairing attempts. Create a new pairing link on the host."));
    case "invalid-claim":
      return resolve(
        msg("The host refused the pairing request. The link may have been altered or reused."),
      );
    case "rejected":
      return resolve(msg("The host rejected this device."));
    case "invalid-reply":
      return resolve(msg("The host's answer could not be verified. Nothing was saved."));
    case "timeout":
      return resolve(msg("Nobody approved this device in time. Try again."));
    case "host-offline":
      return resolve(msg("The host is offline or not connected to the relay."));
    case "relay-unreachable":
      return resolve(msg("This device can't reach the relay."));
    case "key-mismatch":
      return resolve(
        msg(
          "The host answered with a different key than the pairing link. Someone may be intercepting the connection. Nothing was sent.",
        ),
      );
    case "device-key-unavailable":
      return resolve(msg("This device cannot store a key for the relay."));
    case "dpop-unavailable":
      return resolve(msg("This device cannot create a sign-in key for the host."));
    case "redeem-failed":
      return resolve(msg("The host approved this device, but signing in failed. Pair again."));
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

export class K3RelayOnboarding extends Context.Service<
  K3RelayOnboarding,
  {
    /** Pairs with the host behind `link` and saves the environment. */
    readonly pair: (
      input: K3RelayPairingInput,
      onProgress: (progress: K3RelayPairingProgress) => Effect.Effect<void>,
    ) => Effect.Effect<
      EnvironmentId,
      K3RelayPairingError | ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
  }
>()("@t3tools/client-runtime/k3relay/pairing/K3RelayOnboarding") {}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const context = yield* Effect.context<
    HttpClient.HttpClient | ClientCapabilities.ClientPresentation | Socket.WebSocketConstructor
  >();
  const keys = yield* Effect.serviceOption(DeviceKeyStore);
  const dpop = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const optional = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Option.isSome(keys) ? Effect.provideService(DeviceKeyStore, keys.value) : (self) => self,
      Option.isSome(dpop)
        ? Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, dpop.value)
        : (self) => self,
    );

  return K3RelayOnboarding.of({
    pair: Effect.fn("K3RelayOnboarding.pair")(
      function* (input, onProgress) {
        const paired = yield* optional(runK3RelayDevicePairing(input, onProgress));
        yield* onProgress({ phase: "redeeming" });
        const registration = yield* optional(redeemK3RelayPairing(paired)).pipe(
          Effect.onError(() =>
            Option.isSome(keys) ? Effect.ignore(keys.value.remove(paired.keyId)) : Effect.void,
          ),
        );
        yield* registry.register(registration);
        yield* registry.setCompatibility(registration.target.environmentId, null);
        yield* registry
          .setEnabled(registration.target.environmentId, true)
          .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));
        return registration.target.environmentId;
      },
      Effect.provide(Layer.mergeAll(Layer.succeedContext(context), SecureRandom.layerWebCrypto)),
    ),
  });
});

export const layer = Layer.effect(K3RelayOnboarding, make);
