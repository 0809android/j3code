import type {
  EnvironmentId,
  K3RelayAccountFailure,
  K3RelayAccountProvider,
  K3RelayAccountState,
} from "@t3tools/contracts";
import { AlertTriangleIcon, UserRoundIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useState } from "react";

import {
  type K3RelayHostCall,
  useK3RelayAccountActions,
  useK3RelayAccountState,
} from "~/k3relay/hostApi";
import { readLocalApi } from "~/localApi";
import { Alert, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type GT = ReturnType<typeof useGT>;

const PROVIDER_NAMES: Record<K3RelayAccountProvider, string> = {
  github: "GitHub",
  google: "Google",
  apple: "Apple",
};

function failureText(failure: K3RelayAccountFailure, gt: GT): string {
  switch (failure) {
    case "policy-disallowed":
      return gt("A managed policy does not allow relay connections on this machine.");
    case "disabled":
      return gt("Turn on the relay before signing in.");
    case "not-registered":
      return gt("This machine is not registered with the relay yet. Wait until it is online.");
    case "provider-unavailable":
      return gt("The relay does not offer this sign-in.");
    case "relay-unreachable":
      return gt("This machine can't reach the relay.");
    case "sign-in-failed":
      return gt("Signing in did not finish. Try again.");
    case "sign-in-cancelled":
      return gt("Signing in was cancelled.");
    case "risk-not-acknowledged":
      return gt("Turning approval off needs the risk acknowledged.");
    case "internal":
      return gt("The relay could not complete the request.");
  }
}

export interface K3RelayAccountSettingsActions {
  readonly signIn: (provider: K3RelayAccountProvider) => void;
  readonly signOut: () => void;
  readonly setApproval: (requireApproval: boolean) => void;
}

/** Stateless, for tests: signed in or out, approval on or off, an account device waiting. */
export function K3RelayAccountSettingsView({
  state,
  canWrite,
  busy,
  actions,
}: {
  readonly state: K3RelayAccountState;
  readonly canWrite: boolean;
  readonly busy: boolean;
  readonly actions: K3RelayAccountSettingsActions;
}) {
  const gt = useGT();
  const [confirmingOptOut, setConfirmingOptOut] = useState(false);
  const disabled = !canWrite || busy;
  const offered = state.availableProviders;
  if (!state.signedIn && offered.length === 0) return null;

  return (
    <SettingsSection
      id="k3-relay-account"
      title={gt("Relay account")}
      icon={<UserRoundIcon aria-hidden className="size-4" />}
    >
      <SettingsRow
        title={
          state.signedIn && state.provider !== null
            ? gt("Signed in with {provider}", { provider: PROVIDER_NAMES[state.provider] })
            : gt("Find this machine by signing in")
        }
        description={gt(
          "Optional. Devices signed in to the same account see this machine and can ask to connect. They still need your approval. Pairing with a QR code works without an account.",
        )}
        control={
          state.signedIn ? (
            <Button size="xs" variant="outline" disabled={disabled} onClick={actions.signOut}>
              <T>Sign out</T>
            </Button>
          ) : (
            <div className="flex flex-wrap gap-2">
              {offered.map((provider) => (
                <Button
                  key={provider}
                  size="xs"
                  variant="outline"
                  disabled={disabled || state.signInPending}
                  onClick={() => actions.signIn(provider)}
                >
                  {gt("Sign in with {provider}", { provider: PROVIDER_NAMES[provider] })}
                </Button>
              ))}
            </div>
          )
        }
      />
      {state.signInPending ? (
        <SettingsRow
          title={gt("Finish signing in in your browser")}
          description={gt(
            "The browser comes back to this machine only, so sign in on the computer that runs K3 Code.",
          )}
        />
      ) : null}
      {state.lastError !== null ? (
        <SettingsRow title={gt("Sign-in problem")} description={failureText(state.lastError, gt)} />
      ) : null}
      {state.pendingDevice !== null ? (
        <div className={ITEM_ROW_CLASSNAME} data-testid="k3relay-account-pending">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {state.pendingDevice.oneTap ? (
              <T>
                The device waiting above came through your account, and you just added a device:
                approve it if it is the one in your hands.
              </T>
            ) : (
              <T>
                The device waiting above came through your account: this connection trusts the
                relay. Approve only if a new device is in your hands and shows the same code.
              </T>
            )}
          </p>
        </div>
      ) : null}
      <SettingsRow
        title={gt("Approve new devices")}
        description={
          state.requireApproval
            ? gt(
                "On. A device that signs in to your account waits until you compare codes and approve it here. Recommended.",
              )
            : gt(
                "Off. Any device signed in to your account connects without asking. If the relay or your account were taken over, someone could reach this machine.",
              )
        }
        control={
          <Switch
            checked={state.requireApproval}
            disabled={disabled}
            onCheckedChange={(checked) => {
              if (checked) actions.setApproval(true);
              else setConfirmingOptOut(true);
            }}
            aria-label={gt("Approve new devices")}
          />
        }
      />
      <AlertDialog open={confirmingOptOut} onOpenChange={setConfirmingOptOut}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Let account devices in without asking?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {gt(
                "With approval off, this machine trusts the relay to say which devices belong to your account. A compromised relay, a leaked relay key, a hijacked GitHub, Google or Apple account, or a provider's mistake would let someone run code on this machine. Keep approval on unless you accept that risk. Turn on two-factor sign-in at your provider either way.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Alert variant="warning">
            <AlertTriangleIcon aria-hidden />
            <AlertDescription>
              <T>Devices you paired with a QR code are not affected. They always compare codes.</T>
            </AlertDescription>
          </Alert>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Keep approval on</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingOptOut(false);
                actions.setApproval(false);
              }}
            >
              <T>I understand, turn it off</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

/** The host's account section; hidden on hosts and relays without accounts. */
export function K3RelayAccountSettings({
  environmentId,
  canWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  const { state } = useK3RelayAccountState(environmentId);
  const account = useK3RelayAccountActions(environmentId);
  const [busy, setBusy] = useState(false);
  if (state === null) return null;
  const run =
    <A extends ReadonlyArray<unknown>, B>(
      title: string,
      action: (...args: A) => K3RelayHostCall<B>,
      onSuccess?: (value: B) => void,
    ) =>
    (...args: A) => {
      setBusy(true);
      void action(...args)
        .then((result) => {
          if (result.ok) onSuccess?.(result.value);
          else if (result.error !== null) {
            toastManager.add(
              stackedThreadToast({ type: "error", title, description: result.error }),
            );
          }
        })
        .finally(() => setBusy(false));
    };
  const openInBrowser = ({ authorizeUrl }: { readonly authorizeUrl: string }) => {
    const api = readLocalApi();
    if (api) void api.shell.openExternal(authorizeUrl);
    else window.open(authorizeUrl, "_blank", "noopener,noreferrer");
  };
  return (
    <K3RelayAccountSettingsView
      state={state}
      canWrite={canWrite}
      busy={busy}
      actions={{
        signIn: run(gt("Could not start signing in"), account.signIn, openInBrowser),
        signOut: run(gt("Could not sign out"), account.signOut),
        setApproval: (requireApproval) =>
          run(gt("Could not change approval"), account.setApproval)(
            requireApproval,
            !requireApproval,
          ),
      }}
    />
  );
}
