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
import { msg } from "gt-react";

import { m } from "~/i18n/messages";

/** A sign-in waiting for the browser, with the page it opened so the user can open it again. */
export interface WebK3RelayAccountSignIn {
  readonly pending: K3RelayAccountPendingSignIn;
  readonly authorizeUrl: string;
}

export type WebK3RelayAccountScreen = K3RelayAccountScreenState<
  WebK3RelayAccountSignIn,
  K3RelayAccountSession,
  K3RelayAccountHost
>;
export type WebK3RelayAccountEvent = K3RelayAccountScreenEvent<
  WebK3RelayAccountSignIn,
  K3RelayAccountSession,
  K3RelayAccountHost
>;

/**
 * The device's account screen, kept for the app's lifetime so closing the dialog does not sign
 * out or lose a sign-in the browser has not returned from. Memory only, like the session (§20.5).
 */
export const k3relayAccountScreenAtom: Atom.Writable<WebK3RelayAccountScreen> = Atom.make(
  initialK3RelayAccountScreen<WebK3RelayAccountSignIn, K3RelayAccountSession, K3RelayAccountHost>(
    DEFAULT_K3_RELAY_URL,
  ),
).pipe(Atom.withLabel("k3relay-account-screen"), Atom.keepAlive);

export const dispatchK3RelayAccount = (
  registry: AtomRegistry.AtomRegistry,
  event: WebK3RelayAccountEvent,
) => registry.update(k3relayAccountScreenAtom, (state) => reduceK3RelayAccountScreen(state, event));

/** A `k3relay://account/callback` the OS handed the desktop app, until the account panel takes it. */
export const pendingK3RelayAccountCallbackAtom = Atom.make<string | null>(null).pipe(
  Atom.withLabel("k3relay-account-callback"),
);

/** How the browser tab the provider returned to hands the callback to the tab that signed in. */
export const K3RELAY_ACCOUNT_CALLBACK_CHANNEL = "k3relay-account-callback";

/**
 * On the sign-in's return page (`/k3relay/account/callback`), passes the URL to the tab that
 * started the sign-in, where the verifier and key are, and closes. Returns whether this was that
 * page, in which case the app does not start here.
 */
export function forwardK3RelayAccountCallback(location: Location): boolean {
  if (!isK3RelayAccountCallback(location.href)) return false;
  const callbackUrl = location.href;
  // The code is useless without the other tab's verifier and key, but it need not stay in history.
  window.history.replaceState(null, "", "/");
  if (typeof BroadcastChannel === "function") {
    const channel = new BroadcastChannel(K3RELAY_ACCOUNT_CALLBACK_CHANNEL);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel only reaches this origin and takes no target origin
    channel.postMessage(callbackUrl);
    channel.close();
  }
  const root = document.getElementById("root");
  if (root !== null) {
    root.textContent = m(msg("Return to K3 Code to finish signing in. You can close this window."));
    root.style.cssText = "padding:2rem;font:14px system-ui,sans-serif;text-align:center";
  }
  window.close();
  return true;
}

/** Listens for callbacks from return pages in other tabs of this origin. */
export function listenForK3RelayAccountCallbacks(receive: (url: string) => void): () => void {
  if (typeof BroadcastChannel !== "function") return () => undefined;
  const channel = new BroadcastChannel(K3RELAY_ACCOUNT_CALLBACK_CHANNEL);
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string" && isK3RelayAccountCallback(event.data)) receive(event.data);
  });
  return () => channel.close();
}
