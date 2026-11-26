// K3 Code and T3 Code can be installed side by side. Only K3 Code names are listed here, and
// isSafeRemovalPath additionally refuses anything that equals, contains, or sits inside T3 data.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const K3_PRODUCT_NAMES = [
  "K3 Code",
  "K3 Code (Beta)",
  "K3 Code (Nightly)",
  "K3 Code (Dev)",
] as const;

export const K3_APP_ID = "jp.kinocode.k3code";

/** Electron userData folders under the OS app-data directory. */
export const K3_APP_DATA_PROFILE_NAMES = [
  "k3code-v2",
  "k3code-dev",
  "k3code",
  "K3 Code (Alpha)",
  ...K3_PRODUCT_NAMES,
] as const;

export const K3_MAC_APP_BUNDLES = K3_PRODUCT_NAMES.filter((name) => name !== "K3 Code (Dev)").map(
  (name) => `${name}.app`,
);

export const K3_MAC_CACHE_NAMES = [K3_APP_ID, `${K3_APP_ID}.ShipIt`, ...K3_PRODUCT_NAMES] as const;
export const K3_MAC_PREFERENCE_FILES = [`${K3_APP_ID}.plist`, `${K3_APP_ID}.helper.plist`] as const;
export const K3_MAC_SAVED_STATE_DIRS = [`${K3_APP_ID}.savedState`] as const;
export const K3_MAC_LOG_DIRS = [...K3_PRODUCT_NAMES, "k3code-v2"] as const;
export const K3_MAC_BUNDLE_STORAGE_IDS = [K3_APP_ID] as const;
export const K3_MAC_LAUNCH_AGENT_LABELS = [`${K3_APP_ID}.service`] as const;

export const K3_LINUX_CACHE_NAMES = ["k3code", "K3 Code", "k3code-v2"] as const;
export const K3_LINUX_SYSTEMD_UNITS = ["k3code.service"] as const;

export const K3_WINDOWS_LOCAL_APP_DATA_NAMES = [
  ...K3_PRODUCT_NAMES.filter((name) => name !== "K3 Code (Dev)"),
  "k3code-updater",
  // The Windows background service keeps its task XML here.
  "k3code",
  ...K3_PRODUCT_NAMES.filter((name) => name !== "K3 Code (Dev)").map(
    (name) => `Programs\\${name}`,
  ),
] as const;

const T3_PRODUCT_NAMES = [
  "T3 Code",
  "T3 Code (Alpha)",
  "T3 Code (Beta)",
  "T3 Code (Nightly)",
  "T3 Code (Dev)",
] as const;
const T3_APP_DATA_PROFILE_NAMES = ["t3code-v2", "t3code-dev", "t3code", ...T3_PRODUCT_NAMES];
const T3_APP_ID = "com.t3tools.t3code";

/** A name that belongs to T3 Code; K3 Code never has a reason to delete it. */
const T3_NAME_PATTERN = /(^|[^a-z0-9])t3([^a-z0-9]|$)|t3code|t3 code|t3tools/i;

