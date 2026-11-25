import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { runtime } from "../../lib/runtime";
import type { K3RelayNotificationPreferences } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import { DEFAULT_K3_RELAY_NOTIFICATIONS } from "../agent-awareness/k3relayNotifications";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/**
 * This device's notifications through the K3 relay (spec §13). They reach the hosts it is paired
 * with on its next relay connection; the contents are end-to-end encrypted to this device.
 */
export function SettingsK3RelayNotificationsSection() {
  const gt = useGT();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const stored = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.k3relayNotifications
    : undefined;
  const current = stored ?? DEFAULT_K3_RELAY_NOTIFICATIONS;
  const supported = supportsAgentAwarenessPush();
  const loading = !AsyncResult.isSuccess(preferencesResult);

  const save = (next: K3RelayNotificationPreferences) =>
    Effect.runPromiseExit(
      saveMobilePreferences.run(appAtomRegistry, { k3relayNotifications: next }),
    );

  const handleEnabledChange = async (enabled: boolean) => {
    if (enabled) {
      const permission = await runtime.runPromiseExit(requestAgentNotificationPermission);
      if (permission._tag === "Failure" || permission.value.type !== "granted") {
        Dialog.alert(
          gt("Notifications are off"),
          gt("Allow notifications for {product} in Settings to get relay notifications.", {
            product: "K3 Code",
          }),
        );
        return;
      }
    }
    await save({ ...current, enabled });
  };

  const kindRow = (
    kind: "approval" | "input" | "completed" | "failed",
    label: string,
    icon: "person.fill.checkmark" | "text.bubble" | "checkmark.circle" | "exclamationmark.triangle",
  ) => (
    <SettingsSwitchRow
      key={kind}
      icon={icon}
      label={label}
      disabled={!supported || loading || !current.enabled}
      value={current.enabled && current[kind]}
      onValueChange={(value) => void save({ ...current, [kind]: value })}
    />
  );

  return (
    <SettingsSection
      // oxlint-disable-next-line t3code/no-untranslated-copy -- product name
      title="K3 Relay"
      footer={gt(
        "Notifications from hosts you reach through the K3 relay are end-to-end encrypted to this device. The relay, Apple and Google cannot read them; they only carry what happened, never thread titles or file contents. Changes reach each host the next time this device connects to it.",
      )}
    >
      <SettingsSwitchRow
        icon="bell.badge"
        label={gt("Relay Notifications")}
        subtitle={supported ? undefined : gt("This app build cannot receive notifications.")}
        disabled={!supported || loading}
        value={supported && current.enabled}
        onValueChange={(enabled) => void handleEnabledChange(enabled)}
      />
      {kindRow("approval", gt("Approval needed"), "person.fill.checkmark")}
      {kindRow("input", gt("Input needed"), "text.bubble")}
      {kindRow("completed", gt("Task completed"), "checkmark.circle")}
      {kindRow("failed", gt("Agent run failed"), "exclamationmark.triangle")}
    </SettingsSection>
  );
}
