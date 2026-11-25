import { QrCode } from "@t3tools/shared/qrCode";
import type { EnvironmentId, K3RelayPairingOffer } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { type K3RelayHostCall, useK3RelayHostActions, useK3RelayHostState } from "./hostApi";

const QR_MARGIN = 2;

/** The offer link as a QR code for the new device's camera; the secret stays on this screen. */
export function OfferQrCode(props: { readonly link: string; readonly title: string }) {
  const qr = QrCode.encodeText(props.link, QrCode.Ecc.MEDIUM);
  const size = qr.size + QR_MARGIN * 2;
  let path = "";
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.getModule(x, y)) path += `M${x + QR_MARGIN} ${y + QR_MARGIN}h1v1h-1z`;
    }
  }
  return (
    <View accessible accessibilityLabel={props.title} className="items-center p-4">
      <Svg width={180} height={180} viewBox={`0 0 ${size} ${size}`}>
        <Rect width={size} height={size} fill="#fff" />
        <Path d={path} fill="#000" />
      </Svg>
    </View>
  );
}

/**
 * The host's K3 Relay settings from a phone (spec §18.2: an approved device can approve the
 * next one). Shown once the host streams its relay state.
 */
export function K3RelaySettingsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly canWrite: boolean;
  readonly networkAccessEnabled: boolean;
}) {
  const gt = useGT();
  const { state, error } = useK3RelayHostState(props.environmentId);
  const host = useK3RelayHostActions(props.environmentId);
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState<K3RelayPairingOffer | null>(null);
  const [relayUrlDraft, setRelayUrlDraft] = useState<string | null>(null);
  if (state === null) {
    return error === null ? null : (
      <Text selectable className="px-2 text-sm text-danger-foreground">
        {error}
      </Text>
    );
  }
  const disabled = !props.canWrite || busy;
  const run = <A,>(title: string, action: K3RelayHostCall<A>, onSuccess?: (value: A) => void) => {
    setBusy(true);
    void action
      .then((result) => {
        if (result.ok) onSuccess?.(result.value);
        else if (result.error !== null) Dialog.alert(title, result.error);
      })
      .finally(() => setBusy(false));
  };
  const status =
    state.status === "connected"
      ? gt("Online", { $context: "relay connection status" })
      : state.status === "disconnected"
        ? gt("Offline", { $context: "relay connection status" })
        : state.status === "connecting"
          ? gt("Connecting", { $context: "relay connection status" })
          : state.status === "error"
            ? gt("Error", { $context: "relay connection status" })
            : gt("Off", { $context: "relay connection status" });
  const pending = state.pairing.phase === "awaiting-approval" ? state.pairing : null;
  const openOffer =
    state.pairing.phase === "open" && offer !== null && offer.expiresAt === state.pairing.expiresAt
      ? offer
      : null;
  const relayUrl = relayUrlDraft ?? state.relayUrl;
  const nameOf = (deviceId: string | null) =>
    state.devices.find((device) => device.deviceId === deviceId)?.name ?? null;
  const introduction = state.introduction.phase === "idle" ? null : state.introduction;

  return (
    // oxlint-disable-next-line t3code/no-untranslated-copy -- product name
    <SettingsSection title="K3 Relay">
      <SettingsSwitchRow
        label={gt("Reach this machine through the relay")}
        subtitle={status}
        value={state.enabled}
        disabled={disabled || !state.policyAllowed}
        onValueChange={(enabled) => run(gt("Could not change the relay"), host.setEnabled(enabled))}
      />
      {state.reachableWhenNetworkAccessOff && !props.networkAccessEnabled ? (
        <View className="p-4">
          <Text className="text-sm leading-normal text-foreground-muted">
            <T>
              Network access is off, but devices paired through the relay can still reach this
              machine.
            </T>
          </Text>
        </View>
      ) : null}
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          <T>Relay server</T>
        </Text>
        <AppTextInput
          accessibilityLabel={gt("Relay server address")}
          value={relayUrl}
          onChangeText={setRelayUrlDraft}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        />
      </View>
      {relayUrlDraft !== null && relayUrlDraft.trim() !== state.relayUrl ? (
        <ListActionRow
          label={gt("Save")}
          disabled={disabled || relayUrlDraft.trim() === ""}
          onPress={() =>
            run(
              gt("Could not save the relay address"),
              host.setRelayUrl(relayUrlDraft.trim()),
              () => setRelayUrlDraft(null),
            )
          }
        />
      ) : null}
      {pending !== null ? (
        <View className="gap-2 p-4">
          <Text className="text-base text-foreground">
            {gt("{name} wants to connect", { name: pending.deviceName })}
          </Text>
          {pending.approval === "one-tap" ? (
            <Text className="text-sm leading-normal text-foreground-muted">
              <T>
                It arrived while Add device was open, so one tap approves it. Approve only if the
                new device is in your hands.
              </T>
            </Text>
          ) : (
            <>
              <Text
                selectable
                className="font-mono text-2xl font-t3-semibold tracking-widest text-foreground"
              >
                {pending.confirmationCode}
              </Text>
              <Text className="text-sm leading-normal text-foreground-muted">
                <T>
                  Approve only if the new device is in your hands and shows this exact code. A
                  different code means someone else is pairing: reject it.
                </T>
              </Text>
            </>
          )}
        </View>
      ) : null}
      {pending !== null ? (
        <ListActionRow
          label={gt("Approve")}
          disabled={disabled}
          onPress={() =>
            run(
              gt("Could not approve the device"),
              host.approve(
                pending.deviceId,
                pending.approval === "one-tap" ? undefined : pending.confirmationCode,
              ),
            )
          }
        />
      ) : null}
      {pending !== null ? (
        <ListActionRow
          tone="danger"
          label={gt("Reject")}
          disabled={disabled}
          onPress={() => run(gt("Could not reject the device"), host.reject())}
        />
      ) : null}
      {state.enabled && pending === null && openOffer !== null ? (
        <View className="gap-1 p-4">
          <Text className="text-base text-foreground">
            <T>Scan with the new device</T>
          </Text>
          <OfferQrCode
            link={openOffer.link}
            title={gt("Relay pairing code. Scan it with the new device")}
          />
        </View>
      ) : null}
      {state.enabled && pending === null && openOffer !== null ? (
        <ListActionRow
          label={gt("Cancel")}
          disabled={disabled}
          onPress={() =>
            run(gt("Could not cancel pairing"), host.cancelOffer(), () => setOffer(null))
          }
        />
      ) : null}
      {state.enabled && pending === null && openOffer === null ? (
        <ListActionRow
          label={gt("Add device")}
          disabled={disabled}
          onPress={() => run(gt("Could not create a pairing code"), host.createOffer(), setOffer)}
        />
      ) : null}
      {introduction !== null ? (
        <View className="gap-1 p-4">
          <Text className="text-base text-foreground">
            {introduction.deviceName === null
              ? gt("{introducer} is introducing a new device", {
                  introducer: nameOf(introduction.introducerDeviceId) ?? "?",
                })
              : gt("{introducer} is introducing {name}", {
                  introducer: nameOf(introduction.introducerDeviceId) ?? "?",
                  name: introduction.deviceName,
                })}
          </Text>
          <Text className="text-sm leading-normal text-foreground-muted">
            <T>
              Devices that can introduce add new devices after comparing a code on both screens.
              Revoke the device here if you did not expect this.
            </T>
          </Text>
        </View>
      ) : null}
      {state.devices
        .filter((device) => device.status === "active")
        .map((device) =>
          device.approvedVia === "introduction" ? (
            <View key={`${device.deviceId}-introduced`} className="px-4 py-2">
              <Text className="text-sm text-foreground-muted">
                {nameOf(device.introducedBy) === null
                  ? gt("{name}: added by introduction from another device", { name: device.name })
                  : gt("{name}: added by introduction from {introducer}", {
                      name: device.name,
                      introducer: nameOf(device.introducedBy) ?? "",
                    })}
              </Text>
            </View>
          ) : (
            <SettingsSwitchRow
              key={`${device.deviceId}-invite`}
              label={gt("Let {name} introduce devices", { name: device.name })}
              subtitle={gt(
                "Adds your other devices after one code comparison, and can revoke ordinary devices if one is lost.",
              )}
              value={device.permissions.includes("devices:invite")}
              disabled={disabled}
              onValueChange={(invite) =>
                run(
                  gt("Could not change what the device may do"),
                  host.setInvite(device.deviceId, invite),
                )
              }
            />
          ),
        )}
      {state.devices
        .filter((device) => device.status === "active")
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
                      run(gt("Could not revoke the device"), host.revoke(device.deviceId)),
                  },
                ],
              )
            }
          />
        ))}
    </SettingsSection>
  );
}