export interface UninstallPathContext {
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function resolveAppDataDirectory(context: UninstallPathContext): string {
  const { path, platform, homeDirectory, env } = context;
  if (platform === "win32") {
    return nonEmpty(env.APPDATA) ?? path.join(homeDirectory, "AppData", "Roaming");
  }
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Application Support");
  return nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(homeDirectory, ".config");
}

function resolveLocalAppData(context: UninstallPathContext): string {
  return (
    nonEmpty(context.env.LOCALAPPDATA) ??
    context.path.join(context.homeDirectory, "AppData", "Local")
  );
}

/** Every location T3 Code keeps data in. Nothing equal to, inside, or above these is removed. */
export function protectedT3Paths(context: UninstallPathContext): ReadonlyArray<string> {
  const { path, platform, homeDirectory, env } = context;
  const appData = resolveAppDataDirectory(context);
  const protectedPaths: Array<string> = [
    path.join(homeDirectory, ".t3"),
    ...T3_APP_DATA_PROFILE_NAMES.map((name) => path.join(appData, name)),
  ];
  for (const configured of [env.T3CODE_HOME, env.T3_HOME]) {
    const value = nonEmpty(configured);
    if (value) protectedPaths.push(value);
  }
  if (platform === "darwin") {
    const library = path.join(homeDirectory, "Library");
    for (const name of [T3_APP_ID, `${T3_APP_ID}.ShipIt`, ...T3_PRODUCT_NAMES]) {
      protectedPaths.push(path.join(library, "Caches", name), path.join(library, "Logs", name));
    }
    protectedPaths.push(
      path.join(library, "Preferences", `${T3_APP_ID}.plist`),
      path.join(library, "Saved Application State", `${T3_APP_ID}.savedState`),
      path.join(library, "HTTPStorages", T3_APP_ID),
      path.join(library, "WebKit", T3_APP_ID),
      path.join(library, "LaunchAgents", `${T3_APP_ID}.service.plist`),
    );
    for (const name of T3_PRODUCT_NAMES) {
      protectedPaths.push(
        path.join("/Applications", `${name}.app`),
        path.join(homeDirectory, "Applications", `${name}.app`),
      );
    }
  } else if (platform === "linux") {
    const cacheHome = nonEmpty(env.XDG_CACHE_HOME) ?? path.join(homeDirectory, ".cache");
    const dataHome = nonEmpty(env.XDG_DATA_HOME) ?? path.join(homeDirectory, ".local", "share");
    for (const name of ["t3code", "t3code-v2", "T3 Code"]) {
      protectedPaths.push(path.join(cacheHome, name));
    }
    protectedPaths.push(
      path.join(appData, "systemd", "user", "t3code.service"),
      // K3 Code ships the same GNOME capture extension id as T3 Code, so the folder is shared.
      path.join(dataHome, "gnome-shell", "extensions", "snap-shot@t3.codes"),
    );
  } else if (platform === "win32") {
    const localAppData = resolveLocalAppData(context);
    for (const name of [...T3_PRODUCT_NAMES, "t3code-updater"]) {
      protectedPaths.push(path.join(localAppData, name));
    }
    for (const name of T3_PRODUCT_NAMES) {
      protectedPaths.push(path.join(localAppData, "Programs", name));
    }
  }
  return protectedPaths.map((entry) => path.resolve(entry));
}

const isSameOrInside = (path: Path.Path, candidate: string, parent: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** Whether deleting `candidate` could touch T3 Code's data. */
export function touchesT3Data(context: UninstallPathContext, candidate: string): boolean {
  const { path } = context;
  const resolved = path.resolve(candidate);
  if (T3_NAME_PATTERN.test(path.basename(resolved))) return true;
  return protectedT3Paths(context).some(
    (protectedPath) =>
      isSameOrInside(path, resolved, protectedPath) ||
      isSameOrInside(path, protectedPath, resolved),
  );
}

/**
 * Refuses roots, the home directory, shared OS containers, and anything that could contain or be
 * part of T3 Code's data.
 */
export function isSafeRemovalPath(context: UninstallPathContext, candidate: string): boolean {
  const { path, homeDirectory } = context;
  const resolved = path.resolve(candidate);
  const home = path.resolve(homeDirectory);
  const appData = path.resolve(resolveAppDataDirectory(context));
  if (resolved.length === 0 || resolved === path.dirname(resolved)) return false;
  const forbidden = new Set([
    home,
    appData,
    "/Applications",
    path.join(home, "Applications"),
    path.join(home, "Library"),
    path.join(home, "Library", "Application Support"),
    path.join(home, "Library", "Caches"),
    path.join(home, "Library", "Preferences"),
    path.join(home, "Library", "Saved Application State"),
    path.join(home, "Library", "Logs"),
    path.join(home, "Library", "HTTPStorages"),
    path.join(home, "Library", "WebKit"),
    path.join(home, "Library", "LaunchAgents"),
    path.join(home, ".config"),
    path.join(home, ".cache"),
    path.join(home, ".local"),
    path.join(home, ".local", "share"),
    path.join(home, ".local", "share", "applications"),
    path.join(home, ".local", "share", "gnome-shell"),
    path.join(home, ".local", "share", "gnome-shell", "extensions"),
    path.join(home, "AppData"),
    path.join(home, "AppData", "Roaming"),
    path.join(home, "AppData", "Local"),
    path.join(home, "AppData", "Local", "Programs"),
  ]);
  // Anything above the home directory (/, /Users) would contain it.
  if (forbidden.has(resolved) || isSameOrInside(path, home, resolved)) return false;
  return !touchesT3Data(context, resolved);
}

/** Resolves, drops duplicates, and keeps only paths that pass `isSafeRemovalPath`. */
export function filterSafeRemovalPaths(
  context: UninstallPathContext,
  candidates: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const safe: Array<string> = [];
  for (const candidate of candidates) {
    const resolved = context.path.resolve(candidate);
    if (seen.has(resolved)) continue;
    if (!isSafeRemovalPath(context, resolved)) continue;
    seen.add(resolved);
    safe.push(resolved);
  }
  return safe;
}

/** OS-level folders and files that belong only to K3 Code, before existence checks. */
export function collectK3SystemPaths(
  context: UninstallPathContext,
  options: { readonly includeAppBundles: boolean },
): ReadonlyArray<string> {
  const { path, platform, homeDirectory, env } = context;
  const appData = resolveAppDataDirectory(context);
  const candidates: Array<string> = K3_APP_DATA_PROFILE_NAMES.map((name) =>
    path.join(appData, name),
  );
  if (platform === "darwin") {
    const library = path.join(homeDirectory, "Library");
    if (options.includeAppBundles) {
      for (const bundle of K3_MAC_APP_BUNDLES) {
        candidates.push(
          path.join("/Applications", bundle),
          path.join(homeDirectory, "Applications", bundle),
        );
      }
    }
    for (const name of K3_MAC_CACHE_NAMES) candidates.push(path.join(library, "Caches", name));
    for (const file of K3_MAC_PREFERENCE_FILES) {
      candidates.push(path.join(library, "Preferences", file));
    }
    for (const dir of K3_MAC_SAVED_STATE_DIRS) {
      candidates.push(path.join(library, "Saved Application State", dir));
    }
    for (const dir of K3_MAC_LOG_DIRS) candidates.push(path.join(library, "Logs", dir));
    for (const id of K3_MAC_BUNDLE_STORAGE_IDS) {
      candidates.push(path.join(library, "HTTPStorages", id), path.join(library, "WebKit", id));
    }
  } else if (platform === "linux") {
    const cacheHome = nonEmpty(env.XDG_CACHE_HOME) ?? path.join(homeDirectory, ".cache");
    for (const name of K3_LINUX_CACHE_NAMES) candidates.push(path.join(cacheHome, name));
  } else if (platform === "win32") {
    const localAppData = resolveLocalAppData(context);
    for (const name of K3_WINDOWS_LOCAL_APP_DATA_NAMES) {
      candidates.push(path.join(localAppData, name));
    }
  }
  return candidates;
}

/** Task Scheduler names are machine-wide, so each Windows account runs its own K3 Code task. */
export const k3WindowsServiceTaskName = (domain: string, userName: string) =>
  `k3code-${domain}-${userName}`;

/** Files K3 Code's server keeps in `<home>/userdata`; any one of them marks a K3 home. */
export const K3_HOME_USERDATA_MARKERS = [
  "statev2.sqlite",
  "settings.json",
  "server-owner.sqlite",
  "server-runtime.json",
] as const;

/**
 * Whether `baseDir` looks like a K3 Code home: a `userdata/` folder holding one of K3 Code's own
 * stores. `--base-dir` and `K3CODE_HOME` can point anywhere, so a folder of another shape is
 * never removed as a whole.
 */
export const isK3HomeDirectory = Effect.fn("uninstallTargets.isK3HomeDirectory")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userdataDir = path.join(baseDir, "userdata");
  const info = yield* fs.stat(userdataDir).pipe(Effect.option);
  if (info._tag === "None" || info.value.type !== "Directory") return false;
  for (const marker of K3_HOME_USERDATA_MARKERS) {
    if (yield* fs.exists(path.join(userdataDir, marker)).pipe(Effect.orElseSucceed(() => false))) {
      return true;
    }
  }
  return false;
});

