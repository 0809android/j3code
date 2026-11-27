import type { EnvironmentId, ThreadHistoryTrimReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeThreadHistoryTrimSchedule,
  planThreadHistoryAfterDaysWrites,
  sumThreadHistoryTrimReports,
  uniformThreadHistoryAfterDays,
} from "./threadHistoryTrim.ts";

const formatDate = (iso: string) => iso.slice(0, 10);
const NOW = Date.parse("2026-11-27T00:00:00.000Z");

describe("describeThreadHistoryTrimSchedule", () => {
  it("says no pass has run until both times are known", () => {
    expect(
      describeThreadHistoryTrimSchedule({
        status: { lastTrimmedAt: null, nextTrimAt: null },
        nowMs: NOW,
        formatDate,
      }),
    ).toBe(
      "Not trimmed yet. The first pass runs a few minutes after you turn trimming on, or after the server starts if it is already on.",
    );
  });

  it("names the next pass, and says when it is due", () => {
    const status = {
      lastTrimmedAt: "2026-10-28T00:00:00.000Z",
      nextTrimAt: "2026-11-27T00:00:01.000Z",
    };
    expect(describeThreadHistoryTrimSchedule({ status, nowMs: NOW, formatDate })).toBe(
      "Last trimmed 2026-10-28. Next pass 2026-11-27.",
    );
    expect(describeThreadHistoryTrimSchedule({ status, nowMs: NOW + 1_000, formatDate })).toBe(
      "Last trimmed 2026-10-28. The next pass is due.",
    );
  });
});

describe("sumThreadHistoryTrimReports", () => {
  it("adds thread counts and sizes across environments", () => {
    const report = (threadCount: number, estimatedBytes: number): ThreadHistoryTrimReport => ({
      dryRun: true,
      afterDays: 30,
      threadCount,
      itemCount: 0,
      estimatedBytes,
    });
    expect(sumThreadHistoryTrimReports([report(2, 100), report(3, 50)])).toEqual({
      threadCount: 5,
      estimatedBytes: 150,
    });
    expect(sumThreadHistoryTrimReports([])).toEqual({ threadCount: 0, estimatedBytes: 0 });
  });
});

describe("uniformThreadHistoryAfterDays", () => {
  it("returns the shared value, or mixed when environments differ", () => {
    expect(uniformThreadHistoryAfterDays([])).toBeNull();
    expect(uniformThreadHistoryAfterDays([null, null])).toBeNull();
    expect(uniformThreadHistoryAfterDays([30, 30])).toBe(30);
    expect(uniformThreadHistoryAfterDays([30, null])).toBe("mixed");
    expect(uniformThreadHistoryAfterDays([30, 7])).toBe("mixed");
  });
});

describe("planThreadHistoryAfterDaysWrites", () => {
  it("writes the days, or null to turn trimming off, to each environment", () => {
    const ids = ["a", "b"] as EnvironmentId[];
    expect(planThreadHistoryAfterDaysWrites(ids, 30)).toEqual([
      { environmentId: "a", patch: { storageCleanup: { threadHistoryAfterDays: 30 } } },
      { environmentId: "b", patch: { storageCleanup: { threadHistoryAfterDays: 30 } } },
    ]);
    expect(planThreadHistoryAfterDaysWrites(ids.slice(0, 1), null)).toEqual([
      { environmentId: "a", patch: { storageCleanup: { threadHistoryAfterDays: null } } },
    ]);
  });
});
