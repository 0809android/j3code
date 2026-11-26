import { WS_METHODS } from "@t3tools/contracts";
import type { AccountProvider } from "@t3tools/shared/relay";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type {
  K3RelayAccountHost,
  K3RelayAccountPendingSignIn,
  K3RelayAccountSession,
} from "../k3relay/account.ts";
import { K3RelayAccountOnboarding } from "../k3relay/accountOnboarding.ts";
import type { K3RelayPairingProgress } from "../k3relay/pairing.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createRuntimeCommand,
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
    /** Whether a device may introduce others (§18.2); the owner's call only. */
    setDevicePermissions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:k3relay:set-device-permissions",
      tag: WS_METHODS.k3RelaySetDevicePermissions,
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

/**
 * The device's own account at a relay (spec §20), as commands its sign-in screen runs. Unlike
 * the host atoms above, these talk to the relay directly, not to an environment.
 */
export function createK3RelayAccountCommands<R, E>(
  runtime: Atom.AtomRuntime<K3RelayAccountOnboarding | R, E>,
  label: string,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    offer: createRuntimeCommand(runtime, {
      label: `${label}:offer`,
      execute: (input: { readonly relayUrl: string }) =>
        K3RelayAccountOnboarding.pipe(Effect.flatMap((accounts) => accounts.offer(input.relayUrl))),
    }),
    startSignIn: createRuntimeCommand(runtime, {
      label: `${label}:start-sign-in`,
      execute: (input: {
        readonly relayUrl: string;
        readonly provider: AccountProvider;
        readonly redirect: string;
      }) =>
        K3RelayAccountOnboarding.pipe(Effect.flatMap((accounts) => accounts.startSignIn(input))),
    }),
    completeSignIn: createRuntimeCommand(runtime, {
      label: `${label}:complete-sign-in`,
      scheduler,
      // The browser can hand the same callback back twice; its code is redeemed once.
      concurrency: {
        mode: "singleFlight",
        key: (input: { readonly pending: K3RelayAccountPendingSignIn }) => input.pending.keyId,
      },
      execute: (input: {
        readonly pending: K3RelayAccountPendingSignIn;
        readonly callbackUrl: string;
      }) =>
        K3RelayAccountOnboarding.pipe(
          Effect.flatMap((accounts) => accounts.completeSignIn(input.pending, input.callbackUrl)),
        ),
    }),
    forget: createRuntimeCommand(runtime, {
      label: `${label}:forget`,
      execute: (input: { readonly keyId: string }) =>
        K3RelayAccountOnboarding.pipe(Effect.flatMap((accounts) => accounts.forget(input.keyId))),
    }),
    listHosts: createRuntimeCommand(runtime, {
      label: `${label}:list-hosts`,
      execute: (input: { readonly session: K3RelayAccountSession }) =>
        K3RelayAccountOnboarding.pipe(
          Effect.flatMap((accounts) => accounts.listHosts(input.session)),
        ),
    }),
    connectHost: createRuntimeCommand(runtime, {
      label: `${label}:connect-host`,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: (input: { readonly host: K3RelayAccountHost }) => input.host.hostId,
      },
      execute: (input: {
        readonly session: K3RelayAccountSession;
        readonly host: K3RelayAccountHost;
        readonly deviceName: string;
        readonly onProgress: (progress: K3RelayPairingProgress) => void;
      }) =>
        K3RelayAccountOnboarding.pipe(
          Effect.flatMap((accounts) =>
            accounts.connectHost(input, (progress) =>
              Effect.sync(() => input.onProgress(progress)),
            ),
          ),
        ),
    }),
  };
}
