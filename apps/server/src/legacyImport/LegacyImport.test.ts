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
import { applyStagedLegacyImport } from "./stagedImport.ts";

const createDatabase = (file: string, migrationId: number, note: string) => {
  const database = new NodeSqlite.DatabaseSync(file);
  try {
    database.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY)");
    database.exec(`INSERT INTO effect_sql_migrations VALUES (${migrationId})`);
    database.exec("CREATE TABLE notes (value TEXT)");
    database.exec(`INSERT INTO notes VALUES ('${note}')`);
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
      createDatabase(config.dbPath, 5, "from k3 code");

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

      // The running database is untouched until the next start swaps the snapshot in.
      assert.equal(readNote(config.dbPath), "from k3 code");
      assert.isTrue((yield* importer.scan).sessionsStaged);
      yield* applyStagedLegacyImport(config.stateDir, config.dbPath);
      assert.equal(readNote(config.dbPath), "from t3 code");
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
