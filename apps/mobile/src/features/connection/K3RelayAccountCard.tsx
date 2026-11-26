import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  type K3RelayAccountHost,
  type K3RelayAccountScreenError,
  k3relayAccountCallbackMatches,
  k3relayAccountScreenError,
  k3relayAccountScreenErrorText,
  k3relayAccountSignInChoices,
} from "@t3tools/client-runtime/k3relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { ACCOUNT_APP_REDIRECT, type AccountProvider } from "@t3tools/shared/relay";
import * as Option from "effect/Option";
import * as WebBrowser from "expo-web-browser";
import { T, useGT, useMessages } from "gt-react-native";
import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { k3relayAccount } from "../../connection/onboarding";
import { m } from "../../i18n/messages";
import { cn } from "../../lib/cn";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type MobileK3RelayAccountEvent,
  authSessionCallback,
  dispatchK3RelayAccount,
  k3relayAccountScreenAtom,
  pendingK3RelayAccountCallbackAtom,
} from "./k3relayAccount";

const PROVIDER_NAMES: Record<AccountProvider, string> = {
  github: "GitHub",
  google: "Google",
  apple: "Apple",
};

/** Host ids are long; the start tells a few machines apart until the host names itself. */
const shortHostId = (hostId: string) => hostId.slice(0, 10);

const screenError = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): K3RelayAccountScreenError => {
  const error = squashAtomCommandFailure(result);
  return (
    k3relayAccountScreenError(error) ??
    (error instanceof Error
      ? { kind: "message", message: errorDisplayMessage(error, m) ?? error.message }
      : { kind: "account", reason: "sign-in-failed" })
  );
};

const isSessionExpired = (error: K3RelayAccountScreenError) =>
  error.kind === "account" && error.reason === "session-expired";

/**
 * Signs this device in to a K3 Relay account (spec §20), lists the account's hosts and connects
 * to one through its approval. The provider page opens in an auth session (Safari on iOS, Custom
 * Tabs on Android) that returns through `k3relay://account/callback`. On iOS Sign in with Apple
 * sits beside the other sign-ins, and without it the relay's other sign-ins are not offered.
 */
