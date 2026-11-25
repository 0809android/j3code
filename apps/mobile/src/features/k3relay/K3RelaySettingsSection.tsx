import type { K3RelayHostApiError } from "@t3tools/client-runtime/k3relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { useK3RelayHostApi, useK3RelayHostState } from "./hostApi";

/**
 * The host's K3 Relay settings from a phone (spec §18.2: an approved device can approve the
 * next one). Hidden until the host offers the relay; see `hostApi`.
 */
export function K3RelaySettingsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  const api = useK3RelayHostApi(props.environmentId);
  const { state, error } = useK3RelayHostState(api);
  const [busy, setBusy] = useState(false);
  if (api === null || state === null) {
    return error === null ? null : (
      <Text selectable className="px-2 text-sm text-danger-foreground">
        {error}
      </Text>
    );
  }
  const disabled = !props.canWrite || busy;
  const run = (title: string, action: Effect.Effect<unknown, K3RelayHostApiError>) => {
    setBusy(true);
    void Effect.runPromise(
      action.pipe(
        Effect.catch((failure) => Effect.sync(() => Dialog.alert(title, failure.detail))),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };
  const status =
    state.status === "online"
      ? gt("Online", { $context: "relay connection status" })
      : state.status === "offline"
        ? gt("Offline", { $context: "relay connection status" })
        : state.status === "connecting"
          ? gt("Connecting", { $context: "relay connection status" })
          : state.status === "error"
            ? gt("Error", { $context: "relay connection status" })
            : gt("Off", { $context: "relay connection status" });

  return (
    // oxlint-disable-next-line t3code/no-untranslated-copy -- product name
    <SettingsSection title="K3 Relay">
      <SettingsSwitchRow
        label={gt("Reach this machine through the relay")}
        subtitle={status}
        value={state.enabled}
        disabled={disabled || !state.allowedByPolicy}
        onValueChange={(enabled) => run(gt("Could not change the relay"), api.setEnabled(enabled))}
      />
      {state.enabled && !state.networkAccessEnabled ? (
        <View className="p-4">
          <Text className="text-sm leading-normal text-foreground-muted">
            <T>
              Network access is off, but devices paired through the relay can still reach this
              machine.
            </T>
          </Text>
        </View>
      ) : null}
      {state.pending !== null ? (
        <View className="gap-2 p-4">
          <Text className="text-base text-foreground">
            {gt("{name} wants to connect", { name: state.pending.name })}
          </Text>
          <Text
            selectable
            className="font-mono text-2xl font-t3-semibold tracking-widest text-foreground"
          >
            {state.pending.confirmationCode}
          </Text>
          <Text className="text-sm leading-normal text-foreground-muted">
            <T>
              Approve only if the new device is in your hands and shows this exact code. A different
              code means someone else is pairing: reject it.
            </T>
          </Text>
        </View>
      ) : null}
      {state.pending !== null ? (
        <ListActionRow
          label={gt("Approve")}
          disabled={disabled}
          onPress={() =>
            run(gt("Could not approve the device"), api.approve(state.pending!.deviceId))
          }
        />
      ) : null}
      {state.pending !== null ? (
        <ListActionRow
          tone="danger"
          label={gt("Reject")}
          disabled={disabled}
          onPress={() =>
            run(gt("Could not reject the device"), api.reject(state.pending!.deviceId))
          }
        />
      ) : null}
      {state.devices
        .filter((device) => device.revokedAt === null)
        .map((device) => (
          <ListActionRow
            key={device.deviceId}
            tone="danger"
            label={gt("Revoke {name}", { name: device.name })}
            disabled={disabled}
            onPress={() =>
              Dialog.alert(
                gt("Revoke {name}?", { name: device.name }),
                gt("It disconnects now and must be paired again to come back."),
                [
                  { text: gt("Cancel"), style: "cancel" },
                  {
                    text: gt("Revoke"),
                    style: "destructive",
                    onPress: () =>
                      run(gt("Could not revoke the device"), api.revokeDevice(device.deviceId)),
                  },
                ],
              )
            }
          />
        ))}
    </SettingsSection>
  );
}
