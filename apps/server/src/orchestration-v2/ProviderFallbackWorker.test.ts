import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderFallbackWorker from "./ProviderFallbackWorker.ts";
import {
  MAX_PROVIDER_FALLBACK_AGE_MS,
  isFallbackEligibleErrorClass,
  providerFallbackCommand,
  selectProviderFallbackTarget,
  type ProviderFallbackPreferences,
} from "./ProviderFallbackWorker.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const claudeSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const codexSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const mistralSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("mistral"),
  model: "devstral-medium-latest",
};

const nowMs = Date.parse("2026-11-24T00:00:00.000Z");

const basePreferences = (
  overrides: Partial<ProviderFallbackPreferences> = {},
): ProviderFallbackPreferences => ({
  providerFallbackOnError: true,
  providerFallbackChain: [codexSelection, mistralSelection],
  providerFallbackErrorClasses: DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES,
  providerFallbackMaxAttempts: 2,
  fallbackModelSelection: null,
  providerInstances: {
    [ProviderInstanceId.make("claudeAgent")]: {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
    },
    [ProviderInstanceId.make("codex")]: {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
    },
    [ProviderInstanceId.make("mistral")]: {
      driver: ProviderDriverKind.make("openai-compatible"),
      enabled: true,
    },
  },
  projectSettingsOverrides: {},
  ...overrides,
});

const failedCandidate = (
  overrides: Partial<ProjectionStore.ProjectionProviderFallbackCandidate> = {},
): ProjectionStore.ProjectionProviderFallbackCandidate => {
  const failedAt = DateTime.makeUnsafe(nowMs - 5_000);
  return {
    id: ThreadId.make("thread:fallback"),
    projectId: ProjectId.make("project:default"),
    status: "failed",
    modelSelection: claudeSelection,
    lastErrorClass: "provider_error",
    lastError: "Upstream 503",
    latestRunId: RunId.make("run:failed-1"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    recentFailedSelections: [claudeSelection],
    consecutiveFallbackAttempts: 0,
    ...overrides,
  };
};

describe("ProviderFallbackWorker selection and command logic", () => {
  it("never falls back on validation_error or permission_error", () => {
    assert.isFalse(
      isFallbackEligibleErrorClass("validation_error", DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES),
    );
    assert.isFalse(
      isFallbackEligibleErrorClass("permission_error", DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES),
    );
    assert.isTrue(
      isFallbackEligibleErrorClass("usage_limit", DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES),
    );
    assert.isTrue(
      isFallbackEligibleErrorClass("transport_error", DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES),
    );
    assert.isTrue(isFallbackEligibleErrorClass(null, DEFAULT_PROVIDER_FALLBACK_ERROR_CLASSES));
  });

  it("picks the first enabled secondary model that has not already failed", () => {
    const first = selectProviderFallbackTarget(failedCandidate(), basePreferences());
    assert.deepStrictEqual(first, codexSelection);

    const second = selectProviderFallbackTarget(
      failedCandidate({
        modelSelection: codexSelection,
        recentFailedSelections: [codexSelection, claudeSelection],
      }),
      basePreferences(),
    );
    assert.deepStrictEqual(second, mistralSelection);
  });

  it("skips disabled provider instances and falls back to fallbackModelSelection", () => {
    const target = selectProviderFallbackTarget(
      failedCandidate(),
      basePreferences({
        providerFallbackChain: [codexSelection],
        fallbackModelSelection: mistralSelection,
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
          },
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
          },
          [ProviderInstanceId.make("mistral")]: {
            driver: ProviderDriverKind.make("openai-compatible"),
            enabled: true,
          },
        },
      }),
    );
    assert.deepStrictEqual(target, mistralSelection);
  });

  it("builds an idempotent message.dispatch command targeting the secondary model", () => {
    const command = providerFallbackCommand(failedCandidate(), basePreferences(), nowMs);
    assert.isNotNull(command);
    assert.equal(command?.type, "message.dispatch");
    if (command?.type === "message.dispatch") {
      assert.deepStrictEqual(command.modelSelection, codexSelection);
      assert.equal(command.commandId, "provider-fallback:thread:fallback:run:failed-1");
      assert.equal(command.messageId, "provider-fallback:thread:fallback:run:failed-1");
      assert.equal(command.dispatchMode.type, "start_immediately");
    }
  });

  it("stops once consecutiveFallbackAttempts reaches providerFallbackMaxAttempts", () => {
    const command = providerFallbackCommand(
      failedCandidate({ consecutiveFallbackAttempts: 2 }),
      basePreferences({ providerFallbackMaxAttempts: 2 }),
      nowMs,
    );
    assert.isNull(command);
  });

  it("ignores failures older than MAX_PROVIDER_FALLBACK_AGE_MS", () => {
    const oldAt = DateTime.makeUnsafe(nowMs - MAX_PROVIDER_FALLBACK_AGE_MS - 1_000);
    const command = providerFallbackCommand(
      failedCandidate({ latestRunCompletedAt: oldAt, updatedAt: oldAt }),
      basePreferences(),
      nowMs,
    );
    assert.isNull(command);
  });

  it("returns null when providerFallbackOnError is disabled", () => {
    const command = providerFallbackCommand(
      failedCandidate(),
      basePreferences({ providerFallbackOnError: false }),
      nowMs,
    );
    assert.isNull(command);
  });
});

it.effect("dispatches fallback on failed run events and skips idle sweeps", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const queries = yield* Queue.unbounded<number>();
    const dispatched = yield* Queue.unbounded<string>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    let candidateReady = false;
    const layer = ProviderFallbackWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getProviderFallbackCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((t) => Queue.offer(queries, t - nowMs)),
                Effect.map(() => (candidateReady ? [failedCandidate()] : [])),
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Queue.offer(dispatched, command.commandId).pipe(Effect.as({} as never)),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(basePreferences() as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      yield* TestClock.adjust("30 seconds");
      candidateReady = true;
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* Queue.take(queries), 35_000);
      assert.equal(yield* Queue.take(dispatched), "provider-fallback:thread:fallback:run:failed-1");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "retries after backoff when dispatch fails transiently instead of blacklisting the run",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const dispatched = yield* Queue.unbounded<string>();
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      let dispatchCount = 0;
      const layer = ProviderFallbackWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getProviderFallbackCandidates: () => Effect.succeed([failedCandidate()]),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) => {
                dispatchCount += 1;
                if (dispatchCount === 1) {
                  return Effect.fail(new Error("transient lock") as never);
                }
                return Queue.offer(dispatched, command.commandId).pipe(Effect.as({} as never));
              },
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed(basePreferences() as never),
              streamChanges: Stream.never,
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* TestClock.adjust("20 seconds");
        assert.equal(
          yield* Queue.take(dispatched),
          "provider-fallback:thread:fallback:run:failed-1",
        );
        assert.equal(dispatchCount, 2);
      }).pipe(Effect.provide(layer));
    }),
);
