import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import { resolveThreadListV2Status } from "../threads/threadListV2";

export interface J3OpsSummary {
  readonly workingCount: number;
  readonly attentionCount: number;
  readonly failedCount: number;
  readonly environmentCount: number;
  readonly fallbackEnabledCount: number;
  readonly fallbackChainMaxCount: number;
}

export function summarizeJ3Operations(input: {
  readonly threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      | "environmentId"
      | "archivedAt"
      | "hasPendingApprovals"
      | "hasPendingUserInput"
      | "pendingSubagentRequest"
      | "pendingGuestMessageCount"
      | "runtime"
      | "blockedOnThreadWait"
    >
  >;
  readonly serverConfigsByEnvironment: ReadonlyMap<EnvironmentId, ServerConfig | null>;
  readonly selectedEnvironmentId: EnvironmentId | null;
}): J3OpsSummary {
  let workingCount = 0;
  let attentionCount = 0;
  let failedCount = 0;

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    if (
      input.selectedEnvironmentId !== null &&
      thread.environmentId !== input.selectedEnvironmentId
    ) {
      continue;
    }

    const status = resolveThreadListV2Status(thread);
    switch (status) {
      case "working":
        workingCount += 1;
        break;
      case "waiting":
        // resolveThreadListV2Status maps both `runtime.status === "idle"` and
        // `runtime.status === "running" && blockedOnThreadWait === true` to "waiting".
        // Only count genuinely running threads waiting on child work as working.
        if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
          workingCount += 1;
        }
        break;
      case "approval":
      case "input":
      case "request":
        attentionCount += 1;
        break;
      case "failed":
      case "limited":
        failedCount += 1;
        break;
      case "ready":
        break;
    }
  }

  let environmentCount = 0;
  let fallbackEnabledCount = 0;
  let fallbackChainMaxCount = 0;

  for (const [environmentId, config] of input.serverConfigsByEnvironment.entries()) {
    if (config === null) continue;
    if (input.selectedEnvironmentId !== null && environmentId !== input.selectedEnvironmentId) {
      continue;
    }
    environmentCount += 1;
    if (config.settings.providerFallbackOnError) {
      fallbackEnabledCount += 1;
      const chainLen = config.settings.providerFallbackChain.length;
      if (chainLen > fallbackChainMaxCount) {
        fallbackChainMaxCount = chainLen;
      }
    }
  }

  return {
    workingCount,
    attentionCount,
    failedCount,
    environmentCount,
    fallbackEnabledCount,
    fallbackChainMaxCount,
  };
}
