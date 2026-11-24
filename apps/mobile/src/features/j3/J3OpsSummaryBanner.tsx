import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { environmentServerConfigsAtom } from "../../state/server";
import { openSettings } from "../settings/settings-navigation";
import { summarizeJ3Operations } from "./j3OpsSummary";

export function J3OpsSummaryBanner(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly compact?: boolean;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const serverConfigsByEnvironment = useAtomValue(environmentServerConfigsAtom);

  const summary = summarizeJ3Operations({
    threads: props.threads,
    serverConfigsByEnvironment,
    selectedEnvironmentId: props.selectedEnvironmentId,
  });

  if (summary.environmentCount === 0) {
    return null;
  }

  const fallbackEnabled = summary.fallbackEnabledCount > 0;
  const fallbackLabel = fallbackEnabled
    ? summary.fallbackChainMaxCount > 0
      ? gt("Fallback ON ({count})", { count: summary.fallbackChainMaxCount })
      : gt("Fallback ON")
    : gt("Fallback OFF");

  const hasActivity =
    summary.workingCount > 0 || summary.attentionCount > 0 || summary.failedCount > 0;

  return (
    <View className={cn("pb-2", props.compact ? "px-2" : "px-4")}>
      <View className="flex-row flex-wrap items-center justify-between gap-2 rounded-2xl border border-border-subtle bg-card px-3 py-2">
        <View className="flex-row flex-wrap items-center gap-2.5">
          {summary.workingCount > 0 ? (
            <View className="flex-row items-center gap-1">
              <SymbolView
                name="bolt.circle"
                size={13}
                tintColorClassName="accent-foreground"
                type="monochrome"
              />
              <Text className="text-xs font-t3-medium text-foreground">
                {gt("Working {count}", { count: summary.workingCount })}
              </Text>
            </View>
          ) : null}

          {summary.attentionCount > 0 ? (
            <View className="flex-row items-center gap-1">
              <SymbolView
                name="exclamationmark.shield"
                size={13}
                tintColorClassName="accent-warning-foreground"
                type="monochrome"
              />
              <Text className="text-xs font-t3-medium text-warning-foreground">
                {gt("Needs you {count}", { count: summary.attentionCount })}
              </Text>
            </View>
          ) : null}

          {summary.failedCount > 0 ? (
            <View className="flex-row items-center gap-1">
              <SymbolView
                name="exclamationmark.triangle"
                size={13}
                tintColorClassName="accent-danger-foreground"
                type="monochrome"
              />
              <Text className="text-xs font-t3-medium text-danger-foreground">
                {gt("Failed {count}", { count: summary.failedCount })}
              </Text>
            </View>
          ) : null}

          {!hasActivity ? (
            <View className="flex-row items-center gap-1">
              <SymbolView
                name="checkmark.circle"
                size={13}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
              <Text className="text-xs text-foreground-muted">{gt("All threads idle")}</Text>
            </View>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Open provider fallback settings")}
          onPress={() => openSettings(navigation, "SettingsThreads")}
          className={cn(
            "flex-row items-center gap-1 rounded-full px-2.5 py-1 active:opacity-75",
            fallbackEnabled ? "bg-subtle-strong" : "bg-subtle",
          )}
        >
          <SymbolView
            name="arrow.triangle.branch"
            size={12}
            tintColorClassName={fallbackEnabled ? "accent-foreground" : "accent-foreground-muted"}
            type="monochrome"
          />
          <Text
            className={cn(
              "text-xs font-t3-medium",
              fallbackEnabled ? "text-foreground" : "text-foreground-muted",
            )}
          >
            {fallbackLabel}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
