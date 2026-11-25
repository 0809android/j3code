import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The host side of the K3 relay (spec v3.5): its connection, pairing, and the device ledger.
 * Not T3 Connect, whose `relay:*` names live in `relay.ts`.
 */

export const DEFAULT_K3_RELAY_URL = "wss://relay.k3.kinocode.jp";

/**
 * The origin devices sign DPoP proofs against for requests through the relay mux. The host's real
 * name never reaches the relay, and relayed requests resolve against this origin only.
 */
export const K3_RELAY_PROVISIONAL_ORIGIN = "https://k3host.invalid";

/**
 * The E2EE v2 `environmentId` of relay sessions. A device only knows the host from its pairing
 * offer, so relay handshakes bind to the host id, not the environment id.
 */
export const k3RelayE2eeEnvironmentId = (hostId: string): string => hostId;

/** Device-only routes, served by the host's relay bridge inside the mux and nowhere else. */
export const K3_RELAY_GRANT_PATH = "/api/relay/grant";
export const K3_RELAY_BOOTSTRAP_PATH = "/api/relay/bootstrap";

export const K3RelaySettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  url: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_K3_RELAY_URL)),
  ),
  /** Concurrent device sessions this host serves through the relay. */
  maxSessions: PositiveInt.check(Schema.isLessThanOrEqualTo(64)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(8)),
  ),
  /** Buffered bytes one session may hold before its streams are refused. */
  maxSessionBufferBytes: PositiveInt.check(
    Schema.isBetween({ minimum: 1024 * 1024, maximum: 256 * 1024 * 1024 }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(16 * 1024 * 1024))),
});
export type K3RelaySettings = typeof K3RelaySettings.Type;

export const K3RelaySettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  url: Schema.optionalKey(TrimmedNonEmptyString),
  maxSessions: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(64))),
  maxSessionBufferBytes: Schema.optionalKey(
    PositiveInt.check(Schema.isBetween({ minimum: 1024 * 1024, maximum: 256 * 1024 * 1024 })),
  ),
});
export type K3RelaySettingsPatch = typeof K3RelaySettingsPatch.Type;

export const K3RelayConnectionStatus = Schema.Literals([
  "disabled",
  "connecting",
  "connected",
  "disconnected",
  "error",
]);
export type K3RelayConnectionStatus = typeof K3RelayConnectionStatus.Type;

/** Why the host is not connected, when it should be. */
export const K3RelayConnectionError = Schema.Literals([
  "policy-disallowed",
  "invalid-url",
  "registration-failed",
  "unauthorized",
  "blocked",
  "network",
  "identity-unavailable",
]);
export type K3RelayConnectionError = typeof K3RelayConnectionError.Type;

export const K3RelayDeviceAlgorithm = Schema.Literals(["ed25519", "p256"]);
export type K3RelayDeviceAlgorithm = typeof K3RelayDeviceAlgorithm.Type;

export const K3RelayDevice = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  name: Schema.String,
  alg: K3RelayDeviceAlgorithm,
  /** Epoch milliseconds. */
  createdAt: NonNegativeInt,
  lastSeenAt: Schema.NullOr(NonNegativeInt),
  status: Schema.Literals(["active", "revoked"]),
  revokedAt: Schema.NullOr(NonNegativeInt),
  /** Live E2E sessions through the relay right now. */
  connectedSessions: NonNegativeInt,
});
export type K3RelayDevice = typeof K3RelayDevice.Type;

export const K3RelayPairingCloseReason = Schema.Literals([
  "approved",
  "rejected",
  "expired",
  "too-many-attempts",
  "cancelled",
]);
export type K3RelayPairingCloseReason = typeof K3RelayPairingCloseReason.Type;

/** The host's pairing window. The offer link (with its secret) is only returned to its creator. */
export const K3RelayPairingState = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("idle") }),
  Schema.Struct({ phase: Schema.Literal("open"), expiresAt: NonNegativeInt }),
  Schema.Struct({
    phase: Schema.Literal("awaiting-approval"),
    deviceId: TrimmedNonEmptyString,
    deviceName: Schema.String,
    alg: K3RelayDeviceAlgorithm,
    /** `K7QM-2XFD`; the device shows the same code. Approving needs the user to compare them. */
    confirmationCode: TrimmedNonEmptyString,
    approvalDeadline: NonNegativeInt,
  }),
  Schema.Struct({ phase: Schema.Literal("closed"), reason: K3RelayPairingCloseReason }),
]);
export type K3RelayPairingState = typeof K3RelayPairingState.Type;

