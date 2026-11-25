import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

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
  };
}
