import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LegacyImport from "./LegacyImport.ts";
import {
  applyStagedLegacyImport,
  STAGING_DIRNAME,
  clearAppliedLegacyImport,
  hasAppliedLegacyImport,
} from "./stagedImport.ts";

const createDatabase = (file: string, migrationId: number, note: string) => {
  const database = new NodeSqlite.DatabaseSync(file);
  try {
    // 本物の V2 データベースは、作るときにこれを有効にする。
    database.exec("PRAGMA auto_vacuum = INCREMENTAL");
    database.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY)");
    database.exec(`INSERT INTO effect_sql_migrations VALUES (${migrationId})`);
    database.exec("CREATE TABLE notes (value TEXT)");
    database.exec(`INSERT INTO notes VALUES ('${note}')`);
  } finally {
    database.close();
  }
};

const addQueuedEffect = (file: string) => {
  const database = new NodeSqlite.DatabaseSync(file);
  try {
    database.exec(
      "CREATE TABLE orchestration_v2_effect_outbox (effect_id TEXT PRIMARY KEY, status TEXT NOT NULL, lease_owner TEXT, completed_at TEXT, updated_at TEXT, last_error TEXT)",
    );
    database.exec(
      "INSERT INTO orchestration_v2_effect_outbox VALUES ('queued', 'pending', NULL, NULL, NULL, NULL)",
    );
    database.exec(
      "INSERT INTO orchestration_v2_effect_outbox VALUES ('done', 'succeeded', NULL, NULL, NULL, NULL)",
    );
  } finally {
    database.close();
  }
};

