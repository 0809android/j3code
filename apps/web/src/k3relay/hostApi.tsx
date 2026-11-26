import {
  createK3RelayEnvironmentAtoms,
  hostLacksK3Relay,
} from "@t3tools/client-runtime/state/k3relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  K3RelayAccountProvider,
  K3RelayAccountState,
  K3RelayHostState,
  K3RelayPairingOffer,
} from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

/** The host's relay over its RPCs; on/off and the URL are server settings. */
const k3RelayEnvironment = createK3RelayEnvironmentAtoms(connectionAtomRuntime);

export interface K3RelayHostStateView {
  readonly state: K3RelayHostState | null;
  /** Null too for a host without the relay (an older K3 Code): its settings leave it out. */
  readonly error: string | null;
}

/** The host's live relay state. Nothing until the first state, so hosts without it show nothing. */
export function useK3RelayHostState(environmentId: EnvironmentId | null): K3RelayHostStateView {
  const resolve = useMessages();
  const atom =
    environmentId === null ? null : k3RelayEnvironment.state({ environmentId, input: {} });
  const query = useEnvironmentQuery(atom, resolve);
  const lacksRelay = useEnvironmentQuerySelector(atom, hostLacksK3Relay);
  return {
    state: query.data,
    error: query.data === null && !lacksRelay ? query.error : null,
  };
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
  readonly setNotifications: (notifications: boolean) => K3RelayHostCall;
  readonly setRelayUrl: (url: string) => K3RelayHostCall;
  readonly createOffer: () => K3RelayHostCall<K3RelayPairingOffer>;
  readonly cancelOffer: () => K3RelayHostCall;
  /** With the confirmation code the user compared; omitted only when the host offered one tap. */
  readonly approve: (deviceId: string, confirmationCode?: string) => K3RelayHostCall;
  readonly reject: () => K3RelayHostCall;
  readonly revoke: (deviceId: string) => K3RelayHostCall;
  readonly rename: (deviceId: string, name: string) => K3RelayHostCall;
  /** Whether the device may introduce others and revoke ordinary devices (spec §18.2). */
  readonly setInvite: (deviceId: string, invite: boolean) => K3RelayHostCall;
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
  const setDevicePermissions = useAtomCommand(k3RelayEnvironment.setDevicePermissions, options);
  return {
    setEnabled: (enabled) =>
      settle(updateSettings({ environmentId, input: { patch: { relay: { enabled } } } })),
    setNotifications: (notifications) =>
      settle(updateSettings({ environmentId, input: { patch: { relay: { notifications } } } })),
    setRelayUrl: (url) =>
      settle(updateSettings({ environmentId, input: { patch: { relay: { url } } } })),
    createOffer: () => settle(createPairingOffer({ environmentId, input: {} })),
    cancelOffer: () => settle(cancelPairing({ environmentId, input: {} })),
    approve: (deviceId, confirmationCode) =>
      settle(
        approvePairing({
          environmentId,
          input: confirmationCode === undefined ? { deviceId } : { deviceId, confirmationCode },
        }),
      ),
    reject: () => settle(rejectPairing({ environmentId, input: {} })),
    revoke: (deviceId) => settle(revokeDevice({ environmentId, input: { deviceId } })),
    rename: (deviceId, name) => settle(renameDevice({ environmentId, input: { deviceId, name } })),
    setInvite: (deviceId, invite) =>
      settle(setDevicePermissions({ environmentId, input: { deviceId, invite } })),
  };
}

export interface K3RelayAccountStateView {
  readonly state: K3RelayAccountState | null;
  readonly error: string | null;
}

/** The host's account at the relay and its approval policy (spec §20). Null on older hosts. */
export function useK3RelayAccountState(
  environmentId: EnvironmentId | null,
): K3RelayAccountStateView {
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    environmentId === null ? null : k3RelayEnvironment.accountState({ environmentId, input: {} }),
    resolve,
  );
  return { state: query.data, error: query.data === null ? query.error : null };
}

export interface K3RelayAccountActions {
  readonly signIn: (
    provider: K3RelayAccountProvider,
  ) => K3RelayHostCall<{ readonly authorizeUrl: string }>;
  readonly signOut: () => K3RelayHostCall;
  readonly setApproval: (requireApproval: boolean, acknowledgedRisk: boolean) => K3RelayHostCall;
}

export function useK3RelayAccountActions(environmentId: EnvironmentId): K3RelayAccountActions {
  const options = { reportFailure: false } as const;
  const signIn = useAtomCommand(k3RelayEnvironment.accountSignIn, options);
  const signOut = useAtomCommand(k3RelayEnvironment.accountSignOut, options);
  const setApproval = useAtomCommand(k3RelayEnvironment.accountSetApproval, options);
  return {
    signIn: (provider) => settle(signIn({ environmentId, input: { provider } })),
    signOut: () => settle(signOut({ environmentId, input: {} })),
    setApproval: (requireApproval, acknowledgedRisk) =>
      settle(setApproval({ environmentId, input: { requireApproval, acknowledgedRisk } })),
  };
}
