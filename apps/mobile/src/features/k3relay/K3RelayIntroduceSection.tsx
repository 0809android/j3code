import {
  type K3RelayIntroductionApproval,
  type K3RelayIntroductionClaims,
  type K3RelayIntroductionFailureReason,
  type K3RelayIntroductionSession,
  k3relayIntroductionFailureText,
} from "@t3tools/client-runtime/k3relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";
import { T, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { k3relayIntroducer } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { OfferQrCode } from "./K3RelaySettingsSection";

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "waiting"; readonly session: K3RelayIntroductionSession }
  | {
      readonly kind: "compare";
      readonly session: K3RelayIntroductionSession;
      readonly claims: K3RelayIntroductionClaims;
    }
  | { readonly kind: "done"; readonly approvals: ReadonlyArray<K3RelayIntroductionApproval> }
  | { readonly kind: "failed"; readonly reason: K3RelayIntroductionFailureReason };

const reasonOf = (result: {
  readonly cause: Cause.Cause<unknown>;
}): K3RelayIntroductionFailureReason => {
  const error = squashAtomCommandFailure(result);
  return typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === "K3RelayIntroductionError"
    ? (error as unknown as { readonly reason: K3RelayIntroductionFailureReason }).reason
    : "internal";
};

/**
 * This phone introduces a new device to every host it reaches through the relay (spec §18.2):
 * a QR code for the new device, one code to compare, one approval for all hosts.
 */
export function K3RelayIntroduceSection() {
  const gt = useGT();
  const resolve = useMessages();
  const options = { reportFailure: false } as const;
  const open = useAtomCommand(k3relayIntroducer.open, options);
  const collect = useAtomCommand(k3relayIntroducer.collect, options);
  const approve = useAtomCommand(k3relayIntroducer.approve, options);
  const cancel = useAtomCommand(k3relayIntroducer.cancel, options);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const attemptRef = useRef(0);

  const start = async () => {
    const attempt = ++attemptRef.current;
    setPhase({ kind: "busy" });
    const opened = await open({});
    if (attempt !== attemptRef.current) return;
    if (opened._tag !== "Success") {
      setPhase(
        isAtomCommandInterrupted(opened)
          ? { kind: "idle" }
          : { kind: "failed", reason: reasonOf(opened) },
      );
      return;
    }
    const session = opened.value;
    setPhase({ kind: "waiting", session });
    const collected = await collect(session);
    if (attempt !== attemptRef.current) return;
    if (collected._tag !== "Success") {
      void cancel(session);
      setPhase(
        isAtomCommandInterrupted(collected)
          ? { kind: "idle" }
          : { kind: "failed", reason: reasonOf(collected) },
      );
      return;
    }
    setPhase({ kind: "compare", session, claims: collected.value });
  };

  const confirm = async (claims: K3RelayIntroductionClaims) => {
    const attempt = ++attemptRef.current;
    setPhase({ kind: "busy" });
    const approved = await approve({ claims, confirmationCode: claims.confirmationCode });
    if (attempt !== attemptRef.current) return;
    setPhase(
      approved._tag === "Success"
        ? { kind: "done", approvals: approved.value }
        : { kind: "failed", reason: reasonOf(approved) },
    );
  };

  const stop = () => {
    attemptRef.current += 1;
    if (phase.kind === "waiting" || phase.kind === "compare") void cancel(phase.session);
    setPhase({ kind: "idle" });
  };

  return (
    <SettingsSection title={gt("Introduce a device")}>
      <View className="p-4">
        <Text className="text-sm leading-normal text-foreground-muted">
          <T>
            The new device scans a QR code from this one, and you compare one code on both screens.
            Each host must first allow this device to introduce, in its relay settings.
          </T>
        </Text>
      </View>
      {phase.kind === "busy" ? (
        <View className="flex-row items-center gap-2 px-4 pb-4">
          <ActivityIndicator size="small" />
        </View>
      ) : null}
      {phase.kind === "waiting" ? (
        <View className="gap-2 p-4">
          <Text className="text-base text-foreground">
            <T>Scan with the new device</T>
          </Text>
          <OfferQrCode
            link={phase.session.link}
            title={gt("Introduction code. Scan it with the new device")}
          />
          <Text className="text-sm text-foreground-muted">
            {gt("For {hosts}. Show it in person only.", {
              hosts: phase.session.opened.map((window) => window.host.label).join(", "),
            })}
          </Text>
          {phase.session.refused.map(({ host, reason }) => (
            <Text key={host.hostId} className="text-sm text-foreground-muted">
              {gt("Not included: {host}. {reason}", {
                host: host.label,
                reason: k3relayIntroductionFailureText(reason, resolve),
              })}
            </Text>
          ))}
          <View className="flex-row items-center gap-2">
            <ActivityIndicator size="small" />
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              <T>Waiting for the new device…</T>
            </Text>
          </View>
        </View>
      ) : null}
      {phase.kind === "compare" ? (
        <View className="gap-2 p-4">
          <Text className="text-base text-foreground">
            {gt("{name} wants to join {hosts}", {
              name: phase.claims.deviceName,
              hosts: phase.claims.claims.map(({ window }) => window.host.label).join(", "),
            })}
          </Text>
          <Text
            selectable
            className="font-mono text-2xl font-t3-semibold tracking-widest text-foreground"
          >
            {phase.claims.confirmationCode}
          </Text>
          <Text className="text-sm leading-normal text-foreground-muted">
            <T>
              Approve only if the new device is in your hands and shows this exact code. A different
              code means someone else scanned the QR code: cancel.
            </T>
          </Text>
        </View>
      ) : null}
      {phase.kind === "compare" ? (
        <ListActionRow label={gt("Approve")} onPress={() => void confirm(phase.claims)} />
      ) : null}
      {phase.kind === "done"
        ? phase.approvals.map(({ host, result }) => (
            <View key={host.hostId} className="px-4 py-1">
              <Text className="text-sm text-foreground-muted">
                {result.ok
                  ? gt("{host}: added", { host: host.label })
                  : gt("{host}: {reason}", {
                      host: host.label,
                      reason: k3relayIntroductionFailureText(result.reason, resolve),
                    })}
              </Text>
            </View>
          ))
        : null}
      {phase.kind === "failed" ? (
        <View className="px-4 pb-2">
          <Text accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
            {k3relayIntroductionFailureText(phase.reason, resolve)}
          </Text>
        </View>
      ) : null}
      {phase.kind === "waiting" || phase.kind === "compare" ? (
        <ListActionRow tone="danger" label={gt("Cancel")} onPress={stop} />
      ) : phase.kind === "busy" ? null : (
        <ListActionRow label={gt("Introduce a device")} onPress={() => void start()} />
      )}
    </SettingsSection>
  );
}
