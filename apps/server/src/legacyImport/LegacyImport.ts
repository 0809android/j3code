import * as NodeSqlite from "node:sqlite";

import {
  LegacyImportError,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ServerSettingsPatch,
  type LegacyImportItem,
  type LegacyImportKind,
  type LegacyImportRunInput,
  type LegacyImportRunResult,
  type LegacyImportScanResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as ServerSettings from "../serverSettings.ts";
import { DATABASE_FILENAME, STAGING_DIRNAME } from "./stagedImport.ts";

/** The home directory of the T3 Code this app was forked from. */
const LEGACY_HOME_DIRNAME = ".t3";

// General preferences only. Anything keyed by a project, a device, a credential or a path
// belongs to the other install and stays with it.
const SETTINGS_KEYS = [
  "defaultModelSelection",
  "fallbackModelSelection",
  "defaultRuntimeMode",
  "responseStreamingMode",
  "defaultTheme",
  "defaultThemeSetAt",
  "defaultAppearance",
  "defaultAppearanceSetAt",
  "favorites",
  "providerModelPreferences",
  "fastWorktreeCheckout",
  "enableProviderUpdateChecks",
  "continueThreadsAfterServerUpdate",
  "keepAwakeWhileAgentsWork",
  "idleCompaction",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleKeepPullRequests",
  "sidebarAutoSettleOnMerge",
  "autoResumeLimitedThreads",
  "snoozeLimitedThreads",
  "snoozePresets",
  "hiddenThreadTags",
  "hideTaggedThreads",
  "promptSuggestionsEnabled",
  "defaultAutoPull",
  "defaultProjectScripts",
  "workflowsEnabled",
  "linkedEnvironmentsEnabled",
  "storageCleanup",
  "worktreeCleanup",
] as const;

// Device-local settings that name this machine's hardware, profiles or onboarding progress.
const CLIENT_SETTINGS_SKIPPED_KEYS: ReadonlySet<string> = new Set([
  "onboardingCompletedAt",
  "language",
  "voiceMicrophone",
  "voiceMicrophones",
  "browserProfiles",
  "browserDefaultProfileId",
]);

export class LegacyImport extends Context.Service<
  LegacyImport,
  {
    readonly scan: Effect.Effect<LegacyImportScanResult, LegacyImportError>;
    readonly run: (
      input: LegacyImportRunInput,
    ) => Effect.Effect<LegacyImportRunResult, LegacyImportError>;
    /** Stops this server so its supervisor starts it again, which applies staged sessions. */
    readonly restart: Effect.Effect<boolean>;
  }
>()("t3/legacyImport/LegacyImport") {}

const quoteSqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const maxMigrationId = (databasePath: string) => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations")
      .get() as { readonly id: number | null } | undefined;
    return row?.id ?? 0;
  } finally {
    database.close();
  }
};

