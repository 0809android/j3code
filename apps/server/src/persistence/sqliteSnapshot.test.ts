import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { snapshotSqliteDatabase } from "./sqliteSnapshot.ts";

const createDatabase = (file: string, autoVacuum: "NONE" | "INCREMENTAL") => {
  const database = new NodeSqlite.DatabaseSync(file);
  try {
    database.exec(`PRAGMA auto_vacuum = ${autoVacuum}`);
    database.exec("CREATE TABLE notes (value TEXT)");
    database.exec("INSERT INTO notes VALUES ('kept')");
  } finally {
    database.close();
  }
};

const inspect = (file: string) => {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return {
      notes: database
        .prepare("SELECT value FROM notes")
        .all()
        .map((row) => String(row.value)),
      autoVacuum: Number(database.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum),
    };
  } finally {
    database.close();
  }
};

it.layer(NodeServices.layer)("snapshotSqliteDatabase", (it) => {
  // 0 は V1 のファイル、2 は T3 Code の V2 データベース。読み取り専用で同じ値を設定し直すと失敗する。
  it.effect.each(["NONE", "INCREMENTAL"] as const)(
    "copies a database whose auto_vacuum is %s into an incremental copy",
    (autoVacuum) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-snapshot-" });
        const source = path.join(dir, "source.sqlite");
        const snapshot = path.join(dir, "snapshot.sqlite");
        createDatabase(source, autoVacuum);

        yield* snapshotSqliteDatabase(source, snapshot);

        assert.deepEqual(inspect(snapshot), { notes: ["kept"], autoVacuum: 2 });
        assert.deepEqual(inspect(source), {
          notes: ["kept"],
          autoVacuum: autoVacuum === "NONE" ? 0 : 2,
        });
      }),
  );

  it.effect("lets the event loop run while it copies", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-snapshot-" });
      const source = path.join(dir, "source.sqlite");
      createDatabase(source, "INCREMENTAL");
      const order: string[] = [];

      // 同じスレッドでコピーすると、この予約はコピーが終わるまで動けない。
      setImmediate(() => order.push("event loop"));
      yield* snapshotSqliteDatabase(source, path.join(dir, "snapshot.sqlite"));
      order.push("snapshot");

      assert.deepEqual(order, ["event loop", "snapshot"]);
    }),
  );

  it.effect("fails instead of overwriting an existing file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-snapshot-" });
      const source = path.join(dir, "source.sqlite");
      const snapshot = path.join(dir, "snapshot.sqlite");
      createDatabase(source, "INCREMENTAL");
      yield* fs.writeFileString(snapshot, "already here");

      const failure = yield* Effect.flip(snapshotSqliteDatabase(source, snapshot));

      assert.equal(failure._tag, "SqliteSnapshotError");
      assert.equal(yield* fs.readFileString(snapshot), "already here");
    }),
  );
});
