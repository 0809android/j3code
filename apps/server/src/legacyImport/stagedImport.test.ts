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
