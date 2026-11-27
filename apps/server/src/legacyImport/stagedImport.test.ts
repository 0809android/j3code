import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  applyStagedLegacyImport,
  DATABASE_FILENAME,
  clearAppliedLegacyImport,
  hasAppliedLegacyImport,
  hasStagedLegacyImport,
  STAGING_DIRNAME,
} from "./stagedImport.ts";

it.layer(NodeServices.layer)("stagedImport", (it) => {
  const seed = (file: string, statements: string) => {
    const database = new NodeSqlite.DatabaseSync(file);
    database.exec(statements);
    database.close();
  };
  const valueIn = (file: string) => {
    const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    try {
      return database.prepare("SELECT v FROM t").get()?.v;
    } finally {
      database.close();
    }
  };

  it.effect("swaps in the staged database and keeps the previous one beside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const dbPath = path.join(stateDir, DATABASE_FILENAME);
      yield* fs.makeDirectory(path.join(stateDir, STAGING_DIRNAME));
      seed(dbPath, "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('current');");
      seed(
        path.join(stateDir, STAGING_DIRNAME, DATABASE_FILENAME),
        "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('imported');",
      );
      assert.isTrue(yield* hasStagedLegacyImport(stateDir));

      yield* applyStagedLegacyImport(stateDir, dbPath);

      assert.equal(valueIn(dbPath), "imported");
      assert.isFalse(yield* hasStagedLegacyImport(stateDir));
      assert.isTrue(yield* hasAppliedLegacyImport(stateDir));
      yield* clearAppliedLegacyImport(stateDir);
      assert.isFalse(yield* hasAppliedLegacyImport(stateDir));
      const backup = (yield* fs.readDirectory(stateDir)).find((name) =>
        name.startsWith(`${DATABASE_FILENAME}.before-import-`),
      );
      assert.isDefined(backup);
      assert.equal(valueIn(path.join(stateDir, backup!)), "current");
    }),
  );

  it.effect("keeps the current database when the snapshot cannot be prepared", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const dbPath = path.join(stateDir, DATABASE_FILENAME);
      yield* fs.makeDirectory(path.join(stateDir, STAGING_DIRNAME));
      seed(dbPath, "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('current');");
      yield* fs.writeFileString(
        path.join(stateDir, STAGING_DIRNAME, DATABASE_FILENAME),
        "not a database",
      );

      yield* applyStagedLegacyImport(stateDir, dbPath);

      assert.equal(valueIn(dbPath), "current");
      assert.isTrue(yield* hasStagedLegacyImport(stateDir));
      assert.isFalse(yield* hasAppliedLegacyImport(stateDir));
    }),
  );

  it.effect("keeps this environment's credentials and cancels T3 Code's queued work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const dbPath = path.join(stateDir, DATABASE_FILENAME);
      const stagedPath = path.join(stateDir, STAGING_DIRNAME, DATABASE_FILENAME);
      yield* fs.makeDirectory(path.join(stateDir, STAGING_DIRNAME));
      seed(
        dbPath,
        `CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, subject TEXT, added_later TEXT);
         INSERT INTO auth_sessions VALUES ('k3-desktop', 'desktop', 'x');
         CREATE TABLE auth_pairing_links (id TEXT PRIMARY KEY);
         INSERT INTO auth_pairing_links VALUES ('k3-link');`,
      );
      seed(
        stagedPath,
        `CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, subject TEXT);
         INSERT INTO auth_sessions VALUES ('t3-desktop', 'desktop');
         CREATE TABLE auth_pairing_links (id TEXT PRIMARY KEY);
         INSERT INTO auth_pairing_links VALUES ('t3-link');
         CREATE TABLE threads (id TEXT);
         INSERT INTO threads VALUES ('imported-thread');
         CREATE TABLE orchestration_v2_effect_outbox (
           effect_id TEXT PRIMARY KEY, effect_type TEXT, status TEXT, lease_owner TEXT,
           completed_at TEXT, updated_at TEXT, last_error TEXT);
         INSERT INTO orchestration_v2_effect_outbox VALUES
           ('start', 'provider-turn.start', 'pending', NULL, NULL, NULL, NULL),
           ('continue', 'provider-runtime.continue', 'running', 'worker', NULL, NULL, NULL),
           ('checkpoint', 'checkpoint.capture', 'pending', NULL, NULL, NULL, NULL),
           ('done', 'provider-turn.start', 'succeeded', NULL, 'then', 'then', NULL);`,
      );

      yield* applyStagedLegacyImport(stateDir, dbPath);

      const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      const rows = (sql: string) =>
        database
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }));
      try {
        assert.deepEqual(rows("SELECT * FROM auth_sessions"), [
          { session_id: "k3-desktop", subject: "desktop" },
        ]);
        assert.deepEqual(rows("SELECT * FROM auth_pairing_links"), [{ id: "k3-link" }]);
        assert.deepEqual(rows("SELECT * FROM threads"), [{ id: "imported-thread" }]);
        assert.deepEqual(
          rows("SELECT effect_id, status, lease_owner FROM orchestration_v2_effect_outbox"),
          [
            { effect_id: "start", status: "cancelled", lease_owner: null },
            { effect_id: "continue", status: "cancelled", lease_owner: null },
            { effect_id: "checkpoint", status: "pending", lease_owner: null },
            { effect_id: "done", status: "succeeded", lease_owner: null },
          ],
        );
      } finally {
        database.close();
      }
    }),
  );

  it.effect("leaves the database alone when nothing is staged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const dbPath = path.join(stateDir, DATABASE_FILENAME);
      seed(dbPath, "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('current');");

      yield* applyStagedLegacyImport(stateDir, dbPath);

      assert.equal(valueIn(dbPath), "current");
      assert.deepEqual(yield* fs.readDirectory(stateDir), [DATABASE_FILENAME]);
      assert.isFalse(yield* hasAppliedLegacyImport(stateDir));
    }),
  );
});
