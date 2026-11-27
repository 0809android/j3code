import * as NodeSqlite from "node:sqlite";

import { LegacyImportError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { PROCESS_BOUND_EFFECT_TYPES } from "../orchestration-v2/EffectOutbox.ts";

export const STAGING_DIRNAME = "legacy-import";
export const DATABASE_FILENAME = "statev2.sqlite";
// Exists while the database is the one just swapped in from T3 Code, until startup has recovered it.
const APPLIED_MARKER_FILENAME = "legacy-import-applied";

// This environment's credentials (the desktop app's session, paired devices) live in the database.
// The snapshot takes them from the database it replaces, so nobody is signed out by the swap and
// T3 Code's credentials never carry over.
const AUTH_TABLES = ["auth_sessions", "auth_pairing_links", "auth_connect_devices"];
const OUTBOX_TABLE = "orchestration_v2_effect_outbox";
const IMPORT_CANCELLED_EFFECT_TYPES: ReadonlyArray<string> = [
  ...PROCESS_BOUND_EFFECT_TYPES,
  "provider-runtime.continue",
];

const quoteSqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const inTransaction = (database: NodeSqlite.DatabaseSync, work: () => void) => {
  database.exec("BEGIN");
  try {
    work();
    database.exec("COMMIT");
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
};

const prepareSnapshot = (stagedPath: string, currentPath: string | null, now: string) => {
  const database = new NodeSqlite.DatabaseSync(stagedPath);
  try {
    const columns = (table: string, schema: string) =>
      database
        .prepare("SELECT name FROM pragma_table_info(?, ?)")
        .all(table, schema)
        .map((row) => String(row.name));
    if (currentPath !== null) {
      database.exec(`ATTACH DATABASE ${quoteSqlString(currentPath)} AS current`);
      inTransaction(database, () => {
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
      });
    }
    // Provider work T3 Code had queued, including its own restart continuations, is still T3 Code's.
    if (columns(OUTBOX_TABLE, "main").length > 0) {
      const end = (status: "cancelled" | "failed") =>
        database
          .prepare(
            `UPDATE ${OUTBOX_TABLE} SET status = ?, lease_owner = NULL, completed_at = ?,
               updated_at = ?, last_error = ?
             WHERE status IN ('pending', 'running')
               AND effect_type IN (${IMPORT_CANCELLED_EFFECT_TYPES.map(() => "?").join(", ")})`,
          )
          .run(
            status,
            now,
            now,
            "Queued in T3 Code before this database was imported.",
            ...IMPORT_CANCELLED_EFFECT_TYPES,
          );
      // Databases from before effect cancellation allow only 'failed' as an end state.
      inTransaction(database, () => {
        try {
          end("cancelled");
        } catch {
          end("failed");
        }
      });
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
    const marker = path.join(stateDir, APPLIED_MARKER_FILENAME);
    if (!(yield* fs.exists(staged))) return;

    const now = yield* DateTime.now;
    const currentPath = (yield* fs.exists(databasePath)) ? databasePath : null;
    // A snapshot that keeps T3 Code's credentials or queued work is not swapped in; the next start retries.
    yield* Effect.try({
      try: () => prepareSnapshot(staged, currentPath, DateTime.formatIso(now)),
      catch: (cause) => new LegacyImportError({ operation: "sessions", cause }),
    }).pipe(
      // A mark left by a swap that never finished would treat this app's own database as imported.
      Effect.tapError(() => fs.remove(marker, { force: true }).pipe(Effect.ignore)),
    );

    // Written first so no swapped-in snapshot is ever recovered as this app's own work.
    yield* fs.writeFileString(marker, "");
    const stamp = DateTime.formatIso(now).replaceAll(":", "-");
    const moved: Array<readonly [string, string]> = [];
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
      Effect.onError(() =>
        Effect.gen(function* () {
          for (const [backup, current] of moved) yield* fs.rename(backup, current);
          yield* fs.remove(marker, { force: true });
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
    );
    yield* Effect.logInfo("Applied staged T3 Code database import", { databasePath });
    yield* fs.remove(stagingDir, { recursive: true, force: true });
  },
  Effect.ignoreCause({ log: true }),
);

/** Whether the database was swapped in from T3 Code and startup has not recovered it yet. */
export const hasAppliedLegacyImport = Effect.fn("LegacyImport.hasApplied")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Unreadable counts as imported: continuing T3 Code's turns here is the worse mistake.
  return yield* fs
    .exists(path.join(stateDir, APPLIED_MARKER_FILENAME))
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check for the T3 Code import mark", { cause }).pipe(
          Effect.as(true),
        ),
      ),
    );
});

export const clearAppliedLegacyImport = Effect.fn("LegacyImport.clearApplied")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .remove(path.join(stateDir, APPLIED_MARKER_FILENAME), { force: true })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Could not clear the T3 Code import mark; interrupted turns will not continue after restarts until it is removed",
          { cause },
        ),
      ),
    );
});
