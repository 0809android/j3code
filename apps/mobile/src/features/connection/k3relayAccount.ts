import {
  type K3RelayAccountHost,
  type K3RelayAccountPendingSignIn,
  type K3RelayAccountScreenEvent,
  type K3RelayAccountScreenState,
  type K3RelayAccountSession,
  initialK3RelayAccountScreen,
  isK3RelayAccountCallback,
  reduceK3RelayAccountScreen,
} from "@t3tools/client-runtime/k3relay";
import { DEFAULT_K3_RELAY_URL } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

export type MobileK3RelayAccountScreen = K3RelayAccountScreenState<
  K3RelayAccountPendingSignIn,
  K3RelayAccountSession,
  K3RelayAccountHost
>;
export type MobileK3RelayAccountEvent = K3RelayAccountScreenEvent<
  K3RelayAccountPendingSignIn,
  K3RelayAccountSession,
  K3RelayAccountHost
>;

/**
 * The device's account screen, kept while the app runs so leaving Add environment does not sign
 * out. Memory only, like the session itself (§20.5).
 */
export const k3relayAccountScreenAtom: Atom.Writable<MobileK3RelayAccountScreen> = Atom.make(
  initialK3RelayAccountScreen<
    K3RelayAccountPendingSignIn,
    K3RelayAccountSession,
    K3RelayAccountHost
  >(DEFAULT_K3_RELAY_URL),
).pipe(Atom.withLabel("k3relay-account-screen"), Atom.keepAlive);

export const dispatchK3RelayAccount = (
  registry: AtomRegistry.AtomRegistry,
  event: MobileK3RelayAccountEvent,
) => registry.update(k3relayAccountScreenAtom, (state) => reduceK3RelayAccountScreen(state, event));

/**
 * A `k3relay://account/callback` that reached the app as a link rather than through the auth
 * session (Android can deliver both), until the account card takes it.
 */
export const pendingK3RelayAccountCallbackAtom = Atom.make<string | null>(null).pipe(
  Atom.withLabel("k3relay-account-callback"),
  Atom.keepAlive,
);

/** What `WebBrowser.openAuthSessionAsync` returned, as the callback to redeem, if any. */
export function authSessionCallback(result: {
  readonly type: string;
  readonly url?: string;
}): string | null {
  return result.type === "success" &&
    typeof result.url === "string" &&
    isK3RelayAccountCallback(result.url)
    ? result.url
    : null;
}
