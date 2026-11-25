import {
  type K3RelayPairingFailureReason,
  type K3RelayPairingProgress,
  k3relayPairingFailureText,
  previewK3RelayOffer,
} from "@t3tools/client-runtime/k3relay";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { connectK3RelayPairing } from "../../connection/onboarding";
import { m } from "../../i18n/messages";
import { cn } from "../../lib/cn";
import { useAtomCommand } from "../../state/use-atom-command";

/** A `k3relay://` link (scanned or pasted) belongs to this card, not the address form. */
export const isK3RelayLink = (value: string) => value.trim().toLowerCase().startsWith("k3relay:");

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  | { readonly kind: "awaiting-approval"; readonly confirmationCode: string }
  | { readonly kind: "redeeming" }
  | { readonly kind: "failed"; readonly message: string };

const phaseOf = (progress: K3RelayPairingProgress): Phase =>
  progress.phase === "awaiting-approval"
    ? { kind: "awaiting-approval", confirmationCode: progress.confirmationCode }
    : progress.phase === "redeeming"
      ? { kind: "redeeming" }
      : { kind: "connecting" };

const pairingReason = (error: unknown): K3RelayPairingFailureReason | null =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "K3RelayPairingError"
    ? (error as { readonly reason: K3RelayPairingFailureReason }).reason
    : null;

/** Pairs through a K3 Relay (spec §8): show the code to compare, wait for the host, save. */
export function K3RelayPairingCard({
  link,
  defaultDeviceName,
  onPaired,
  onCancel,
}: {
  readonly link: string;
  readonly defaultDeviceName: string;
  readonly onPaired: (environmentId: EnvironmentId) => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const pair = useAtomCommand(connectK3RelayPairing, { reportFailure: false });
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Read once: it only decides whether the scanned offer already expired.
  const [now] = useState(() => Date.now());
  const attemptRef = useRef(0);
  const preview = previewK3RelayOffer(link, now);
  const offer = typeof preview === "object" ? preview : null;
  const busy =
    phase.kind === "connecting" || phase.kind === "awaiting-approval" || phase.kind === "redeeming";

  const start = async () => {
    const attempt = ++attemptRef.current;
    setPhase({ kind: "connecting" });
    const result = await pair({
      link: link.trim(),
      deviceName: deviceName.trim(),
      onProgress: (progress) => {
        if (attempt === attemptRef.current) setPhase(phaseOf(progress));
      },
    });
    if (attempt !== attemptRef.current) return;
    if (result._tag === "Success") {
      setPhase({ kind: "idle" });
      onPaired(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setPhase({ kind: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    const reason = pairingReason(error);
    setPhase({
      kind: "failed",
      message:
        reason !== null
          ? k3relayPairingFailureText(reason, resolve)
          : error instanceof Error
            ? (errorDisplayMessage(error, m) ?? error.message)
            : k3relayPairingFailureText("redeem-failed", resolve),
    });
  };

  return (
    <View collapsable={false} className="gap-3">
      <Text className="px-4 text-sm font-t3-medium text-foreground-muted">
        <T>Pair through the relay</T>
      </Text>
      <View
        collapsable={false}
        className="gap-3 rounded-[26px] border-continuous bg-grouped-card p-4"
      >
        <Text className="text-sm leading-normal text-foreground-muted">
          <T>
            Everything is end-to-end encrypted: the relay only passes along ciphertext it cannot
            read. This device saves the host's key, a relay pass and its own key, which never leaves
            it.
          </T>
        </Text>
        {offer !== null ? (
          <Text className="text-sm leading-normal text-foreground-muted">
            {gt("Relay: {relayUrl}", { relayUrl: offer.relayUrl })}
          </Text>
        ) : (
          <Text className="text-sm leading-normal text-danger-foreground">
            {k3relayPairingFailureText(
              typeof preview === "string" ? preview : "malformed",
              resolve,
            )}
          </Text>
        )}

        {phase.kind === "awaiting-approval" ? (
          <View collapsable={false} className="items-center gap-2 py-2">
            <Text className="text-sm text-foreground-muted">
              <T>Confirmation code</T>
            </Text>
            <Text
              selectable
              accessibilityLabel={gt("Confirmation code {code}", {
                code: phase.confirmationCode,
              })}
              className="font-mono text-3xl font-t3-semibold tracking-widest text-foreground"
            >
              {phase.confirmationCode}
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
          <View collapsable={false} className="gap-1">
            <Text className="text-sm text-foreground-muted">
              <T>Name for this device</T>
            </Text>
            <AppTextInput
              value={deviceName}
              onChangeText={setDeviceName}
              maxLength={64}
              editable={!busy}
              accessibilityLabel={gt("Name for this device")}
              className="min-h-[44px] text-base"
            />
            <Text className="text-xs text-foreground-muted">
              <T>Shown on the host's approval screen. The relay never sees it.</T>
            </Text>
          </View>
        )}

        {phase.kind === "failed" ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
            {phase.message}
          </Text>
        ) : null}

        <View collapsable={false} className="flex-row justify-end gap-3">
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              attemptRef.current += 1;
              onCancel();
            }}
            className="min-h-[44px] justify-center px-3"
          >
            <Text className="text-base text-foreground-muted">
              <T>Cancel</T>
            </Text>
          </Pressable>
          {phase.kind !== "awaiting-approval" ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy || offer === null || deviceName.trim() === ""}
              onPress={() => void start()}
              className={cn(
                "min-h-[44px] justify-center rounded-full bg-primary px-4",
                (busy || offer === null || deviceName.trim() === "") && "opacity-50",
              )}
            >
              <Text className="text-base font-t3-medium text-primary-foreground">
                {phase.kind === "connecting"
                  ? gt("Connecting to the relay…")
                  : phase.kind === "redeeming"
                    ? gt("Signing in…")
                    : gt("Pair")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}
