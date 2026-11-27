import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  applyStagedLegacyImport,
  DATABASE_FILENAME,
  hasAppliedLegacyImport,
  hasStagedLegacyImport,
  runFirstStartAfterLegacyImport,
  STAGING_DIRNAME,
} from "./stagedImport.ts";

const createDatabase = (file: string, note: string, sessionColumns: ReadonlyArray<string>) => {
  const database = new NodeSqlite.DatabaseSync(file);
  try {
    database.exec("CREATE TABLE notes (value TEXT)");
    database.prepare("INSERT INTO notes VALUES (?)").run(note);
    database.exec(`CREATE TABLE auth_sessions (${sessionColumns.join(" TEXT, ")} TEXT)`);
    database.prepare("INSERT INTO auth_sessions (session_id) VALUES (?)").run(`${note}-sign-in`);
  } finally {
    database.close();
  }
};

const read = (file: string, sql: string) => {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return database
      .prepare(sql)
      .all()
      .map((row) => String(Object.values(row)[0]));
  } finally {
    database.close();
  }
};

it.layer(NodeServices.layer)("stagedImport", (it) => {
  it.effect("swaps in the staged database, keeping this install's sign-ins and old files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const dbPath = path.join(stateDir, DATABASE_FILENAME);
      createDatabase(dbPath, "current", ["session_id"]);
      yield* fs.writeFileString(`${dbPath}-wal`, "");
      yield* fs.makeDirectory(path.join(stateDir, STAGING_DIRNAME));
      createDatabase(path.join(stateDir, STAGING_DIRNAME, DATABASE_FILENAME), "imported", [
        "session_id",
      ]);
      assert.isTrue(yield* hasStagedLegacyImport(stateDir));

      yield* applyStagedLegacyImport(stateDir, dbPath);

      assert.deepEqual(read(dbPath, "SELECT value FROM notes"), ["imported"]);
      assert.deepEqual(read(dbPath, "SELECT session_id FROM auth_sessions"), ["current-sign-in"]);
      assert.isFalse(yield* hasStagedLegacyImport(stateDir));
      assert.isTrue(yield* hasAppliedLegacyImport(stateDir));
      const names = yield* fs.readDirectory(stateDir);
      const backup = names.find(
        (name) => name.includes(".before-import-") && !name.endsWith("-wal"),
      );
      assert.isDefined(backup);
      assert.deepEqual(read(path.join(stateDir, backup!), "SELECT value FROM notes"), ["current"]);
      assert.isTrue(
        names.some((name) => name.includes(".before-import-") && name.endsWith("-wal")),
      );
    }),
  );

  it.effect("keeps the current database when the staged one cannot take its sign-ins", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const dbPath = path.join(stateDir, DATABASE_FILENAME);
      createDatabase(dbPath, "current", ["session_id", "proof_key_thumbprint"]);
      yield* fs.makeDirectory(path.join(stateDir, STAGING_DIRNAME));
      createDatabase(path.join(stateDir, STAGING_DIRNAME, DATABASE_FILENAME), "imported", [
        "session_id",
      ]);

      yield* applyStagedLegacyImport(stateDir, dbPath);

      assert.deepEqual(read(dbPath, "SELECT value FROM notes"), ["current"]);
      assert.isFalse(yield* hasAppliedLegacyImport(stateDir));
    }),
  );

  it.effect("marks the import before the swap, so a swap cut short still starts as imported", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const dbPath = path.join(stateDir, DATABASE_FILENAME);
      createDatabase(dbPath, "current", ["session_id"]);
      yield* fs.makeDirectory(path.join(stateDir, STAGING_DIRNAME));
      createDatabase(path.join(stateDir, STAGING_DIRNAME, DATABASE_FILENAME), "imported", [
        "session_id",
      ]);
      // テストの時計は 1970 年から動かないので、退避先の名前が決まる。そこを塞いで差し替えを止める。
      const blocked = `${dbPath}.before-import-1970-01-01T00-00-00.000Z`;
      yield* fs.makeDirectory(path.join(blocked, "occupied"), { recursive: true });

      yield* applyStagedLegacyImport(stateDir, dbPath);

      assert.deepEqual(read(dbPath, "SELECT value FROM notes"), ["current"]);
      assert.isTrue(yield* hasStagedLegacyImport(stateDir));
      assert.isTrue(yield* hasAppliedLegacyImport(stateDir));
    }),
  );

  it.effect("puts the current database back when the swap fails after moving it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const dbPath = path.join(stateDir, DATABASE_FILENAME);
      createDatabase(dbPath, "current", ["session_id"]);
      yield* fs.writeFileString(`${dbPath}-wal`, "");
      yield* fs.makeDirectory(path.join(stateDir, STAGING_DIRNAME));
      createDatabase(path.join(stateDir, STAGING_DIRNAME, DATABASE_FILENAME), "imported", [
        "session_id",
      ]);
      // 本体は退避できて、-wal の退避先だけ塞がっている。
      const blocked = `${dbPath}.before-import-1970-01-01T00-00-00.000Z-wal`;
      yield* fs.makeDirectory(path.join(blocked, "occupied"), { recursive: true });

      yield* applyStagedLegacyImport(stateDir, dbPath);

      assert.deepEqual(read(dbPath, "SELECT value FROM notes"), ["current"]);
      assert.isTrue(yield* fs.exists(`${dbPath}-wal`));
      assert.isTrue(yield* hasStagedLegacyImport(stateDir));
    }),
  );

  it.effect("clears the import mark only after the first start succeeds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const seen: boolean[] = [];

      yield* runFirstStartAfterLegacyImport(stateDir, (imported) =>
        Effect.sync(() => void seen.push(imported)),
      );
      yield* fs.makeDirectory(path.join(stateDir, STAGING_DIRNAME));
      yield* fs.writeFileString(path.join(stateDir, STAGING_DIRNAME, "applied"), "");
      const failed = yield* Effect.exit(
        runFirstStartAfterLegacyImport(stateDir, (imported) =>
          Effect.sync(() => void seen.push(imported)).pipe(Effect.andThen(Effect.fail("crash"))),
        ),
      );
      assert.isTrue(Exit.isFailure(failed));
      assert.isTrue(yield* hasAppliedLegacyImport(stateDir));
      yield* runFirstStartAfterLegacyImport(stateDir, (imported) =>
        Effect.sync(() => void seen.push(imported)),
      );

      assert.deepEqual(seen, [false, true, true]);
      assert.isFalse(yield* hasAppliedLegacyImport(stateDir));
    }),
  );

  it.effect("leaves the database alone when nothing is staged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const dbPath = path.join(stateDir, DATABASE_FILENAME);
      yield* fs.writeFileString(dbPath, "current");

      yield* applyStagedLegacyImport(stateDir, dbPath);

      assert.equal(yield* fs.readFileString(dbPath), "current");
      assert.deepEqual(yield* fs.readDirectory(stateDir), [DATABASE_FILENAME]);
    }),
  );
});
