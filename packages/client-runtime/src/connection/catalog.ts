import { DesktopSshEnvironmentTargetSchema, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BearerConnectionTarget,
  K3RelayConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";

const ConnectionProfileBase = {
  connectionId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
};

export class BearerConnectionProfile extends Schema.TaggedClass<BearerConnectionProfile>()(
  "BearerConnectionProfile",
  {
    ...ConnectionProfileBase,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
    learned: Schema.optionalKey(Schema.Literal(true)),
    authorization: Schema.optionalKey(Schema.Literal("t3-connect")),
    /**
     * "tailscale" on a learned route the server found on its Tailscale
     * interface. A bare 100.64.0.0/10 address could belong to any VPN.
     */
    network: Schema.optionalKey(Schema.Literal("tailscale")),
    /**
     * The server's E2EE identity key (base64url) pinned from the pairing
     * link. Set once at pairing; a changed key fails the handshake loudly.
     */
    serverIdentityKey: Schema.optionalKey(Schema.String),
  },
) {}

export class SshConnectionProfile extends Schema.TaggedClass<SshConnectionProfile>()(
  "SshConnectionProfile",
  {
    ...ConnectionProfileBase,
    target: DesktopSshEnvironmentTargetSchema,
  },
) {}

/** The relay admission ticket the host signed for this device (spec §5). Re-verified before use. */
export const K3RelayStoredGrant = Schema.Struct({
  v: Schema.Literal(1),
  hostId: Schema.String,
  deviceId: Schema.String,
  alg: Schema.Literals(["ed25519", "p256"]),
  issuedAt: Schema.Number,
  expiresAt: Schema.Number,
  nonce: Schema.String,
  sig: Schema.String,
});
export type K3RelayStoredGrant = typeof K3RelayStoredGrant.Type;

export class K3RelayConnectionProfile extends Schema.TaggedClass<K3RelayConnectionProfile>()(
  "K3RelayConnectionProfile",
  {
    ...ConnectionProfileBase,
    relayUrl: Schema.String,
    hostId: Schema.String,
    /** The host key `Hk` (base64url) pinned at pairing. A different key never connects. */
    hostIdentityKey: Schema.String,
    /** Names the device key in the platform's key store; the secret never leaves it. */
    deviceKeyId: Schema.String,
    deviceAlg: Schema.Literals(["ed25519", "p256"]),
    /** base64url. */
    devicePublicKey: Schema.String,
    grant: K3RelayStoredGrant,
  },
) {}

export const ConnectionProfile = Schema.Union([
  BearerConnectionProfile,
  SshConnectionProfile,
  K3RelayConnectionProfile,
]);
export type ConnectionProfile = typeof ConnectionProfile.Type;

export interface ConnectionRoute {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
}

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
  readonly alternateRoutes?: ReadonlyArray<ConnectionRoute>;
  readonly enabled: boolean;
  readonly unsupportedReason?: string;
  readonly serverUpdateRequired?: boolean;
}

export class BearerConnectionCredential extends Schema.TaggedClass<BearerConnectionCredential>()(
  "BearerConnectionCredential",
  {
    token: Schema.String,
  },
) {}

/** A token bound to this device's DPoP key, which the host renews while the device uses it. */
export class DpopConnectionCredential extends Schema.TaggedClass<DpopConnectionCredential>()(
  "DpopConnectionCredential",
  {
    accessToken: Schema.String,
    expiresAtEpochMs: Schema.Number,
  },
) {}

export const ConnectionCredential = Schema.Union([
  BearerConnectionCredential,
  DpopConnectionCredential,
]);
export type ConnectionCredential = typeof ConnectionCredential.Type;

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  {
    target: PrimaryConnectionTarget,
  },
) {}

export class RelayConnectionRegistration extends Schema.TaggedClass<RelayConnectionRegistration>()(
  "RelayConnectionRegistration",
  {
    target: RelayConnectionTarget,
  },
) {}

export class BearerConnectionRegistration extends Schema.TaggedClass<BearerConnectionRegistration>()(
  "BearerConnectionRegistration",
  {
    target: BearerConnectionTarget,
    profile: BearerConnectionProfile,
    credential: ConnectionCredential,
  },
) {}

export class SshConnectionRegistration extends Schema.TaggedClass<SshConnectionRegistration>()(
  "SshConnectionRegistration",
  {
    target: SshConnectionTarget,
    profile: SshConnectionProfile,
    /** The token from pairing over SSH, which later connects reuse. */
    credential: BearerConnectionCredential,
  },
) {}

export class K3RelayConnectionRegistration extends Schema.TaggedClass<K3RelayConnectionRegistration>()(
  "K3RelayConnectionRegistration",
  {
    target: K3RelayConnectionTarget,
    profile: K3RelayConnectionProfile,
    /** The DPoP-bound session redeemed over the relay from the pairing's bootstrap credential. */
    credential: DpopConnectionCredential,
  },
) {}

export const ConnectionRegistration = Schema.Union([
  RelayConnectionRegistration,
  BearerConnectionRegistration,
  SshConnectionRegistration,
  K3RelayConnectionRegistration,
]);
export type ConnectionRegistration = typeof ConnectionRegistration.Type;

/**
 * The primary stays on same-origin cookie auth
 * (`PrimaryConnectionRegistration`); secondary local backends live on a
 * separate loopback origin and authenticate with a bearer token minted from
 * their bootstrap credential (`BearerConnectionRegistration`).
 */
export const PlatformConnectionRegistration = Schema.Union([
  PrimaryConnectionRegistration,
  BearerConnectionRegistration,
]);
export type PlatformConnectionRegistration = typeof PlatformConnectionRegistration.Type;

export function connectionRegistrationCatalogEntry(
  registration: ConnectionRegistration | PrimaryConnectionRegistration,
): ConnectionCatalogEntry {
  switch (registration._tag) {
    case "PrimaryConnectionRegistration":
    case "RelayConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.none(),
        enabled: true,
      };
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
    case "K3RelayConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.some(registration.profile),
        enabled: true,
      };
  }
}
