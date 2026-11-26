import { type EnvironmentId, isListedThreadLineage, type ThreadId } from "@t3tools/contracts";
import { type AgentAwarenessPhase, projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import type { NotifyKind } from "@t3tools/shared/notify";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import type { AgentAwarenessThread } from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  makeAgentAwarenessPublishWorker,
  shouldPublishAgentAwarenessEvent,
  snoozedCompletion,
} from "../AgentAwarenessRelay.ts";
import * as RelayNotifier from "./RelayNotifier.ts";

/** A run can end moments before its continuation starts; a completion must hold this long. */
const COMPLETION_CONFIRM_MS = 5_000;

type AlertKind = Exclude<NotifyKind, "test" | "device">;

export const notifyKindOfPhase = (phase: AgentAwarenessPhase): AlertKind | null => {
  switch (phase) {
    case "waiting_for_approval":
      return "approval";
    case "waiting_for_input":
      return "input";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return null;
  }
};

/** One alert per request or per run: the same wait seen twice is one notification. */
export const alertKeyOf = (kind: AlertKind, thread: AgentAwarenessThread): string =>
  kind === "approval" || kind === "input"
    ? `${kind}:${thread.pendingRuntimeRequest?.id ?? DateTime.formatIso(thread.updatedAt)}`
    : `${kind}:${thread.latestRunId ?? ""}`;

/**
 * Turns thread events into K3 relay notifications: approval or input needed, a run completed or
 * failed. Top-level threads only, once per request or run, completions confirmed after a short
 * hold, snoozed completions silent, and nothing for work that ended before this server started.
 */
export class RelayNotifyWatcher extends Context.Service<
  RelayNotifyWatcher,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly evaluate: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/relay/k3relay/RelayNotifyWatcher") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const notifier = yield* RelayNotifier.RelayNotifier;
  const environmentId: EnvironmentId = yield* (yield* ServerEnvironment.ServerEnvironment)
    .getEnvironmentId;
  const startedAt = yield* Clock.currentTimeMillis;
  const alerted = new Map<ThreadId, string>();
  const pendingCompletion = new Map<ThreadId, { readonly key: string; readonly due: number }>();
  let enqueue: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  const evaluateUnsafe = Effect.fn("RelayNotifyWatcher.evaluate")(function* (threadId: ThreadId) {
    const snapshot = yield* threads.getAgentAwarenessSnapshot(threadId);
    const thread = snapshot.threads[0] ?? null;
    if (thread === null || thread.archivedAt !== null || !isListedThreadLineage(thread.lineage)) {
      alerted.delete(threadId);
      pendingCompletion.delete(threadId);
      return;
    }
    const project = yield* projects.getById(thread.projectId);
    if (Option.isNone(project)) return;
    const state = projectThreadAwarenessV2({ environmentId, project: project.value, thread });
    const kind = state === null ? null : notifyKindOfPhase(state.phase);
    if (kind === null || (kind === "completed" && snoozedCompletion(thread, state))) {
      if (kind === null) alerted.delete(threadId);
      pendingCompletion.delete(threadId);
      return;
    }
    const key = alertKeyOf(kind, thread);
    if (alerted.get(threadId) === key) return;
    if (
      (kind === "completed" || kind === "failed") &&
      (thread.latestRunCompletedAt == null ||
        DateTime.toEpochMillis(thread.latestRunCompletedAt) <= startedAt)
    ) {
      // Ended before this server started: already told, or too late to matter.
      alerted.set(threadId, key);
      return;
    }
    if (kind === "completed") {
      const now = yield* Clock.currentTimeMillis;
      const pending = pendingCompletion.get(threadId);
      if (pending === undefined || pending.key !== key) {
        pendingCompletion.set(threadId, { key, due: now + COMPLETION_CONFIRM_MS });
        yield* Effect.sleep(COMPLETION_CONFIRM_MS).pipe(
          Effect.andThen(Effect.suspend(() => enqueue(threadId))),
          Effect.forkDetach,
        );
        return;
      }
      if (now < pending.due) return;
    }
    pendingCompletion.delete(threadId);
    alerted.set(threadId, key);
    yield* notifier.notify({ kind, threadId });
  });

  const evaluate = (threadId: ThreadId) =>
    evaluateUnsafe(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("K3 relay notification check failed", { threadId, cause }),
      ),
    );

  const worker = yield* makeAgentAwarenessPublishWorker(evaluate);
  enqueue = worker.enqueue;

  const start = forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) =>
      shouldPublishAgentAwarenessEvent(event) ? worker.enqueue(event.threadId) : Effect.void,
    ),
  );

  return RelayNotifyWatcher.of({
    start,
    evaluate: Effect.fn("RelayNotifyWatcher.evaluateNow")(function* (threadId: ThreadId) {
      yield* evaluate(threadId);
      yield* worker.drain;
    }),
  });
});

export const layer = Layer.effect(RelayNotifyWatcher, make);
