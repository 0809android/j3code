import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import type * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { makeUpdatePauseController } from "./updatePauseController.ts";

const summary = {
  terminalizedRuns: 1,
  stoppedSessions: 1,
  closedRequests: 0,
  retiredEffects: 0,
  requeuedEffects: 0,
};

const setupWith = Effect.fn("test.setup")(function* (options: { readonly ready: boolean }) {
  const gate = yield* ServerRuntimeStartup.makeCommandGate;
  if (options.ready) {
    yield* gate.signalCommandReady;
  }
  const calls: Array<string> = [];
  let dispatchPaused = false;
  const record = (call: string) => Effect.sync(() => void calls.push(call));
  const controller = yield* makeUpdatePauseController({
    closeCommands: gate.closeCommands(
      new ServerRuntimeStartup.ServerRuntimeStartupError({
        mode: "web",
        host: null,
        port: 3773,
        cause: "pausing",
      }),
    ),
    reopenCommands: gate.reopenCommands,
    stopEffectWorker: record("stop worker"),
    startEffectWorker: record("start worker"),
    recovery: {
      prepareForUpdate: Effect.succeed([
        {} as ProviderRuntimeRecovery.RunningProviderTurn,
        {} as ProviderRuntimeRecovery.RunningProviderTurn,
      ]),
      reconcile: (trigger, options) =>
        record(`reconcile ${trigger} ${options?.update}`).pipe(Effect.as(summary)),
    },
    sessions: {
      interruptForShutdown: (turns) => record(`interrupt ${turns.length}`),
      shutdown: record("release sessions"),
      resumeEventIngestion: record("ingest events"),
      pauseDispatch: Effect.sync(() => {
        dispatchPaused = true;
        calls.push("pause dispatch");
      }),
      resumeDispatch: Effect.sync(() => {
        dispatchPaused = false;
        calls.push("resume dispatch");
      }),
    },
  });
  const commandAccepted = Effect.exit(gate.enqueueCommand(Effect.void)).pipe(
    Effect.map(Exit.isSuccess),
  );
  const dispatchOpen = Effect.sync(() => !dispatchPaused);
  return { controller, calls, commandAccepted, dispatchOpen, gate };
});

const setup = setupWith({ ready: true });

const PAUSE = ["stop worker", "pause dispatch", "interrupt 2"];
const UNPAUSE = [
  "release sessions",
  "ingest events",
  "reconcile shutdown not-installed",
  "resume dispatch",
  "start worker",
];

it.effect("un-pauses once at the deadline when no restart follows the pause", () =>
  Effect.gen(function* () {
    const { controller, calls, commandAccepted, dispatchOpen } = yield* setup;
    assert.isTrue(yield* dispatchOpen);
    assert.deepEqual(yield* controller.pauseRunsForUpdate, { pausedRuns: 2 });
    assert.deepEqual(yield* controller.pauseRunsForUpdate, { pausedRuns: 2 });
    assert.isFalse(yield* commandAccepted);
    assert.isFalse(yield* dispatchOpen);

    yield* TestClock.adjust("119 seconds");
    assert.deepEqual(calls, PAUSE);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(calls, [...PAUSE, ...UNPAUSE]);
    assert.isTrue(yield* commandAccepted);
    assert.isTrue(yield* dispatchOpen);

    yield* controller.resumeRunsAfterUpdate;
    yield* TestClock.adjust("10 minutes");
    assert.deepEqual(calls, [...PAUSE, ...UNPAUSE]);
  }),
);

it.effect("un-pauses at once when the updater reports a failed install", () =>
  Effect.gen(function* () {
    const { controller, calls, commandAccepted } = yield* setup;
    yield* controller.pauseRunsForUpdate;
    yield* controller.resumeRunsAfterUpdate;
    assert.deepEqual(calls, [...PAUSE, ...UNPAUSE]);
    assert.isTrue(yield* commandAccepted);

    yield* TestClock.adjust("10 minutes");
    assert.deepEqual(calls, [...PAUSE, ...UNPAUSE]);
    assert.deepEqual(yield* controller.pauseRunsForUpdate, { pausedRuns: 2 });
    assert.deepEqual(calls, [...PAUSE, ...UNPAUSE, ...PAUSE]);
  }),
);

it.effect("keeps the pause when the update stops the server", () =>
  Effect.gen(function* () {
    const { controller, calls } = yield* setup;
    yield* controller.pauseRunsForUpdate;
    assert.isTrue(yield* controller.beginShutdown);
    yield* TestClock.adjust("10 minutes");
    yield* controller.resumeRunsAfterUpdate;
    assert.deepEqual(calls, PAUSE);
  }),
);

it.effect("does not pause while startup has not signalled command readiness", () =>
  Effect.gen(function* () {
    const { controller, calls, gate, dispatchOpen } = yield* setupWith({ ready: false });
    const queued = yield* gate.enqueueCommand(Effect.succeed("ran")).pipe(Effect.forkScoped);

    assert.deepEqual(yield* controller.pauseRunsForUpdate, { pausedRuns: 0 });
    assert.deepEqual(calls, []);
    assert.isTrue(yield* dispatchOpen);

    // Startup finishing afterwards admits the command; no deadline un-pause is left behind.
    yield* gate.signalCommandReady;
    assert.equal(yield* Fiber.join(queued), "ran");
    yield* TestClock.adjust("10 minutes");
    assert.deepEqual(calls, []);
    assert.isTrue(
      yield* Effect.exit(gate.enqueueCommand(Effect.void)).pipe(Effect.map(Exit.isSuccess)),
    );
  }),
);
