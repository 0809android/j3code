import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

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

const context = (
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string> = {},
): UninstallPathContext => ({ path: NodePath, platform, homeDirectory: home, env });

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
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      for (const marker of T3_MARKERS) {
        expect(name, `${name} looks like a T3 Code name`).not.toMatch(marker);
      }
    }
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "collects no path that touches T3 Code on %s",
    (platform) => {
      const home = platform === "win32" ? "/home/alice" : "/Users/alice";
      for (const includeAppBundles of [true, false]) {
        const paths = collectK3SystemPaths(context(platform, home), { includeAppBundles });
        expect(paths.length).toBeGreaterThan(0);
        for (const target of paths) {
          expect(touchesT3Data(context(platform, home), target), target).toBe(false);
        }
        expect(filterSafeRemovalPaths(context(platform, home), paths).length).toBe(
          new Set(paths.map((target) => NodePath.resolve(target))).size,
        );
      }
    },
  );
});

describe("isSafeRemovalPath", () => {
  const home = "/home/alice";

  it("refuses T3 Code's home, profiles, caches, and the shared GNOME extension", () => {
    const ctx = context("linux", home);
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
      expect(isSafeRemovalPath(ctx, target), target).toBe(false);
    }
  });

  it("refuses a directory that contains T3 Code's data", () => {
    const ctx = context("linux", home);
    expect(isSafeRemovalPath(ctx, `${home}/.config`)).toBe(false);
    expect(isSafeRemovalPath(ctx, `${home}/.local/share/gnome-shell`)).toBe(false);
    expect(isSafeRemovalPath(ctx, "/home")).toBe(false);
    expect(isSafeRemovalPath(ctx, "/")).toBe(false);
  });

  it("refuses the T3 home configured through the environment", () => {
    const ctx = context("linux", home, { T3CODE_HOME: "/data/agents" });
    expect(isSafeRemovalPath(ctx, "/data/agents")).toBe(false);
    expect(isSafeRemovalPath(ctx, "/data/agents/userdata")).toBe(false);
    expect(isSafeRemovalPath(ctx, "/data")).toBe(false);
  });

  it("accepts K3 Code's own folders", () => {
    const ctx = context("linux", home);
    for (const target of [
      `${home}/.k3code`,
      `${home}/.config/k3code-v2`,
      `${home}/.cache/k3code`,
      `${home}/Applications/K3Code.AppImage`,
    ]) {
      expect(isSafeRemovalPath(ctx, target), target).toBe(true);
    }
  });
});
