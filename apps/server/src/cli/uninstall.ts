// @effect-diagnostics nodeBuiltinImport:off
// Windows cleanup must outlive this executable to delete its directory; scoped ChildProcess kills children on exit.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import {
  buildWindowsWaitAndRemoveCommand,
  collectK3SystemPaths,
  filterSafeRemovalPaths,
  isK3HomeDirectory,
  isSafeRemovalPath,
} from "@t3tools/shared/uninstallTargets";
import * as BootService from "../cloud/bootService.ts";
import {
  findPosixLauncher,
  generatedWindowsShimTarget,
  isVersionExecutable,
  pinnedRuntimeVersionsDir,
  readPosixLauncherTarget,
  resolveLauncherPath,
} from "../cloud/pinnedRuntime.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { stateDirOwned } from "../serviceLauncher.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";
import { awaitDetachedSpawn } from "../process/windowsVerbatimSpawn.ts";
import { findWindowsShim } from "./update.ts";

export class CliUninstallError extends Schema.TaggedError<CliUninstallError>()(
  "CliUninstallError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface UninstallPlan {
  readonly service: boolean;
  readonly otherHomeService: string | undefined;
  readonly versionsDir: string;
  readonly launchers: ReadonlyArray<string>;
  readonly desktopShims: ReadonlyArray<string>;
  readonly runtimeDir: string | undefined;
  readonly userdataDir: string;
  readonly baseDir: string | undefined;
  readonly completePaths: ReadonlyArray<string>;
}

// The desktop app's `t3` launcher carries this line. T3 Code writes a different one, so a
// `t3` that belongs to T3 Code is never matched.
const DESKTOP_CLI_SHIM_MARKER = "Written by K3 Code: runs the desktop app's bundled t3 CLI.";

/** Candidate OS-level desktop app, cache, preference, and state paths removed by `--all`. */
export function collectCompleteRemovalCandidates(input: {
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ReadonlyArray<string> {
  const context = {
    path: input.path,
    platform: input.platform,
    homeDirectory: input.homeDir,
    env: input.env,
  };
  return filterSafeRemovalPaths(
    context,
    collectK3SystemPaths(context, { includeAppBundles: true }),
  );
}

/** Finds desktop-installed CLI symlinks/shims in standard user bin directories. */
export const findDesktopShimLaunchers = Effect.fn("cli.uninstall.find_desktop_shims")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const homeDir = yield* HostProcess.HomeDirectory;
  const dirs =
    platform === "darwin"
      ? [
          path.join(homeDir, ".local", "bin"),
          path.join(homeDir, "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
        ]
      : platform === "win32"
        ? [path.join(homeDir, ".local", "bin")]
        : [path.join(homeDir, ".local", "bin"), path.join(homeDir, "bin")];
  const names = platform === "win32" ? ["t3.cmd"] : ["t3"];
  const found: Array<string> = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File" || Number(info.value.size) > 16_384) {
        continue;
      }
      const contents = yield* fs.readFileString(candidate).pipe(Effect.orElseSucceed(() => ""));
      if (contents.includes(DESKTOP_CLI_SHIM_MARKER)) {
        found.push(candidate);
      }
    }
  }
  return found;
});

/** Delete only launchers targeting this home's runtime/versions. */
export const findOwnedLauncher = Effect.fn("cli.uninstall.find_launcher")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly versionsDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  if (input.launchedAs === undefined) return undefined;
  if (platform === "win32") {
    const shimPath = yield* findWindowsShim(input.launchedAs);
    if (shimPath === undefined) return undefined;
    const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
    const target = Option.isSome(contents) ? generatedWindowsShimTarget(contents.value) : undefined;
    return target !== undefined && isVersionExecutable(path, input.versionsDir, target)
      ? shimPath
      : undefined;
  }
  return yield* findPosixLauncher({ launchedAs: input.launchedAs, versionsDir: input.versionsDir });
});

