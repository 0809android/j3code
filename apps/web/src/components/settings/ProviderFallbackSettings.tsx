import {
  DEFAULT_PROVIDER_FALLBACK_ATTEMPTS,
  DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES,
  MAX_PROVIDER_FALLBACK_ATTEMPTS,
  MAX_PROVIDER_FALLBACK_CHAIN,
  MIN_PROVIDER_FALLBACK_ATTEMPTS,
  type ModelSelection,
  type ProviderFallbackErrorClass,
} from "@t3tools/contracts";
import { pickModelSelection } from "@t3tools/shared/model";
import { useGT } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const FALLBACK_ATTEMPT_OPTIONS = Array.from(
  { length: MAX_PROVIDER_FALLBACK_ATTEMPTS - MIN_PROVIDER_FALLBACK_ATTEMPTS + 1 },
  (_, index) => MIN_PROVIDER_FALLBACK_ATTEMPTS + index,
);

const ERROR_CLASS_ORDER: ReadonlyArray<ProviderFallbackErrorClass> = [
  "usage_limit",
  "provider_error",
  "transport_error",
  "unknown",
];

function selectionKey(selection: Pick<ModelSelection, "instanceId" | "model">): string {
  return `${selection.instanceId}\0${selection.model}`;
}

export function ProviderFallbackSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { scope, target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers =
    (representative?.serverConfig
      ? providersByEnvironment.get(representative.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, target?.projectId ?? null);
  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);

  if (isProjectScope) {
    return null;
  }

  const chain = settings.providerFallbackChain;
  const errorClasses = settings.providerFallbackErrorClasses;

  const firstAvailableSelection = (): ModelSelection | null => {
    const used = new Set(chain.map(selectionKey));
    for (const entry of entries) {
      if (!entry.enabled) continue;
      for (const model of entry.models) {
        const candidate: ModelSelection = { instanceId: entry.instanceId, model: model.slug };
        if (!used.has(selectionKey(candidate))) {
          return candidate;
        }
      }
    }
    return null;
  };

  const addFallbackEntry = () => {
    if (chain.length >= MAX_PROVIDER_FALLBACK_CHAIN) return;
    const next = firstAvailableSelection();
    if (!next) return;
    updateSettings({ providerFallbackChain: [...chain, next] });
  };

  const updateFallbackEntry = (index: number, nextSelection: ModelSelection) => {
    const nextKey = selectionKey(nextSelection);
    if (chain.some((item, idx) => idx !== index && selectionKey(item) === nextKey)) {
      return;
    }
    const next = chain.map((item, idx) => (idx === index ? nextSelection : item));
    updateSettings({ providerFallbackChain: next });
  };

  const removeFallbackEntry = (index: number) => {
    updateSettings({ providerFallbackChain: chain.filter((_, idx) => idx !== index) });
  };

  const moveFallbackEntry = (index: number, delta: -1 | 1) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= chain.length) return;
    const next = [...chain];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(targetIndex, 0, moved);
    updateSettings({ providerFallbackChain: next });
  };

  const toggleErrorClass = (errorClass: ProviderFallbackErrorClass) => {
    const has = errorClasses.includes(errorClass);
    const next = has
      ? errorClasses.filter((item) => item !== errorClass)
      : [...errorClasses, errorClass];
    updateSettings({ providerFallbackErrorClasses: next });
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

  return (
    <SettingsSection id="provider-fallback" title={gt("Provider fallback")}>
      <SettingsRow
        serverScoped
        {...searchableSetting("provider-fallback-on-error")}
        description={gt(
          "Automatically hand off a failed turn to the next available secondary provider and continue the task.",
        )}
        settingKeys={["providerFallbackOnError"]}
        control={
          <Switch
            checked={settings.providerFallbackOnError}
            onCheckedChange={(checked) =>
              updateSettings({ providerFallbackOnError: Boolean(checked) })
            }
            aria-label={gt("Auto-fallback on provider error")}
          />
        }
      />

      <SettingsRow
        serverScoped
        {...searchableSetting("provider-fallback-chain")}
        description={gt(
          "Ordered secondary providers tried when the active provider fails. Falls back to the default fallback model if left empty.",
        )}
        settingKeys={["providerFallbackChain"]}
        resetAction={
          chain.length > 0 ? (
            <SettingResetButton
              ariaLabel={gt("Clear provider fallback chain")}
              onClick={() => updateSettings({ providerFallbackChain: [] })}
            />
          ) : null
        }
        control={
          <div className="flex w-full max-w-md flex-col items-end gap-2">
            {chain.map((selection, index) => {
              const modelOptions = getCustomModelOptionsByInstance(
                settings,
                providers,
                selection.instanceId,
                selection.model,
              );
              return (
                <div
                  key={`${selection.instanceId}:${selection.model}`}
                  className="flex w-full items-center justify-end gap-1.5"
                >
                  <span className="text-xs font-medium text-muted-foreground tabular-nums">
                    #{index + 1}
                  </span>
                  <ProviderModelPicker
                    environmentId={representative?.environmentId ?? null}
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptions}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel={gt("Secondary fallback provider")}
                    getModelDisabledReason={modelDisabledReason}
                    onInstanceModelChange={(instanceId, model) => {
                      updateFallbackEntry(index, pickModelSelection(selection, instanceId, model));
                    }}
                  />
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    disabled={index === 0}
                    aria-label={gt("Move fallback up")}
                    onClick={() => moveFallbackEntry(index, -1)}
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    disabled={index === chain.length - 1}
                    aria-label={gt("Move fallback down")}
                    onClick={() => moveFallbackEntry(index, 1)}
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={gt("Remove fallback provider")}
                    onClick={() => removeFallbackEntry(index)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              );
            })}
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={
                chain.length >= MAX_PROVIDER_FALLBACK_CHAIN || firstAvailableSelection() === null
              }
              onClick={addFallbackEntry}
            >
              <PlusIcon className="size-3.5" />
              {gt("Add secondary provider")}
            </Button>
          </div>
        }
      />

      <SettingsRow
        serverScoped
        {...searchableSetting("provider-fallback-error-classes")}
        description={gt(
          "Failure types that trigger automatic fallback. Validation and permission errors never trigger fallback.",
        )}
        settingKeys={["providerFallbackErrorClasses"]}
        resetAction={
          errorClasses.join(",") !== DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES.join(",") ? (
            <SettingResetButton
              ariaLabel={gt("Reset fallback error triggers to default")}
              onClick={() =>
                updateSettings({
                  providerFallbackErrorClasses: [...DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES],
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex flex-wrap justify-end gap-1.5">
            {ERROR_CLASS_ORDER.map((errorClass) => {
              const active = errorClasses.includes(errorClass);
              return (
                <Button
                  key={errorClass}
                  type="button"
                  size="xs"
                  variant={active ? "secondary" : "outline"}
                  aria-pressed={active}
                  onClick={() => toggleErrorClass(errorClass)}
                >
                  {errorClassLabel(errorClass)}
                </Button>
              );
            })}
          </div>
        }
      />

      <SettingsRow
        serverScoped
        {...searchableSetting("provider-fallback-max-attempts")}
        description={gt(
          "Maximum consecutive automatic fallbacks before pausing for manual intervention.",
        )}
        settingKeys={["providerFallbackMaxAttempts"]}
        resetAction={
          settings.providerFallbackMaxAttempts !== DEFAULT_PROVIDER_FALLBACK_ATTEMPTS ? (
            <SettingResetButton
              ariaLabel={gt("Reset max fallback attempts to default")}
              onClick={() =>
                updateSettings({
                  providerFallbackMaxAttempts: DEFAULT_PROVIDER_FALLBACK_ATTEMPTS,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={String(settings.providerFallbackMaxAttempts)}
            onValueChange={(value) => {
              const parsed = Number(value);
              if (Number.isInteger(parsed)) {
                updateSettings({ providerFallbackMaxAttempts: parsed });
              }
            }}
          >
            <SelectTrigger className="w-24" aria-label={gt("Max consecutive fallbacks")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end">
              {FALLBACK_ATTEMPT_OPTIONS.map((count) => (
                <SelectItem key={count} value={String(count)}>
                  {String(count)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
