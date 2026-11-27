import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandAvailability, WindowsShellEnvironment } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Observe the existing synchronous shell probe without launching the user's login shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import { assert, it, vi } from "vite-plus/test";

import {
  BACKGROUND_LOGIN_SHELL_TIMEOUT,
  fixPath,
  hydratePosixHome,
  refreshPathFromLoginShell,
  refreshWindowsPath,
} from "./os-jank.ts";

vi.mock("node:child_process", { spy: true });

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

effectIt.effect("hydrates PATH when the desktop handoff is absent", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue("__K3CODE_ENV_PATH_START__\n/opt/tools/bin\n__K3CODE_ENV_PATH_END__\n"),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(probe.mock.calls.length, 1);
        assert.equal(probe.mock.calls[0]?.[1]?.[0], "-ilc");
        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

const timedOut = (file: string) =>
  Object.assign(new Error(`spawnSync ${file} ETIMEDOUT`), { code: "ETIMEDOUT" });

effectIt.effect("waits longer for a login shell that times out at startup", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi.spyOn(NodeChildProcess, "execFileSync").mockImplementation((file, _args, options) => {
        // This profile takes 8 seconds while the machine is under load.
        if ((options?.timeout ?? 0) < 8_000) throw timedOut(String(file));
        return "__K3CODE_ENV_PATH_START__\n/opt/tools/bin\n__K3CODE_ENV_PATH_END__\n";
      }),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("waits longer for only one hung login shell", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi.spyOn(NodeChildProcess, "execFileSync").mockImplementation((file) => {
        throw timedOut(String(file));
      }),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        const timeouts = probe.mock.calls.map(([, , options]) => options?.timeout);
        assert.equal(timeouts.filter((timeout) => (timeout ?? 0) > 5_000).length, 1);
        assert.equal(env.PATH, "/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("keeps mise's PATH record with the login shell PATH", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__K3CODE_ENV_PATH_START__",
            "/home/me/.local/bin:/mise/installs/claude/latest:/mise/shims",
            "__K3CODE_ENV_PATH_END__",
            "__K3CODE_ENV___MISE_DIFF_START__",
            "mise-diff",
            "__K3CODE_ENV___MISE_DIFF_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.__MISE_DIFF, "mise-diff");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect(
  "hydrates missing JAVA_HOME and feature flags from the login shell and keeps explicit ones",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        vi
          .spyOn(NodeChildProcess, "execFileSync")
          .mockReturnValue(
            [
              "__K3CODE_ENV_PATH_START__",
              "/opt/homebrew/bin",
              "__K3CODE_ENV_PATH_END__",
              "__K3CODE_ENV_JAVA_HOME_START__",
              "/opt/homebrew/opt/openjdk@17",
              "__K3CODE_ENV_JAVA_HOME_END__",
              "__K3CODE_ENV_K3CODE_FEATURE_FLAGS_START__",
              "tanstack_source",
              "__K3CODE_ENV_K3CODE_FEATURE_FLAGS_END__",
            ].join("\n"),
          ),
      ),
      () =>
        Effect.gen(function* () {
          const missing: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
          const explicit: NodeJS.ProcessEnv = {
            SHELL: "/bin/zsh",
            PATH: "/usr/bin",
            JAVA_HOME: "/custom/jdk",
            K3CODE_FEATURE_FLAGS: "",
          };

          for (const env of [missing, explicit]) {
            yield* fixPath().pipe(
              Effect.provideService(HostProcess.Platform, "darwin"),
              Effect.provideService(HostProcess.Environment, env),
              Effect.provide(NodeServices.layer),
            );
          }

          assert.equal(missing.JAVA_HOME, "/opt/homebrew/opt/openjdk@17");
          assert.equal(explicit.JAVA_HOME, "/custom/jdk");
          assert.equal(missing.K3CODE_FEATURE_FLAGS, "tanstack_source");
          assert.equal(explicit.K3CODE_FEATURE_FLAGS, "");
        }),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
);

effectIt.effect("replaces a Path-spelled Windows PATH instead of adding a second key", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };

    yield* fixPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () => Effect.succeed({ PATH: "C:\\Tools" })),
      Effect.provideService(CommandAvailability, () => Effect.succeed(true)),
      Effect.provide(NodeServices.layer),
    );

    assert.deepEqual(env, { PATH: "C:\\Tools;C:\\Windows" });
  }),
);

effectIt.effect("adds a directory an installer wrote to the registry after launch", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Tools;C:\\Windows" };
    const installed = "C:\\Users\\me\\AppData\\Local\\cursor-agent";

    yield* refreshWindowsPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () =>
        Effect.succeed({ PATH: `C:\\Windows;${installed}` }),
      ),
    );

    assert.deepEqual(env, { PATH: `C:\\Tools;C:\\Windows;${installed}` });
  }),
);

// A login shell whose profile never finishes, and a log of what the refresh warned.
const hangingLoginShell = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.never,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

effectIt.effect("gives up on a slow login shell after 5 seconds unless the caller allows longer", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };
    const run = (options?: Parameters<typeof refreshPathFromLoginShell>[0]) =>
      refreshPathFromLoginShell(options).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, env),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, hangingLoginShell),
        Effect.forkChild,
      );

    // The default is what a user waiting on a refresh gets.
    const waited = yield* run();
    yield* TestClock.adjust("4 seconds");
    assert.isUndefined(waited.pollUnsafe());
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(waited);

    // The background pass at startup may wait out a slow profile.
    const background = yield* run({ timeout: BACKGROUND_LOGIN_SHELL_TIMEOUT });
    yield* TestClock.adjust("14 seconds");
    assert.isUndefined(background.pollUnsafe());
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(background);
  }),
);