/** Whether `launcher` is a link, unedited `t3` script, or unedited `t3.cmd` into this home's runtime/versions. */
const ownsLauncher = Effect.fn("cli.uninstall.owns_launcher")(function* (
  launcher: string,
  versionsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const realVersionsDir = yield* fs
    .realPath(versionsDir)
    .pipe(Effect.orElseSucceed(() => versionsDir));
  const scriptTarget = platform === "win32" ? undefined : yield* readPosixLauncherTarget(launcher);
  // The link or script text keeps a pruned (dangling) target; the real path sees through a
  // symlinked K3 home.
  const targets =
    platform === "win32"
      ? [
          yield* fs.readFileString(launcher).pipe(
            Effect.map(generatedWindowsShimTarget),
            Effect.orElseSucceed(() => undefined),
          ),
        ]
      : [
          yield* fs.readLink(launcher).pipe(
            Effect.map((link) => path.resolve(path.dirname(launcher), link)),
            Effect.orElseSucceed(() => undefined),
          ),
          yield* fs.realPath(launcher).pipe(Effect.orElseSucceed(() => undefined)),
          scriptTarget,
          scriptTarget !== undefined
            ? yield* fs.realPath(scriptTarget).pipe(Effect.orElseSucceed(() => undefined))
            : undefined,
        ];
  return targets.some(
    (target) =>
      target !== undefined &&
      (isVersionExecutable(path, versionsDir, target) ||
        isVersionExecutable(path, realVersionsDir, target)),
  );
});

/**
 * Launchers recorded in `runtime/launchers` by the install scripts and `t3 install` that still
 * point into this home's runtime/versions. npx can run a different version than the installed
 * one, so the launcher this process started from does not always name them.
 */
export const findRecordedLaunchers = Effect.fn("cli.uninstall.find_recorded_launchers")(function* (
  versionsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recorded = yield* fs
    .readFileString(path.join(path.dirname(versionsDir), "launchers"))
    .pipe(Effect.orElseSucceed(() => ""));
  const owned: Array<string> = [];
  for (const launcher of recorded.split(/\r?\n/).filter(Boolean)) {
    if (yield* ownsLauncher(launcher, versionsDir)) owned.push(launcher);
  }
  return owned;
});

