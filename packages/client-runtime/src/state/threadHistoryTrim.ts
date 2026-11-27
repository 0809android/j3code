import type {
  EnvironmentId,
  ServerSettingsPatch,
  ThreadHistoryTrimReport,
  ThreadHistoryTrimStatus,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** Names the last and next pass, or says none has run or that the next one is due. */
export function describeThreadHistoryTrimSchedule(input: {
  readonly status: ThreadHistoryTrimStatus;
  readonly nowMs: number;
  readonly formatDate: (iso: string) => string;
  readonly resolve?: MFunctionType;
}): string {
  const resolve = input.resolve ?? mFallback;
  const { lastTrimmedAt, nextTrimAt } = input.status;
  if (lastTrimmedAt === null || nextTrimAt === null) {
    return resolve(
      msg("Not trimmed yet. The first pass runs a few minutes after the server starts."),
    );
  }
  const last = input.formatDate(lastTrimmedAt);
  if (Date.parse(nextTrimAt) <= input.nowMs) {
    return resolve(msg("Last trimmed {last}. The next pass is due.", { last }));
  }
  return resolve(
    msg("Last trimmed {last}. Next pass {next}.", { last, next: input.formatDate(nextTrimAt) }),
  );
}

export function sumThreadHistoryTrimReports(reports: ReadonlyArray<ThreadHistoryTrimReport>) {
  return {
    threadCount: reports.reduce((sum, report) => sum + report.threadCount, 0),
    estimatedBytes: reports.reduce((sum, report) => sum + report.estimatedBytes, 0),
  };
}

/** The days every environment shares (null when all are off), or "mixed" when they differ. */
export function uniformThreadHistoryAfterDays(
  values: ReadonlyArray<number | null>,
): number | null | "mixed" {
  const [first = null] = values;
  return values.every((value) => value === first) ? first : "mixed";
}

export function planThreadHistoryAfterDaysWrites(
  environmentIds: ReadonlyArray<EnvironmentId>,
  days: number | null,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly patch: ServerSettingsPatch }> {
  return environmentIds.map((environmentId) => ({
    environmentId,
    patch: { storageCleanup: { threadHistoryAfterDays: days } },
  }));
}
