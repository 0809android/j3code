import { createPersistentSidecarClient } from "@t3tools/shared/nativeSidecarWorker";

import type { TranscriptFile } from "./usageTranscriptReader.ts";

export interface NativeListResult {
  readonly files: readonly TranscriptFile[];
  readonly walked: readonly string[];
  readonly failedPaths: number;
}

export interface NativeFilterLinesResult {
  readonly ok: boolean;
  readonly resumed: boolean;
  readonly resumeOffset: number;
  readonly guardLength: number;
  readonly guardHash: number;
  readonly matchedLines: readonly string[];
  readonly tailLine?: string;
  readonly oversizedSkipped: number;
}

const scannerClient = createPersistentSidecarClient({
  binaryBaseName: "j3-usage-scanner",
  envPathVar: "J3CODE_USAGE_SCANNER_PATH",
  crateDirName: "j3-usage-scanner",
  anchorDir: import.meta.dirname,
  defaultTimeoutMs: 30_000,
});

export function listTranscriptFilesNative(
  root: string,
  sinceMs: number,
  options?: { readonly fileName?: string },
): Promise<NativeListResult | null> {
  return scannerClient.request<NativeListResult>({
    command: "list",
    root,
    sinceMs,
    ...(options?.fileName === undefined ? {} : { fileName: options.fileName }),
  });
}

export function filterTranscriptLinesNative(input: {
  readonly path: string;
  readonly markers: readonly string[];
  readonly resumeOffset?: number;
  readonly guardLength?: number;
  readonly guardHash?: number;
  readonly maxLineBytes?: number;
}): Promise<NativeFilterLinesResult | null> {
  return scannerClient.request<NativeFilterLinesResult>({
    command: "filter-lines",
    ...input,
  });
}
