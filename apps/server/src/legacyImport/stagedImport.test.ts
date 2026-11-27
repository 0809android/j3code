import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  applyStagedLegacyImport,
  DATABASE_FILENAME,
  hasStagedLegacyImport,
  STAGING_DIRNAME,
} from "./stagedImport.ts";

it.layer(NodeServices.layer)("stagedImport", (it) => {
  it.effect("swaps in the staged database and keeps the previous files beside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const dbPath = path.join(stateDir, DATABASE_FILENAME);
      yield* fs.writeFileString(dbPath, "current");
      yield* fs.writeFileString(`${dbPath}-wal`, "current-wal");
      yield* fs.makeDirectory(path.join(stateDir, STAGING_DIRNAME));
      yield* fs.writeFileString(
        path.join(stateDir, STAGING_DIRNAME, DATABASE_FILENAME),
        "imported",
      );
      assert.isTrue(yield* hasStagedLegacyImport(stateDir));

      yield* applyStagedLegacyImport(stateDir, dbPath);

      assert.equal(yield* fs.readFileString(dbPath), "imported");
      assert.isFalse(yield* fs.exists(`${dbPath}-wal`));
      assert.isFalse(yield* hasStagedLegacyImport(stateDir));
      const names = yield* fs.readDirectory(stateDir);
      const backup = names.find(
        (name) => name.includes(".before-import-") && !name.endsWith("-wal"),
      );
      assert.isDefined(backup);
      assert.equal(yield* fs.readFileString(path.join(stateDir, backup!)), "current");
      assert.isTrue(
        names.some((name) => name.includes(".before-import-") && name.endsWith("-wal")),
      );
    }),
  );

  it.effect("keeps this environment's credentials and drops T3 Code's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-staged-" });
      const dbPath = path.join(stateDir, DATABASE_FILENAME);
      const stagedPath = path.join(stateDir, STAGING_DIRNAME, DATABASE_FILENAME);
      yield* fs.makeDirectory(path.join(stateDir, STAGING_DIRNAME));
      const seed = (file: string, statements: string) => {
        const database = new NodeSqlite.DatabaseSync(file);
        database.exec(statements);
        database.close();
      };
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
         INSERT INTO threads VALUES ('imported-thread');`,
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
      yield* fs.writeFileString(dbPath, "current");

      yield* applyStagedLegacyImport(stateDir, dbPath);

      assert.equal(yield* fs.readFileString(dbPath), "current");
      assert.deepEqual(yield* fs.readDirectory(stateDir), [DATABASE_FILENAME]);
    }),
  );
});
