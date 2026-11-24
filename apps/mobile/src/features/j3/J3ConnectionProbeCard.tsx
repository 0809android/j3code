import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import {
  classifyJ3ConnectionHost,
  probeJ3Connection,
  type J3ConnectionKind,
  type J3ConnectionProbeResult,
} from "./j3ConnectionProbe";

interface ProbeRecord {
  readonly host: string;
  readonly result: J3ConnectionProbeResult;
}

function connectionKindIcon(kind: J3ConnectionKind): AppSymbolName {
  switch (kind) {
    case "tailscale":
      return "point.3.connected.trianglepath.dotted";
    case "relay":
      return "server.rack";
    case "local":
      return "wifi";
    case "remote":
      return "globe";
    case "invalid":
      return "exclamationmark.triangle";
  }
}

export function J3ConnectionProbeCard(props: { readonly hostInput: string }) {
  const gt = useGT();
  const trimmedHost = props.hostInput.trim();
  const [probing, setProbing] = useState<{
    readonly host: string;
    readonly seq: number;
  } | null>(null);
  const [probeRecord, setProbeRecord] = useState<ProbeRecord | null>(null);
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const activeProbeRef = useRef<{
    readonly host: string;
    readonly controller: AbortController;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts an in-flight probe when the edited host changes
  useEffect(() => {
    if (activeProbeRef.current && activeProbeRef.current.host !== trimmedHost) {
      activeProbeRef.current.controller.abort();
      activeProbeRef.current = null;
    }
  }, [trimmedHost]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts any in-flight probe on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeProbeRef.current?.controller.abort();
      activeProbeRef.current = null;
    };
  }, []);

  if (!trimmedHost) {
    return null;
  }

  const classification = classifyJ3ConnectionHost(trimmedHost);
  const isProbing = probing?.host === trimmedHost;
  const activeResult = probeRecord?.host === trimmedHost ? probeRecord.result : null;
  const effectiveKind = activeResult ? activeResult.kind : classification.kind;

  const kindLabel = (() => {
    switch (effectiveKind) {
      case "tailscale":
        return gt("Tailscale network");
      case "relay":
        return gt("J3 Relay Proxy");
      case "local":
        return gt("Local network");
      case "remote":
        return gt("Remote host");
      case "invalid":
        return gt("Invalid address");
    }
  })();

  const handleTestPress = async () => {
    if (isProbing || classification.kind === "invalid") return;
    activeProbeRef.current?.controller.abort();
    const controller = new AbortController();
    activeProbeRef.current = { host: trimmedHost, controller };
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setProbing({ host: trimmedHost, seq });
    const result = await probeJ3Connection(trimmedHost, { signal: controller.signal });
    if (!mountedRef.current) return;
    setProbing((current) => (current?.seq === seq ? null : current));
    if (requestSeqRef.current !== seq || controller.signal.aborted) return;
    activeProbeRef.current = null;
    setProbeRecord({ host: trimmedHost, result });
    void Haptics.notificationAsync(
      result.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error,
    );
  };

  const resultSummary = (() => {
    if (!activeResult) return null;
    if (activeResult.ok) {
      if (activeResult.relayDetected) {
        return gt("J3 Relay reachable ({ms} ms)", { ms: activeResult.latencyMs });
      }
      return gt("Server reachable ({ms} ms)", { ms: activeResult.latencyMs });
    }
    if (activeResult.errorCode === "timeout") {
      return gt("Connection timed out");
    }
    if (activeResult.errorCode === "unreachable") {
      return gt("Host unreachable");
    }
    if (activeResult.errorCode === "http_error" && activeResult.statusCode !== null) {
      return gt("Server returned HTTP {status}", { status: activeResult.statusCode });
    }
    return gt("Could not reach address");
  })();

  return (
    <View className="gap-2.5 rounded-[20px] border border-border-subtle bg-grouped-card px-4 py-3">
      <View className="flex-row items-center justify-between gap-2">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <SymbolView
            name={connectionKindIcon(effectiveKind)}
            size={15}
            tintColorClassName={
              effectiveKind === "invalid" ? "accent-danger-foreground" : "accent-foreground-muted"
            }
            type="monochrome"
          />
          <View className="min-w-0 flex-1">
            <Text className="text-xs font-t3-medium text-foreground" numberOfLines={1}>
              {kindLabel}
            </Text>
            {classification.normalizedUrl ? (
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                {classification.normalizedUrl}
              </Text>
            ) : null}
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Test connection")}
          disabled={isProbing || classification.kind === "invalid"}
          onPress={() => void handleTestPress()}
          className={cn(
            "rounded-full border border-border-subtle bg-subtle px-3 py-1.5",
            (isProbing || classification.kind === "invalid") && "opacity-50",
          )}
        >
          <Text className="text-xs font-t3-medium text-foreground">
            {isProbing ? gt("Testing…") : gt("Test")}
          </Text>
        </Pressable>
      </View>

      {resultSummary ? (
        <View className="flex-row items-center gap-1.5 border-t border-border-subtle pt-2">
          <SymbolView
            name={activeResult?.ok ? "checkmark.circle.fill" : "exclamationmark.triangle"}
            size={14}
            tintColorClassName={
              activeResult?.ok ? "accent-adaptive-emerald-600-400" : "accent-danger-foreground"
            }
            type="monochrome"
          />
          <Text
            accessibilityLiveRegion="polite"
            className={cn(
              "min-w-0 flex-1 text-xs",
              activeResult?.ok ? "text-adaptive-emerald-600-400" : "text-danger-foreground",
            )}
          >
            {resultSummary}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
