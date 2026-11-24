import { createPersistentSidecarClient } from "@t3tools/shared/nativeSidecarWorker";

interface NativeWorkspaceFileEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly score: number;
}

interface NativeWorkspaceFilesResult {
  readonly entries: readonly NativeWorkspaceFileEntry[];
  readonly truncated: boolean;
  readonly scannedFiles: number;
}

interface NativeWorkspaceGrepMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly matchLen?: number;
  readonly text: string;
}

interface NativeWorkspaceGrepResult {
  readonly matches: readonly NativeWorkspaceGrepMatch[];
  readonly truncated: boolean;
  readonly searchedFiles: number;
  readonly error?: string;
}

interface NativeCheckIgnoreResult {
  readonly ignored: readonly string[];
  readonly ok: boolean;
}

const searchClient = createPersistentSidecarClient({
  binaryBaseName: "j3-workspace-search",
  envPathVar: "J3CODE_WORKSPACE_SEARCH_PATH",
  crateDirName: "j3-workspace-search",
  anchorDir: import.meta.dirname,
  defaultTimeoutMs: 15_000,
});

export function searchWorkspaceFilesNative(input: {
  readonly cwd: string;
  readonly query?: string;
  readonly limit?: number;
  readonly includeHidden?: boolean;
}): Promise<NativeWorkspaceFilesResult | null> {
  return searchClient.request<NativeWorkspaceFilesResult>({
    command: "files",
    cwd: input.cwd,
    query: input.query ?? "",
    limit: input.limit ?? 100,
    includeHidden: input.includeHidden ?? false,
  });
}

export function grepWorkspaceContentsNative(input: {
  readonly cwd: string;
  readonly query: string;
  readonly caseSensitive?: boolean;
  readonly useRegex?: boolean;
  readonly wholeWord?: boolean;
  readonly limit?: number;
  readonly maxPerFile?: number;
}): Promise<NativeWorkspaceGrepResult | null> {
  return searchClient.request<NativeWorkspaceGrepResult>({
    command: "grep",
    cwd: input.cwd,
    query: input.query,
    caseSensitive: input.caseSensitive ?? false,
    useRegex: input.useRegex ?? false,
    wholeWord: input.wholeWord ?? false,
    limit: input.limit ?? 100,
    maxPerFile: input.maxPerFile ?? 20,
  });
}

export function checkIgnoredPathsNative(input: {
  readonly cwd: string;
  readonly paths: ReadonlyArray<{ readonly path: string; readonly isDir: boolean }>;
}): Promise<NativeCheckIgnoreResult | null> {
  return searchClient.request<NativeCheckIgnoreResult>({
    command: "check-ignore",
    cwd: input.cwd,
    paths: input.paths,
  });
}
