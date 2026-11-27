import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { type DeviceLedger, makeDeviceLedger } from "@t3tools/shared/relay";
import { makeJsonFileLedgerStore } from "@t3tools/shared/relay/ledgerFile";

import * as ServerConfig from "../../config.ts";

/**
 * The host's K3 relay device ledger (spec §5): the only authority on which devices may connect.
 * A JSON file in the server's state directory, owner-only.
 */
export class RelayDeviceLedger extends Context.Service<RelayDeviceLedger, DeviceLedger>()(
  "t3/relay/k3relay/RelayDeviceLedger",
) {}

/** Where the relay keeps its host state and ledger. */
export const relayStateDirectory = (stateDir: string, path: Path.Path) =>
  path.join(stateDir, "k3relay");

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = relayStateDirectory(config.stateDir, path);
  // A ledger that cannot be written refuses every device; it never stops the server starting.
  yield* fs
    .makeDirectory(directory, { recursive: true, mode: 0o700 })
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not create the K3 relay state directory", cause),
      ),
    );
  const store = yield* makeJsonFileLedgerStore(path.join(directory, "devices.json"));
  return RelayDeviceLedger.of(yield* makeDeviceLedger(store));
});

export const layer = Layer.effect(RelayDeviceLedger, make);
