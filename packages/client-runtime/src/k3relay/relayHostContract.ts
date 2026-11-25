import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

/**
 * The host's K3 Relay surface as this client uses it, until `packages/contracts` defines it.
 */

// ── Host settings (Settings > Relay) ────────────────────────────────────────

export const K3RelayHostStatus = Schema.Literals([
  "disabled",
  "connecting",
  "online",
  "offline",
  "error",
]);
export type K3RelayHostStatus = typeof K3RelayHostStatus.Type;

export interface K3RelayHostOffer {
  /** `k3relay://pair?...#s=...`; shown as a QR code and, with a warning, as a link. */
  readonly link: string;
  readonly expiresAt: number;
}

export interface K3RelayPendingDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly alg: "ed25519" | "p256";
  /** `K7QM-2XFD`; the device shows the same code. */
  readonly confirmationCode: string;
  readonly approvalDeadline: number;
}

export interface K3RelayHostDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly alg: "ed25519" | "p256";
  readonly approvedAt: number;
  readonly revokedAt: number | null;
  readonly lastSeenAt: number | null;
}

export interface K3RelayHostState {
  readonly enabled: boolean;
  readonly relayUrl: string;
  readonly status: K3RelayHostStatus;
  /** An error code from the host, when `status` is `error`. */
  readonly statusDetail: string | null;
  /** Managed policy (`allowsConnect` / `allowsRemoteClients`) can keep the relay off. */
  readonly allowedByPolicy: boolean;
  /** The relay reaches the host even with network access off; the UI says so. */
  readonly networkAccessEnabled: boolean;
  readonly offer: K3RelayHostOffer | null;
  readonly pending: K3RelayPendingDevice | null;
  readonly devices: ReadonlyArray<K3RelayHostDevice>;
}

export class K3RelayHostApiError extends Schema.TaggedError<K3RelayHostApiError>()(
  "K3RelayHostApiError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** What the host's settings screen needs. The real implementation will call the host's RPCs. */
export interface K3RelayHostApi {
  readonly state: Stream.Stream<K3RelayHostState, K3RelayHostApiError>;
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void, K3RelayHostApiError>;
  readonly setRelayUrl: (relayUrl: string) => Effect.Effect<void, K3RelayHostApiError>;
  readonly createOffer: Effect.Effect<K3RelayHostOffer, K3RelayHostApiError>;
  readonly cancelOffer: Effect.Effect<void, K3RelayHostApiError>;
  readonly approve: (deviceId: string) => Effect.Effect<void, K3RelayHostApiError>;
  readonly reject: (deviceId: string) => Effect.Effect<void, K3RelayHostApiError>;
  readonly revokeDevice: (deviceId: string) => Effect.Effect<void, K3RelayHostApiError>;
  readonly renameDevice: (
    deviceId: string,
    name: string,
  ) => Effect.Effect<void, K3RelayHostApiError>;
}
