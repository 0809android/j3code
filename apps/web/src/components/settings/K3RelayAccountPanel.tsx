import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type K3RelayAccountHost,
  type K3RelayAccountScreenError,
  k3relayAccountCallbackMatches,
  k3relayAccountScreenError,
  k3relayAccountScreenErrorText,
  k3relayAccountSignInChoices,
  k3relayAccountWebRedirect,
} from "@t3tools/client-runtime/k3relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { ACCOUNT_APP_REDIRECT, type AccountProvider } from "@t3tools/shared/relay";
import { RadioTowerIcon, ShieldCheckIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";

import { k3relayAccount } from "~/connection/onboarding";
import { m } from "~/i18n/messages";
import {
  type WebK3RelayAccountEvent,
  type WebK3RelayAccountScreen,
  dispatchK3RelayAccount,
  k3relayAccountScreenAtom,
  listenForK3RelayAccountCallbacks,
  pendingK3RelayAccountCallbackAtom,
} from "~/k3relay/accountSignIn";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

const PROVIDER_NAMES: Record<AccountProvider, string> = {
  github: "GitHub",
  google: "Google",
  apple: "Apple",
};

/** Host ids are long; the start is enough to tell a few machines apart until the host names itself. */
const shortHostId = (hostId: string) => hostId.slice(0, 10);

export interface K3RelayAccountPanelActions {
  readonly changeRelayUrl: (relayUrl: string) => void;
  readonly retryOffer: () => void;
  readonly signIn: (provider: AccountProvider) => void;
  readonly cancelSignIn: () => void;
  readonly signOut: () => void;
  readonly refreshHosts: () => void;
  readonly connect: (host: K3RelayAccountHost) => void;
}

/** Stateless apart from the relay field being edited, so tests render each step directly. */
export function K3RelayAccountView({
  state,
  canReturn,
  deviceName,
  savedHostIds,
  onDeviceNameChange,
  actions,
}: {
  readonly state: WebK3RelayAccountScreen;
  /** Whether the browser can come back here; false on a plain-HTTP address the relay can't allow. */
  readonly canReturn: boolean;
  readonly deviceName: string;
  readonly savedHostIds: ReadonlySet<string>;
  readonly onDeviceNameChange: (name: string) => void;
  readonly actions: K3RelayAccountPanelActions;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const [relayDraft, setRelayDraft] = useState<string | null>(null);
  const errorText = (error: K3RelayAccountScreenError) =>
    k3relayAccountScreenErrorText(error, resolve);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
        <ShieldCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          <p>
            <T>
              An account only lets this device into the relay and lists your hosts. To use a host,
              you still approve this device on that host.
            </T>
          </p>
          <p>
            <T>The relay does not store your email address or name.</T>
          </p>
          <p>
            <T>Turn on two-step verification with your sign-in provider to protect the account.</T>
          </p>
        </div>
      </div>

      {state.kind === "signed-out" ? (
        <>
          {relayDraft === null ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
              <RadioTowerIcon aria-hidden className="size-3 shrink-0" />
              <span>
                <T>
                  Relay:{" "}
                  <span className="font-mono break-all text-foreground">
                    <Var>{state.relayUrl}</Var>
                  </span>
                </T>
              </span>
              <Button
                size="micro"
                variant="ghost"
                disabled={state.signIn !== null}
                onClick={() => setRelayDraft(state.relayUrl)}
              >
                <T>Change</T>
              </Button>
            </p>
          ) : (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const next = relayDraft.trim();
                setRelayDraft(null);
                if (next !== "" && next !== state.relayUrl) actions.changeRelayUrl(next);
              }}
            >
              <Input
                value={relayDraft}
                onChange={(event) => setRelayDraft(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                aria-label={gt("Relay server address")}
              />
              <Button type="submit" size="xs" variant="outline">
                <T>Save</T>
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => setRelayDraft(null)}>
                <T>Cancel</T>
              </Button>
            </form>
          )}

          {!canReturn ? (
            <Alert variant="warning">
              <AlertDescription>
                <T>
                  Signing in from this address is not possible: the relay only returns to HTTPS
                  pages and to this computer. Open K3 Code over HTTPS or on localhost, or pair with
                  a link or QR code instead.
                </T>
              </AlertDescription>
            </Alert>
          ) : state.signIn?.step === "waiting" ? (
            <div className="space-y-3 rounded-lg border border-border/60 px-4 py-4" role="status">
              <p className="flex items-center gap-2 text-sm text-foreground">
                <Spinner className="size-3" />
                {gt("Finish signing in with {provider} in your browser.", {
                  provider: PROVIDER_NAMES[state.signIn.provider],
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  render={
                    <a href={state.signIn.pending.authorizeUrl} target="_blank" rel="noreferrer" />
                  }
                >
                  <T>Open the sign-in page again</T>
                </Button>
                <Button size="xs" variant="ghost" onClick={actions.cancelSignIn}>
                  <T>Cancel</T>
                </Button>
              </div>
            </div>
          ) : state.offer.status === "loading" || state.offer.status === "idle" ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Spinner className="size-3" />
              <T>Checking which sign-ins the relay offers…</T>
            </p>
          ) : state.offer.status === "failed" ? (
            <div className="space-y-2">
              <p className="text-xs text-destructive">{errorText(state.offer.error)}</p>
              <Button size="xs" variant="outline" onClick={actions.retryOffer}>
                <T>Try again</T>
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {k3relayAccountSignInChoices(state.offer.providers, "web").providers.map(
                (provider) => (
                  <Button
                    key={provider}
                    variant="outline"
                    className="w-full"
                    disabled={state.signIn !== null}
                    onClick={() => actions.signIn(provider)}
                  >
                    {state.signIn?.provider === provider
                      ? gt("Opening {provider}…", { provider: PROVIDER_NAMES[provider] })
                      : gt("Sign in with {provider}", { provider: PROVIDER_NAMES[provider] })}
                  </Button>
                ),
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {gt("Signed in with {provider}", { provider: PROVIDER_NAMES[state.provider] })}
              </p>
              <p className="truncate font-mono text-2xs text-muted-foreground">{state.relayUrl}</p>
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={state.connecting !== null}
              onClick={actions.signOut}
            >
              <T>Sign out</T>
            </Button>
          </div>

          {state.connecting?.step === "awaiting-approval" ? (
            <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-4 text-center">
              <p className="text-xs font-medium text-muted-foreground">
                <T>Confirmation code</T>
              </p>
              <p
                className="font-mono text-3xl font-semibold tracking-widest text-foreground tabular-nums"
                data-testid="k3relay-account-confirmation-code"
              >
                {state.connecting.confirmationCode}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                <T>
                  Check that the host shows exactly this code, then approve there. If the codes
                  differ, reject on the host: someone else may be pairing.
                </T>
              </p>
              <p
                className="flex items-center justify-center gap-2 text-xs text-muted-foreground"
                role="status"
              >
                <Spinner className="size-3" />
                <T>Waiting for the host to approve…</T>
              </p>
            </div>
          ) : (
            <>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  <T>Name for this device</T>
                </span>
                <Input
                  value={deviceName}
                  onChange={(event) => onDeviceNameChange(event.target.value)}
                  maxLength={64}
                  disabled={state.connecting !== null}
                />
                <span className="mt-1 block text-2xs text-muted-foreground">
                  <T>Shown on the host's approval screen. The relay never sees it.</T>
                </span>
              </label>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-foreground">
                    <T>Hosts on this account</T>
                  </p>
                  <Button
                    size="micro"
                    variant="ghost"
                    disabled={state.hosts.status === "loading" || state.connecting !== null}
                    onClick={actions.refreshHosts}
                  >
                    <T>Refresh</T>
                  </Button>
                </div>
                {state.hosts.status === "loading" ? (
                  <p
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                    role="status"
                  >
                    <Spinner className="size-3" />
                    <T>Loading your hosts…</T>
                  </p>
                ) : state.hosts.status === "failed" ? (
                  <p className="text-xs text-destructive">{errorText(state.hosts.error)}</p>
                ) : state.hosts.hosts.length === 0 ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    <T>
                      No hosts on this account yet. On the host, open Settings › Relay and sign in
                      with the same account.
                    </T>
                  </p>
                ) : (
                  <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                    {state.hosts.hosts.map((host) => {
                      const saved = savedHostIds.has(host.hostId);
                      const connecting = state.connecting?.hostId === host.hostId;
                      return (
                        <li
                          key={host.hostId}
                          className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                          <span className="min-w-0 truncate text-sm text-foreground">
                            <T>
                              Host{" "}
                              <span className="font-mono">
                                <Var>{shortHostId(host.hostId)}</Var>
                              </span>
                            </T>
                          </span>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={
                              saved || state.connecting !== null || deviceName.trim() === ""
                            }
                            onClick={() => actions.connect(host)}
                          >
                            {saved
                              ? gt("Added", { $context: "an environment already on this device" })
                              : connecting
                                ? state.connecting?.step === "redeeming"
                                  ? gt("Signing in…")
                                  : gt("Connecting…")
                                : gt("Connect", { $context: "verb, connects to a host" })}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="text-2xs text-muted-foreground">
                  <T>The host shows its name once you connect. The relay does not know it.</T>
                </p>
              </div>
            </>
          )}
        </>
      )}

      {state.error !== null ? (
        <Alert variant="error">
          <AlertDescription>{errorText(state.error)}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

const screenError = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): K3RelayAccountScreenError => {
  const error = squashAtomCommandFailure(result);
  return (
    k3relayAccountScreenError(error) ??
    (error instanceof Error
      ? { kind: "message", message: thrownErrorMessage(error, m) ?? error.message }
      : { kind: "account", reason: "sign-in-failed" })
  );
};

const isSessionExpired = (error: K3RelayAccountScreenError) =>
  error.kind === "account" && error.reason === "session-expired";

/**
 * Signs this device in to a relay account (spec §20), lists the account's hosts and connects to
 * one through its approval. In a browser tab the provider returns to this origin's callback page,
 * which hands the result back here; the desktop app gets `k3relay://account/callback` from the OS.
 */
export function K3RelayAccountPanel({
  defaultDeviceName,
  savedHostIds,
  onConnected,
}: {
  readonly defaultDeviceName: string;
  readonly savedHostIds: ReadonlySet<string>;
  readonly onConnected: (environmentId: EnvironmentId) => void;
}) {
  const registry = useContext(RegistryContext);
  const state = useAtomValue(k3relayAccountScreenAtom);
  const [desktopCallback, setDesktopCallback] = useAtom(pendingK3RelayAccountCallbackAtom);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const redeemingRef = useRef(false);
  const offer = useAtomCommand(k3relayAccount.offer, { reportFailure: false });
  const startSignIn = useAtomCommand(k3relayAccount.startSignIn, { reportFailure: false });
  const completeSignIn = useAtomCommand(k3relayAccount.completeSignIn, { reportFailure: false });
  const forget = useAtomCommand(k3relayAccount.forget, { reportFailure: false });
  const listHosts = useAtomCommand(k3relayAccount.listHosts, { reportFailure: false });
  const connectHost = useAtomCommand(k3relayAccount.connectHost, { reportFailure: false });
  const desktop = window.desktopBridge;
  // Desktop opens the system browser, which returns through the app's own scheme.
  const redirect =
    desktop === undefined
      ? k3relayAccountWebRedirect(window.location.origin)
      : ACCOUNT_APP_REDIRECT;
  const loadOfferIfUnasked = () => {
    // Read from the registry, not this render: a load started a moment ago already moved it on.
    const current = registry.get(k3relayAccountScreenAtom);
    if (current.kind === "signed-out" && current.offer.status === "idle") {
      void loadOffer(current.relayUrl);
    }
  };
  // Signing out, an expired session and a new relay all leave the offer unasked.
  const dispatch = (event: WebK3RelayAccountEvent) => {
    dispatchK3RelayAccount(registry, event);
    loadOfferIfUnasked();
  };

  const loadOffer = async (relayUrl: string) => {
    dispatch({ type: "offer-loading" });
    const result = await offer({ relayUrl });
    const current = registry.get(k3relayAccountScreenAtom);
    // The user moved to another relay meanwhile.
    if (current.kind !== "signed-out" || current.relayUrl !== relayUrl) return;
    dispatch(
      result._tag === "Success"
        ? { type: "offer-loaded", providers: result.value.providers }
        : { type: "offer-failed", error: screenError(result) },
    );
  };

  const loadHosts = async () => {
    const current = registry.get(k3relayAccountScreenAtom);
    if (current.kind !== "signed-in") return;
    const session = current.session;
    dispatch({ type: "hosts-requested" });
    const result = await listHosts({ session });
    if (result._tag === "Success") {
      dispatch({ type: "hosts-loaded", hosts: result.value });
      return;
    }
    const error = screenError(result);
    if (isSessionExpired(error)) void forget({ keyId: session.keyId });
    dispatch({ type: "hosts-failed", error });
  };

  const receiveCallback = async (url: string) => {
    const current = registry.get(k3relayAccountScreenAtom);
    if (current.kind !== "signed-out" || current.signIn?.step !== "waiting") return;
    const { pending } = current.signIn.pending;
    // Another sign-in's callback (an old tab, a second click) is not ours to redeem.
    if (!k3relayAccountCallbackMatches(pending, url)) return;
    redeemingRef.current = true;
    const result = await completeSignIn({ pending, callbackUrl: url }).finally(() => {
      redeemingRef.current = false;
    });
    if (result._tag === "Success") {
      dispatch({ type: "signed-in", session: result.value });
      await loadHosts();
      return;
    }
    dispatch(
      isAtomCommandInterrupted(result)
        ? { type: "sign-in-cancelled" }
        : { type: "sign-in-failed", error: screenError(result) },
    );
  };

  const signIn = async (provider: AccountProvider) => {
    if (state.kind !== "signed-out" || redirect === null) return;
    // Opened now, inside the click, so the browser does not block it; it navigates once ready.
    const popup = desktop === undefined ? window.open("", "_blank") : null;
    if (popup !== null) popup.opener = null;
    dispatch({ type: "sign-in-requested", provider });
    const result = await startSignIn({ relayUrl: state.relayUrl, provider, redirect });
    if (result._tag === "Failure") {
      popup?.close();
      dispatch(
        isAtomCommandInterrupted(result)
          ? { type: "sign-in-cancelled" }
          : { type: "sign-in-failed", error: screenError(result) },
      );
      return;
    }
    const { authorizeUrl, pending } = result.value;
    dispatch({ type: "sign-in-opened", pending: { pending, authorizeUrl } });
    if (desktop !== undefined) {
      void desktop.openExternal(authorizeUrl);
    } else if (popup !== null) {
      popup.location.href = authorizeUrl;
    } else {
      window.open(authorizeUrl, "_blank", "noopener");
    }
  };

  const cancelSignIn = () => {
    if (state.kind !== "signed-out" || state.signIn?.step !== "waiting") return;
    // The callback already arrived and is being redeemed; let it finish.
    if (redeemingRef.current) return;
    void forget({ keyId: state.signIn.pending.pending.keyId });
    dispatch({ type: "sign-in-cancelled" });
  };

  const signOut = () => {
    if (state.kind !== "signed-in") return;
    void forget({ keyId: state.session.keyId });
    dispatch({ type: "signed-out" });
  };

  const connect = async (host: K3RelayAccountHost) => {
    if (state.kind !== "signed-in") return;
    const session = state.session;
    dispatch({ type: "connect-requested", hostId: host.hostId });
    const result = await connectHost({
      session,
      host,
      deviceName: deviceName.trim(),
      onProgress: (progress) => dispatch({ type: "connect-progress", progress }),
    });
    if (result._tag === "Success") {
      dispatch({ type: "connect-ended", error: null });
      onConnected(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      dispatch({ type: "connect-ended", error: null });
      return;
    }
    const error = screenError(result);
    if (isSessionExpired(error)) void forget({ keyId: session.keyId });
    dispatch({ type: "connect-ended", error });
  };

  const onCallback = useEffectEvent((url: string) => void receiveCallback(url));
  const loadOfferOnOpen = useEffectEvent(loadOfferIfUnasked);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the relay which sign-ins it offers when the screen opens
  useEffect(() => {
    loadOfferOnOpen();
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the callback pages of this origin's other tabs, where a browser sign-in returns
  useEffect(() => {
    if (desktop !== undefined) return;
    return listenForK3RelayAccountCallbacks(onCallback);
  }, [desktop]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- takes the callback the desktop shell received from the OS
  useEffect(() => {
    if (desktopCallback === null) return;
    setDesktopCallback(null);
    onCallback(desktopCallback);
  }, [desktopCallback, setDesktopCallback]);

  return (
    <K3RelayAccountView
      state={state}
      canReturn={redirect !== null}
      deviceName={deviceName}
      savedHostIds={savedHostIds}
      onDeviceNameChange={setDeviceName}
      actions={{
        changeRelayUrl: (relayUrl) => dispatch({ type: "relay-url-changed", relayUrl }),
        retryOffer: () => {
          if (state.kind === "signed-out") void loadOffer(state.relayUrl);
        },
        signIn: (provider) => void signIn(provider),
        cancelSignIn,
        signOut,
        refreshHosts: () => void loadHosts(),
        connect: (host) => void connect(host),
      }}
    />
  );
}
