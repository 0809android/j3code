import { ACCOUNT_LOOPBACK_PATH, type AccountProvider } from "@t3tools/shared/relay";
import { mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { type K3RelayAccountFailureReason, k3relayAccountFailureText } from "./account.ts";
import {
  type K3RelayPairingFailureReason,
  type K3RelayPairingProgress,
  k3relayPairingFailureText,
} from "./pairing.ts";

/**
 * The device's "sign in with an account" screen (spec §20), shared by web, desktop and mobile:
 * which sign-ins to show, and the screen's steps as a pure reducer. The apps own the effects
 * (opening the browser, receiving the callback) and feed their results back in as events.
 */

export type K3RelayAccountPlatform = "ios" | "android" | "web";

const PROVIDER_ORDER: ReadonlyArray<AccountProvider> = ["github", "google", "apple"];
const IOS_PROVIDER_ORDER: ReadonlyArray<AccountProvider> = ["apple", "github", "google"];

export interface K3RelayAccountSignInChoices {
  readonly providers: ReadonlyArray<AccountProvider>;
  /** iOS only: the relay offers other sign-ins but not Sign in with Apple, so none are shown. */
  readonly appleRequired: boolean;
}

/**
 * Only what the relay turned on. On iOS, App Store rule 4.8 wants Sign in with Apple beside any
 * other sign-in, so without it the account entry is left out and QR pairing remains.
 */
export function k3relayAccountSignInChoices(
  offered: ReadonlyArray<AccountProvider>,
  platform: K3RelayAccountPlatform,
): K3RelayAccountSignInChoices {
  const order = platform === "ios" ? IOS_PROVIDER_ORDER : PROVIDER_ORDER;
  const providers = order.filter((provider) => offered.includes(provider));
  if (platform === "ios" && providers.length > 0 && !providers.includes("apple")) {
    return { providers: [], appleRequired: true };
  }
  return { providers, appleRequired: false };
}

// ── The way back from the browser ────────────────────────────────────────────

const parseUrl = (text: string): URL | null => {
  try {
    return new URL(text.trim());
  } catch {
    return null;
  }
};

/** `k3relay://account/callback?…`, or the web client's own `/k3relay/account/callback` page. */
export function isK3RelayAccountCallback(url: string): boolean {
  const parsed = parseUrl(url);
  if (parsed === null) return false;
  if (parsed.protocol === "k3relay:") {
    return parsed.host.toLowerCase() === "account" && parsed.pathname === "/callback";
  }
  return (
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.pathname === ACCOUNT_LOOPBACK_PATH
  );
}

/** Whether `url` came back for this very sign-in. Another one's callback is ignored, not used. */
export function k3relayAccountCallbackMatches(
  pending: { readonly appState: string },
  url: string,
): boolean {
  return parseUrl(url)?.searchParams.get("state") === pending.appState;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Where a browser tab of this web client asks the relay to send the code: its own origin's
 * callback page. The relay allows loopback with a port, and HTTPS pages its operator listed in
 * `ACCOUNT_WEB_REDIRECTS`; any other origin has no way back, so the screen says so up front.
 */
export function k3relayAccountWebRedirect(origin: string): string | null {
  const parsed = parseUrl(origin);
  if (parsed === null) return null;
  const allowed =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname) && parsed.port !== "");
  return allowed ? `${parsed.origin}${ACCOUNT_LOOPBACK_PATH}` : null;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type K3RelayAccountScreenError =
  | { readonly kind: "account"; readonly reason: K3RelayAccountFailureReason }
  | { readonly kind: "pairing"; readonly reason: K3RelayPairingFailureReason }
  | { readonly kind: "message"; readonly message: string };

const taggedReason = (error: unknown, tag: string): string | null =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === tag &&
  typeof (error as { readonly reason?: unknown }).reason === "string"
    ? (error as { readonly reason: string }).reason
    : null;

/** The reason behind an account or pairing failure; `null` for anything else. */
export function k3relayAccountScreenError(error: unknown): K3RelayAccountScreenError | null {
  const account = taggedReason(error, "K3RelayAccountClientError");
  if (account !== null) {
    return { kind: "account", reason: account as K3RelayAccountFailureReason };
  }
  const pairing = taggedReason(error, "K3RelayPairingError");
  if (pairing !== null) {
    return { kind: "pairing", reason: pairing as K3RelayPairingFailureReason };
  }
  return null;
}

export function k3relayAccountScreenErrorText(
  error: K3RelayAccountScreenError,
  resolve: MFunctionType = mFallback,
): string {
  switch (error.kind) {
    case "account":
      return k3relayAccountFailureText(error.reason, resolve);
    case "pairing":
      return k3relayPairingFailureText(error.reason, resolve);
    case "message":
      return error.message;
  }
}

// ── The screen's steps ───────────────────────────────────────────────────────

export type K3RelayAccountOfferState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly providers: ReadonlyArray<AccountProvider> }
  | { readonly status: "failed"; readonly error: K3RelayAccountScreenError };

export type K3RelayAccountSignInStep<P> =
  | { readonly step: "starting"; readonly provider: AccountProvider }
  | { readonly step: "waiting"; readonly provider: AccountProvider; readonly pending: P };

export type K3RelayAccountHostsState<H> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly hosts: ReadonlyArray<H> }
  | { readonly status: "failed"; readonly error: K3RelayAccountScreenError };

export type K3RelayAccountConnecting =
  | { readonly hostId: string; readonly step: "connecting" }
  | {
      readonly hostId: string;
      readonly step: "awaiting-approval";
      readonly confirmationCode: string;
    }
  | { readonly hostId: string; readonly step: "redeeming" };

