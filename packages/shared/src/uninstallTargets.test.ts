import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  K3_APP_DATA_PROFILE_NAMES,
  K3_LINUX_CACHE_NAMES,
  K3_LINUX_SYSTEMD_UNITS,
  K3_MAC_APP_BUNDLES,
  K3_MAC_CACHE_NAMES,
  K3_MAC_LAUNCH_AGENT_LABELS,
  K3_MAC_LOG_DIRS,
  K3_MAC_PREFERENCE_FILES,
  K3_MAC_SAVED_STATE_DIRS,
  K3_WINDOWS_LOCAL_APP_DATA_NAMES,
  collectK3SystemPaths,
  filterSafeRemovalPaths,
  isSafeRemovalPath,
  touchesT3Data,
  type UninstallPathContext,
} from "./uninstallTargets.ts";

const T3_MARKERS = [/t3code/i, /t3 code/i, /t3tools/i, /(^|[^a-z0-9])t3([^a-z0-9]|$)/i];

const makeContext = (
  path: Path.Path,
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string> = {},
): UninstallPathContext => ({ path, platform, homeDirectory: home, env });

describe("K3 uninstall target names", () => {
  it("never list a T3 Code name", () => {
    const names = [
      ...K3_APP_DATA_PROFILE_NAMES,
      ...K3_LINUX_CACHE_NAMES,
      ...K3_LINUX_SYSTEMD_UNITS,
      ...K3_MAC_APP_BUNDLES,
      ...K3_MAC_CACHE_NAMES,
      ...K3_MAC_LAUNCH_AGENT_LABELS,
      ...K3_MAC_LOG_DIRS,
      ...K3_MAC_PREFERENCE_FILES,
      ...K3_MAC_SAVED_STATE_DIRS,
      ...K3_WINDOWS_LOCAL_APP_DATA_NAMES,
    ];
    assert.isAbove(names.length, 0);
    for (const name of names) {
      for (const marker of T3_MARKERS) {
        assert.notMatch(name, marker, `${name} looks like a T3 Code name`);
      }
    }
  });

  for (const platform of ["darwin", "linux", "win32"] as const) {
    it.effect(`collects no path that touches T3 Code on ${platform}`, () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = platform === "win32" ? "/home/alice" : "/Users/alice";
        const ctx = makeContext(path, platform, home);
        for (const includeAppBundles of [true, false]) {
          const paths = collectK3SystemPaths(ctx, { includeAppBundles });
          assert.isAbove(paths.length, 0);
          for (const target of paths) {
            assert.isFalse(touchesT3Data(ctx, target), target);
          }
          assert.equal(
            filterSafeRemovalPaths(ctx, paths).length,
            new Set(paths.map((target) => path.resolve(target))).size,
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }
});

describe("isSafeRemovalPath", () => {
  const home = "/home/alice";

  it.effect("refuses T3 Code's home, profiles, caches, and the shared GNOME extension", () =>
    Effect.gen(function* () {
      const ctx = makeContext(yield* Path.Path, "linux", home);
      for (const target of [
        `${home}/.t3`,
        `${home}/.t3/userdata`,
        `${home}/.t3/userdata/statev2.sqlite`,
        `${home}/.config/t3code-v2`,
        `${home}/.config/T3 Code (Alpha)`,
        `${home}/.cache/t3code`,
        `${home}/.config/systemd/user/t3code.service`,
        `${home}/.local/share/gnome-shell/extensions/snap-shot@t3.codes`,
      ]) {
        assert.isFalse(isSafeRemovalPath(ctx, target), target);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a directory that contains T3 Code's data", () =>
    Effect.gen(function* () {
      const ctx = makeContext(yield* Path.Path, "linux", home);
      assert.isFalse(isSafeRemovalPath(ctx, `${home}/.config`));
      assert.isFalse(isSafeRemovalPath(ctx, `${home}/.local/share/gnome-shell`));
      assert.isFalse(isSafeRemovalPath(ctx, "/home"));
      assert.isFalse(isSafeRemovalPath(ctx, "/"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses the T3 home configured through the environment", () =>
    Effect.gen(function* () {
      const ctx = makeContext(yield* Path.Path, "linux", home, { T3CODE_HOME: "/data/agents" });
      assert.isFalse(isSafeRemovalPath(ctx, "/data/agents"));
      assert.isFalse(isSafeRemovalPath(ctx, "/data/agents/userdata"));
      assert.isFalse(isSafeRemovalPath(ctx, "/data"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts K3 Code's own folders", () =>
    Effect.gen(function* () {
      const ctx = makeContext(yield* Path.Path, "linux", home);
      for (const target of [
        `${home}/.k3code`,
        `${home}/.config/k3code-v2`,
        `${home}/.cache/k3code`,
        `${home}/Applications/K3Code.AppImage`,
      ]) {
        assert.isTrue(isSafeRemovalPath(ctx, target), target);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
