import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { POSIX_CLEANUP_SCRIPT } from "@t3tools/shared/uninstallTargets";

import {
  buildWindowsCleanupCommand,
  collectDesktopUninstallCandidates,
  findNsisUninstallerName,
  isSafeRemovalPath,
  resolveMacAppBundlePath,
  windowsServiceTaskCommands,
} from "./DesktopUninstall.ts";

const T3_DATA_FRAGMENTS = [".t3", "t3code", "T3 Code", "com.t3tools.t3code", "snap-shot@t3.codes"];

const assertNoT3Data = (paths: ReadonlyArray<string>) => {
  for (const target of paths) {
    for (const fragment of T3_DATA_FRAGMENTS) {
      assert.isFalse(target.includes(fragment), `${target} must not touch T3 Code (${fragment})`);
    }
  }
};

it.layer(NodeServices.layer)("DesktopUninstall path resolution", (it) => {
  it.effect("resolves the enclosing macOS .app bundle from an executable path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(
        resolveMacAppBundlePath(path, "/Applications/K3 Code (Beta).app/Contents/MacOS/K3 Code"),
        "/Applications/K3 Code (Beta).app",
      );
      assert.isNull(resolveMacAppBundlePath(path, "/usr/local/bin/node"));
    }),
  );

  it.effect("refuses root, home, shared OS container directories, and T3 Code data", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = "/Users/alice";
      for (const unsafe of [
        "/",
        "/Users",
        home,
        "/Applications",
        `${home}/Applications`,
        `${home}/Library`,
        `${home}/Library/Application Support`,
        `${home}/Library/Caches`,
        `${home}/Library/Preferences`,
        `${home}/Library/LaunchAgents`,
        `${home}/.config`,
        `${home}/.cache`,
        `${home}/.t3`,
        `${home}/.t3/userdata`,
        `${home}/Library/Application Support/t3code-v2`,
        `${home}/Library/Application Support/T3 Code (Alpha)`,
        `${home}/Library/Caches/com.t3tools.t3code`,
        "/Applications/T3 Code (Alpha).app",
      ]) {
        assert.isFalse(
          isSafeRemovalPath({ path, candidate: unsafe, homeDirectory: home, platform: "darwin" }),
          `expected ${unsafe} to be rejected`,
        );
      }
      for (const safe of [
        `${home}/.k3code`,
        "/Applications/K3 Code (Beta).app",
        `${home}/Library/Application Support/k3code-v2`,
      ]) {
        assert.isTrue(
          isSafeRemovalPath({ path, candidate: safe, homeDirectory: home, platform: "darwin" }),
          `expected ${safe} to be accepted`,
        );
      }
    }),
  );

  it.effect("rejects a base directory that is, contains, or sits inside T3 Code's home", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = "/Users/alice";
      for (const baseDir of [`${home}/.t3`, `${home}/.t3/k3`, home]) {
        const result = collectDesktopUninstallCandidates({
          path,
          platform: "darwin",
          isPackaged: false,
          executablePath: "/usr/bin/node",
          homeDirectory: home,
          baseDir,
          userDataPath: `${home}/Library/Application Support/k3code-v2`,
          linuxApplicationsDir: `${home}/.local/share/applications`,
          linuxDesktopEntryName: "jp.kinocode.K3Code.desktop",
          appImagePath: Option.none(),
          env: {},
        });
        assert.notInclude(result.paths, path.resolve(baseDir));
        assertNoT3Data(result.paths);
      }
    }),
  );

  it.effect("honors a T3_HOME or T3CODE_HOME that points at a custom T3 Code location", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = "/Users/alice";
      const result = collectDesktopUninstallCandidates({
        path,
        platform: "darwin",
        isPackaged: false,
        executablePath: "/usr/bin/node",
        homeDirectory: home,
        baseDir: "/Volumes/Work/shared-home",
        userDataPath: `${home}/Library/Application Support/k3code-v2`,
        linuxApplicationsDir: `${home}/.local/share/applications`,
        linuxDesktopEntryName: "jp.kinocode.K3Code.desktop",
        appImagePath: Option.none(),
        env: { T3CODE_HOME: "/Volumes/Work/shared-home" },
      });
      assert.notInclude(result.paths, "/Volumes/Work/shared-home");
    }),
  );

  it.effect("collects the macOS bundle, data, caches, preferences, and launch agent", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = "/Users/alice";
      const appData = `${home}/Library/Application Support`;
      const result = collectDesktopUninstallCandidates({
        path,
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/K3 Code (Beta).app/Contents/MacOS/K3 Code",
        homeDirectory: home,
        baseDir: `${home}/.k3code`,
        userDataPath: `${appData}/k3code-v2`,
        linuxApplicationsDir: `${home}/.local/share/applications`,
        linuxDesktopEntryName: "jp.kinocode.K3Code.desktop",
        appImagePath: Option.none(),
        env: {},
      });

      assert.equal(result.appBundlePath, "/Applications/K3 Code (Beta).app");
      assert.sameMembers(
        [...result.paths],
        [
          `${home}/.k3code`,
          `${appData}/k3code-v2`,
          `${appData}/k3code-dev`,
          `${appData}/k3code`,
          `${appData}/K3 Code`,
          `${appData}/K3 Code (Alpha)`,
          `${appData}/K3 Code (Beta)`,
          `${appData}/K3 Code (Nightly)`,
          `${appData}/K3 Code (Dev)`,
          `${home}/Library/Caches/jp.kinocode.k3code`,
          `${home}/Library/Caches/jp.kinocode.k3code.ShipIt`,
          `${home}/Library/Caches/K3 Code`,
          `${home}/Library/Caches/K3 Code (Beta)`,
          `${home}/Library/Caches/K3 Code (Nightly)`,
          `${home}/Library/Caches/K3 Code (Dev)`,
          `${home}/Library/Preferences/jp.kinocode.k3code.plist`,
          `${home}/Library/Preferences/jp.kinocode.k3code.helper.plist`,
          `${home}/Library/Saved Application State/jp.kinocode.k3code.savedState`,
          `${home}/Library/Logs/K3 Code`,
          `${home}/Library/Logs/K3 Code (Beta)`,
          `${home}/Library/Logs/K3 Code (Nightly)`,
          `${home}/Library/Logs/K3 Code (Dev)`,
          `${home}/Library/Logs/k3code-v2`,
          `${home}/Library/HTTPStorages/jp.kinocode.k3code`,
          `${home}/Library/WebKit/jp.kinocode.k3code`,
          `${home}/Library/LaunchAgents/jp.kinocode.k3code.service.plist`,
          "/Applications/K3 Code (Beta).app",
        ],
      );
      assertNoT3Data(result.paths);
    }),
  );

  it.effect("never includes an app bundle in development mode", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = "/Users/alice";
      const appData = `${home}/Library/Application Support`;
      const result = collectDesktopUninstallCandidates({
        path,
        platform: "darwin",
        isPackaged: false,
        executablePath: "/repo/.electron-runtime/K3 Code (Dev).app/Contents/MacOS/Electron",
        homeDirectory: home,
        baseDir: `${home}/.k3code`,
        userDataPath: `${appData}/k3code-dev`,
        linuxApplicationsDir: `${home}/.local/share/applications`,
        linuxDesktopEntryName: "jp.kinocode.K3Code.Development.desktop",
        appImagePath: Option.none(),
        env: {},
      });

      assert.isNull(result.appBundlePath);
      assert.notInclude(result.paths, "/repo/.electron-runtime/K3 Code (Dev).app");
    }),
  );

  it.effect("does not treat another app's bundle as K3 Code's", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = "/Users/alice";
      const result = collectDesktopUninstallCandidates({
        path,
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code",
        homeDirectory: home,
        baseDir: `${home}/.k3code`,
        userDataPath: `${home}/Library/Application Support/k3code-v2`,
        linuxApplicationsDir: `${home}/.local/share/applications`,
        linuxDesktopEntryName: "jp.kinocode.K3Code.desktop",
        appImagePath: Option.none(),
        env: {},
      });
      assert.isNull(result.appBundlePath);
      assertNoT3Data(result.paths);
    }),
  );

  it.effect("collects Linux K3 Code paths without T3 Code or the shared GNOME extension", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = "/home/alice";
      const result = collectDesktopUninstallCandidates({
        path,
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_k3code/k3code",
        homeDirectory: home,
        baseDir: `${home}/.k3code`,
        userDataPath: `${home}/.config/k3code-v2`,
        linuxApplicationsDir: `${home}/.local/share/applications`,
        linuxDesktopEntryName: "jp.kinocode.K3Code.desktop",
        appImagePath: Option.some(`${home}/Applications/K3Code.AppImage`),
        env: {},
      });

      assert.equal(result.appBundlePath, `${home}/Applications/K3Code.AppImage`);
      assert.include(result.paths, `${home}/Applications/K3Code.AppImage`);
      assert.include(result.paths, `${home}/.k3code`);
      assert.include(result.paths, `${home}/.cache/k3code`);
      assert.include(result.paths, `${home}/.config/systemd/user/k3code.service`);
      assert.include(result.paths, `${home}/.local/share/applications/jp.kinocode.K3Code.desktop`);
      assertNoT3Data(result.paths);
    }),
  );

  it.effect("keeps Windows removal to K3 Code folders and never T3 Code's", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = "/Users/alice";
      const result = collectDesktopUninstallCandidates({
        path,
        platform: "win32",
        isPackaged: true,
        executablePath: `${home}/AppData/Local/Programs/K3 Code/K3 Code.exe`,
        homeDirectory: home,
        baseDir: `${home}/.k3code`,
        userDataPath: `${home}/AppData/Roaming/k3code-v2`,
        linuxApplicationsDir: `${home}/.local/share/applications`,
        linuxDesktopEntryName: "jp.kinocode.K3Code.desktop",
        appImagePath: Option.none(),
        env: {},
      });
      assert.include(result.paths, `${home}/AppData/Local/k3code-updater`);
      assert.include(result.paths, `${home}/AppData/Local/Programs/K3 Code`);
      assertNoT3Data(result.paths);
    }),
  );

  it.effect("silently filters out an unsafe baseDir equal to homeDirectory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "k3-uninstall-safe-" });
      const result = collectDesktopUninstallCandidates({
        path,
        platform: "linux",
        isPackaged: false,
        executablePath: "/usr/bin/node",
        homeDirectory: home,
        baseDir: home,
        userDataPath: path.join(home, ".config", "k3code-v2"),
        linuxApplicationsDir: path.join(home, ".local", "share", "applications"),
        linuxDesktopEntryName: "jp.kinocode.K3Code.desktop",
        appImagePath: Option.none(),
        env: {},
      });
      assert.notInclude(result.paths, path.resolve(home));
    }),
  );
});