export const K3RelayHostState = Schema.Struct({
  enabled: Schema.Boolean,
  /** False when the managed policy forbids the relay; the connector never starts then. */
  policyAllowed: Schema.Boolean,
  /** False when `remoteTransportPolicy` is `private-e2ee-only`, which refuses relayed requests. */
  transportPolicyAllowed: Schema.Boolean,
  relayUrl: TrimmedNonEmptyString,
  status: K3RelayConnectionStatus,
  error: Schema.NullOr(K3RelayConnectionError),
  registered: Schema.Boolean,
  hostId: Schema.NullOr(TrimmedNonEmptyString),
  activeSessions: NonNegativeInt,
  connectedDevices: NonNegativeInt,
  maxSessions: PositiveInt,
  /**
   * The relay reaches this host even with network access turned off, since the host dials out.
   * Settings should say so next to the network access switch.
   */
  reachableWhenNetworkAccessOff: Schema.Boolean,
  /** New devices always need approval with compared codes; on by default (spec §20.3). */
  requireApproval: Schema.Boolean,
  pairing: K3RelayPairingState,
  devices: Schema.Array(K3RelayDevice),
});
export type K3RelayHostState = typeof K3RelayHostState.Type;

export const K3RelayPairingOffer = Schema.Struct({
  /** `k3relay://pair?…#s=…`; the secret sits in the fragment. Show as a QR code. */
  link: TrimmedNonEmptyString,
  relayUrl: TrimmedNonEmptyString,
  hostId: TrimmedNonEmptyString,
  /** `Hk`, base64url. */
  hostIdentityKey: TrimmedNonEmptyString,
  expiresAt: NonNegativeInt,
});
export type K3RelayPairingOffer = typeof K3RelayPairingOffer.Type;

export const K3RelayDeviceInput = Schema.Struct({ deviceId: TrimmedNonEmptyString });
export type K3RelayDeviceInput = typeof K3RelayDeviceInput.Type;

export const K3RelayRenameDeviceInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  name: Schema.String,
});
export type K3RelayRenameDeviceInput = typeof K3RelayRenameDeviceInput.Type;

export const K3RelayFailure = Schema.Literals([
  "policy-disallowed",
  "disabled",
  "no-pending-pairing",
  "unknown-device",
  "invalid-name",
  "internal",
]);
export type K3RelayFailure = typeof K3RelayFailure.Type;

export class K3RelayError extends Schema.TaggedError<K3RelayError>()("K3RelayError", {
  failure: K3RelayFailure,
}) {
  override get message(): string {
    switch (this.failure) {
      case "policy-disallowed":
        return "Your organization's policy does not allow the K3 relay on this host.";
      case "disabled":
        return "The K3 relay is turned off on this host.";
      case "no-pending-pairing":
        return "No device is waiting for approval.";
      case "unknown-device":
        return "That device is not in this host's ledger.";
      case "invalid-name":
        return "Device names must be 1-64 visible characters.";
      case "internal":
        return "The K3 relay could not complete the request.";
    }
  }
}

/** A relay grant (spec §5), exactly as the relay and `@t3tools/shared/relay` encode it. */
export const K3RelayGrant = Schema.Struct({
  v: Schema.Literal(1),
  hostId: Schema.String,
  deviceId: Schema.String,
  alg: K3RelayDeviceAlgorithm,
  issuedAt: NonNegativeInt,
  expiresAt: NonNegativeInt,
  nonce: Schema.String,
  sig: Schema.String,
});
export type K3RelayGrant = typeof K3RelayGrant.Type;

/** `POST /api/relay/grant` inside the mux: a fresh grant when under 30 days remain, else null. */
export const K3RelayGrantRenewalResponse = Schema.Struct({ grant: Schema.NullOr(K3RelayGrant) });
export type K3RelayGrantRenewalResponse = typeof K3RelayGrantRenewalResponse.Type;

/**
 * `POST /api/relay/bootstrap` inside the mux: a one-time credential for `/oauth/token`, bound to
 * the E2E-authenticated device. Exchange it through the relay with a DPoP proof.
 */
export const K3RelayBootstrapResponse = Schema.Struct({
  bootstrapToken: TrimmedNonEmptyString,
  expiresAt: NonNegativeInt,
});
export type K3RelayBootstrapResponse = typeof K3RelayBootstrapResponse.Type;
