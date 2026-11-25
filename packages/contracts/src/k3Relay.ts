import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

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

/**
 * Relayed devices never get a signed URL (spec §12): a signed URL is a bearer capability that
 * works over any route and outlives a revocation. They get a handle instead, which the host
 * redeems only for the E2E-authenticated device it was issued to, inside the mux.
 */
export const K3_RELAY_ASSET_ROUTE_PREFIX = "/api/assets/file";
export const K3_RELAY_UPLOAD_ROUTE_PREFIX = "/api/attachments/upload/relay";

/** The `code` of a host's answer to a request that cannot work through the relay. */
export const K3_RELAY_UNSUPPORTED_CODE = "relay-unsupported";

/** What cannot work through the relay, and so is refused there with this reason. */
export const K3RelayUnsupportedFeature = Schema.Literals([
  /** Signed asset or upload URLs: bearer capabilities usable outside the E2E channel. */
  "signed-url",
  /** Media tickets: `<img>`, EventSource and socket credentials in a URL. */
  "media-ticket",
  "guest-share",
  /** `/api/preview/tunnel`: raw TCP (SOCKS5) into the host's loopback ports. */
  "preview-tunnel",
  /** The device hub's proxy and `/api/devices/ws`. */
  "device-hub",
  /** The server browser's streamed preview tabs. */
  "preview-stream",
  "voice-input",
]);
export type K3RelayUnsupportedFeature = typeof K3RelayUnsupportedFeature.Type;

export const K3RelayUnsupportedResponse = Schema.Struct({
  code: Schema.Literal(K3_RELAY_UNSUPPORTED_CODE),
  feature: K3RelayUnsupportedFeature,
  message: Schema.String,
});
export type K3RelayUnsupportedResponse = typeof K3RelayUnsupportedResponse.Type;

export const k3RelayUnsupportedMessage = (feature: K3RelayUnsupportedFeature): string => {
  switch (feature) {
    case "signed-url":
      return "Signed URLs are not issued through the K3 relay.";
    case "media-ticket":
      return "Media tickets are not issued through the K3 relay.";
    case "guest-share":
      return "Guest sharing does not work through the K3 relay.";
    case "preview-tunnel":
      return "Port forwarding to the host does not work through the K3 relay.";
    case "device-hub":
      return "Devices on the host cannot be used through the K3 relay.";
    case "preview-stream":
      return "The host's browser preview does not work through the K3 relay.";
    case "voice-input":
      return "Voice input does not work through the K3 relay.";
  }
};

export const k3RelayUnsupportedResponse = (
  feature: K3RelayUnsupportedFeature,
): K3RelayUnsupportedResponse => ({
  code: K3_RELAY_UNSUPPORTED_CODE,
  feature,
  message: k3RelayUnsupportedMessage(feature),
});

/** A refusal of something the relay cannot carry; answers 403 with {@link K3RelayUnsupportedResponse}. */
export class K3RelayUnsupportedError extends Schema.TaggedError<K3RelayUnsupportedError>()(
  "K3RelayUnsupportedError",
  { code: Schema.Literal(K3_RELAY_UNSUPPORTED_CODE), feature: K3RelayUnsupportedFeature },
  { httpApiStatus: 403 },
) {
  static of(feature: K3RelayUnsupportedFeature) {
    return new K3RelayUnsupportedError({ code: K3_RELAY_UNSUPPORTED_CODE, feature });
  }

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(
      HttpServerResponse.jsonUnsafe(k3RelayUnsupportedResponse(this.feature), {
        status: 403,
        headers: { "cache-control": "no-store" },
      }),
    );
  }

  override get message(): string {
    return k3RelayUnsupportedMessage(this.feature);
  }
}

const isK3RelayUnsupportedResponse = Schema.is(K3RelayUnsupportedResponse);

/** The refused feature, when a host's answer is a relay refusal. */
export const k3RelayUnsupportedFeatureOf = (body: unknown): K3RelayUnsupportedFeature | null =>
  isK3RelayUnsupportedResponse(body) ? body.feature : null;

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
/**
 * How the waiting device is approved (spec §20.3). `compare-code`: the user compares the codes and
 * the approval names the code they saw. `one-tap`: the first device, not paired by QR, in an "Add
 * device" window the host's user opened, approved with one tap. QR pairing always compares codes.
 */
export const K3RelayApprovalMode = Schema.Literals(["compare-code", "one-tap"]);
export type K3RelayApprovalMode = typeof K3RelayApprovalMode.Type;

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
    /** Older hosts always compared codes. */
    approval: K3RelayApprovalMode.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("compare-code" as const)),
    ),
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

/**
 * Approving names the device, and, unless the host offered one tap, the confirmation code the user
 * compared: the host refuses a code-compare approval without the code it showed.
 */
export const K3RelayApproveInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  confirmationCode: Schema.optionalKey(TrimmedNonEmptyString),
});
export type K3RelayApproveInput = typeof K3RelayApproveInput.Type;

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
  "confirmation-required",
  "not-a-relay-device",
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
      case "confirmation-required":
        return "Compare the confirmation codes, then approve with the code this host shows.";
      case "not-a-relay-device":
        return "Only a device paired through the K3 relay can remove itself.";
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
