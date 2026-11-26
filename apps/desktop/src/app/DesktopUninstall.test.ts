import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  collectDesktopUninstallCandidates,
  isSafeRemovalPath,
  resolveMacAppBundlePath,
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