// cmd.exe needs verbatim quoting and a literal path, with delayed expansion disabled. The shell
// waits for `pid` (this CLI) to exit before deleting.
export function spawnWindowsRemoval(comspec: string, dir: string, pid: number) {
  return NodeChildProcess.spawn(
    comspec,
    [
      "/d",
      "/v:off",
      "/s",
      "/c",
      buildWindowsWaitAndRemoveCommand({ pid, pathEnvNames: ["T3_UNINSTALL_RUNTIME"] }),
    ],
    {
      env: { ...process.env, T3_UNINSTALL_RUNTIME: dir },
      windowsVerbatimArguments: true,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
}

const planUninstall = Effect.fn("cli.uninstall.plan")(function* (input: {
  readonly baseDir: string;
  readonly complete: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const homeDir = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const installedBaseDir =
    status.supported && status.installed ? status.installedBaseDir : undefined;
  const servesThisHome = installedBaseDir !== undefined && status.otherBaseDir === undefined;
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const runtimeDir = path.dirname(versionsDir);
  const launchedAs = (yield* HostProcess.IsExecutable) ? yield* resolveLauncherPath : undefined;
  const launchedFrom = yield* findOwnedLauncher({ launchedAs, versionsDir });
  const baseDirExists = yield* fs.exists(input.baseDir).pipe(Effect.orElseSucceed(() => false));
  const completePaths: Array<string> = [];
  let desktopShims: ReadonlyArray<string> = [];
  if (input.complete && baseDirExists) {
    // --base-dir or K3CODE_HOME can point anywhere, including T3 Code's ~/.t3 or the home directory.
    const safeToRemove = isSafeRemovalPath(
      { path, platform, homeDirectory: homeDir, env },
      input.baseDir,
    );
    if (!safeToRemove) {
      return yield* new CliUninstallError({
        reason: `Refusing to remove ${input.baseDir}: it is the home directory, a shared system folder, or T3 Code's data.`,
      });
    }
    if (!(yield* isK3HomeDirectory(input.baseDir))) {
      return yield* new CliUninstallError({
        reason: `Refusing to remove ${input.baseDir}: it does not look like a K3 Code home (no userdata/ folder with K3 Code's data). Nothing was removed. Point --base-dir or K3CODE_HOME at the K3 Code home, or run without --all.`,
      });
    }
  }
  if (input.complete) {
    desktopShims = yield* findDesktopShimLaunchers();
    const candidates = collectCompleteRemovalCandidates({ path, platform, homeDir, env });
    for (const candidate of candidates) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        completePaths.push(candidate);
      }
    }
  }
  const plan: UninstallPlan = {
    service: servesThisHome,
    otherHomeService: servesThisHome ? undefined : installedBaseDir,
    versionsDir,
    launchers: [
      ...new Set([
        ...(launchedFrom === undefined ? [] : [launchedFrom]),
        ...(yield* findRecordedLaunchers(versionsDir)),
      ]),
    ],
    desktopShims,
    runtimeDir: (yield* fs.exists(runtimeDir).pipe(Effect.orElseSucceed(() => false)))
      ? runtimeDir
      : undefined,
    userdataDir: path.join(input.baseDir, "userdata"),
    baseDir: input.complete && baseDirExists ? input.baseDir : undefined,
    completePaths,
  };
  return plan;
});

/** Reads `serviceManaged` from the running server's `server-runtime.json`. */
const readServiceManaged = Effect.fn("cli.uninstall.read_service_managed")(function* (
  baseDir: string,
) {
  const path = yield* Path.Path;
  const state = yield* readPersistedServerRuntimeState(
    path.join(baseDir, "userdata", "server-runtime.json"),
  );
  return Option.isSome(state) && state.value.serviceManaged === true;
});

/**
 * Refuses to delete a home whose server is running, which is how the desktop app (or any
 * `t3 serve`) shows itself: its server holds the home's ownership lock. A server started by the
 * background service is fine, since the uninstall stops that service first.
 */
export const ensureNoRunningServer = Effect.fn("cli.uninstall.ensure_no_running_server")(
  function* (input: { readonly baseDir: string; readonly serviceWillBeRemoved: boolean }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = path.join(input.baseDir, "userdata");
    const traces = yield* Effect.all([
      fs.exists(path.join(stateDir, "server-owner.sqlite")),
      fs.exists(path.join(stateDir, "server-runtime.json")),
    ]).pipe(Effect.orElseSucceed(() => [false, false]));
    if (!traces.some(Boolean)) return;
    const owned = yield* Effect.tryPromise({
      try: () => stateDirOwned(input.baseDir),
      catch: (cause) =>
        new CliUninstallError({
          reason: `Could not tell whether K3 Code is running for ${input.baseDir}: ${String(cause)}. Nothing was removed.`,
        }),
    });
    if (!owned) return;
    if (input.serviceWillBeRemoved && (yield* readServiceManaged(input.baseDir))) return;
    return yield* new CliUninstallError({
      reason: `K3 Code is running and using ${input.baseDir} (the desktop app, or a server started with \`t3 serve\`). Quit it first, then run uninstall again. Nothing was removed.`,
    });
  },
);

interface RemovalTarget {
  readonly path: string;
  readonly describe: string;
  readonly recursive: boolean;
}

/**
 * Removes every target, recording a failure and moving on so one locked file does not leave
 * the rest installed. Returns the descriptions of what could not be removed.
 */
export const removeBestEffort = Effect.fn("cli.uninstall.remove_best_effort")(function* (
  targets: ReadonlyArray<RemovalTarget>,
) {
  const fs = yield* FileSystem.FileSystem;
  const failures: Array<string> = [];
  for (const target of targets) {
    yield* fs.remove(target.path, { recursive: target.recursive, force: true }).pipe(
      Effect.matchEffect({
        onSuccess: () => Console.log(`Removed ${target.path}.`),
        onFailure: () =>
          Effect.sync(() => failures.push(target.describe)).pipe(
            Effect.andThen(Console.log(`Could not remove ${target.path}.`)),
          ),
      }),
    );
  }
  return failures;
});

export const uninstallCommand = Command.make("uninstall", {
  ...projectLocationFlags,
  all: Flag.Boolean("all").pipe(
    Flag.withAlias("a"),
    Flag.withDescription(
      "Completely remove K3 Code: also delete all user data, databases, settings, caches, preferences, and the desktop app.",
    ),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Remove everything without asking. Required from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Remove K3 Code from this machine: the background service, launchers, and downloaded versions. Pass --all to also remove user data, caches, preferences, and the desktop app.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUninstall({
        baseDir: config.baseDir,
        complete: flags.all,
        assumeYes: flags.yes,
      }).pipe(Effect.provide(CliService.layer(config)));
    }),
  ),
);

const logOtherHomeService = (plan: UninstallPlan) =>
  plan.otherHomeService === undefined
    ? Effect.void
    : Console.log(
        `The K3 Code service serves ${plan.otherHomeService}, so it was not removed. Pass \`${BootService.formatBootServiceBaseDirOption(plan.otherHomeService)}\` to remove it.`,
      );