const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeServerSettingsPatchOption = Schema.decodeUnknownOption(ServerSettingsPatch);
const decodeServerSettingsPatch = Schema.decodeEffect(ServerSettingsPatch);
const decodeProviderInstanceConfigMap = Schema.decodeUnknownOption(ProviderInstanceConfigMap);
const isLegacyImportError = Schema.is(LegacyImportError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const restart = yield* DatabaseStorage.ServerRestart;
  const home = yield* HostProcess.HomeDirectory;

  const sourceDir = path.join(home, LEGACY_HOME_DIRNAME, "userdata");
  const sourceFile = (name: string) => path.join(sourceDir, name);
  const stagingDir = path.join(config.stateDir, STAGING_DIRNAME);
  const stagedDatabase = path.join(stagingDir, DATABASE_FILENAME);

  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const realPathOr = (target: string) =>
    fs.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  // This server already runs on the legacy home when started with T3CODE_HOME=~/.t3.
  const sourceIsUsable = Effect.gen(function* () {
    if (!(yield* exists(sourceDir))) return false;
    return (yield* realPathOr(sourceDir)) !== (yield* realPathOr(config.stateDir));
  });

  const readJsonObject = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.flatMap(decodeUnknownJson),
      Effect.map((value) =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? Option.some(value as Record<string, unknown>)
          : Option.none<Record<string, unknown>>(),
      ),
      Effect.orElseSucceed(() => Option.none<Record<string, unknown>>()),
    );

  const scan = Effect.gen(function* () {
    const sessionsStaged = yield* exists(stagedDatabase);
    const canRestart = restart !== null;
    if (!(yield* sourceIsUsable)) {
      return { sourceDir: null, items: [], sessionsStaged, canRestart };
    }
    const legacySettings = Option.getOrUndefined(
      yield* readJsonObject(sourceFile("settings.json")),
    );
    const providerCount = Object.keys(
      (legacySettings?.providerInstances as Record<string, unknown> | undefined) ?? {},
    ).length;
    const settingsAvailable = (yield* Effect.forEach(
      ["client-settings.json", "settings.json", "keybindings.json"],
      (name) => exists(sourceFile(name)),
    )).some(Boolean);
    const databaseInfo = yield* fs.stat(sourceFile(DATABASE_FILENAME)).pipe(Effect.option);
    const items: Array<LegacyImportItem> = [
      { kind: "settings", available: settingsAvailable },
      { kind: "providers", available: providerCount > 0, count: providerCount },
      {
        kind: "sessions",
        available: Option.isSome(databaseInfo),
        ...(Option.isSome(databaseInfo) ? { sizeBytes: Number(databaseInfo.value.size) } : {}),
      },
    ];
    return { sourceDir, items, sessionsStaged, canRestart };
  }).pipe(Effect.mapError((cause) => new LegacyImportError({ operation: "scan", cause })));

  const importSettings = Effect.gen(function* () {
    const legacy = yield* readJsonObject(sourceFile("settings.json"));
    if (Option.isSome(legacy)) {
      const patch: Record<string, unknown> = {};
      // Decoded key by key, so one setting this version no longer accepts skips only itself.
      for (const key of SETTINGS_KEYS) {
        if (
          key in legacy.value &&
          Option.isSome(decodeServerSettingsPatchOption({ [key]: legacy.value[key] }))
        ) {
          patch[key] = legacy.value[key];
        }
      }
      if (Object.keys(patch).length > 0) {
        yield* serverSettings.updateSettings(yield* decodeServerSettingsPatch(patch));
      }
    }

    const keybindings = sourceFile("keybindings.json");
    if (yield* exists(keybindings)) {
      if (yield* exists(config.keybindingsConfigPath)) {
        yield* fs.copyFile(
          config.keybindingsConfigPath,
          `${config.keybindingsConfigPath}.before-import`,
        );
      }
      yield* fs.copyFile(keybindings, config.keybindingsConfigPath);
    }

    const client = yield* readJsonObject(sourceFile("client-settings.json"));
    return Option.isSome(client)
      ? Object.fromEntries(
          Object.entries(client.value).filter(([key]) => !CLIENT_SETTINGS_SKIPPED_KEYS.has(key)),
        )
      : undefined;
  }).pipe(Effect.mapError((cause) => new LegacyImportError({ operation: "settings", cause })));

  const importProviders = Effect.gen(function* () {
    const legacy = yield* readJsonObject(sourceFile("settings.json"));
    if (Option.isNone(legacy)) return;
    const instances = decodeProviderInstanceConfigMap(legacy.value.providerInstances ?? {});
    if (Option.isNone(instances)) return;
    for (const [instanceId, instance] of Object.entries(instances.value)) {
      yield* serverSettings.updateProviderInstance({
        operation: "upsert",
        instanceId: ProviderInstanceId.make(instanceId),
        instance,
      });
    }
  }).pipe(Effect.mapError((cause) => new LegacyImportError({ operation: "providers", cause })));

  // The live database cannot be replaced while this server has it open. The snapshot waits in the
  // state directory and `applyStagedLegacyImport` swaps it in before the next start opens it.
  const stageSessions = Effect.gen(function* () {
    const source = sourceFile(DATABASE_FILENAME);
    yield* fs.makeDirectory(stagingDir, { recursive: true });
    yield* fs.remove(stagedDatabase, { force: true });
    const sessionsError = (cause: unknown) =>
      new LegacyImportError({ operation: "sessions", cause });
    // An older app cannot run a database a newer app has migrated.
    const compatible = yield* Effect.try({
      try: () => maxMigrationId(source) <= maxMigrationId(config.dbPath),
      catch: sessionsError,
    });
    if (!compatible) {
      return yield* sessionsError(
        "The T3 Code data is newer than this app. Update this app first.",
      );
    }
    yield* Effect.try({
      try: () => {
        const database = new NodeSqlite.DatabaseSync(source, { readOnly: true });
        try {
          database.exec(`VACUUM INTO ${quoteSqlString(stagedDatabase)}`);
        } finally {
          database.close();
        }
      },
      catch: sessionsError,
    });

    // Attachments are named by id, so files already here are never replaced.
    const sourceAttachments = sourceFile("attachments");
    if (yield* exists(sourceAttachments)) {
      const entries = yield* fs.readDirectory(sourceAttachments, { recursive: true });
      for (const entry of entries) {
        const from = path.join(sourceAttachments, entry);
        const to = path.join(config.attachmentsDir, entry);
        if ((yield* fs.stat(from)).type !== "File" || (yield* exists(to))) continue;
        yield* fs.makeDirectory(path.dirname(to), { recursive: true });
        yield* fs.copyFile(from, to);
      }
    }
  }).pipe(
    Effect.mapError((cause) =>
      isLegacyImportError(cause) ? cause : new LegacyImportError({ operation: "sessions", cause }),
    ),
  );

  const run = Effect.fn("LegacyImport.run")(function* (input: LegacyImportRunInput) {
    if (!(yield* sourceIsUsable)) {
      return yield* new LegacyImportError({
        operation: "scan",
        cause: "There is no T3 Code data to import.",
      });
    }
    const kinds = new Set<LegacyImportKind>(input.kinds);
    const applied: Array<LegacyImportKind> = [];
    let clientSettings: Record<string, unknown> | undefined;
    // Providers first: model preferences in settings may name their instances.
    if (kinds.has("providers")) {
      yield* importProviders;
      applied.push("providers");
    }
    if (kinds.has("settings")) {
      clientSettings = yield* importSettings;
      applied.push("settings");
    }
    if (kinds.has("sessions")) {
      yield* stageSessions;
      applied.push("sessions");
    }
    return {
      applied,
      restartRequired: kinds.has("sessions"),
      ...(clientSettings === undefined ? {} : { clientSettings }),
    } satisfies LegacyImportRunResult;
  });

  const restartServer = Effect.gen(function* () {
    if (restart === null) return false;
    // Let the response reach the client before the server stops.
    yield* restart.pipe(Effect.delay(Duration.millis(500)), Effect.forkDetach);
    return true;
  });

  return LegacyImport.of({ scan, run, restart: restartServer });
});

export const layer = Layer.effect(LegacyImport, make);
