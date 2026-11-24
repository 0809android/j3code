import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailureClass,
  type ProviderFallbackErrorClass,
  type ServerSettings,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const PROVIDER_FALLBACK_MESSAGE_PREFIX = "provider-fallback:";
/** Only auto-fallback failures that happened recently, so enabling the setting does not revive old threads. */
export const MAX_PROVIDER_FALLBACK_AGE_MS = 10 * 60 * 1000;
const MAX_TRACKED_ATTEMPTS = 500;

const BLOCKED_FALLBACK_ERROR_CLASSES: ReadonlySet<OrchestrationV2ProviderFailureClass> = new Set([
  "validation_error",
  "permission_error",
]);

function selectionKey(selection: Pick<ModelSelection, "instanceId" | "model">): string {
  return `${selection.instanceId}\0${selection.model}`;
}

export function isFallbackEligibleErrorClass(
  errorClass: OrchestrationV2ProviderFailureClass | null | undefined,
  configuredClasses: ReadonlyArray<ProviderFallbackErrorClass>,
): boolean {
  const effective: OrchestrationV2ProviderFailureClass = errorClass ?? "unknown";
  if (BLOCKED_FALLBACK_ERROR_CLASSES.has(effective)) {
    return false;
  }
  return configuredClasses.includes(effective as ProviderFallbackErrorClass);
}

export type ProviderFallbackPreferences = Pick<
  ServerSettings,
  | "providerFallbackOnError"
  | "providerFallbackChain"
  | "providerFallbackErrorClasses"
  | "providerFallbackMaxAttempts"
  | "fallbackModelSelection"
  | "providerInstances"
  | "projectSettingsOverrides"
>;

export function selectProviderFallbackTarget(
  candidate: Pick<
    ProjectionStore.ProjectionProviderFallbackCandidate,
    "projectId" | "modelSelection" | "recentFailedSelections"
  >,
  preferences: Pick<
    ProviderFallbackPreferences,
    | "providerFallbackChain"
    | "fallbackModelSelection"
    | "providerInstances"
    | "projectSettingsOverrides"
  >,
): ModelSelection | null {
  const ordered: ReadonlyArray<ModelSelection> = [
    ...preferences.providerFallbackChain,
    ...(preferences.fallbackModelSelection !== null ? [preferences.fallbackModelSelection] : []),
  ];
  if (ordered.length === 0) return null;

  const failedKeys = new Set<string>([
    selectionKey(candidate.modelSelection),
    ...candidate.recentFailedSelections.map(selectionKey),
  ]);
  const seenCandidates = new Set<string>();

  for (const target of ordered) {
    const key = selectionKey(target);
    if (seenCandidates.has(key) || failedKeys.has(key)) continue;
    seenCandidates.add(key);
    if (
      !resolveProjectProviderInstanceEnabled(preferences, candidate.projectId, target.instanceId)
    ) {
      continue;
    }
    return target;
  }
  return null;
}

export function providerFallbackCommand(
  candidate: ProjectionStore.ProjectionProviderFallbackCandidate,
  preferences: ProviderFallbackPreferences,
  nowMs: number,
): OrchestrationV2Command | null {
  if (
    !preferences.providerFallbackOnError ||
    candidate.status !== "failed" ||
    candidate.archivedAt !== null ||
    candidate.settledOverride === "settled" ||
    candidate.pendingRuntimeRequest !== null
  ) {
    return null;
  }
  if (candidate.consecutiveFallbackAttempts >= preferences.providerFallbackMaxAttempts) {
    return null;
  }
  if (
    !isFallbackEligibleErrorClass(
      candidate.lastErrorClass,
      preferences.providerFallbackErrorClasses,
    )
  ) {
    return null;
  }
  const failedAtMs = DateTime.toEpochMillis(candidate.latestRunCompletedAt ?? candidate.updatedAt);
  if (nowMs - failedAtMs > MAX_PROVIDER_FALLBACK_AGE_MS) {
    return null;
  }
  const target = selectProviderFallbackTarget(candidate, preferences);
  if (target === null) {
    return null;
  }
  const identity = `${candidate.id}:${candidate.latestRunId}`;
  const reasonLabel = candidate.lastErrorClass ?? "unknown";
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`${PROVIDER_FALLBACK_MESSAGE_PREFIX}${identity}`),
    messageId: MessageId.make(`${PROVIDER_FALLBACK_MESSAGE_PREFIX}${identity}`),
    threadId: candidate.id,
    modelSelection: target,
    text: `The previous provider (${candidate.modelSelection.instanceId}/${candidate.modelSelection.model}) failed (${reasonLabel}). Continue the interrupted task from where it stopped.`,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

const affectsProviderFallback = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const DISPATCH_RETRY_BACKOFF_MS = 15_000;

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const due = DueHint.make();
  const attemptedRuns = new Set<string>();

  const rememberAttempt = (key: string) => {
    attemptedRuns.add(key);
    if (attemptedRuns.size > MAX_TRACKED_ATTEMPTS) {
      const oldest = attemptedRuns.values().next().value;
      if (oldest !== undefined) attemptedRuns.delete(oldest);
    }
  };

  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsProviderFallback(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));

  return Effect.fn("ProviderFallbackWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    if (!preferences.providerFallbackOnError) {
      yield* due.record(readVersion, Infinity, nowMs);
      return;
    }
    const since = DateTime.makeUnsafe(Math.max(0, nowMs - MAX_PROVIDER_FALLBACK_AGE_MS));
    const candidates = yield* projections.getProviderFallbackCandidates({
      since,
      errorClasses: preferences.providerFallbackErrorClasses,
    });
    let acted = false;
    let retryAtMs = Infinity;
    for (const candidate of candidates) {
      const attemptKey = `${candidate.id}:${candidate.latestRunId}`;
      if (attemptedRuns.has(attemptKey)) continue;
      const command = providerFallbackCommand(candidate, preferences, nowMs);
      if (command === null) continue;
      yield* threads.dispatch(command).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            acted = true;
            rememberAttempt(attemptKey);
          }).pipe(
            Effect.andThen(
              Effect.logInfo("orchestration-v2.provider-fallback.dispatched", {
                threadId: candidate.id,
                failedRunId: candidate.latestRunId,
                from: candidate.modelSelection,
                to: command.type === "message.dispatch" ? command.modelSelection : undefined,
                errorClass: candidate.lastErrorClass,
              }),
            ),
          ),
        ),
        Effect.catchCause((cause) => {
          retryAtMs = Math.min(retryAtMs, nowMs + DISPATCH_RETRY_BACKOFF_MS);
          return Effect.logWarning("orchestration-v2.provider-fallback.dispatch-failed", {
            threadId: candidate.id,
            failedRunId: candidate.latestRunId,
            cause,
          });
        }),
      );
    }
    if (acted) return;
    yield* due.record(readVersion, retryAtMs, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("provider-fallback", sweep());
  }),
);
