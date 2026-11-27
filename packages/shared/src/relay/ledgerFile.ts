import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as HostProcess from "../HostProcess.ts";
import {
  type LedgerDevice,
  type LedgerStore,
  LedgerStoreError,
  decodeLedgerFile,
  encodeLedgerFile,
  isConsistent,
} from "./ledger.ts";

// Host only: it reads the host's filesystem and platform, so clients must not import it.
const OWNER_ONLY = 0o600;

/**
 * A JSON file, written atomically (temp file, fsync, rename) and kept owner-only (`0600`),
 * including when an older copy was more open.
 */
export const makeJsonFileLedgerStore = Effect.fn("relay.makeJsonFileLedgerStore")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const platform = yield* HostProcess.Platform;
  const storeError = (detail: string) => () => new LedgerStoreError({ detail });

  const load = Effect.gen(function* () {
    const exists = yield* fs.exists(filePath);
    if (!exists) return [];
    const text = yield* fs.readFileString(filePath);
    const file = yield* decodeLedgerFile(text).pipe(
      Effect.mapError(storeError("The device ledger file is corrupt.")),
    );
    if (!file.devices.every(isConsistent)) {
      return yield* new LedgerStoreError({ detail: "The device ledger file is inconsistent." });
    }
    return file.devices;
  }).pipe(Effect.catchTags({ PlatformError: storeError("The device ledger could not be read.") }));

  const save = Effect.fn("relay.ledgerFile.save")(
    function* (devices: ReadonlyArray<LedgerDevice>) {
      const contents = yield* encodeLedgerFile({ version: 1, devices }).pipe(
        Effect.mapError(storeError("The device ledger could not be encoded.")),
      );
      // The atomic write keeps the replaced file's mode, so narrow it first.
      if (platform !== "win32" && (yield* fs.exists(filePath))) {
        yield* fs.chmod(filePath, OWNER_ONLY);
      }
      yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` });
    },
    Effect.catchTags({ PlatformError: storeError("The device ledger could not be written.") }),
    Effect.provide(context),
  );

  return { load, save } satisfies LedgerStore;
});
