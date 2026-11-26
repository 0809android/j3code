// @effect-diagnostics nodeBuiltinImport:off
// Detached cleanup must outlive the Electron process so it can remove userData, baseDir, and the app bundle after exit.
import * as NodeChildProcess from "node:child_process";

import type { DesktopUninstallPlan } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  K3_LINUX_SYSTEMD_UNITS,
  K3_MAC_LAUNCH_AGENT_LABELS,
  buildWindowsWaitAndRemoveCommand,
  collectK3SystemPaths,
  filterSafeRemovalPaths,
  isK3HomeDirectory,
  isSafeRemovalPath as isSafeK3RemovalPath,
  k3WindowsServiceTaskName,
  type UninstallPathContext,
} from "@t3tools/shared/uninstallTargets";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-uninstall");

export class DesktopUninstallError extends Schema.TaggedError<DesktopUninstallError>()(
  "DesktopUninstallError",
  { message: Schema.String },
) {}

export class DesktopUninstall extends Context.Service<
  DesktopUninstall,
  {
    readonly getPlan: Effect.Effect<DesktopUninstallPlan, DesktopUninstallError>;
    readonly run: Effect.Effect<void, DesktopUninstallError>;
  }
>()("@t3tools/desktop/app/DesktopUninstall") {}

/** Walks up from a macOS executable path to find its enclosing `.app` bundle directory. */
export function resolveMacAppBundlePath(path: Path.Path, execPath: string): string | null {
  let current = path.resolve(execPath);
  for (;;) {
    if (current.endsWith(".app") && path.basename(current) !== ".app") {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Guards against ever scheduling deletion of a root, home, shared OS container directory, or
 * anything that could contain or belong to T3 Code's data.
 */
export function isSafeRemovalPath(input: {
  readonly path: Path.Path;
  readonly candidate: string;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): boolean {
  return isSafeK3RemovalPath(
    {
      path: input.path,
      platform: input.platform ?? "darwin",
      homeDirectory: input.homeDirectory,
      env: input.env ?? {},
    },
    input.candidate,
  );
}

export interface DesktopUninstallCandidateSet {
  readonly appBundlePath: string | null;
  readonly serviceUnitPaths: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
}

const isK3AppName = (name: string) => name.toLowerCase().replaceAll(" ", "").startsWith("k3code");

/**
 * Computes the filesystem paths that belong to K3 Code on the current OS.
 * Only paths that exist on disk are included in the final plan and cleanup invocation.
 * T3 Code's folders are never candidates, and `filterSafeRemovalPaths` refuses them again.
 */
export function collectDesktopUninstallCandidates(input: {
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly executablePath: string;
  readonly homeDirectory: string;
  readonly baseDir: string;
  readonly userDataPath: string;
  readonly linuxApplicationsDir: string;
  readonly linuxDesktopEntryName: string;
  readonly appImagePath: Option.Option<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): DesktopUninstallCandidateSet {
  const { path, platform, homeDirectory } = input;
  const context: UninstallPathContext = { path, platform, homeDirectory, env: input.env };
  const candidates: Array<string> = [
    input.baseDir,
    input.userDataPath,
    ...collectK3SystemPaths(context, { includeAppBundles: false }),
  ];
  const serviceUnitPaths: Array<string> = [];
  let appBundlePath: string | null = null;

  if (platform === "darwin") {
    for (const label of K3_MAC_LAUNCH_AGENT_LABELS) {
      const plistPath = path.join(homeDirectory, "Library", "LaunchAgents", `${label}.plist`);
      serviceUnitPaths.push(plistPath);
      candidates.push(plistPath);
    }
    if (input.isPackaged) {
      const bundle = resolveMacAppBundlePath(path, input.executablePath);
      if (bundle !== null && isK3AppName(path.basename(bundle))) {
        appBundlePath = bundle;
        candidates.push(bundle);
      }
    }
  } else if (platform === "linux") {
    const xdgConfigHome = input.env.XDG_CONFIG_HOME?.trim() || path.join(homeDirectory, ".config");
    candidates.push(path.join(input.linuxApplicationsDir, input.linuxDesktopEntryName));
    for (const unit of K3_LINUX_SYSTEMD_UNITS) {
      const unitPath = path.join(xdgConfigHome, "systemd", "user", unit);
      serviceUnitPaths.push(unitPath);
      candidates.push(unitPath);
    }
    if (input.isPackaged && Option.isSome(input.appImagePath)) {
      appBundlePath = path.resolve(input.appImagePath.value);
      candidates.push(appBundlePath);
    }
  } else if (platform === "win32") {
    if (input.isPackaged) {
      const installDir = path.dirname(path.resolve(input.executablePath));
      if (isK3AppName(path.basename(installDir))) {
        appBundlePath = installDir;
        candidates.push(installDir);
      }
    }
  }

  const safePaths = filterSafeRemovalPaths(context, candidates);
  const safeBundlePath =
    appBundlePath !== null && safePaths.includes(path.resolve(appBundlePath))
      ? path.resolve(appBundlePath)
      : null;

  return {
    appBundlePath: safeBundlePath,
    serviceUnitPaths,
    paths: safePaths,
  };
}

const POSIX_CLEANUP_SCRIPT = [
  'pid="$1"',
  "shift",
  "i=0",
  'while [ "$i" -lt 150 ] && kill -0 "$pid" 2>/dev/null; do',
  "  sleep 0.1",
  "  i=$((i + 1))",
  "done",
  'for target in "$@"; do',
  '  [ -n "$target" ] && rm -rf -- "$target" 2>/dev/null || true',
  "done",
].join("\n");

/** schtasks invocations that stop, disable, and unregister K3 Code's Windows background service. */
export function windowsServiceTaskCommands(
  taskName: string,
): ReadonlyArray<ReadonlyArray<string>> {
  return [
    ["/End", "/TN", taskName],
    ["/Change", "/TN", taskName, "/DISABLE"],
    ["/Delete", "/TN", taskName, "/F"],
  ];
}

/** The cmd.exe command line that waits for `pid` to exit, then deletes each target path. */
export function buildWindowsCleanupCommand(input: {
  readonly pid: number;
  readonly targetCount: number;
}): string {
  return buildWindowsWaitAndRemoveCommand({
    pid: input.pid,
    pathEnvNames: Array.from(
      { length: input.targetCount },
      (_, index) => `K3_UNINSTALL_TARGET_${index}`,
    ),
  });
}

/**
 * Spawns a detached OS helper that waits for the Electron app PID to exit and then
 * deletes all scheduled K3 Code paths.
 */
export function spawnDetachedDesktopCleanup(input: {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly paths: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<void, DesktopUninstallError> {
  if (input.paths.length === 0) return Effect.void;
  return Effect.callback<void, DesktopUninstallError>((resume) => {
    const child =
      input.platform === "win32"
        ? (() => {
            const comspec = input.env.ComSpec ?? input.env.COMSPEC ?? "cmd.exe";
            const envVars: Record<string, string> = {};
            for (const [index, target] of input.paths.entries()) {
              envVars[`K3_UNINSTALL_TARGET_${index}`] = target;
            }
            const command = buildWindowsCleanupCommand({
              pid: input.pid,
              targetCount: input.paths.length,
            });
            return NodeChildProcess.spawn(comspec, ["/d", "/v:off", "/s", "/c", command], {
              env: { ...process.env, ...envVars },
              windowsVerbatimArguments: true,
              detached: true,
              stdio: "ignore",
              windowsHide: true,
            });
          })()
        : NodeChildProcess.spawn(
            "/bin/sh",
            ["-c", POSIX_CLEANUP_SCRIPT, "k3-desktop-uninstall", String(input.pid), ...input.paths],
            {
              detached: true,
              stdio: "ignore",
            },
          );

    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resume(
        Effect.fail(
          new DesktopUninstallError({
            message: `Could not start the uninstall cleanup helper: ${error.message}`,
          }),
        ),
      );
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resume(Effect.void);
    });
  });
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const cliCommand = yield* DesktopCliCommand.DesktopCliCommand;
  const backendPool = yield* DesktopBackendPool.DesktopBackendPool;
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const electronApp = yield* ElectronApp.ElectronApp;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = yield* HostProcess.Environment;
  const executablePath = yield* HostProcess.ExecutablePath;

  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  const runIgnore = (command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      spawner
        .spawn(
          ChildProcess.make(command, [...args], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: "2 seconds",
          }),
        )
        .pipe(Effect.flatMap((handle) => handle.exitCode.pipe(Effect.timeout("5 seconds")))),
    ).pipe(Effect.ignore);

  const windowsTaskName = k3WindowsServiceTaskName(env.USERDOMAIN ?? "", env.USERNAME ?? "");

  const hasWindowsServiceTask = Effect.scoped(
    spawner
      .spawn(
        ChildProcess.make("schtasks", ["/Query", "/TN", windowsTaskName], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          forceKillAfter: "2 seconds",
        }),
      )
      .pipe(Effect.flatMap((handle) => handle.exitCode.pipe(Effect.timeout("5 seconds")))),
  ).pipe(
    Effect.map((code) => Number(code) === 0),
    Effect.orElseSucceed(() => false),
  );

  const stopBackgroundServices = Effect.gen(function* () {
    if (environment.platform === "darwin") {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      for (const label of K3_MAC_LAUNCH_AGENT_LABELS) {
        const plistPath = environment.path.join(
          environment.homeDirectory,
          "Library",
          "LaunchAgents",
          `${label}.plist`,
        );
        if (uid !== undefined) {
          yield* runIgnore("launchctl", ["bootout", `gui/${uid}/${label}`]);
        }
        yield* runIgnore("launchctl", ["unload", "-w", plistPath]);
      }
    } else if (environment.platform === "linux") {
      for (const unit of K3_LINUX_SYSTEMD_UNITS) {
        yield* runIgnore("systemctl", ["--user", "disable", "--now", unit]);
      }
      yield* runIgnore("systemctl", ["--user", "daemon-reload"]);
    } else if (environment.platform === "win32") {
      for (const args of windowsServiceTaskCommands(windowsTaskName)) {
        yield* runIgnore("schtasks", args);
      }
    }
  });

  const buildPlan = Effect.gen(function* () {
    const userDataPath = yield* appIdentity.resolveUserDataPath.pipe(
      Effect.mapError((error) => new DesktopUninstallError({ message: error.message })),
    );
    const candidates = collectDesktopUninstallCandidates({
      path: environment.path,
      platform: environment.platform,
      isPackaged: environment.isPackaged,
      executablePath,
      homeDirectory: environment.homeDirectory,
      baseDir: environment.baseDir,
      userDataPath,
      linuxApplicationsDir: environment.linuxApplicationsDir,
      linuxDesktopEntryName: environment.linuxDesktopEntryName,
      appImagePath: environment.appImagePath,
      env,
    });

    const existingPaths: Array<string> = [];
    const resolvedBaseDir = environment.path.resolve(environment.baseDir);
    for (const candidate of candidates.paths) {
      if (!(yield* exists(candidate))) continue;
      // K3CODE_HOME can point at any folder; only one shaped like a K3 home is removed whole.
      if (
        candidate === resolvedBaseDir &&
        !(yield* isK3HomeDirectory(candidate).pipe(
          Effect.provideService(Path.Path, environment.path),
          Effect.provideService(FileSystem.FileSystem, fs),
        ))
      ) {
        yield* logWarning("keeping the base directory: it does not look like a K3 Code home", {
          baseDir: candidate,
        });
        continue;
      }
      existingPaths.push(candidate);
    }

    let hasBackgroundService = environment.platform === "win32" && (yield* hasWindowsServiceTask);
    for (const unitPath of candidates.serviceUnitPaths) {
      if (hasBackgroundService) break;
      if (yield* exists(unitPath)) {
        hasBackgroundService = true;
        break;
      }
    }

    const cliState = yield* cliCommand.state;

    const plan: DesktopUninstallPlan = {
      supported: true,
      isPackaged: environment.isPackaged,
      appBundlePath:
        candidates.appBundlePath !== null && (yield* exists(candidates.appBundlePath))
          ? candidates.appBundlePath
          : null,
      baseDir: environment.baseDir,
      paths: existingPaths,
      hasBackgroundService,
      cliCommandPath: cliState.installedPath,
    };
    return plan;
  });

  const run = Effect.gen(function* () {
    const plan = yield* buildPlan;
    yield* logInfo("starting complete desktop uninstall", {
      pathCount: plan.paths.length,
      hasBackgroundService: plan.hasBackgroundService,
      cliCommandPath: plan.cliCommandPath,
      appBundlePath: plan.appBundlePath,
    });

    // 1. Remove the installed CLI command and any PATH entry we added.
    if (plan.cliCommandPath !== null) {
      yield* cliCommand.uninstall.pipe(
        Effect.catch((error) =>
          logWarning("failed to uninstall CLI command during complete uninstall", {
            error: error.message,
          }),
        ),
      );
    }

    // 2. Unload/disable any OS background service before deleting its files.
    yield* stopBackgroundServices;

    // 3. Stop all pooled local backend instances cleanly so SQLite databases close.
    const instances = yield* backendPool.list;
    yield* Effect.forEach(
      instances,
      (instance) =>
        instance
          .stop({ timeout: DesktopBackendManager.BACKEND_QUIT_STOP_TIMEOUT })
          .pipe(Effect.ignore),
      { concurrency: "unbounded" },
    );

    // 4. Spawn detached cleanup helper that deletes all K3 Code paths once Electron exits.
    yield* spawnDetachedDesktopCleanup({
      platform: environment.platform,
      pid: process.pid,
      paths: plan.paths,
      env,
    });

    // 5. Request clean app shutdown and quit Electron.
    yield* shutdown.request;
    yield* electronApp.quit;
  }).pipe(Effect.withSpan("desktop.uninstall.run"));

  return DesktopUninstall.of({
    getPlan: buildPlan.pipe(Effect.withSpan("desktop.uninstall.getPlan")),
    run,
  });
});

export const layer = Layer.effect(DesktopUninstall, make);
