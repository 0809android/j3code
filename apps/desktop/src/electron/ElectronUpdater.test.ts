// @effect-diagnostics nodeBuiltinImport:off -- Intercepts the spawn electron-updater requires natively.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { autoUpdater } from "electron-updater";
import type * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import { vi } from "vite-plus/test";

// electron-updater requires Electron natively, outside vi.mock's reach, and builds its
// autoUpdater singleton as soon as it is imported.
vi.hoisted(() => {
  const NodeModule = process.getBuiltinModule("node:module");
  const NodeEvents = process.getBuiltinModule("node:events");
  const require = NodeModule.createRequire(import.meta.url);
  const electronPath = NodeModule.createRequire(require.resolve("electron-updater")).resolve(
    "electron",
  );
  const electronModule = new NodeModule.Module(electronPath);
  electronModule.filename = electronPath;
  electronModule.loaded = true;
  electronModule.exports = {
    app: {
      getVersion: () => "1.0.0",
      getName: () => "K3 Code",
      isPackaged: true,
      quit: () => undefined,
      once: () => undefined,
    },
    autoUpdater: new NodeEvents.EventEmitter(),
  };
  require.cache[electronPath] = electronModule;
});

import * as ElectronUpdater from "./ElectronUpdater.ts";

const childProcess = NodeModule.createRequire(import.meta.url)("node:child_process") as {
  spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => NodeChildProcess.ChildProcess;
};

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "ElectronUpdater AppImage install",
  () => {
    it.live("relaunches the installed AppImage without the updating process's descriptors", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-appimage-install-" });
        const appImagePath = path.join(dir, "K3-Code.AppImage");
        const stagedPath = path.join(dir, "K3-Code-1.0.1.AppImage");
        const fdReportPath = path.join(dir, "relaunched-fds.txt");
        yield* fileSystem.writeFileString(appImagePath, "old AppImage");
        yield* fileSystem.writeFileString(
          stagedPath,
          `#!/bin/sh\nls /proc/self/fd > '${fdReportPath}'\n`,
        );
        yield* fileSystem.chmod(stagedPath, 0o755);

        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("APPIMAGE", appImagePath)),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );

        autoUpdater.logger = null;
        Object.assign(autoUpdater, {
          downloadedUpdateHelper: {
            file: stagedPath,
            downloadedFileInfo: { isAdminRightsRequired: false },
          },
        });

        // Electron's main process holds the AppImage runtime's keepalive pipe and some
        // Chromium files without O_CLOEXEC. Node cannot hold such a descriptor, so the
        // relaunch runs with fd 7 opened that way to stand in for them.
        const relaunched = yield* Deferred.make<void>();
        const realSpawn = childProcess.spawn;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            childProcess.spawn = (command, args, options) => {
              const child = realSpawn(
                "bash",
                ["-c", 'exec 7</dev/null; exec "$@"', "leaky-parent", command, ...args],
                options,
              );
              child.once("exit", () => Deferred.doneUnsafe(relaunched, Effect.void));
              return child;
            };
            NodeModule.syncBuiltinESMExports();
          }),
          () =>
            Effect.sync(() => {
              childProcess.spawn = realSpawn;
              NodeModule.syncBuiltinESMExports();
            }),
        );

        const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
        yield* electronUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
        yield* Deferred.await(relaunched);

        const descriptors = (yield* fileSystem.readFileString(fdReportPath)).trim().split("\n");
        assert.notInclude(
          descriptors,
          "7",
          `relaunched AppImage inherited the updating process's fd 7 (open fds: ${descriptors.join(" ")})`,
        );
      }).pipe(Effect.provide([ElectronUpdater.layer, NodeServices.layer])),
    );
  },
);

describe("ElectronUpdater download retry", () => {
  const stubDownload = () => {
    const resolvers: Array<() => void> = [];
    // startSignals[n] completes when electron-updater's downloadUpdate is called for the nth time.
    const firstStarted = Deferred.makeUnsafe<void>();
    const retryStarted = Deferred.makeUnsafe<void>();
    const startSignals = [firstStarted, retryStarted];
    const spy = vi.spyOn(autoUpdater, "downloadUpdate").mockImplementation(() => {
      const signal = startSignals[resolvers.length];
      const settled = new Promise<Array<string>>((resolve) => {
        resolvers.push(() => resolve([]));
      });
      if (signal) Deferred.doneUnsafe(signal, Effect.void);
      return settled;
    });
    return { spy, resolvers, firstStarted, retryStarted, started: () => resolvers.length };
  };

  it.effect("waits for the interrupted download to settle before retrying", () =>
    Effect.gen(function* () {
      const download = stubDownload();
      yield* Effect.addFinalizer(() => Effect.sync(() => download.spy.mockRestore()));
      const electronUpdater = yield* ElectronUpdater.ElectronUpdater;

      const first = yield* electronUpdater.downloadUpdate.pipe(Effect.forkScoped);
      yield* Deferred.await(download.firstStarted);
      yield* Fiber.interrupt(first);

      const retry = yield* electronUpdater.downloadUpdate.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.equal(download.started(), 1, "retry must not start while the old promise is pending");

      download.resolvers[0]?.();
      yield* Deferred.await(download.retryStarted);
      assert.equal(download.started(), 2);
      download.resolvers[1]?.();
      yield* Fiber.join(retry);
    }).pipe(Effect.scoped, Effect.provide([ElectronUpdater.layer, TestClock.layer()])),
  );

  it.effect("refuses to retry and asks for a restart when the old download never settles", () =>
    Effect.gen(function* () {
      const download = stubDownload();
      yield* Effect.addFinalizer(() => Effect.sync(() => download.spy.mockRestore()));
      const electronUpdater = yield* ElectronUpdater.ElectronUpdater;

      const first = yield* electronUpdater.downloadUpdate.pipe(Effect.forkScoped);
      yield* Deferred.await(download.firstStarted);
      yield* Fiber.interrupt(first);

      const retry = yield* electronUpdater.downloadUpdate.pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust(
        Duration.sum(ElectronUpdater.CANCELLED_DOWNLOAD_SETTLE_TIMEOUT, Duration.millis(1)),
      );
      const error = yield* Fiber.join(retry);
      assert.equal(error.restartRequired, true);
      assert.equal(download.started(), 1, "electron-updater must not be asked to download again");

      // Let the stub settle so the module-level pending download does not leak into other tests.
      download.resolvers[0]?.();
      yield* Effect.yieldNow;
    }).pipe(Effect.scoped, Effect.provide([ElectronUpdater.layer, TestClock.layer()])),
  );
});
