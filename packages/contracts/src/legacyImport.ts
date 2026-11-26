import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

/** What can be carried over from a K3 Code install on the same machine. */
export const LegacyImportKind = Schema.Literals(["settings", "providers", "sessions"]);
export type LegacyImportKind = typeof LegacyImportKind.Type;

export const LegacyImportScanInput = Schema.Struct({});
export type LegacyImportScanInput = typeof LegacyImportScanInput.Type;

export const LegacyImportItem = Schema.Struct({
  kind: LegacyImportKind,
  available: Schema.Boolean,
  // Provider instances for "providers"; bytes of the database for "sessions".
  count: Schema.optionalKey(NonNegativeInt),
  sizeBytes: Schema.optionalKey(NonNegativeInt),
});
export type LegacyImportItem = typeof LegacyImportItem.Type;

export const LegacyImportScanResult = Schema.Struct({
  // Null when no K3 Code data exists here, or this server already is that install.
  sourceDir: Schema.NullOr(Schema.String),
  items: Schema.Array(LegacyImportItem),
  // Sessions are staged and replace the database at the next server start.
  sessionsStaged: Schema.Boolean,
  // False when nothing would start this server again after it stops.
  canRestart: Schema.Boolean,
});
export type LegacyImportScanResult = typeof LegacyImportScanResult.Type;

export const LegacyImportRunInput = Schema.Struct({
  kinds: Schema.Array(LegacyImportKind),
});
export type LegacyImportRunInput = typeof LegacyImportRunInput.Type;

export const LegacyImportRunResult = Schema.Struct({
  applied: Schema.Array(LegacyImportKind),
  restartRequired: Schema.Boolean,
  // The other install's device-local UI settings; the calling client applies them itself.
  clientSettings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type LegacyImportRunResult = typeof LegacyImportRunResult.Type;

export const LegacyImportRestartInput = Schema.Struct({});
export type LegacyImportRestartInput = typeof LegacyImportRestartInput.Type;

export const LegacyImportRestartResult = Schema.Struct({ restarting: Schema.Boolean });
export type LegacyImportRestartResult = typeof LegacyImportRestartResult.Type;

export class LegacyImportError extends Schema.TaggedError<LegacyImportError>()(
  "LegacyImportError",
  {
    operation: Schema.Literals(["scan", "settings", "providers", "sessions"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not import ${this.operation} from K3 Code.`;
  }
}