/** How long a cleanup helper waits for the app to exit before it gives up without deleting. */
export const CLEANUP_PID_WAIT_SECONDS = 60;

/**
 * The cmd.exe command line (for `cmd /d /v:off /s /c`) that waits up to 60 seconds for `pid` to
 * exit and then deletes the path in each named environment variable. Only a tasklist line naming
 * the PID keeps the wait going, so a localized "no tasks" message ends it. If the PID is still
 * alive after the wait, nothing is deleted: the command appends a line to the file named by
 * `logPathEnvName` (when given) and exits with code 1.
 *
 * With `uninstaller`, the NSIS uninstaller named by `exePathEnvName` runs silently after the
 * deletions (`_?=` keeps it in place and makes `start /wait` wait for it), then `dirPathEnvName`
 * is removed to clear what the uninstaller leaves behind. A missing uninstaller is skipped.
 */
export function buildWindowsWaitAndRemoveCommand(input: {
  readonly pid: number;
  readonly pathEnvNames: ReadonlyArray<string>;
  readonly logPathEnvName?: string;
  readonly uninstaller?: {
    readonly exePathEnvName: string;
    readonly dirPathEnvName: string;
  };
}): string {
  const alive = `tasklist /FI "PID eq ${input.pid}" /NH 2>nul | findstr /C:" ${input.pid} " >nul`;
  const waitStep = `for /l %i in (1,1,${CLEANUP_PID_WAIT_SECONDS}) do (${alive} && ping -n 2 127.0.0.1 >nul)`;
  const logStep =
    input.logPathEnvName === undefined
      ? ""
      : `echo K3 Code uninstall cleanup skipped: process ${input.pid} did not exit within ${CLEANUP_PID_WAIT_SECONDS} seconds. Nothing was deleted.>>"%${input.logPathEnvName}%" & `;
  const abortStep = `${alive} && (${logStep}exit 1)`;
  const removeDir = (key: string) =>
    `if exist "%${key}%" (rmdir /s /q "%${key}%" 2>nul || del /f /q "%${key}%" 2>nul)`;
  const steps = input.pathEnvNames.map(removeDir);
  if (input.uninstaller !== undefined) {
    const { exePathEnvName, dirPathEnvName } = input.uninstaller;
    steps.push(
      `if exist "%${exePathEnvName}%" start "" /wait "%${exePathEnvName}%" /S _?=%${dirPathEnvName}%`,
      removeDir(dirPathEnvName),
    );
  }
  return `"${waitStep} & ping -n 2 127.0.0.1 >nul & ${abortStep} & ${steps.join(" & ")}"`;
}

/**
 * The `/bin/sh -c` script that waits up to 60 seconds for the PID in `$1` to exit and then deletes
 * every path from `$3` on. `$2` is a log file; if the PID is still alive after the wait, the
 * script records that there and deletes nothing.
 */
export const POSIX_CLEANUP_SCRIPT = [
  'pid="$1"',
  'log="$2"',
  "shift 2",
  "i=0",
  `while [ "$i" -lt ${CLEANUP_PID_WAIT_SECONDS * 10} ] && kill -0 "$pid" 2>/dev/null; do`,
  "  sleep 0.1",
  "  i=$((i + 1))",
  "done",
  'if kill -0 "$pid" 2>/dev/null; then',
  `  echo "K3 Code uninstall cleanup skipped: process $pid did not exit within ${CLEANUP_PID_WAIT_SECONDS} seconds. Nothing was deleted." >> "$log" 2>/dev/null`,
  "  exit 1",
  "fi",
  'for target in "$@"; do',
  '  [ -n "$target" ] && rm -rf -- "$target" 2>/dev/null || true',
  "done",
].join("\n");
