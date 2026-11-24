import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_PROVIDER_FALLBACK_ATTEMPTS,
  DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES,
  MAX_PROVIDER_FALLBACK_ATTEMPTS,
  MAX_PROVIDER_FALLBACK_CHAIN,
  MIN_PROVIDER_FALLBACK_ATTEMPTS,
  type ModelSelection,
  type ProviderFallbackErrorClass,
  type ServerProvider,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { environmentPresentations } from "../../state/presentation";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  managedSettingReason,
  type ScopedMobileSettingsTarget,
  uniformMobileSetting,
} from "./settings-scoped-server";

const ERROR_CLASS_ORDER: ReadonlyArray<ProviderFallbackErrorClass> = [
  "usage_limit",
  "provider_error",
  "transport_error",
  "unknown",
];

const ATTEMPT_OPTIONS = Array.from(
  { length: MAX_PROVIDER_FALLBACK_ATTEMPTS - MIN_PROVIDER_FALLBACK_ATTEMPTS + 1 },
  (_, index) => MIN_PROVIDER_FALLBACK_ATTEMPTS + index,
);

function selectionKey(selection: Pick<ModelSelection, "instanceId" | "model">): string {
  return `${selection.instanceId}\0${selection.model}`;
}

function collectAvailableModels(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<{ readonly label: string; readonly selection: ModelSelection }> {
  const results: Array<{ readonly label: string; readonly selection: ModelSelection }> = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const providerLabel = provider.displayName?.trim() || provider.instanceId;
    for (const model of provider.models) {
      results.push({
        label: `${providerLabel} · ${model.name}`,
        selection: { instanceId: provider.instanceId, model: model.slug },
      });
    }
  }
  return results;
}

