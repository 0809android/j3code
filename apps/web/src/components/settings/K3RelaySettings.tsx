import type {
  K3RelayHostApi,
  K3RelayHostDevice,
  K3RelayHostState,
  K3RelayHostStatus,
} from "@t3tools/client-runtime/k3relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AlertTriangleIcon, RadioTowerIcon } from "lucide-react";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { useK3RelayHostApi, useK3RelayHostState } from "~/k3relay/hostApi";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type GT = ReturnType<typeof useGT>;

function statusLabel(status: K3RelayHostStatus, gt: GT): string {
  switch (status) {
    case "online":
      return gt("Online", { $context: "relay connection status" });
    case "offline":
      return gt("Offline", { $context: "relay connection status" });
    case "connecting":
      return gt("Connecting", { $context: "relay connection status" });
    case "error":
      return gt("Error", { $context: "relay connection status" });
    case "disabled":
      return gt("Off", { $context: "relay connection status" });
  }
}

const statusVariant = (status: K3RelayHostStatus) =>
  status === "online"
    ? "success"
    : status === "error"
      ? "error"
      : status === "offline"
        ? "warning"
        : "outline";

const formatTime = (epochMs: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(epochMs);

export interface K3RelaySettingsActions {
  readonly setEnabled: (enabled: boolean) => void;
  readonly setRelayUrl: (relayUrl: string) => void;
  readonly createOffer: () => void;
  readonly cancelOffer: () => void;
  readonly approve: (deviceId: string) => void;
  readonly reject: (deviceId: string) => void;
  readonly revoke: (deviceId: string) => void;
  readonly rename: (deviceId: string, name: string) => void;
}

/** Stateless, so each state (pending approval, revoked, off) renders directly in tests. */
export function K3RelaySettingsView({
  state,
  canWrite,
  busy,
  actions,
}: {
  readonly state: K3RelayHostState;
  readonly canWrite: boolean;
  readonly busy: boolean;
  readonly actions: K3RelaySettingsActions;
}) {
  const gt = useGT();
  const [relayUrlDraft, setRelayUrlDraft] = useState(state.relayUrl);
  const [showLink, setShowLink] = useState(false);
  const [renaming, setRenaming] = useState<{ deviceId: string; name: string } | null>(null);
  const disabled = !canWrite || busy;
  const activeDevices = state.devices.filter((device) => device.revokedAt === null);
  const revokedDevices = state.devices.filter((device) => device.revokedAt !== null);

  const renderDevice = (device: K3RelayHostDevice) => (
    <div key={device.deviceId} className={ITEM_ROW_CLASSNAME} data-testid="k3relay-device">
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-0.5">
          {renaming?.deviceId === device.deviceId ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                actions.rename(device.deviceId, renaming.name);
                setRenaming(null);
              }}
            >
              <Input
                value={renaming.name}
                onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
                maxLength={64}
                aria-label={gt("Device name")}
                autoFocus
              />
              <Button type="submit" size="xs" disabled={renaming.name.trim() === ""}>
                <T>Save</T>
              </Button>
            </form>
          ) : (
            <p className="truncate text-sm font-medium text-foreground">{device.name}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {device.revokedAt !== null ? (
              <T>
                Revoked <Var>{formatTime(device.revokedAt)}</Var>
              </T>
            ) : device.lastSeenAt !== null ? (
              <T>
                Approved <Var>{formatTime(device.approvedAt)}</Var> · last seen{" "}
                <Var>{formatTime(device.lastSeenAt)}</Var>
              </T>
            ) : (
              <T>
                Approved <Var>{formatTime(device.approvedAt)}</Var>
              </T>
            )}
          </p>
        </div>
        {device.revokedAt === null && renaming?.deviceId !== device.deviceId ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              onClick={() => setRenaming({ deviceId: device.deviceId, name: device.name })}
            >
              <T>Rename</T>
            </Button>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={disabled}
              onClick={() => actions.revoke(device.deviceId)}
            >
              <T>Revoke</T>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <SettingsSection
      id="k3-relay"
      // oxlint-disable-next-line t3code/no-untranslated-copy -- product name
      title="K3 Relay"
      icon={<RadioTowerIcon aria-hidden className="size-4" />}
    >
      <SettingsRow
        title={gt("Reach this machine through the relay")}
        description={gt(
          "Devices you pair connect from any network, end-to-end encrypted. The relay only passes along ciphertext it cannot read.",
        )}
        status={
          <Badge variant={statusVariant(state.status)} data-testid="k3relay-status">
            {statusLabel(state.status, gt)}
          </Badge>
        }
        control={
          <Switch
            checked={state.enabled}
            disabled={disabled || !state.allowedByPolicy}
            onCheckedChange={(checked) => actions.setEnabled(checked)}
            aria-label={gt("Turn the relay on or off")}
          />
        }
      />
      {!state.allowedByPolicy ? (
        <SettingsRow
          title={gt("Turned off by your organization")}
          description={gt("A managed policy does not allow relay connections on this machine.")}
        />
      ) : null}
      {state.enabled && !state.networkAccessEnabled ? (
        <SettingsRow
          title={gt("Network access is off")}
          description={gt(
            "Devices paired through the relay can still reach this machine. Revoke them below to stop that.",
          )}
        />
      ) : null}
      {state.status === "error" && state.statusDetail !== null ? (
        <SettingsRow title={gt("The relay reported a problem")} description={state.statusDetail} />
      ) : null}
      <SettingsRow
        title={gt("Relay server")}
        description={gt(
          "Use your own relay by entering its address. Devices paired before keep using the relay they were paired with.",
        )}
        control={
          <form
            className="flex w-full items-center gap-2 sm:w-80"
            onSubmit={(event) => {
              event.preventDefault();
              actions.setRelayUrl(relayUrlDraft.trim());
            }}
          >
            <Input
              value={relayUrlDraft}
              onChange={(event) => setRelayUrlDraft(event.target.value)}
              disabled={disabled}
              spellCheck={false}
              aria-label={gt("Relay server address")}
            />
            <Button
              type="submit"
              size="xs"
              variant="outline"
              disabled={disabled || relayUrlDraft.trim() === state.relayUrl}
            >
              <T>Save</T>
            </Button>
          </form>
        }
      />

      {state.enabled ? (
        <div className={ITEM_ROW_CLASSNAME}>
          {state.pending !== null ? (
            <div className="space-y-3" data-testid="k3relay-pending">
              <p className="text-sm font-medium text-foreground">
                <T>
                  <Var>{state.pending.name}</Var> wants to connect
                </T>
              </p>
              <p className="font-mono text-2xl font-semibold tracking-widest text-foreground tabular-nums">
                {state.pending.confirmationCode}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                <T>
                  Approve only if the new device is in your hands and shows this exact code. A
                  different code means someone else is pairing: reject it.
                </T>
              </p>
              <div className="flex gap-2">
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={disabled}
                  onClick={() => actions.reject(state.pending!.deviceId)}
                >
                  <T>Reject</T>
                </Button>
                <Button
                  size="xs"
                  disabled={disabled}
                  onClick={() => actions.approve(state.pending!.deviceId)}
                >
                  <T>Approve</T>
                </Button>
              </div>
            </div>
          ) : state.offer !== null ? (
            <div className="space-y-3" data-testid="k3relay-offer">
              <p className="text-sm font-medium text-foreground">
                <T>Scan with the new device</T>
              </p>
              <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
                <QRCodeSvg
                  value={state.offer.link}
                  size={148}
                  level="M"
                  marginSize={2}
                  title={gt("Relay pairing code. Scan it with the new device")}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                <T>
                  Valid until <Var>{formatTime(state.offer.expiresAt)}</Var>. Scanning in person is
                  safest.
                </T>
              </p>
              {showLink ? (
                <div className="space-y-2">
                  <Alert variant="warning">
                    <AlertTriangleIcon aria-hidden />
                    <AlertDescription>
                      <T>
                        Anyone who gets this link before the new device uses it can try to pair in
                        its place. Send it only over a channel you trust, and still compare the
                        codes before approving.
                      </T>
                    </AlertDescription>
                  </Alert>
                  <Input
                    readOnly
                    value={state.offer.link}
                    onFocus={(event) => event.target.select()}
                    aria-label={gt("Relay pairing link")}
                    spellCheck={false}
                  />
                </div>
              ) : (
                <Button size="xs" variant="ghost-muted" onClick={() => setShowLink(true)}>
                  <T>Show as a link instead</T>
                </Button>
              )}
              <Button size="xs" variant="outline" disabled={disabled} onClick={actions.cancelOffer}>
                <T>Cancel</T>
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                <T>Pair a phone or another computer. You will compare a code on both screens.</T>
              </p>
              <Button
                size="xs"
                disabled={disabled}
                onClick={() => {
                  setShowLink(false);
                  actions.createOffer();
                }}
              >
                <T>Add device</T>
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {activeDevices.map(renderDevice)}
      {revokedDevices.map(renderDevice)}
    </SettingsSection>
  );
}

/** The host's relay settings, shown only where the host offers the relay (see `hostApi`). */
export function K3RelaySettings({
  environmentId,
  canWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  const api = useK3RelayHostApi(environmentId);
  const { state, error } = useK3RelayHostState(api);
  const [busy, setBusy] = useState(false);
  if (api === null) return null;
  if (state === null) {
    return error === null ? null : (
      <SettingsSection id="k3-relay" title={gt("Relay")}>
        <SettingsRow title={gt("Could not load the relay settings")} description={error} />
      </SettingsSection>
    );
  }
  const run =
    <A extends ReadonlyArray<unknown>>(
      title: string,
      action: (...args: A) => ReturnType<K3RelayHostApi["approve"]>,
    ) =>
    (...args: A) => {
      setBusy(true);
      void Effect.runPromise(
        action(...args).pipe(
          Effect.catch((failure) =>
            Effect.sync(() =>
              toastManager.add(
                stackedThreadToast({ type: "error", title, description: failure.detail }),
              ),
            ),
          ),
          Effect.ensuring(Effect.sync(() => setBusy(false))),
        ),
      );
    };
  const actions = {
    setEnabled: run(gt("Could not change the relay"), (enabled: boolean) =>
      api.setEnabled(enabled),
    ),
    setRelayUrl: run(gt("Could not save the relay address"), (url: string) => api.setRelayUrl(url)),
    createOffer: run(gt("Could not create a pairing code"), () => Effect.asVoid(api.createOffer)),
    cancelOffer: run(gt("Could not cancel pairing"), () => api.cancelOffer),
    approve: run(gt("Could not approve the device"), (id: string) => api.approve(id)),
    reject: run(gt("Could not reject the device"), (id: string) => api.reject(id)),
    revoke: run(gt("Could not revoke the device"), (id: string) => api.revokeDevice(id)),
    rename: run(gt("Could not rename the device"), (id: string, name: string) =>
      api.renameDevice(id, name),
    ),
  } satisfies K3RelaySettingsActions;
  return <K3RelaySettingsView state={state} canWrite={canWrite} busy={busy} actions={actions} />;
}
