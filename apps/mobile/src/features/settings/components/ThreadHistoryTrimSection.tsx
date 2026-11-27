import { useAtomValue } from "@effect/atom-react";
import {
  describeThreadHistoryTrimSchedule,
  planThreadHistoryAfterDaysWrites,
  sumThreadHistoryTrimReports,
  uniformThreadHistoryAfterDays,
} from "@t3tools/client-runtime/state/threadHistoryTrim";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthEnvironmentMaintainScope,
  AuthSettingsWriteScope,
  SUGGESTED_THREAD_HISTORY_AFTER_DAYS,
  type EnvironmentId,
  type ThreadHistoryTrimReport,
} from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { useGT, useMessages } from "gt-react-native";
import { useMemo, useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../../components/ui/ListActionRow";
import { NumberField } from "../../../components/ui/NumberField";
import { AppText as Text } from "../../../components/ui/AppText";
import { useNowMinuteMs } from "../../../lib/clock";
import { formatBytes } from "../../../lib/formatBytes";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentsWithScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { managedSettingReason, resolveMobileSettingsTargets } from "../settings-scoped-server";
import { useSettingsWriter } from "../useSettingsWriter";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const MIN_DAYS = 1;
const MAX_DAYS = 3650;

const formatTrimDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

function daysOf(target: SettingsTarget) {
  return target.serverConfig.settings.storageCleanup.threadHistoryAfterDays;
}

// Turns thread history trimming on and off, and trims now after showing what qualifies.
// The server only offers it from versions that trim; only an environment's maintainers change it.
export function ThreadHistoryTrimSection({
  targets,
}: {
  readonly targets: readonly SettingsTarget[];
}) {
  const gt = useGT();
  const resolve = useMessages();
  const preview = useAtomCommand(serverEnvironment.previewThreadHistoryTrim, {
    label: "thread history trim preview",
    reportFailure: false,
  });
  const trim = useAtomCommand(serverEnvironment.trimThreadHistory, {
    label: "thread history trim",
    reportFailure: false,
  });
  const writeSettings = useSettingsWriter();
  const nowMs = useNowMinuteMs();
  const [pending, setPending] = useState<"preview" | "trim" | null>(null);

  const supported = targets.filter(
    (target) => target.serverConfig.environment.capabilities.threadHistoryTrim === true,
  );
  const maintainers = useEnvironmentsWithScope(supported, AuthEnvironmentMaintainScope);
  const writers = useEnvironmentsWithScope(supported, AuthSettingsWriteScope);
  const supportedKey = supported.map((target) => target.environmentId).join("\n");
  const statusesAtom = useMemo(
    () =>
      Atom.make((get) =>
        supportedKey === ""
          ? []
          : (supportedKey.split("\n") as EnvironmentId[]).map((environmentId) =>
              get(serverEnvironment.threadHistoryTrim({ environmentId, input: {} })),
            ),
      ),
    [supportedKey],
  );
  const statuses = useAtomValue(statusesAtom);

  if (supported.length === 0) return null;

  const scoped = resolveMobileSettingsTargets(supported, null);
  const canMaintain = supported.every((target) => maintainers.has(target.environmentId));
  const canWrite = supported.every((target) => writers.has(target.environmentId));
  const managed = managedSettingReason(scoped, ["storageCleanup.threadHistoryAfterDays"]);
  const days = uniformThreadHistoryAfterDays(supported.map(daysOf));
  const editable = canWrite && managed === undefined && pending === null;
  // Turning trimming off deletes nothing, so settings write is enough; turning it on or changing
  // the days needs maintenance access.
  const canTurnOff = editable && days !== null;
  const canChange = editable && canMaintain;
  const runnable = supported.filter(
    (target) => maintainers.has(target.environmentId) && daysOf(target) !== null,
  );

  const saveDays = (next: number | null) => {
    void writeSettings(
      scoped,
      planThreadHistoryAfterDaysWrites(
        supported.map((target) => target.environmentId),
        next,
      ),
    );
  };

  const schedule = supported.flatMap((target, index) => {
    const status = statuses[index];
    if (daysOf(target) === null || status === undefined || !AsyncResult.isSuccess(status)) {
      return [];
    }
    const text = describeThreadHistoryTrimSchedule({
      status: status.value,
      nowMs,
      formatDate: formatTrimDate,
      resolve,
    });
    return [supported.length > 1 ? `${target.label}: ${text}` : text];
  });

  const runOn = async (
    command: typeof trim,
    list: readonly SettingsTarget[],
    failureTitle: (label: string) => string,
  ) => {
    const results = await Promise.all(
      list.map(async (target) => {
        const result = await command({ environmentId: target.environmentId, input: {} });
        if (result._tag === "Success") return { target, report: result.value };
        if (!isAtomCommandInterrupted(result)) {
          Dialog.alert(failureTitle(target.label), String(squashAtomCommandFailure(result)));
        }
        return null;
      }),
    );
    return results.filter((result) => result !== null);
  };

  const confirmTrim = async (
    confirming: ReadonlyArray<{
      readonly target: SettingsTarget;
      readonly report: ThreadHistoryTrimReport;
    }>,
  ) => {
    setPending("trim");
    const results = await runOn(
      trim,
      confirming.filter(({ report }) => report.threadCount > 0).map(({ target }) => target),
      (label) => gt("Could not trim threads on {label}", { label }),
    ).finally(() => setPending(null));
    if (results.length === 0) return;
    // The server queues the pass without estimating again, so the size is the preview's.
    const { threadCount, estimatedBytes } = sumThreadHistoryTrimReports(
      confirming
        .filter(({ target }) =>
          results.some((result) => result.target.environmentId === target.environmentId),
        )
        .map(({ report }) => report),
    );
    Dialog.alert(
      gt("{count, plural, one {Trimming {count} thread} other {Trimming {count} threads}}", {
        count: threadCount,
      }),
      gt("About {size} of tool output and reasoning is being removed.", {
        size: formatBytes(estimatedBytes),
      }),
    );
  };

  const checkTrim = async () => {
    setPending("preview");
    const results = await runOn(preview, runnable, (label) =>
      gt("Could not check old threads on {label}", { label }),
    ).finally(() => setPending(null));
    if (results.length === 0) return;
    const { threadCount, estimatedBytes } = sumThreadHistoryTrimReports(
      results.map(({ report }) => report),
    );
    if (threadCount === 0) {
      Dialog.alert(gt("Nothing to trim"), gt("No threads have gone unused long enough yet."));
      return;
    }
    Dialog.confirm({
      title: gt("Trim old threads?"),
      message: gt(
        "{count, plural, one {Delete tool output and reasoning from {count} unused thread, about {size}? Messages, plans, file changes and attachments are kept. This can't be undone.} other {Delete tool output and reasoning from {count} unused threads, about {size}? Messages, plans, file changes and attachments are kept. This can't be undone.}}",
        { count: threadCount, size: formatBytes(estimatedBytes) },
      ),
      confirmText: gt("Trim threads"),
      destructive: true,
      onConfirm: () => void confirmTrim(results),
    });
  };

  return (
    <SettingsSection
      title={gt("Thread history")}
      footer={
        !canMaintain
          ? gt("Changing thread history trimming needs maintenance access to this environment.")
          : managed
      }
    >
      <SettingsSwitchRow
        icon="clock"
        label={gt("Trim old threads")}
        subtitle={gt(
          "After this many days without use, a thread's finished tool output and reasoning are deleted to save space. Messages, plans, file changes and attachments stay, and you can still search and continue the thread. Running, pinned and snoozed threads and threads with an open pull request are skipped.",
        )}
        value={days === "mixed" ? null : days !== null}
        disabled={!canChange && !canTurnOff}
        onValueChange={(on) => {
          if (!on) saveDays(null);
          else if (canChange) saveDays(SUGGESTED_THREAD_HISTORY_AFTER_DAYS);
        }}
      />
      {typeof days === "number" ? (
        <View className="flex-row items-center gap-4 border-t border-border-subtle px-4 py-4 android:min-h-14 android:py-3">
          <View className="w-[22px] android:w-6" />
          <Text className="flex-1 text-foreground text-lg android:text-base">
            {gt("Days without use")}
          </Text>
          <NumberField
            value={days}
            min={MIN_DAYS}
            max={MAX_DAYS}
            disabled={!canChange}
            label={gt("Days without use")}
            formatValue={(value) =>
              gt("{count, plural, one {{count} day} other {{count} days}}", { count: value })
            }
            onValueChange={saveDays}
          />
        </View>
      ) : null}
      <View className="border-t border-border-subtle">
        <SettingsActionRow
          icon="trash"
          label={
            pending === "preview"
              ? gt("Checking…")
              : pending === "trim"
                ? gt("Trimming…")
                : gt("Trim now")
          }
          description={[
            gt("Shows how many threads qualify, then deletes their old output once you confirm."),
            ...schedule,
          ].join("\n")}
          disabled={pending !== null || runnable.length === 0}
          loading={pending !== null}
          onPress={() => void checkTrim()}
        />
      </View>
    </SettingsSection>
  );
}
