import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const STAGING_DIRNAME = "legacy-import";
export const DATABASE_FILENAME = "statev2.sqlite";

// This environment's credentials (the desktop app's session, paired devices) live in the database.
// The snapshot takes them from the database it replaces, so nobody is signed out by the swap and
// T3 Code's credentials never carry over.
const AUTH_TABLES = ["auth_sessions", "auth_pairing_links", "auth_connect_devices"];

const quoteSqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const keepEnvironmentAuth = (stagedPath: string, currentPath: string) => {
  const database = new NodeSqlite.DatabaseSync(stagedPath);
  try {
    database.exec(`ATTACH DATABASE ${quoteSqlString(currentPath)} AS current`);
    const columns = (table: string, schema: string) =>
      database
        .prepare("SELECT name FROM pragma_table_info(?, ?)")
        .all(table, schema)
        .map((row) => String(row.name));
    database.exec("BEGIN");
    try {
      for (const table of AUTH_TABLES) {
        const stagedColumns = columns(table, "main");
        if (stagedColumns.length === 0) continue;
        database.exec(`DELETE FROM main.${table}`);
        const currentColumns = new Set(columns(table, "current"));
        const shared = stagedColumns
          .filter((column) => currentColumns.has(column))
          .map((column) => `"${column}"`)
          .join(", ");
        if (shared === "") continue;
        database.exec(
          `INSERT INTO main.${table} (${shared}) SELECT ${shared} FROM current.${table}`,
        );
      }
      database.exec("COMMIT");
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  } finally {
    database.close();
  }
};

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
 * Before the database opens: a snapshot staged by the import replaces it, and the previous
 * files stay beside it so nothing is lost.
 */
export const applyStagedLegacyImport = Effect.fn("LegacyImport.applyStaged")(
  function* (stateDir: string, databasePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stagingDir = path.join(stateDir, STAGING_DIRNAME);
    const staged = path.join(stagingDir, DATABASE_FILENAME);
    if (!(yield* fs.exists(staged))) return;
    if (yield* fs.exists(databasePath)) {
      yield* Effect.try(() => keepEnvironmentAuth(staged, databasePath)).pipe(
        Effect.ignoreCause({ log: true }),
      );
    }

    const stamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    for (const suffix of ["", "-wal", "-shm"]) {
      const current = `${databasePath}${suffix}`;
      if (yield* fs.exists(current)) {
        yield* fs.rename(current, `${databasePath}.before-import-${stamp}${suffix}`);
      }
    }
    yield* fs.rename(staged, databasePath);
    yield* fs.remove(stagingDir, { recursive: true, force: true });
    yield* Effect.logInfo("Applied staged T3 Code database import", { databasePath });
  },
  Effect.ignoreCause({ log: true }),
);
