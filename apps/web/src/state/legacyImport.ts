import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const legacyImportScan = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:legacy-import:scan",
  tag: WS_METHODS.legacyImportScan,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
});

export const legacyImportRun = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:legacy-import:run",
  tag: WS_METHODS.legacyImportRun,
});

export const legacyImportRestart = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:legacy-import:restart",
  tag: WS_METHODS.legacyImportRestart,
});
