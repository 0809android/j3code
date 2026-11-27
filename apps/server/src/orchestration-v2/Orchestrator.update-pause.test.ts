import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for update pause dispatch"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "update-pause" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${threadId}`),
  threadId,
  projectId: ProjectId.make("project:update-pause"),
  title: threadId,
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
});

const rejectionTag = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Cause.findErrorOption(exit.cause);
  return error._tag === "Some" ? (error.value as { readonly _tag: string })._tag : undefined;
};

it.effect("refuses server-internal sends while paused for an update, and accepts them after", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const existing = ThreadId.make("thread:update-pause-existing");
    const scheduled = ThreadId.make("thread:update-pause-scheduled");
    yield* orchestrator.dispatch(createThread(existing));

    yield* sessions.pauseDispatch;
    const message = {
      type: "message.dispatch" as const,
      commandId: CommandId.make("send:update-pause"),
      threadId: existing,
      messageId: MessageId.make("send:update-pause"),
      text: "Scheduled prompt",
      attachments: [],
      dispatchMode: { type: "start_immediately" as const },
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
    };
    assert.equal(
      rejectionTag(yield* Effect.exit(orchestrator.dispatch(message))),
      "OrchestratorCommandRejectedError",
    );
    assert.equal(
      rejectionTag(yield* Effect.exit(orchestrator.dispatch(createThread(scheduled)))),
      "OrchestratorCommandRejectedError",
    );
    // Refused before commit: no run started and no thread appeared.
    assert.equal((yield* projections.getThreadProjection(existing)).runs.length, 0);
    assert.isNull(yield* projections.getThreadShell(scheduled));

    // Stopping work is never held back by the pause.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("metadata:update-pause"),
      threadId: existing,
      title: "Renamed while paused",
    });

    yield* sessions.resumeDispatch;
    // The same command ids go through now: the refusal left no receipt behind.
    yield* orchestrator.dispatch(message);
    yield* orchestrator.dispatch(createThread(scheduled));
    assert.equal((yield* projections.getThreadProjection(existing)).runs.length, 1);
    assert.isNotNull(yield* projections.getThreadShell(scheduled));
  }).pipe(Effect.provide(layerTest)),
);