export function K3RelayAccountCard({
  defaultDeviceName,
  onConnected,
}: {
  readonly defaultDeviceName: string;
  readonly onConnected: (environmentId: EnvironmentId) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const registry = useContext(RegistryContext);
  const state = useAtomValue(k3relayAccountScreenAtom);
  // Hosts this device already reaches through a relay are marked added.
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const savedHostIds = new Set<string>();
  for (const entry of catalog.entries.values()) {
    if (Option.isSome(entry.profile) && entry.profile.value._tag === "K3RelayConnectionProfile") {
      savedHostIds.add(entry.profile.value.hostId);
    }
  }
  const [linkedCallback, setLinkedCallback] = useAtom(pendingK3RelayAccountCallbackAtom);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [relayDraft, setRelayDraft] = useState<string | null>(null);
  const redeemingRef = useRef(false);
  const offer = useAtomCommand(k3relayAccount.offer, { reportFailure: false });
  const startSignIn = useAtomCommand(k3relayAccount.startSignIn, { reportFailure: false });
  const completeSignIn = useAtomCommand(k3relayAccount.completeSignIn, { reportFailure: false });
  const forget = useAtomCommand(k3relayAccount.forget, { reportFailure: false });
  const listHosts = useAtomCommand(k3relayAccount.listHosts, { reportFailure: false });
  const connectHost = useAtomCommand(k3relayAccount.connectHost, { reportFailure: false });
  const errorText = (error: K3RelayAccountScreenError) =>
    k3relayAccountScreenErrorText(error, resolve);

  const loadOffer = async (relayUrl: string) => {
    dispatch({ type: "offer-loading" });
    const result = await offer({ relayUrl });
    const current = registry.get(k3relayAccountScreenAtom);
    if (current.kind !== "signed-out" || current.relayUrl !== relayUrl) return;
    dispatch(
      result._tag === "Success"
        ? { type: "offer-loaded", providers: result.value.providers }
        : { type: "offer-failed", error: screenError(result) },
    );
  };
  const loadOfferIfUnasked = () => {
    const current = registry.get(k3relayAccountScreenAtom);
    if (current.kind === "signed-out" && current.offer.status === "idle") {
      void loadOffer(current.relayUrl);
    }
  };
  // Signing out, an expired session and a new relay all leave the offer unasked.
  const dispatch = (event: MobileK3RelayAccountEvent) => {
    dispatchK3RelayAccount(registry, event);
    loadOfferIfUnasked();
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
    const pending = current.signIn.pending;
    // Another sign-in's callback is not ours to redeem.
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

  const cancelWaitingSignIn = () => {
    const current = registry.get(k3relayAccountScreenAtom);
    if (current.kind !== "signed-out" || current.signIn?.step !== "waiting") return;
    // The callback already arrived (as a link) and is being redeemed; let it finish.
    if (redeemingRef.current) return;
    void forget({ keyId: current.signIn.pending.keyId });
    dispatch({ type: "sign-in-cancelled" });
  };

  const signIn = async (provider: AccountProvider) => {
    if (state.kind !== "signed-out") return;
    dispatch({ type: "sign-in-requested", provider });
    const started = await startSignIn({
      relayUrl: state.relayUrl,
      provider,
      redirect: ACCOUNT_APP_REDIRECT,
    });
    if (started._tag === "Failure") {
      dispatch(
        isAtomCommandInterrupted(started)
          ? { type: "sign-in-cancelled" }
          : { type: "sign-in-failed", error: screenError(started) },
      );
      return;
    }
    dispatch({ type: "sign-in-opened", pending: started.value.pending });
    let callback: string | null = null;
    try {
      callback = authSessionCallback(
        await WebBrowser.openAuthSessionAsync(started.value.authorizeUrl, ACCOUNT_APP_REDIRECT),
      );
    } catch {
      callback = null;
    }
    // Android can hand the callback to the app as a link instead; the link handler keeps it.
    const linked = registry.get(pendingK3RelayAccountCallbackAtom);
    if (callback === null && linked !== null) {
      registry.set(pendingK3RelayAccountCallbackAtom, null);
      callback = linked;
    }
    if (callback === null) {
      cancelWaitingSignIn();
      return;
    }
    await receiveCallback(callback);
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

  const loadOfferOnOpen = useEffectEvent(loadOfferIfUnasked);
  const onLinkedCallback = useEffectEvent((url: string) => void receiveCallback(url));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the relay which sign-ins it offers when the screen opens
  useEffect(() => {
    loadOfferOnOpen();
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- takes a callback that reached the app as a link; one with no sign-in waiting is dropped
  useEffect(() => {
    if (linkedCallback === null) return;
    setLinkedCallback(null);
    onLinkedCallback(linkedCallback);
  }, [linkedCallback, setLinkedCallback]);

  const choices =
    state.kind === "signed-out" && state.offer.status === "ready"
      ? k3relayAccountSignInChoices(
          state.offer.providers,
          Platform.OS === "ios" ? "ios" : "android",
        )
      : null;
  return (
    <View collapsable={false} className="gap-2">
      <Text className="px-4 text-sm font-t3-medium text-foreground-muted">
        <T>Or sign in with an account</T>
      </Text>
      <View
        collapsable={false}
        className="gap-3 rounded-[26px] border-continuous bg-grouped-card p-4"
      >
        <Text className="text-sm leading-normal text-foreground-muted">
          <T>
            An account only lets this device into the relay and lists your hosts. To use a host, you
            still approve this device on that host. The relay does not store your email address or
            name.
          </T>
        </Text>

        {state.kind === "signed-out" ? (
          <>
            {relayDraft === null ? (
              <View collapsable={false} className="flex-row flex-wrap items-center gap-2">
                <Text className="flex-1 text-sm leading-normal text-foreground-muted">
                  {gt("Relay: {relayUrl}", { relayUrl: state.relayUrl })}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={state.signIn !== null}
                  onPress={() => setRelayDraft(state.relayUrl)}
                  className="min-h-[44px] justify-center px-2"
                >
                  <Text className="text-base text-primary-text">
                    <T>Change</T>
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View collapsable={false} className="gap-2">
                <AppTextInput
                  value={relayDraft}
                  onChangeText={setRelayDraft}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  accessibilityLabel={gt("Relay server address")}
                  className="min-h-[44px] text-base"
                />
                <View collapsable={false} className="flex-row justify-end gap-3">
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setRelayDraft(null)}
                    className="min-h-[44px] justify-center px-3"
                  >
                    <Text className="text-base text-foreground-muted">
                      <T>Cancel</T>
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      const next = relayDraft.trim();
                      setRelayDraft(null);
                      if (next !== "" && next !== state.relayUrl) {
                        dispatch({ type: "relay-url-changed", relayUrl: next });
                      }
                    }}
                    className="min-h-[44px] justify-center rounded-full bg-primary px-4"
                  >
                    <Text className="text-base font-t3-medium text-primary-foreground">
                      <T>Save</T>
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}

            {state.signIn !== null ? (
              <View collapsable={false} className="flex-row items-center gap-2 py-1">
                <ActivityIndicator size="small" />
                <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
                  {gt("Finish signing in with {provider} in your browser.", {
                    provider: PROVIDER_NAMES[state.signIn.provider],
                  })}
                </Text>
              </View>
            ) : state.offer.status === "loading" || state.offer.status === "idle" ? (
              <View collapsable={false} className="flex-row items-center gap-2 py-1">
                <ActivityIndicator size="small" />
                <Text className="text-sm text-foreground-muted">
                  <T>Checking which sign-ins the relay offers…</T>
                </Text>
              </View>
            ) : state.offer.status === "failed" ? (
              <View collapsable={false} className="gap-2">
                <Text className="text-sm text-danger-foreground">
                  {errorText(state.offer.error)}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void loadOffer(state.relayUrl)}
                  className="min-h-[44px] justify-center self-start px-1"
                >
                  <Text className="text-base text-primary-text">
                    <T>Try again</T>
                  </Text>
                </Pressable>
              </View>
            ) : choices?.appleRequired ? (
              <Text className="text-sm leading-normal text-foreground-muted">
                <T>
                  This relay does not offer Sign in with Apple, which account sign-in needs on
                  iPhone and iPad. Pair with a QR code instead.
                </T>
              </Text>
            ) : (
              <View collapsable={false} className="gap-2">
                {(choices?.providers ?? []).map((provider) => (
                  <Pressable
                    key={provider}
                    accessibilityRole="button"
                    onPress={() => void signIn(provider)}
                    className={cn(
                      "min-h-[48px] flex-row items-center justify-center gap-2 rounded-full px-4",
                      provider === "apple" ? "bg-black" : "border border-border bg-transparent",
                    )}
                  >
                    {provider === "apple" && Platform.OS === "ios" ? (
                      <SymbolView
                        name={{ ios: "apple.logo", android: "lock" }}
                        size={18}
                        tintColor="#ffffff"
                      />
                    ) : null}
                    <Text
                      className={cn(
                        "text-base font-t3-medium",
                        provider === "apple" ? "text-white" : "text-foreground",
                      )}
                    >
                      {gt("Sign in with {provider}", { provider: PROVIDER_NAMES[provider] })}
                    </Text>
                  </Pressable>
                ))}
                <Text className="text-xs leading-normal text-foreground-muted">
                  <T>
                    Turn on two-step verification with your sign-in provider to protect the account.
                  </T>
                </Text>
              </View>
            )}
          </>
        ) : (
          <>
            <View collapsable={false} className="flex-row items-center justify-between gap-3">
              <View collapsable={false} className="flex-1 gap-0.5">
                <Text className="text-base font-t3-medium text-foreground">
                  {gt("Signed in with {provider}", { provider: PROVIDER_NAMES[state.provider] })}
                </Text>
                <Text numberOfLines={1} className="text-xs text-foreground-muted">
                  {state.relayUrl}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={state.connecting !== null}
                onPress={signOut}
                className={cn(
                  "min-h-[44px] justify-center px-2",
                  state.connecting !== null && "opacity-50",
                )}
              >
                <Text className="text-base text-primary-text">
                  <T>Sign out</T>
                </Text>
              </Pressable>
            </View>

            {state.connecting?.step === "awaiting-approval" ? (
              <View collapsable={false} className="items-center gap-2 py-2">
                <Text className="text-sm text-foreground-muted">
                  <T>Confirmation code</T>
                </Text>
                <Text
                  selectable
                  accessibilityLabel={gt("Confirmation code {code}", {
                    code: state.connecting.confirmationCode,
                  })}
                  className="font-mono text-3xl font-t3-semibold tracking-widest text-foreground"
                >
                  {state.connecting.confirmationCode}
                </Text>
                <Text className="text-center text-sm leading-normal text-foreground-muted">
                  <T>
                    Check that the host shows exactly this code, then approve there. If the codes
                    differ, reject on the host: someone else may be pairing.
                  </T>
                </Text>
                <View collapsable={false} className="flex-row items-center gap-2">
                  <ActivityIndicator size="small" />
                  <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
                    <T>Waiting for the host to approve…</T>
                  </Text>
                </View>
              </View>
            ) : (
              <>
                <View collapsable={false} className="gap-1">
                  <Text className="text-sm text-foreground-muted">
                    <T>Name for this device</T>
                  </Text>
                  <AppTextInput
                    value={deviceName}
                    onChangeText={setDeviceName}
                    maxLength={64}
                    editable={state.connecting === null}
                    accessibilityLabel={gt("Name for this device")}
                    className="min-h-[44px] text-base"
                  />
                  <Text className="text-xs text-foreground-muted">
                    <T>Shown on the host's approval screen. The relay never sees it.</T>
                  </Text>
                </View>

                <View collapsable={false} className="gap-1">
                  <View collapsable={false} className="flex-row items-center justify-between">
                    <Text className="text-sm font-t3-medium text-foreground">
                      <T>Hosts on this account</T>
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      disabled={state.hosts.status === "loading" || state.connecting !== null}
                      onPress={() => void loadHosts()}
                      className="min-h-[44px] justify-center px-2"
                    >
                      <Text className="text-base text-primary-text">
                        <T>Refresh</T>
                      </Text>
                    </Pressable>
                  </View>
                  {state.hosts.status === "loading" ? (
                    <View collapsable={false} className="flex-row items-center gap-2 py-1">
                      <ActivityIndicator size="small" />
                      <Text className="text-sm text-foreground-muted">
                        <T>Loading your hosts…</T>
                      </Text>
                    </View>
                  ) : state.hosts.status === "failed" ? (
                    <Text className="text-sm text-danger-foreground">
                      {errorText(state.hosts.error)}
                    </Text>
                  ) : state.hosts.hosts.length === 0 ? (
                    <Text className="text-sm leading-normal text-foreground-muted">
                      <T>
                        No hosts on this account yet. On the host, open Settings › Relay and sign in
                        with the same account.
                      </T>
                    </Text>
                  ) : (
                    state.hosts.hosts.map((host) => {
                      const saved = savedHostIds.has(host.hostId);
                      const connecting = state.connecting?.hostId === host.hostId;
                      const disabled =
                        saved || state.connecting !== null || deviceName.trim() === "";
                      return (
                        <View
                          key={host.hostId}
                          collapsable={false}
                          className="min-h-[48px] flex-row items-center justify-between gap-3"
                        >
                          <Text className="flex-1 font-mono text-base text-foreground">
                            {gt("Host {hostId}", { hostId: shortHostId(host.hostId) })}
                          </Text>
                          <Pressable
                            accessibilityRole="button"
                            disabled={disabled}
                            onPress={() => void connect(host)}
                            className={cn(
                              "min-h-[44px] justify-center rounded-full bg-primary px-4",
                              disabled && "opacity-50",
                            )}
                          >
                            <Text className="text-base font-t3-medium text-primary-foreground">
                              {saved
                                ? gt("Added", {
                                    $context: "an environment already on this device",
                                  })
                                : connecting
                                  ? state.connecting?.step === "redeeming"
                                    ? gt("Signing in…")
                                    : gt("Connecting…")
                                  : gt("Connect", { $context: "verb, connects to a host" })}
                            </Text>
                          </Pressable>
                        </View>
                      );
                    })
                  )}
                  <Text className="text-xs leading-normal text-foreground-muted">
                    <T>The host shows its name once you connect. The relay does not know it.</T>
                  </Text>
                </View>
              </>
            )}
          </>
        )}

        {state.error !== null ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
            {errorText(state.error)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