const runUninstall = Effect.fn("cli.uninstall.run")(function* (input: {
  readonly baseDir: string;
  readonly complete: boolean;
  readonly assumeYes: boolean;
}) {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const service = yield* BootService.BootService;
  const plan = yield* planUninstall({ baseDir: input.baseDir, complete: input.complete });
  if (input.complete && plan.baseDir !== undefined) {
    yield* ensureNoRunningServer({ baseDir: plan.baseDir, serviceWillBeRemoved: plan.service });
  }

  const hasNothing =
    !plan.service &&
    plan.launchers.length === 0 &&
    plan.desktopShims.length === 0 &&
    plan.runtimeDir === undefined &&
    plan.baseDir === undefined &&
    plan.completePaths.length === 0;

  if (hasNothing) {
    yield* Console.log(`Nothing to remove: K3 Code is not installed for ${input.baseDir}.`);
    if (!(yield* HostProcess.IsExecutable)) {
      yield* Console.log(
        "  This CLI runs from a Node script, so it was installed by npm or built from source. Remove it the same way (`npm uninstall -g t3`, or delete the checkout).",
      );
    }
    yield* logOtherHomeService(plan);
    return;
  }

  yield* Console.log("This will remove:");
  if (plan.service) yield* Console.log("  the background service (stopping it first)");
  for (const launcher of plan.launchers) yield* Console.log(`  the launcher at ${launcher}`);
  for (const shim of plan.desktopShims) yield* Console.log(`  the desktop CLI launcher at ${shim}`);
  if (plan.baseDir !== undefined) {
    yield* Console.log(`  all K3 Code data, settings, and versions under ${plan.baseDir}`);
  } else if (plan.runtimeDir !== undefined) {
    yield* Console.log(`  every downloaded version under ${plan.runtimeDir}`);
  }
  for (const target of plan.completePaths) {
    yield* Console.log(`  ${target}`);
  }
  if (!input.complete) {
    yield* Console.log(
      `Your projects, threads, and settings under ${plan.userdataDir} are kept. Pass --all to remove K3 Code completely, including user data, caches, preferences, and the desktop app.`,
    );
  }

  if (!input.assumeYes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUninstallError({
        reason:
          "Not a terminal, so nothing was removed. Rerun with --yes to confirm from a script.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({
        message: input.complete
          ? "Permanently remove K3 Code and ALL its data from this machine?"
          : "Remove K3 Code from this machine?",
        initial: false,
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  // The prompt can wait a long time; keep a service or launcher that changed hands meanwhile.
  if (plan.service && (yield* service.status).otherBaseDir !== undefined) {
    yield* Console.log("Left the background service: it now serves another K3 home.");
  } else if (plan.service) {
    yield* service.uninstall;
    yield* Console.log("Removed the background service.");
  }
  const failures: Array<string> = [];
  const launchersToRemove: Array<RemovalTarget> = [];
  for (const launcher of plan.launchers) {
    if (!(yield* ownsLauncher(launcher, plan.versionsDir))) {
      yield* Console.log(`Left ${launcher}: it no longer runs this installation.`);
      continue;
    }
    launchersToRemove.push({
      path: launcher,
      describe: `the launcher at ${launcher}`,
      recursive: false,
    });
  }
  failures.push(
    ...(yield* removeBestEffort([
      ...launchersToRemove,
      ...plan.desktopShims.map((shim) => ({
        path: shim,
        describe: `the desktop CLI launcher at ${shim}`,
        recursive: false,
      })),
      ...plan.completePaths.map((target) => ({
        path: target,
        describe: target,
        recursive: true,
      })),
    ])),
  );
  const dirToRemove = plan.baseDir ?? plan.runtimeDir;
  if (dirToRemove !== undefined) {
    // Windows refuses to unlink this running executable; a detached shell removes it after exit.
    if (platform === "win32") {
      const comspec = environment["ComSpec"] ?? environment["COMSPEC"] ?? "cmd.exe";
      yield* awaitDetachedSpawn(() => spawnWindowsRemoval(comspec, dirToRemove, process.pid)).pipe(
        Effect.matchEffect({
          onSuccess: () => Console.log(`${dirToRemove} will be removed once the CLI exits.`),
          onFailure: () =>
            Effect.sync(() =>
              failures.push(`${dirToRemove} (delete it yourself once this window is closed)`),
            ).pipe(Effect.andThen(Console.log(`Could not schedule removal of ${dirToRemove}.`))),
        }),
      );
    } else {
      failures.push(
        ...(yield* removeBestEffort([
          { path: dirToRemove, describe: dirToRemove, recursive: true },
        ])),
      );
    }
  }
  if (failures.length > 0) {
    yield* Console.log("");
    yield* Console.log("These could not be removed:");
    for (const failure of failures) yield* Console.log(`  ${failure}`);
    yield* logOtherHomeService(plan);
    return yield* new CliUninstallError({
      reason: `Uninstall finished, but ${failures.length} item(s) could not be removed (listed above). Close anything using them and run uninstall again.`,
    });
  }
  yield* Console.log("");
  yield* Console.log(
    input.complete
      ? "K3 Code has been completely uninstalled."
      : "K3 Code is uninstalled. Thanks for trying K3 Code.",
  );
  yield* logOtherHomeService(plan);
});
