import { WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

const UNKNOWN_RPC = /Unknown request tag/u;

const failureText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof value === "object" && value !== null && "message" in value
      ? String((value as { readonly message: unknown }).message)
      : "";

/**
 * Whether the host answered as one without the relay RPCs (an older K3 Code): its RPC server
 * refuses the unknown method. Its settings then leave the relay out instead of showing an error.
 */
export const hostLacksK3Relay = (result: AsyncResult.AsyncResult<unknown, unknown>): boolean =>
  result._tag === "Failure" &&
  result.cause.reasons.some((reason) =>
    UNKNOWN_RPC.test(
      failureText(
        Cause.isDieReason(reason)
          ? reason.defect
          : Cause.isFailReason(reason)
            ? reason.error
            : undefined,
      ),
    ),
  );

/**
 * The host's K3 relay as its settings screen uses it: the live state, pairing, and the device
 * ledger. Turning the relay on or off and changing its URL go through `serverUpdateSettings`.
 */
export function createK3RelayEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One relay change at a time per host, so a double click never approves or revokes twice.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:k3relay:state",
      tag: WS_METHODS.k3RelaySubscribe,
    }),
    createPairingOffer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:k3relay:create-pairing-offer",
      tag: WS_METHODS.k3RelayCreatePairingOffer,
      scheduler,
      concurrency,
    }),
    cancelPairing: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:k3relay:cancel-pairing",
      tag: WS_METHODS.k3RelayCancelPairing,
      scheduler,
      concurrency,
    }),
    approvePairing: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:k3relay:approve-pairing",
      tag: WS_METHODS.k3RelayApprovePairing,
      scheduler,
      concurrency,
    }),
    rejectPairing: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:k3relay:reject-pairing",
      tag: WS_METHODS.k3RelayRejectPairing,
      scheduler,
      concurrency,
    }),
    revokeDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:k3relay:revoke-device",
      tag: WS_METHODS.k3RelayRevokeDevice,
      scheduler,
      concurrency,
    }),
    renameDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:k3relay:rename-device",
      tag: WS_METHODS.k3RelayRenameDevice,
      scheduler,
      concurrency,
    }),
    /** The host's account at the relay and the approval policy for account devices (§20). */
    accountState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:k3relay:account-state",
      tag: WS_METHODS.k3RelayAccountSubscribe,
    }),
    accountSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:k3relay:account-sign-in",
      tag: WS_METHODS.k3RelayAccountSignIn,
      scheduler,
      concurrency,
    }),
    accountSignOut: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:k3relay:account-sign-out",
      tag: WS_METHODS.k3RelayAccountSignOut,
      scheduler,
      concurrency,
    }),
    accountSetApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:k3relay:account-set-approval",
      tag: WS_METHODS.k3RelayAccountSetApproval,
      scheduler,
      concurrency,
    }),
    /** A relayed device takes itself off the host; the host reads which device from the session. */
    forgetThisDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:k3relay:forget-this-device",
      tag: WS_METHODS.k3RelayForgetThisDevice,
    }),
  };
}
