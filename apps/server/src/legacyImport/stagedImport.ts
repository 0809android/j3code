import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const STAGING_DIRNAME = "legacy-import";
export const DATABASE_FILENAME = "statev2.sqlite";
const APPLIED_MARKER_FILENAME = "applied";

// サインイン・ペアリング・接続した端末・ほかのパソコンとのつながりは、このインストールのもの。
// 取り込んだ側のものに替えると、このアプリが自分のサーバーからサインアウトされる。
const LOCAL_TABLES = [
  "auth_sessions",
  "auth_pairing_links",
  "auth_connect_devices",
  "peer_environment_links",
] as const;

export const tableColumns = (database: NodeSqlite.DatabaseSync, table: string) =>
  database
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => String(row.name));

/** このインストールの表にあって、取り込むデータベースにない表や列（`表.列`）。 */
export const missingLocalColumns = (copy: NodeSqlite.DatabaseSync, live: NodeSqlite.DatabaseSync) =>
  LOCAL_TABLES.flatMap((table) => {
    const copyColumns = new Set(tableColumns(copy, table));
    return tableColumns(live, table)
      .filter((column) => !copyColumns.has(column))
      .map((column) => `${table}.${column}`);
  });

// 差し替える直前に写すので、取り込んでから再起動するまでの失効やペアリングも反映される。
const keepLocalTables = (stagedPath: string, livePath: string) => {
  const staged = new NodeSqlite.DatabaseSync(stagedPath);
  const live = new NodeSqlite.DatabaseSync(livePath, { readOnly: true });
  try {
    const missing = missingLocalColumns(staged, live);
    if (missing.length > 0) {
      throw new Error(`The staged database lacks ${missing.join(", ")}.`);
    }
    staged.exec("BEGIN");
    for (const table of LOCAL_TABLES) {
      const columns = tableColumns(live, table);
      if (columns.length === 0) continue;
      staged.exec(`DELETE FROM "${table}"`);
      const list = columns.map((column) => `"${column}"`).join(", ");
      const insert = staged.prepare(
        `INSERT INTO "${table}" (${list}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      for (const row of live.prepare(`SELECT ${list} FROM "${table}"`).iterate()) {
        insert.run(...columns.map((column) => row[column] as NodeSqlite.SQLInputValue));
      }
    }
    staged.exec("COMMIT");
  } catch (error) {
    if (staged.isTransaction) staged.exec("ROLLBACK");
    throw error;
  } finally {
    live.close();
    staged.close();
  }
};

export class LegacyImportApplyError extends Schema.TaggedError<LegacyImportApplyError>()(
  "LegacyImportApplyError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not keep this install's sign-ins in the staged T3 Code database.";
  }
}

export const hasStagedLegacyImport = Effect.fn("LegacyImport.hasStaged")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs
    .exists(path.join(stateDir, STAGING_DIRNAME, DATABASE_FILENAME))
    .pipe(Effect.orElseSucceed(() => false));
});

/**
 * データベースを開く前に、取り込みで用意したコピーに差し替える。前のファイルは隣に残す。
 * どこかで失敗したら差し替えず、今のデータベースのまま起動する。
 */
export const applyStagedLegacyImport = Effect.fn("LegacyImport.applyStaged")(
  function* (stateDir: string, databasePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stagingDir = path.join(stateDir, STAGING_DIRNAME);
    const staged = path.join(stagingDir, DATABASE_FILENAME);
    if (!(yield* fs.exists(staged))) return;

    if (yield* fs.exists(databasePath)) {
      yield* Effect.try({
        try: () => keepLocalTables(staged, databasePath),
        catch: (cause) => new LegacyImportApplyError({ cause }),
      });
    }
    // 差し替えより先に書く。印がないまま差し替わると、取り込んだ作業がふつうに再開される。
    yield* fs.writeFileString(path.join(stagingDir, APPLIED_MARKER_FILENAME), "");
    const stamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const moved: Array<readonly [backup: string, current: string]> = [];
    yield* Effect.gen(function* () {
      for (const suffix of ["", "-wal", "-shm"]) {
        const current = `${databasePath}${suffix}`;
        if (yield* fs.exists(current)) {
          const backup = `${databasePath}.before-import-${stamp}${suffix}`;
          yield* fs.rename(current, backup);
          moved.push([backup, current]);
        }
      }
      yield* fs.rename(staged, databasePath);
    }).pipe(
      // 途中で失敗したら退避した今のデータベースを戻す。戻さないと空のデータベースで起動し、
      // 次の差し替えでサインインの記録も写せなくなる。本体を戻せたときだけ -wal と -shm も戻す。
      Effect.onError(() =>
        Effect.gen(function* () {
          const [main, ...sidecars] = moved;
          if (main === undefined) return;
          yield* fs.rename(main[0], main[1]);
          for (const [backup, current] of sidecars) {
            yield* fs.rename(backup, current).pipe(Effect.ignoreCause({ log: true }));
          }
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
    );
    yield* Effect.logInfo("Applied staged T3 Code database import", { databasePath });
  },
  Effect.ignoreCause({ log: true }),
);

const appliedMarker = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, STAGING_DIRNAME, APPLIED_MARKER_FILENAME);

/**
 * 取り込んだデータベースで、まだ起動を終えていないとき true。その実行や配送は取り込み元で
 * まだ動いているかもしれないので、続きを始めない。
 */
export const hasAppliedLegacyImport = Effect.fn("LegacyImport.hasApplied")(
  function* (stateDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.exists(appliedMarker(path, stateDir));
  },
  // 確かめられないときは、続きを始めない側に倒す。
  Effect.orElseSucceed(() => true),
);

/** 取り込み後の最初の起動処理が済んでから呼ぶ。 */
export const clearAppliedLegacyImport = Effect.fn("LegacyImport.clearApplied")(
  function* (stateDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(appliedMarker(path, stateDir), { force: true });
  },
  Effect.ignoreCause({ log: true }),
);

/**
 * 取り込み後の最初の起動なら `imported` を true にして `run` を実行し、成功したときだけ印を消す。
 * 途中で失敗したり落ちたりしたら、次の起動も同じ扱いにする。
 */
export const runFirstStartAfterLegacyImport = Effect.fn("LegacyImport.runFirstStart")(function* <
  A,
  E,
  R,
>(stateDir: string, run: (imported: boolean) => Effect.Effect<A, E, R>) {
  const imported = yield* hasAppliedLegacyImport(stateDir);
  const result = yield* run(imported);
  if (imported) yield* clearAppliedLegacyImport(stateDir);
  return result;
});
