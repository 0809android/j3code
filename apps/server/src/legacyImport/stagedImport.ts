import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const STAGING_DIRNAME = "legacy-import";
export const DATABASE_FILENAME = "statev2.sqlite";

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
