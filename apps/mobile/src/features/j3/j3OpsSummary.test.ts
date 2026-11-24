import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { summarizeJ3Operations } from "./j3OpsSummary";

const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;

function makeConfig(fallbackOnError: boolean, chainLength: number): ServerConfig {
  return {
    settings: {
      providerFallbackOnError: fallbackOnError,
      providerFallbackChain: Array.from({ length: chainLength }, (_, index) => ({
        instanceId: `provider-${index}`,
        model: `model-${index}`,
      })),
    },
  } as unknown as ServerConfig;
}

describe("summarizeJ3Operations", () => {
  it("counts active, attention, failed threads and ignores idle or archived threads", () => {
    const configs = new Map<EnvironmentId, ServerConfig | null>([
      [ENV_A, makeConfig(true, 2)],
      [ENV_B, makeConfig(false, 4)],
    ]);

    const summary = summarizeJ3Operations({
      threads: [
        {
          environmentId: ENV_A,
          archivedAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          pendingGuestMessageCount: 0,
          runtime: { status: "running" } as never,
          blockedOnThreadWait: false,
        },
        {
          environmentId: ENV_A,
          archivedAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          pendingGuestMessageCount: 0,
          runtime: { status: "running" } as never,
          blockedOnThreadWait: true,
        },
        {
          // Idle threads must not be counted as working.
          environmentId: ENV_A,
          archivedAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          pendingGuestMessageCount: 0,
          runtime: { status: "idle" } as never,
          blockedOnThreadWait: false,
        },
        {
          environmentId: ENV_A,
          archivedAt: null,
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          pendingGuestMessageCount: 0,
          runtime: { status: "running" } as never,
          blockedOnThreadWait: false,
        },
        {
          environmentId: ENV_B,
          archivedAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          pendingGuestMessageCount: 0,
          runtime: { status: "failed", lastErrorClass: "provider_error" } as never,
          blockedOnThreadWait: false,
        },
        {
          environmentId: ENV_A,
          archivedAt: "2026-11-24T00:00:00.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          pendingGuestMessageCount: 0,
          runtime: { status: "running" } as never,
          blockedOnThreadWait: false,
        },
      ],
      serverConfigsByEnvironment: configs,
      selectedEnvironmentId: null,
    });

    expect(summary).toEqual({
      workingCount: 2,
      attentionCount: 1,
      failedCount: 1,
      environmentCount: 2,
      fallbackEnabledCount: 1,
      // ENV_B has fallback disabled so its 4-item chain must not leak into fallbackChainMaxCount.
      fallbackChainMaxCount: 2,
    });
  });

  it("scopes counts to the selected environment", () => {
    const configs = new Map<EnvironmentId, ServerConfig | null>([
      [ENV_A, makeConfig(true, 1)],
      [ENV_B, makeConfig(false, 3)],
    ]);

    const summary = summarizeJ3Operations({
      threads: [
        {
          environmentId: ENV_A,
          archivedAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          pendingGuestMessageCount: 0,
          runtime: { status: "running" } as never,
          blockedOnThreadWait: false,
        },
        {
          environmentId: ENV_B,
          archivedAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          pendingSubagentRequest: null,
          pendingGuestMessageCount: 0,
          runtime: { status: "failed", lastErrorClass: "usage_limit" } as never,
          blockedOnThreadWait: false,
        },
      ],
      serverConfigsByEnvironment: configs,
      selectedEnvironmentId: ENV_B,
    });

    expect(summary).toEqual({
      workingCount: 0,
      attentionCount: 0,
      failedCount: 1,
      environmentCount: 1,
      fallbackEnabledCount: 0,
      fallbackChainMaxCount: 0,
    });
  });
});