export function MobileProviderFallbackSection(props: {
  readonly displayTargets: ReadonlyArray<ScopedMobileSettingsTarget>;
  readonly reference: ScopedMobileSettingsTarget;
  readonly disabled: boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
}) {
  const gt = useGT();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);

  const disabledFor = (...keys: string[]) =>
    props.disabled || managedSettingReason(props.displayTargets, keys) !== undefined;

  const settings = props.reference.settings;
  const chain = settings.providerFallbackChain;
  const errorClasses = settings.providerFallbackErrorClasses;
  const providers = providersByEnvironment.get(props.reference.environment.environmentId) ?? [];
  const availableModels = collectAvailableModels(providers);
  const usedKeys = new Set(chain.map(selectionKey));
  const addableModels = availableModels.filter(
    (entry) => !usedKeys.has(selectionKey(entry.selection)),
  );
  const normalizedQuery = pickerQuery.trim().toLowerCase();
  const filteredAddableModels = normalizedQuery
    ? addableModels.filter(
        (entry) =>
          entry.label.toLowerCase().includes(normalizedQuery) ||
          entry.selection.model.toLowerCase().includes(normalizedQuery) ||
          entry.selection.instanceId.toLowerCase().includes(normalizedQuery),
      )
    : addableModels;

  const modelLabel = (selection: ModelSelection): string => {
    const match = availableModels.find(
      (entry) => selectionKey(entry.selection) === selectionKey(selection),
    );
    return match?.label ?? `${selection.instanceId} / ${selection.model}`;
  };

  const errorClassLabel = (errorClass: ProviderFallbackErrorClass): string => {
    switch (errorClass) {
      case "usage_limit":
        return gt("Usage / rate limits");
      case "provider_error":
        return gt("Provider errors");
      case "transport_error":
        return gt("Connection errors");
      case "unknown":
        return gt("Unknown errors");
    }
  };

  const moveEntry = (index: number, delta: -1 | 1) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= chain.length) return;
    const next = [...chain];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(targetIndex, 0, moved);
    props.write({ providerFallbackChain: next });
  };

  const removeEntry = (index: number) => {
    props.write({ providerFallbackChain: chain.filter((_, idx) => idx !== index) });
  };

  const addEntry = (selection: ModelSelection) => {
    if (chain.length >= MAX_PROVIDER_FALLBACK_CHAIN || usedKeys.has(selectionKey(selection)))
      return;
    props.write({ providerFallbackChain: [...chain, selection] });
    setPickerOpen(false);
  };

  const toggleErrorClass = (errorClass: ProviderFallbackErrorClass) => {
    const active = errorClasses.includes(errorClass);
    const next = active
      ? errorClasses.filter((item) => item !== errorClass)
      : [...errorClasses, errorClass];
    props.write({ providerFallbackErrorClasses: next });
  };

  const cycleMaxAttempts = () => {
    const currentIndex = ATTEMPT_OPTIONS.indexOf(settings.providerFallbackMaxAttempts);
    const next =
      ATTEMPT_OPTIONS[(currentIndex + 1) % ATTEMPT_OPTIONS.length] ??
      DEFAULT_PROVIDER_FALLBACK_ATTEMPTS;
    props.write({ providerFallbackMaxAttempts: next });
  };

  return (
    <SettingsSection title={gt("Provider fallback")}>
      <SettingsSwitchRow
        icon="arrow.triangle.branch"
        label={gt("Auto-fallback on provider error")}
        subtitle={gt(
          "Automatically hand off a failed turn to the next available secondary provider and continue the task.",
        )}
        value={uniformMobileSetting(props.displayTargets, "providerFallbackOnError")}
        disabled={disabledFor("providerFallbackOnError")}
        onValueChange={(value) => props.write({ providerFallbackOnError: value })}
      />

      <View className="gap-3 px-4 py-3">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="text-sm font-t3-medium text-foreground">
            {gt("Secondary provider chain")}
          </Text>
          <Button
            size="compact"
            tone="secondary"
            label={gt("Max: {count}", { count: settings.providerFallbackMaxAttempts })}
            disabled={disabledFor("providerFallbackMaxAttempts")}
            onPress={cycleMaxAttempts}
          />
        </View>

        {chain.length === 0 ? (
          <Text className="text-xs text-foreground-muted">
            {gt(
              "No secondary providers configured yet. Falls back to the default fallback model if set.",
            )}
          </Text>
        ) : (
          <View className="gap-2">
            {chain.map((selection, index) => (
              <View
                key={`${selection.instanceId}:${selection.model}`}
                className="flex-row items-center justify-between gap-2 rounded-xl bg-subtle px-3 py-2"
              >
                <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                  {`#${index + 1} ${modelLabel(selection)}`}
                </Text>
                <View className="flex-row items-center gap-1">
                  <Button
                    size="compact"
                    tone="text"
                    label="↑"
                    accessibilityLabel={gt("Move fallback up")}
                    disabled={index === 0 || disabledFor("providerFallbackChain")}
                    onPress={() => moveEntry(index, -1)}
                  />
                  <Button
                    size="compact"
                    tone="text"
                    label="↓"
                    accessibilityLabel={gt("Move fallback down")}
                    disabled={index === chain.length - 1 || disabledFor("providerFallbackChain")}
                    onPress={() => moveEntry(index, 1)}
                  />
                  <Button
                    size="compact"
                    tone="danger"
                    label={gt("Remove")}
                    disabled={disabledFor("providerFallbackChain")}
                    onPress={() => removeEntry(index)}
                  />
                </View>
              </View>
            ))}
          </View>
        )}

        <View className="flex-row flex-wrap gap-2">
          <Button
            size="compact"
            tone="secondary"
            label={pickerOpen ? gt("Close picker") : gt("Add secondary provider")}
            disabled={
              disabledFor("providerFallbackChain") ||
              chain.length >= MAX_PROVIDER_FALLBACK_CHAIN ||
              addableModels.length === 0
            }
            onPress={() => setPickerOpen((open) => !open)}
          />
          {errorClasses.join(",") !== DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES.join(",") ? (
            <Button
              size="compact"
              tone="text"
              label={gt("Reset error triggers")}
              disabled={disabledFor("providerFallbackErrorClasses")}
              onPress={() =>
                props.write({
                  providerFallbackErrorClasses: [...DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES],
                })
              }
            />
          ) : null}
        </View>

        {pickerOpen ? (
          <View className="gap-2">
            <TextInput
              value={pickerQuery}
              onChangeText={setPickerQuery}
              placeholder={gt("Filter providers or models")}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              className="rounded-xl border border-border bg-subtle px-3 py-2 text-sm text-foreground"
            />
            <ScrollView
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              className="max-h-72 overflow-hidden rounded-xl border border-border"
            >
              {filteredAddableModels.length === 0 ? (
                <Text className="px-3 py-3 text-xs text-foreground-muted">
                  {gt("No matching models found.")}
                </Text>
              ) : (
                filteredAddableModels.map((entry, idx) => (
                  <ListChoiceRow
                    key={`${entry.selection.instanceId}:${entry.selection.model}`}
                    label={entry.label}
                    description={entry.selection.model}
                    selected={false}
                    separated={idx > 0}
                    disabled={disabledFor("providerFallbackChain")}
                    onPress={() => {
                      addEntry(entry.selection);
                      setPickerQuery("");
                    }}
                  />
                ))
              )}
            </ScrollView>
          </View>
        ) : null}
      </View>

      {ERROR_CLASS_ORDER.map((errorClass) => (
        <SettingsSwitchRow
          key={errorClass}
          label={errorClassLabel(errorClass)}
          value={errorClasses.includes(errorClass)}
          disabled={disabledFor("providerFallbackErrorClasses")}
          onValueChange={() => toggleErrorClass(errorClass)}
        />
      ))}
    </SettingsSection>
  );
}