const addAuthSession = (file: string, sessionId: string, columns: ReadonlyArray<string>) => {
  const database = new NodeSqlite.DatabaseSync(file);
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (${columns.join(" TEXT, ")} TEXT)`);
    database.prepare(`INSERT INTO auth_sessions (session_id) VALUES (?)`).run(sessionId);
  } finally {
    database.close();
  }
};

const addScheduledTask = (file: string) => {
  const database = new NodeSqlite.DatabaseSync(file);
  try {
    database.exec("CREATE TABLE scheduled_tasks (task_id TEXT, enabled INTEGER, updated_at TEXT)");
    database.exec("INSERT INTO scheduled_tasks VALUES ('nightly', 1, NULL)");
  } finally {
    database.close();
  }
};

const readEnabledTasks = (file: string) => {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return database
      .prepare("SELECT task_id FROM scheduled_tasks WHERE enabled = 1")
      .all()
      .map((row) => String(row.task_id));
  } finally {
    database.close();
  }
};

const readAuthSessions = (file: string) => {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return database
      .prepare("SELECT session_id FROM auth_sessions")
      .all()
      .map((row) => String(row.session_id));
  } finally {
    database.close();
  }
};

const readEffectStatuses = (file: string) => {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return database
      .prepare("SELECT effect_id, status FROM orchestration_v2_effect_outbox ORDER BY effect_id")
      .all()
      .map((row) => `${String(row.effect_id)}:${String(row.status)}`);
  } finally {
    database.close();
  }
};

const readNote = (file: string) => {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return (database.prepare("SELECT value FROM notes").get() as { value: string }).value;
  } finally {
    database.close();
  }
};

const layer = LegacyImport.layer.pipe(
  Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
  Layer.provideMerge(ServerConfig.ServerConfig.layerTest("/unused", { prefix: "k3-import-" })),
  Layer.provideMerge(
    Layer.effect(
      HostProcess.HomeDirectory,
      Effect.gen(function* () {
        return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "k3-home-",
        });
      }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("LegacyImport", (it) => {
  it.effect("finds nothing when there is no T3 Code data", () =>
    Effect.gen(function* () {
      const scan = yield* (yield* LegacyImport.LegacyImport).scan;
      assert.isNull(scan.sourceDir);
      assert.deepEqual(scan.items, []);
    }),
  );

  it.effect("imports settings and providers now and stages sessions for the next start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const home = yield* HostProcess.HomeDirectory;
      const legacy = path.join(home, ".t3", "userdata");
      yield* fs.makeDirectory(legacy, { recursive: true });
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(legacy, "settings.json"),
        JSON.stringify({
          defaultRuntimeMode: "approval-required",
          providerInstances: { codex: { driver: "codex", enabled: true } },
        }),
      );
      yield* fs.writeFileString(path.join(legacy, "keybindings.json"), "[]");
      yield* fs.writeFileString(
        path.join(legacy, "client-settings.json"),
        JSON.stringify({
          chatWidth: "wide",
          language: "en",
          onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      createDatabase(path.join(legacy, "statev2.sqlite"), 5, "from t3 code");
      addQueuedEffect(path.join(legacy, "statev2.sqlite"));
      addAuthSession(path.join(legacy, "statev2.sqlite"), "t3-sign-in", ["session_id", "subject"]);
      addScheduledTask(path.join(legacy, "statev2.sqlite"));
      createDatabase(config.dbPath, 5, "from k3 code");
      addAuthSession(config.dbPath, "k3-sign-in", ["session_id", "subject"]);

      const importer = yield* LegacyImport.LegacyImport;
      const scan = yield* importer.scan;
      assert.equal(scan.sourceDir, legacy);
      assert.deepEqual(
        scan.items.map((item) => [item.kind, item.available]),
        [
          ["settings", true],
          ["providers", true],
          ["sessions", true],
        ],
      );
      assert.equal(scan.items.find((item) => item.kind === "providers")?.count, 1);

      const result = yield* importer.run({ kinds: ["settings", "providers", "sessions"] });
      assert.deepEqual([...result.applied].sort(), ["providers", "sessions", "settings"]);
      assert.isTrue(result.restartRequired);
      assert.equal(result.clientSettings?.chatWidth, "wide");
      assert.isFalse("language" in (result.clientSettings ?? {}));
      assert.isFalse("onboardingCompletedAt" in (result.clientSettings ?? {}));
      assert.equal(yield* fs.readFileString(config.keybindingsConfigPath), "[]");

      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      assert.isDefined(
        settings.providerInstances["codex" as keyof typeof settings.providerInstances],
      );
      assert.equal(settings.defaultRuntimeMode, "approval-required");

      // 動いているデータベースは、次の起動で差し替えるまで変わらない。
      assert.equal(readNote(config.dbPath), "from k3 code");
      assert.isTrue((yield* importer.scan).sessionsStaged);
      // 取り込んでから再起動するまでのペアリングも残る。
      addAuthSession(config.dbPath, "k3-paired-later", ["session_id", "subject"]);
      yield* applyStagedLegacyImport(config.stateDir, config.dbPath);
      assert.equal(readNote(config.dbPath), "from t3 code");
      assert.isFalse((yield* importer.scan).sessionsStaged);
      // T3 Code が予約した処理はそちらに残し、取り込み後の起動だけが、コピーした実行だと分かる。
      assert.deepEqual(readEffectStatuses(config.dbPath), ["done:succeeded", "queued:cancelled"]);
      assert.deepEqual(readEffectStatuses(path.join(legacy, "statev2.sqlite")), [
        "done:succeeded",
        "queued:pending",
      ]);
      assert.deepEqual(readAuthSessions(config.dbPath), ["k3-sign-in", "k3-paired-later"]);
      assert.deepEqual(readEnabledTasks(config.dbPath), []);
      assert.deepEqual(readEnabledTasks(path.join(legacy, "statev2.sqlite")), ["nightly"]);
      assert.isTrue(yield* hasAppliedLegacyImport(config.stateDir));
      assert.isTrue(yield* hasAppliedLegacyImport(config.stateDir));
      yield* clearAppliedLegacyImport(config.stateDir);
      assert.isFalse(yield* hasAppliedLegacyImport(config.stateDir));
    }),
  );

  it.effect("stages nothing when the import stops before it finishes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const home = yield* HostProcess.HomeDirectory;
      const legacy = path.join(home, ".t3", "userdata");
      yield* fs.remove(path.join(legacy, "statev2.sqlite"), { force: true });
      createDatabase(path.join(legacy, "statev2.sqlite"), 5, "from t3 code");
      yield* fs.remove(config.dbPath, { force: true });
      createDatabase(config.dbPath, 5, "from k3 code");
      // データベースのコピーを書いたあとで、添付ファイルのコピーが失敗する。
      yield* fs.makeDirectory(path.join(legacy, "attachments", "thread"), { recursive: true });
      yield* fs.writeFileString(path.join(legacy, "attachments", "thread", "a.png"), "png");
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFileString(path.join(config.attachmentsDir, "thread"), "not a directory");

      const importer = yield* LegacyImport.LegacyImport;
      const failure = yield* Effect.flip(importer.run({ kinds: ["sessions"] }));
      assert.equal(failure.operation, "sessions");
      assert.isFalse((yield* importer.scan).sessionsStaged);
      assert.deepEqual(yield* fs.readDirectory(path.join(config.stateDir, STAGING_DIRNAME)), []);
      yield* fs.remove(path.join(legacy, "attachments"), { recursive: true });
      yield* fs.remove(path.join(config.attachmentsDir, "thread"));
    }),
  );

  it.effect("refuses T3 Code data too old to keep this app's sign-ins", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const home = yield* HostProcess.HomeDirectory;
      const legacy = path.join(home, ".t3", "userdata");
      yield* fs.remove(path.join(legacy, "statev2.sqlite"), { force: true });
      createDatabase(path.join(legacy, "statev2.sqlite"), 5, "from t3 code");
      addAuthSession(path.join(legacy, "statev2.sqlite"), "t3-sign-in", ["session_id"]);
      yield* fs.remove(config.dbPath, { force: true });
      createDatabase(config.dbPath, 5, "from k3 code");
      addAuthSession(config.dbPath, "k3-sign-in", ["session_id", "proof_key_thumbprint"]);

      const importer = yield* LegacyImport.LegacyImport;
      const failure = yield* Effect.flip(importer.run({ kinds: ["sessions"] }));
      assert.equal(failure.operation, "sessions");
      assert.isFalse((yield* importer.scan).sessionsStaged);
    }),
  );

  it.effect("refuses a database newer than this app", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const home = yield* HostProcess.HomeDirectory;
      const legacy = path.join(home, ".t3", "userdata");
      yield* fs.remove(path.join(legacy, "statev2.sqlite"), { force: true });
      createDatabase(path.join(legacy, "statev2.sqlite"), 99, "newer");
      yield* fs.remove(config.dbPath, { force: true });
      createDatabase(config.dbPath, 5, "older");

      const failure = yield* Effect.flip(
        (yield* LegacyImport.LegacyImport).run({ kinds: ["sessions"] }),
      );
      assert.equal(failure._tag, "LegacyImportError");
      assert.equal(failure.operation, "sessions");
      assert.equal(readNote(config.dbPath), "older");
    }),
  );
});
