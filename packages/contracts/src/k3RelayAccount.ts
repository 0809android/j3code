import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Accounts on the host side of the K3 relay (spec v3.5 §20): signing this host in to an account
 * at the relay, so the account's devices find it, and the approval policy for devices that come
 * through an account. Approval is on by default; turning it off needs an acknowledged risk.
 */

export const K3_RELAY_ACCOUNT_METHODS = {
  subscribe: "k3relay.account.subscribe",
  signIn: "k3relay.account.signIn",
  signOut: "k3relay.account.signOut",
  setApproval: "k3relay.account.setApproval",
} as const;

export const K3RelayAccountProvider = Schema.Literals(["github", "google", "apple"]);
export type K3RelayAccountProvider = typeof K3RelayAccountProvider.Type;

export const K3RelayAccountFailure = Schema.Literals([
  "policy-disallowed",
  "disabled",
  "not-registered",
  "provider-unavailable",
  "relay-unreachable",
  "sign-in-failed",
  "sign-in-cancelled",
  "risk-not-acknowledged",
  "internal",
]);
export type K3RelayAccountFailure = typeof K3RelayAccountFailure.Type;

export class K3RelayAccountError extends Schema.TaggedError<K3RelayAccountError>()(
  "K3RelayAccountError",
  { failure: K3RelayAccountFailure },
) {
  override get message(): string {
    switch (this.failure) {
      case "policy-disallowed":
        return "Your organization's policy does not allow the K3 relay on this host.";
      case "disabled":
        return "Turn on the K3 relay before signing in.";
      case "not-registered":
        return "This host is not registered with the relay yet. Wait until it is connected.";
      case "provider-unavailable":
        return "The relay does not offer this sign-in.";
      case "relay-unreachable":
        return "The relay could not be reached.";
      case "sign-in-failed":
        return "Signing in did not finish.";
      case "sign-in-cancelled":
        return "Signing in was cancelled.";
      case "risk-not-acknowledged":
        return "Turning approval off needs the risk acknowledged.";
      case "internal":
        return "The K3 relay could not complete the request.";
    }
  }
}

/** A device that came through an account and waits in the host's approval (pairing) state. */
export const K3RelayAccountPendingDevice = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  /**
   * The host's user opened "Add device" and this is its first device: approving needs no code
   * comparison. Otherwise the codes must be compared, as for QR pairing.
   */
  oneTap: Schema.Boolean,
});
export type K3RelayAccountPendingDevice = typeof K3RelayAccountPendingDevice.Type;

export const K3RelayAccountState = Schema.Struct({
  /** What the relay offers; empty when it has no accounts or could not be reached. */
  availableProviders: Schema.Array(K3RelayAccountProvider),
  signedIn: Schema.Boolean,
  provider: Schema.NullOr(K3RelayAccountProvider),
  /** Epoch milliseconds. */
  signedInAt: Schema.NullOr(NonNegativeInt),
  /** A sign-in waits for the browser to come back to this machine. */
  signInPending: Schema.Boolean,
  lastError: Schema.NullOr(K3RelayAccountFailure),
  /** Devices that come through an account need the host's approval (spec §20.3). */
  requireApproval: Schema.Boolean,
  /** When the user turned approval off after being shown the risk. */
  approvalOptOutAt: Schema.NullOr(NonNegativeInt),
  pendingDevice: Schema.NullOr(K3RelayAccountPendingDevice),
});
export type K3RelayAccountState = typeof K3RelayAccountState.Type;

export const K3RelayAccountSignInInput = Schema.Struct({ provider: K3RelayAccountProvider });
export type K3RelayAccountSignInInput = typeof K3RelayAccountSignInInput.Type;

export const K3RelayAccountSignInResult = Schema.Struct({
  /** Open in a browser on this host's machine: the provider returns to a loopback listener. */
  authorizeUrl: TrimmedNonEmptyString,
});
export type K3RelayAccountSignInResult = typeof K3RelayAccountSignInResult.Type;

export const K3RelayAccountApprovalInput = Schema.Struct({
  requireApproval: Schema.Boolean,
  /** Must be true to turn approval off: the user saw why it matters and chose anyway. */
  acknowledgedRisk: Schema.Boolean,
});
export type K3RelayAccountApprovalInput = typeof K3RelayAccountApprovalInput.Type;

const K3RelayAccountRpcError = Schema.Union([K3RelayAccountError, EnvironmentAuthorizationError]);

export const WsK3RelayAccountSubscribeRpc = Rpc.make(K3_RELAY_ACCOUNT_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: K3RelayAccountState,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsK3RelayAccountSignInRpc = Rpc.make(K3_RELAY_ACCOUNT_METHODS.signIn, {
  payload: K3RelayAccountSignInInput,
  success: K3RelayAccountSignInResult,
  error: K3RelayAccountRpcError,
});

export const WsK3RelayAccountSignOutRpc = Rpc.make(K3_RELAY_ACCOUNT_METHODS.signOut, {
  payload: Schema.Struct({}),
  error: K3RelayAccountRpcError,
});

export const WsK3RelayAccountSetApprovalRpc = Rpc.make(K3_RELAY_ACCOUNT_METHODS.setApproval, {
  payload: K3RelayAccountApprovalInput,
  success: K3RelayAccountState,
  error: K3RelayAccountRpcError,
});
