// @effect-diagnostics nodeBuiltinImport:off - The test observes a real cleanup-shell spawn failure.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { afterEach, expect, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { posixLauncherScript } from "../cloud/pinnedRuntime.ts";
import {
  findOwnedLauncher,
  findRecordedLaunchers,
  spawnWindowsRemoval,
  uninstallCommand,
} from "./uninstall.ts";

vi.mock("node:child_process", { spy: true });

afterEach(() => vi.restoreAllMocks());

it.live("reports failure when the Windows cleanup shell cannot start", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-shell-" });
    const runtimeDir = path.join(baseDir, "runtime");
    yield* fs.makeDirectory(runtimeDir);
    vi.spyOn(BootService, "layer").mockReturnValue(
      Layer.succeed(
        BootService.BootService,
        BootService.BootService.of({
          status: Effect.succeed({
            supported: false,
            installed: false,
            current: false,
            unitPath: "",
            logPath: "",
          }),
          withStopped: (operation) => operation,
          restart: Effect.die("unexpected restart"),
          install: () => Effect.die("unexpected install"),
          uninstall: Effect.die("unexpected uninstall"),
        }),
      ),
    );
    const actual = yield* Effect.promise(() =>
      vi.importActual<typeof import("node:child_process")>("node:child_process"),
    );
    const spawn = actual.spawn;
    const failedSpawn = new Promise<Error>((resolve) => {
      vi.spyOn(NodeChildProcess, "spawn").mockImplementation((...args) => {
        const child = spawn(...args);
        // Observe the real spawn error without letting it terminate the test runner.
        child.once("error", resolve);
        return child;
      });
    });
    const result = yield* Command.runWith(uninstallCommand, { version: packageJson.version })([
      "--base-dir",
      baseDir,
      "--yes",
    ]).pipe(
      Effect.result,
      Effect.provideService(HostProcess.Environment, {
        ComSpec: path.join(baseDir, "missing-cmd.exe"),
      }),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.IsExecutable, false),
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
          Layer.fresh(TestConsole.layer),
        ),
      ),
    );
    yield* Effect.promise(() => failedSpawn);
    expect(result._tag, "an unavailable cleanup shell must fail uninstall").toBe("Failure");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
);

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("t3 uninstall command", (it) => {
  it.effect.each([
    {
      label: "names another home's service it leaves installed",
      otherFromRead: 1,
      removed: [],
      output: "--base-dir '/home/me/.t3'",
    },
    {
      label: "leaves a service that serves another home by the time it is removed",
      otherFromRead: 2,
      removed: [],
      output: "Left the background service: it now serves another K3 home.",
    },
  ])("$label", (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-cli-test-" });
      const uninstalls: Array<true> = [];
      let reads = 0;
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(
          BootService.BootService,
          BootService.BootService.of({
            status: Effect.sync(() => ({
              supported: true,
              installed: true,
              current: true,
              installedBaseDir: "/home/me/.t3",
              ...(++reads >= input.otherFromRead ? { otherBaseDir: "/home/me/.t3" } : {}),
              unitPath: "/home/me/.config/systemd/user/t3code.service",
              logPath: "/home/me/.t3/userdata/logs/boot-service.log",
            })),
            withStopped: (operation) => operation,
            restart: Effect.die("unexpected restart"),
            install: () => Effect.die("unexpected install"),
            uninstall: Effect.sync(() => {
              uninstalls.push(true);
              return true;
            }),
          }),
        ),
      );

      const output = yield* Command.runWith(uninstallCommand, { version: packageJson.version })([
        "--base-dir",
        baseDir,
        "--yes",
      ]).pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.map((lines) => lines.join("\n")),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      assert.deepStrictEqual(uninstalls, input.removed);
      assert.include(output, input.output);
    }),
  );

  const bootServiceFor = (homeDir: string, baseDir: string, uninstalls: Array<true>) =>
    Layer.succeed(
      BootService.BootService,
      BootService.BootService.of({
        status: Effect.succeed({
          supported: true,
          installed: true,
          current: true,
          installedBaseDir: baseDir,
          unitPath: NodePath.join(homeDir, ".config/systemd/user/k3code.service"),
          logPath: NodePath.join(baseDir, "userdata/logs/boot-service.log"),
        }),
        withStopped: (operation) => operation,
        restart: Effect.die("unexpected restart"),
        install: () => Effect.die("unexpected install"),
        uninstall: Effect.sync(() => {
          uninstalls.push(true);
          return true;
        }),
      }),
    );

  const runUninstallAll = (homeDir: string, baseDir: string) =>
    Command.runWith(uninstallCommand, { version: packageJson.version })([
      "--base-dir",
      baseDir,
      "--all",
      "--yes",
    ]).pipe(
      Effect.andThen(TestConsole.logLines),
      Effect.map((lines) => lines.join("\n")),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.HomeDirectory, homeDir),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(HostProcess.IsExecutable, false),
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
          Layer.fresh(TestConsole.layer),
        ),
      ),
    );

  it.effect(
    "removes only K3 Code's baseDir, caches, app data, and desktop shim with --all --yes, never T3 Code's",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-uninstall-all-home-" });
        const baseDir = path.join(homeDir, ".k3code");
        const userdataFile = path.join(baseDir, "userdata", "statev2.sqlite");
        const cacheFile = path.join(homeDir, ".cache", "k3code", "cache.bin");
        const configFile = path.join(homeDir, ".config", "k3code-v2", "Preferences");
        const desktopShim = path.join(homeDir, ".local", "bin", "t3");
        const unrelatedFile = path.join(homeDir, "keep-me.txt");
        const t3Shim = path.join(homeDir, "bin", "t3");
        const t3Files = [
          path.join(homeDir, ".t3", "userdata", "statev2.sqlite"),
          path.join(homeDir, ".cache", "t3code", "cache.bin"),
          path.join(homeDir, ".config", "t3code-v2", "Preferences"),
          path.join(homeDir, ".config", "T3 Code (Alpha)", "Preferences"),
          path.join(
            homeDir,
            ".local",
            "share",
            "gnome-shell",
            "extensions",
            "snap-shot@t3.codes",
            "metadata.json",
          ),
          t3Shim,
        ];

        for (const file of [
          userdataFile,
          cacheFile,
          configFile,
          desktopShim,
          unrelatedFile,
          ...t3Files,
        ]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        }
        yield* fs.writeFileString(userdataFile, "sqlite");
        yield* fs.writeFileString(cacheFile, "cache");
        yield* fs.writeFileString(configFile, "{}");
        yield* fs.writeFileString(
          desktopShim,
          "#!/bin/sh\n# Written by K3 Code: runs the desktop app's bundled t3 CLI.\n",
        );
        yield* fs.writeFileString(unrelatedFile, "untouched");
        for (const file of t3Files) {
          yield* fs.writeFileString(
            file,
            file === t3Shim
              ? "#!/bin/sh\n# Written by T3 Code: runs the desktop app's bundled t3 CLI.\n"
              : "t3 data",
          );
        }

        const uninstalls: Array<true> = [];
        vi.spyOn(BootService, "layer").mockReturnValue(
          bootServiceFor(homeDir, baseDir, uninstalls),
        );

        const output = yield* runUninstallAll(homeDir, baseDir);

        assert.deepStrictEqual(uninstalls, [true]);
        assert.isFalse(yield* fs.exists(baseDir));
        assert.isFalse(yield* fs.exists(path.join(homeDir, ".cache", "k3code")));
        assert.isFalse(yield* fs.exists(path.join(homeDir, ".config", "k3code-v2")));
        assert.isFalse(yield* fs.exists(desktopShim));
        assert.isTrue(yield* fs.exists(unrelatedFile));
        for (const file of t3Files) {
          assert.isTrue(yield* fs.exists(file), `${file} belongs to T3 Code and must be kept`);
        }
        assert.notInclude(output, "/.t3");
        assert.notInclude(output, "t3code");
        assert.notInclude(output, "T3 Code (Alpha)");
        assert.notInclude(output, t3Shim);
        assert.include(output, "K3 Code has been completely uninstalled.");
      }),
  );

  it.effect("refuses --all when the base directory is T3 Code's home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-uninstall-t3-home-" });
      const t3Home = path.join(homeDir, ".t3");
      const t3File = path.join(t3Home, "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(t3File), { recursive: true });
      yield* fs.writeFileString(t3File, "sqlite");

      vi.spyOn(BootService, "layer").mockReturnValue(bootServiceFor(homeDir, t3Home, []));

      const error = yield* runUninstallAll(homeDir, t3Home).pipe(Effect.flip);

      assert.include(String(error), "Refusing to remove");
      assert.isTrue(yield* fs.exists(t3File));
    }),
  );
});