it.effect("plans to stop, disable, and delete the Windows background service task", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(windowsServiceTaskCommands("k3code-PC-alice"), [
      ["/End", "/TN", "k3code-PC-alice"],
      ["/Change", "/TN", "k3code-PC-alice", "/DISABLE"],
      ["/Delete", "/TN", "k3code-PC-alice", "/F"],
    ]);
  }),
);

it.effect("makes the Windows cleanup wait for the app PID before deleting", () =>
  Effect.sync(() => {
    const command = buildWindowsCleanupCommand({ pid: 4242, targetCount: 2 });
    const wait = command.indexOf('tasklist /FI "PID eq 4242"');
    assert.isAbove(wait, -1);
    assert.include(command, "(1,1,60)");
    assert.isAbove(command.indexOf("rmdir /s /q"), wait);
    assert.include(command, "K3_UNINSTALL_TARGET_1");
    assert.notInclude(command, "ping -n 4");
  }),
);

it.effect("makes the Windows cleanup delete nothing when the app PID outlives the wait", () =>
  Effect.sync(() => {
    const command = buildWindowsCleanupCommand({ pid: 4242, targetCount: 2 });
    const abort = command.indexOf("exit 1");
    assert.isAbove(abort, command.indexOf("(1,1,60)"));
    assert.isBelow(abort, command.indexOf("rmdir /s /q"));
    assert.include(command, '>>"%K3_UNINSTALL_LOG%"');
  }),
);