/**
 * `P` is the sign-in waiting for the browser, `S` the hour's session and `H` a listed host.
 * They stay opaque here: the reducer only moves them between steps.
 */
export type K3RelayAccountScreenState<P, S, H> =
  | {
      readonly kind: "signed-out";
      readonly relayUrl: string;
      readonly offer: K3RelayAccountOfferState;
      readonly signIn: K3RelayAccountSignInStep<P> | null;
      readonly error: K3RelayAccountScreenError | null;
    }
  | {
      readonly kind: "signed-in";
      readonly relayUrl: string;
      readonly provider: AccountProvider;
      readonly session: S;
      readonly hosts: K3RelayAccountHostsState<H>;
      readonly connecting: K3RelayAccountConnecting | null;
      readonly error: K3RelayAccountScreenError | null;
    };

export type K3RelayAccountScreenEvent<P, S, H> =
  | { readonly type: "relay-url-changed"; readonly relayUrl: string }
  | { readonly type: "offer-loading" }
  | { readonly type: "offer-loaded"; readonly providers: ReadonlyArray<AccountProvider> }
  | { readonly type: "offer-failed"; readonly error: K3RelayAccountScreenError }
  | { readonly type: "sign-in-requested"; readonly provider: AccountProvider }
  | { readonly type: "sign-in-opened"; readonly pending: P }
  | { readonly type: "sign-in-failed"; readonly error: K3RelayAccountScreenError }
  | { readonly type: "sign-in-cancelled" }
  | { readonly type: "signed-in"; readonly session: S }
  | { readonly type: "hosts-requested" }
  | { readonly type: "hosts-loaded"; readonly hosts: ReadonlyArray<H> }
  | { readonly type: "hosts-failed"; readonly error: K3RelayAccountScreenError }
  | { readonly type: "connect-requested"; readonly hostId: string }
  | { readonly type: "connect-progress"; readonly progress: K3RelayPairingProgress }
  | { readonly type: "connect-ended"; readonly error: K3RelayAccountScreenError | null }
  | { readonly type: "signed-out" };

export const initialK3RelayAccountScreen = <P, S, H>(
  relayUrl: string,
): K3RelayAccountScreenState<P, S, H> => ({
  kind: "signed-out",
  relayUrl,
  offer: { status: "idle" },
  signIn: null,
  error: null,
});

const isSessionExpired = (error: K3RelayAccountScreenError) =>
  error.kind === "account" && error.reason === "session-expired";

const connectingStep = (
  hostId: string,
  progress: K3RelayPairingProgress,
): K3RelayAccountConnecting =>
  progress.phase === "awaiting-approval"
    ? { hostId, step: "awaiting-approval", confirmationCode: progress.confirmationCode }
    : progress.phase === "redeeming"
      ? { hostId, step: "redeeming" }
      : { hostId, step: "connecting" };

/** Events that do not fit the current step return the same state, so stale results never land. */
export function reduceK3RelayAccountScreen<P, S, H>(
  state: K3RelayAccountScreenState<P, S, H>,
  event: K3RelayAccountScreenEvent<P, S, H>,
): K3RelayAccountScreenState<P, S, H> {
  if (event.type === "signed-out") return initialK3RelayAccountScreen(state.relayUrl);

  if (state.kind === "signed-out") {
    switch (event.type) {
      case "relay-url-changed":
        return state.signIn === null
          ? { ...state, relayUrl: event.relayUrl, offer: { status: "idle" }, error: null }
          : state;
      case "offer-loading":
        return { ...state, offer: { status: "loading" } };
      case "offer-loaded":
        return { ...state, offer: { status: "ready", providers: event.providers } };
      case "offer-failed":
        return { ...state, offer: { status: "failed", error: event.error } };
      case "sign-in-requested":
        return state.signIn === null
          ? { ...state, signIn: { step: "starting", provider: event.provider }, error: null }
          : state;
      case "sign-in-opened":
        return state.signIn?.step === "starting"
          ? {
              ...state,
              signIn: { step: "waiting", provider: state.signIn.provider, pending: event.pending },
            }
          : state;
      case "sign-in-failed":
        return state.signIn === null ? state : { ...state, signIn: null, error: event.error };
      case "sign-in-cancelled":
        return state.signIn === null ? state : { ...state, signIn: null, error: null };
      case "signed-in":
        return state.signIn?.step === "waiting"
          ? {
              kind: "signed-in",
              relayUrl: state.relayUrl,
              provider: state.signIn.provider,
              session: event.session,
              hosts: { status: "loading" },
              connecting: null,
              error: null,
            }
          : state;
      default:
        return state;
    }
  }

  switch (event.type) {
    case "hosts-requested":
      return { ...state, hosts: { status: "loading" }, error: null };
    case "hosts-loaded":
      return { ...state, hosts: { status: "ready", hosts: event.hosts } };
    case "hosts-failed":
      return isSessionExpired(event.error)
        ? { ...initialK3RelayAccountScreen(state.relayUrl), error: event.error }
        : { ...state, hosts: { status: "failed", error: event.error } };
    case "connect-requested":
      return state.connecting === null
        ? { ...state, connecting: { hostId: event.hostId, step: "connecting" }, error: null }
        : state;
    case "connect-progress":
      return state.connecting === null
        ? state
        : { ...state, connecting: connectingStep(state.connecting.hostId, event.progress) };
    case "connect-ended":
      if (event.error !== null && isSessionExpired(event.error)) {
        return { ...initialK3RelayAccountScreen(state.relayUrl), error: event.error };
      }
      return { ...state, connecting: null, error: event.error };
    default:
      return state;
  }
}