it.layer(NodeServices.layer)("t3 uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // macOS spells the temp folder /var but resolves it to /private/var.
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-uninstall-" })
        .pipe(Effect.flatMap(fs.realPath));
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0/t3");
      const otherExe = path.join(root, "other/runtime/versions/1.0.0/t3");
      const copy = path.join(root, "copy/t3");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/t3");
      const theirs = path.join(root, "other/bin/t3");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.equal(yield* findOwnedLauncher({ launchedAs: ours, versionsDir }), ours);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: theirs, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: copy, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: undefined, versionsDir }));
      // A script launcher execs by absolute path, so argv0 names the executable.
      const scriptDir = path.join(root, "script-bin");
      const script = path.join(scriptDir, "t3");
      yield* fs.makeDirectory(scriptDir);
      yield* fs.writeFileString(script, posixLauncherScript(exe), { mode: 0o755 });
      assert.equal(
        yield* findOwnedLauncher({ launchedAs: exe, versionsDir }).pipe(
          Effect.provideService(HostProcess.Environment, { PATH: scriptDir }),
        ),
        script,
      );
      const editedScript = path.join(scriptDir, "t3-edited");
      yield* fs.writeFileString(editedScript, `${posixLauncherScript(exe)}# mine\n`);

      // On Windows, only the shim exactly as written is ours; a user's wrapper stays.
      const shimDir = path.join(root, "win-bin");
      const shim = path.join(shimDir, "t3.cmd");
      yield* fs.makeDirectory(shimDir);
      const windowsOwner = (contents: string) =>
        fs
          .writeFileString(shim, contents)
          .pipe(
            Effect.andThen(findOwnedLauncher({ launchedAs: exe, versionsDir })),
            Effect.provideService(HostProcess.Platform, "win32"),
            Effect.provideService(HostProcess.Environment, { PATH: shimDir }),
          );
      assert.equal(yield* windowsOwner(`@echo off\r\n"${exe}" %*`), shim);
      assert.isUndefined(yield* windowsOwner(`@echo off\r\nset FOO=1\r\n"${exe}" %*`));

      // npx can run another version than the installed one, so uninstall also reads the
      // recorded launchers: through a symlinked home, and dangling after a prune.
      const throughAlias = path.join(root, "bin/t3-alias");
      const pruned = path.join(root, "bin/t3-pruned");
      const scriptThroughAlias = path.join(scriptDir, "t3-alias");
      const prunedScript = path.join(scriptDir, "t3-pruned");
      yield* fs.symlink(root, path.join(root, "alias"));
      yield* fs.symlink(path.join(root, "alias/runtime/versions/1.0.0/t3"), throughAlias);
      yield* fs.symlink(path.join(versionsDir, "0.9.0/t3"), pruned);
      yield* fs.writeFileString(
        scriptThroughAlias,
        posixLauncherScript(path.join(root, "alias/runtime/versions/1.0.0/t3")),
        { mode: 0o755 },
      );
      yield* fs.writeFileString(
        prunedScript,
        posixLauncherScript(path.join(versionsDir, "0.9.0/t3")),
        { mode: 0o755 },
      );
      // Another program inside a version is not a launcher.
      const sibling = path.join(root, "bin/t3-sibling");
      yield* fs.symlink(path.join(versionsDir, "1.0.0/node"), sibling);
      yield* fs.writeFileString(
        path.join(root, "runtime/launchers"),
        [
          ours,
          theirs,
          copy,
          throughAlias,
          pruned,
          sibling,
          script,
          scriptThroughAlias,
          prunedScript,
          editedScript,
          path.join(root, "missing"),
        ].join("\n") + "\n",
      );
      for (const dir of [versionsDir, path.join(root, "alias/runtime/versions")]) {
        assert.deepStrictEqual(yield* findRecordedLaunchers(dir), [
          ours,
          throughAlias,
          pruned,
          script,
          scriptThroughAlias,
          prunedScript,
        ]);
      }

      // On Windows only an unedited t3.cmd is ours; a hand-edited wrapper belongs to the user.
      const cmd = path.join(root, "bin/t3.cmd");
      const edited = path.join(root, "bin/edited.cmd");
      yield* fs.writeFileString(cmd, `@echo off\r\n"${exe}" %*`);
      yield* fs.writeFileString(edited, `@echo off\r\nset "K3CODE_HOME=D:\\other"\r\n"${exe}" %*`);
      yield* fs.writeFileString(path.join(root, "runtime/launchers"), `${cmd}\r\n${edited}\r\n`);
      assert.deepStrictEqual(
        yield* findRecordedLaunchers(versionsDir).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        ),
        [cmd],
      );
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );
});

it.live.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "t3 uninstall has cmd.exe remove the runtime directory, preserving spaces and literal environment-variable syntax",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const runtimeDir = path.join(root, "t3 home %COMSPEC% !COMSPEC! & data", "runtime");
      yield* fs.makeDirectory(path.join(runtimeDir, "versions", "1.0.0"), { recursive: true });
      yield* fs.writeFileString(path.join(runtimeDir, "versions", "1.0.0", "t3.exe"), "");

      const child = spawnWindowsRemoval(
        yield* Config.String("ComSpec").pipe(Config.withDefault("cmd.exe")),
        runtimeDir,
      );
      yield* Effect.callback<void, Error>((resume) => {
        child.once("error", (error) => resume(Effect.fail(error)));
        child.once("exit", (code) =>
          resume(code === 0 ? Effect.void : Effect.die(`cmd.exe exited with ${code}`)),
        );
      });

      assert.isFalse(yield* fs.exists(runtimeDir));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