it.effect("makes the POSIX cleanup give up with a log line instead of deleting after the wait", () =>
  Effect.sync(() => {
    assert.include(POSIX_CLEANUP_SCRIPT, "-lt 600");
    const abort = POSIX_CLEANUP_SCRIPT.indexOf("exit 1");
    assert.isAbove(abort, POSIX_CLEANUP_SCRIPT.indexOf("done"));
    assert.isBelow(abort, POSIX_CLEANUP_SCRIPT.indexOf("rm -rf"));
    assert.include(POSIX_CLEANUP_SCRIPT, '>> "$log"');
  }),
);

it.effect("runs the NSIS uninstaller silently after the deletions, then clears the folder", () =>
  Effect.sync(() => {
    const command = buildWindowsCleanupCommand({
      pid: 4242,
      targetCount: 1,
      withUninstaller: true,
    });
    const data = command.indexOf("K3_UNINSTALL_TARGET_0");
    const uninstaller = command.indexOf('start "" /wait "%K3_UNINSTALL_NSIS_EXE%" /S _?=');
    assert.isAbove(uninstaller, data);
    assert.include(command, 'if exist "%K3_UNINSTALL_NSIS_EXE%"');
    assert.isAbove(command.lastIndexOf('rmdir /s /q "%K3_UNINSTALL_NSIS_DIR%"'), uninstaller);
  }),
);

it.effect("leaves the uninstaller step out when the install folder has none", () =>
  Effect.sync(() => {
    const command = buildWindowsCleanupCommand({ pid: 4242, targetCount: 1 });
    assert.notInclude(command, "/wait");
    assert.notInclude(command, "K3_UNINSTALL_NSIS");
  }),
);

it.effect("finds electron-builder's NSIS uninstaller by name", () =>
  Effect.sync(() => {
    assert.strictEqual(
      findNsisUninstallerName(["K3 Code (Beta).exe", "Uninstall K3 Code (Beta).exe", "d3d.dll"]),
      "Uninstall K3 Code (Beta).exe",
    );
    assert.strictEqual(
      findNsisUninstallerName(["Uninstall K3 Code.exe"]),
      "Uninstall K3 Code.exe",
    );
    assert.isUndefined(findNsisUninstallerName(["K3 Code.exe", "Uninstall T3 Code.exe"]));
  }),
);
