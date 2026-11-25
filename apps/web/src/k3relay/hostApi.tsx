import { createK3RelayEnvironmentAtoms } from "@t3tools/client-runtime/state/k3relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, K3RelayHostState, K3RelayPairingOffer } from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

/** The host's relay over its RPCs; on/off and the URL are server settings. */
export const k3RelayEnvironment = createK3RelayEnvironmentAtoms(connectionAtomRuntime);

export interface K3RelayHostStateView {
  readonly state: K3RelayHostState | null;
  readonly error: string | null;
}

/** The host's live relay state. Nothing until the first state, so hosts without it show nothing. */
export function useK3RelayHostState(environmentId: EnvironmentId | null): K3RelayHostStateView {
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    environmentId === null ? null : k3RelayEnvironment.state({ environmentId, input: {} }),
    resolve,
  );
  return { state: query.data, error: query.data === null ? query.error : null };
}

/** A failed call's message, or null when it succeeded or was cut off. */
export type K3RelayHostCall<A = unknown> = Promise<
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string | null }
>;

const settle = async <A, E>(pending: Promise<AtomCommandResult<A, E>>): K3RelayHostCall<A> => {
  const result = await pending;
  if (result._tag === "Success") return { ok: true, value: result.value };
  if (isAtomCommandInterrupted(result)) return { ok: false, error: null };
  const error = squashAtomCommandFailure(result);
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
};

export interface K3RelayHostActions {
  readonly setEnabled: (enabled: boolean) => K3RelayHostCall;
  readonly setRelayUrl: (url: string) => K3RelayHostCall;
  readonly createOffer: () => K3RelayHostCall<K3RelayPairingOffer>;
  readonly cancelOffer: () => K3RelayHostCall;
  readonly approve: (deviceId: string) => K3RelayHostCall;
  readonly reject: () => K3RelayHostCall;
  readonly revoke: (deviceId: string) => K3RelayHostCall;
  readonly rename: (deviceId: string, name: string) => K3RelayHostCall;
}

export function useK3RelayHostActions(environmentId: EnvironmentId): K3RelayHostActions {
  const options = { reportFailure: false } as const;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, options);
  const createPairingOffer = useAtomCommand(k3RelayEnvironment.createPairingOffer, options);
  const cancelPairing = useAtomCommand(k3RelayEnvironment.cancelPairing, options);
  const approvePairing = useAtomCommand(k3RelayEnvironment.approvePairing, options);
  const rejectPairing = useAtomCommand(k3RelayEnvironment.rejectPairing, options);
  const revokeDevice = useAtomCommand(k3RelayEnvironment.revokeDevice, options);
  const renameDevice = useAtomCommand(k3RelayEnvironment.renameDevice, options);
  return {
    setEnabled: (enabled) =>
      settle(updateSettings({ environmentId, input: { patch: { relay: { enabled } } } })),
    setRelayUrl: (url) =>
      settle(updateSettings({ environmentId, input: { patch: { relay: { url } } } })),
    createOffer: () => settle(createPairingOffer({ environmentId, input: {} })),
    cancelOffer: () => settle(cancelPairing({ environmentId, input: {} })),
    approve: (deviceId) => settle(approvePairing({ environmentId, input: { deviceId } })),
    reject: () => settle(rejectPairing({ environmentId, input: {} })),
    revoke: (deviceId) => settle(revokeDevice({ environmentId, input: { deviceId } })),
    rename: (deviceId, name) => settle(renameDevice({ environmentId, input: { deviceId, name } })),
  };
}
