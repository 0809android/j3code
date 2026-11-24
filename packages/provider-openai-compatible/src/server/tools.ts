// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Local tool execution runs Node fs/process APIs directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { RuntimeMode } from "@t3tools/contracts";
import { createPersistentSidecarClient } from "@t3tools/shared/nativeSidecarWorker";

const workspaceSearchClient = createPersistentSidecarClient({
  binaryBaseName: "j3-workspace-search",
  envPathVar: "J3CODE_WORKSPACE_SEARCH_PATH",
  crateDirName: "j3-workspace-search",
  anchorDir: import.meta.dirname,
  defaultTimeoutMs: 15_000,
});

function runNativeWorkspaceSearch<T>(
  payload: Record<string, unknown>,
  options?: { readonly platform?: NodeJS.Platform; readonly signal?: AbortSignal },
): Promise<T | null> {
  return workspaceSearchClient.request<T>(payload, options);
}

export interface OpenAiToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export const CODING_TOOL_DEFINITIONS: ReadonlyArray<OpenAiToolDefinition> = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file relative to the workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute path to read." },
          start_line: { type: "integer", description: "Optional 1-based start line." },
          end_line: { type: "integer", description: "Optional 1-based inclusive end line." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories inside a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (defaults to workspace root)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a UTF-8 file inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write." },
          content: { type: "string", description: "Full file contents." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact string occurrence inside a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to modify." },
          old_string: { type: "string", description: "Exact existing text to replace." },
          new_string: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Find files and directories in the workspace matching a path query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring or fuzzy file path query." },
          limit: { type: "integer", description: "Maximum results (default 50)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_files",
      description: "Search text content across files in the workspace.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Literal text or regular expression to search for.",
          },
          case_sensitive: {
            type: "boolean",
            description: "Case-sensitive search (default false).",
          },
          use_regex: { type: "boolean", description: "Treat query as regex (default false)." },
          limit: { type: "integer", description: "Maximum matching lines (default 50)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace directory.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
        },
        required: ["command"],
      },
    },
  },
];

export interface ExecutedToolResult {
  readonly ok: boolean;
  readonly output: string;
  readonly kind: "read" | "file_change" | "command";
  readonly fileName?: string;
  readonly command?: string;
  readonly exitCode?: number;
}

const MAX_TOOL_OUTPUT_CHARS = 32_000;
const COMMAND_TIMEOUT_MS = 60_000;

function truncateOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...[truncated ${text.length - MAX_TOOL_OUTPUT_CHARS} chars]`;
}

async function resolveRealOrAncestor(targetPath: string): Promise<string> {
  const pendingSegments: Array<string> = [];
  let cursor = NodePath.resolve(targetPath);
  for (;;) {
    try {
      const realBase = await NodeFSP.realpath(cursor);
      return pendingSegments.length === 0
        ? realBase
        : NodePath.join(realBase, ...pendingSegments.toReversed());
    } catch {
      const parent = NodePath.dirname(cursor);
      if (parent === cursor) {
        return NodePath.resolve(targetPath);
      }
      pendingSegments.push(NodePath.basename(cursor));
      cursor = parent;
    }
  }
}

function isOutsideRoot(root: string, target: string): boolean {
  const relative = NodePath.relative(root, target);
  return (
    relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative)
  );
}

async function resolveWorkspacePath(
  cwd: string,
  requestedPath: string,
  allowOutsideWorkspace: boolean,
): Promise<{ readonly absolutePath: string; readonly displayPath: string }> {
  const root = NodePath.resolve(cwd);
  const resolved = NodePath.isAbsolute(requestedPath)
    ? NodePath.resolve(requestedPath)
    : NodePath.resolve(root, requestedPath);
  const outsideLexical = isOutsideRoot(root, resolved);
  if (outsideLexical && !allowOutsideWorkspace) {
    throw new Error(`Path "${requestedPath}" is outside the workspace root.`);
  }
  if (!allowOutsideWorkspace) {
    const realRoot = await NodeFSP.realpath(root).catch(() => root);
    const realTarget = await resolveRealOrAncestor(resolved);
    if (isOutsideRoot(realRoot, realTarget)) {
      throw new Error(`Path "${requestedPath}" resolves outside the workspace root.`);
    }
  }
  const relative = NodePath.relative(root, resolved);
  return {
    absolutePath: resolved,
    displayPath: outsideLexical ? resolved : relative || ".",
  };
}

function killProcessTree(child: NodeChildProcess.ChildProcess, platform?: NodeJS.Platform): void {
  if (child.pid !== undefined && platform === "win32") {
    try {
      NodeChildProcess.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    } catch {
      // fall back to child.kill()
    }
  }
  child.kill();
}

export async function executeCodingTool(input: {
  readonly name: string;
  readonly rawArguments: string;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
}): Promise<ExecutedToolResult> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = input.rawArguments.trim() ? JSON.parse(input.rawArguments) : {};
    args =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch (error) {
    return {
      ok: false,
      kind: "read",
      output: `Invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const allowFullAccess = input.runtimeMode === "full-access";
  const allowEdits =
    input.runtimeMode === "auto-accept-edits" ||
    input.runtimeMode === "auto" ||
    input.runtimeMode === "full-access";
  const allowCommands = input.runtimeMode === "auto" || input.runtimeMode === "full-access";

  try {
    switch (input.name) {
      case "read_file": {
        const rawPath = typeof args.path === "string" ? args.path : "";
        if (!rawPath)
          return { ok: false, kind: "read", output: "Missing required parameter: path" };
        const { absolutePath, displayPath } = await resolveWorkspacePath(
          input.cwd,
          rawPath,
          allowFullAccess,
        );
        const content = await NodeFSP.readFile(absolutePath, "utf8");
        const lines = content.split(/\r?\n/u);
        const start =
          typeof args.start_line === "number" && args.start_line > 0
            ? Math.floor(args.start_line)
            : 1;
        const end =
          typeof args.end_line === "number" && args.end_line >= start
            ? Math.min(lines.length, Math.floor(args.end_line))
            : Math.min(lines.length, start + 399);
        const slice = lines
          .slice(start - 1, end)
          .map((line, idx) => `${start + idx}: ${line}`)
          .join("\n");
        return {
          ok: true,
          kind: "read",
          fileName: displayPath,
          output: truncateOutput(slice),
        };
      }

      case "list_directory": {
        const rawPath = typeof args.path === "string" && args.path.trim() ? args.path : ".";
        const { absolutePath } = await resolveWorkspacePath(input.cwd, rawPath, allowFullAccess);
        const entries = await NodeFSP.readdir(absolutePath, { withFileTypes: true });
        const formatted = entries
          .slice(0, 200)
          .map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`)
          .join("\n");
        return { ok: true, kind: "read", output: formatted || "(empty directory)" };
      }

      case "write_file": {
        if (!allowEdits) {
          return {
            ok: false,
            kind: "file_change",
            output: `File writes are disabled in "${input.runtimeMode}" mode. Switch to Auto-accept edits or Auto.`,
          };
        }
        const rawPath = typeof args.path === "string" ? args.path : "";
        const content = typeof args.content === "string" ? args.content : undefined;
        if (!rawPath || content === undefined) {
          return { ok: false, kind: "file_change", output: "Missing path or content." };
        }
        const { absolutePath, displayPath } = await resolveWorkspacePath(
          input.cwd,
          rawPath,
          allowFullAccess,
        );
        await NodeFSP.mkdir(NodePath.dirname(absolutePath), { recursive: true });
        await NodeFSP.writeFile(absolutePath, content, "utf8");
        return {
          ok: true,
          kind: "file_change",
          fileName: displayPath,
          output: `Wrote ${content.length} chars to ${displayPath}`,
        };
      }

      case "edit_file": {
        if (!allowEdits) {
          return {
            ok: false,
            kind: "file_change",
            output: `File edits are disabled in "${input.runtimeMode}" mode. Switch to Auto-accept edits or Auto.`,
          };
        }
        const rawPath = typeof args.path === "string" ? args.path : "";
        const oldStr = typeof args.old_string === "string" ? args.old_string : undefined;
        const newStr = typeof args.new_string === "string" ? args.new_string : undefined;
        if (!rawPath || !oldStr || newStr === undefined) {
          return {
            ok: false,
            kind: "file_change",
            output: "Missing path, non-empty old_string, or new_string.",
          };
        }
        const { absolutePath, displayPath } = await resolveWorkspacePath(
          input.cwd,
          rawPath,
          allowFullAccess,
        );
        const existing = await NodeFSP.readFile(absolutePath, "utf8");
        if (!existing.includes(oldStr)) {
          return {
            ok: false,
            kind: "file_change",
            fileName: displayPath,
            output: "old_string not found in file.",
          };
        }
        const updated = existing.replace(oldStr, () => newStr);
        await NodeFSP.writeFile(absolutePath, updated, "utf8");
        return {
          ok: true,
          kind: "file_change",
          fileName: displayPath,
          output: `Updated ${displayPath}`,
        };
      }

      case "search_files": {
        if (input.signal?.aborted) {
          return { ok: false, kind: "read", output: "[interrupted]" };
        }
        const query = typeof args.query === "string" ? args.query : "";
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(200, Math.floor(args.limit))
            : 50;
        const nativeResult = await runNativeWorkspaceSearch<{
          readonly entries: ReadonlyArray<{ readonly path: string; readonly kind: string }>;
          readonly truncated: boolean;
        }>(
          { command: "files", cwd: input.cwd, query, limit },
          {
            ...(input.platform ? { platform: input.platform } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
        if (input.signal?.aborted) {
          return { ok: false, kind: "read", output: "[interrupted]" };
        }
        if (nativeResult) {
          const lines = nativeResult.entries.map(
            (entry) => `[${entry.kind === "directory" ? "dir" : "file"}] ${entry.path}`,
          );
          if (nativeResult.truncated) lines.push("...(truncated)");
          return {
            ok: true,
            kind: "read",
            output: truncateOutput(lines.join("\n") || "(no matches)"),
          };
        }
        const entries = await NodeFSP.readdir(input.cwd, { withFileTypes: true });
        const lower = query.trim().toLowerCase();
        const filtered = entries
          .filter((entry) => !lower || entry.name.toLowerCase().includes(lower))
          .slice(0, limit)
          .map((entry) => `[${entry.isDirectory() ? "dir" : "file"}] ${entry.name}`);
        return {
          ok: true,
          kind: "read",
          output: truncateOutput(filtered.join("\n") || "(no matches)"),
        };
      }

      case "grep_files": {
        if (input.signal?.aborted) {
          return { ok: false, kind: "read", output: "[interrupted]" };
        }
        const query = typeof args.query === "string" ? args.query : "";
        if (!query) return { ok: false, kind: "read", output: "Missing required parameter: query" };
        const caseSensitive = args.case_sensitive === true;
        const useRegex = args.use_regex === true;
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(200, Math.floor(args.limit))
            : 50;
        const nativeResult = await runNativeWorkspaceSearch<{
          readonly matches: ReadonlyArray<{
            readonly path: string;
            readonly line: number;
            readonly text: string;
          }>;
          readonly truncated: boolean;
          readonly error?: string;
        }>(
          {
            command: "grep",
            cwd: input.cwd,
            query,
            caseSensitive,
            useRegex,
            limit,
          },
          {
            ...(input.platform ? { platform: input.platform } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
        if (input.signal?.aborted) {
          return { ok: false, kind: "read", output: "[interrupted]" };
        }
        if (nativeResult) {
          if (nativeResult.error) return { ok: false, kind: "read", output: nativeResult.error };
          const lines = nativeResult.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
          if (nativeResult.truncated) lines.push("...(truncated)");
          return {
            ok: true,
            kind: "read",
            output: truncateOutput(lines.join("\n") || "(no matches)"),
          };
        }
        return {
          ok: false,
          kind: "read",
          output: "Native workspace search binary not available; use read_file or run_command.",
        };
      }

      case "run_command": {
        const command = typeof args.command === "string" ? args.command.trim() : "";
        if (!command) return { ok: false, kind: "command", output: "Missing command." };
        if (!allowCommands) {
          return {
            ok: false,
            kind: "command",
            command,
            output: `Command execution is disabled in "${input.runtimeMode}" mode. Switch to Auto or Full access.`,
          };
        }
        if (input.signal?.aborted) {
          return { ok: false, kind: "command", command, exitCode: 130, output: "[interrupted]" };
        }
        const result = await new Promise<{ readonly exitCode: number; readonly output: string }>(
          (resolve) => {
            let settled = false;
            const finish = (outcome: { readonly exitCode: number; readonly output: string }) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              input.signal?.removeEventListener("abort", onAbort);
              resolve(outcome);
            };
            const child = NodeChildProcess.spawn(command, {
              cwd: input.cwd,
              env: input.environment,
              shell: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
            let combined = "";
            const append = (chunk: Buffer) => {
              if (combined.length < MAX_TOOL_OUTPUT_CHARS * 2) {
                combined += chunk.toString("utf8");
              }
            };
            child.stdout.on("data", append);
            child.stderr.on("data", append);
            const onAbort = () => {
              killProcessTree(child, input.platform);
              finish({
                exitCode: 130,
                output: `${truncateOutput(combined)}\n[command interrupted]`.trim(),
              });
            };
            input.signal?.addEventListener("abort", onAbort, { once: true });
            const timer = setTimeout(() => {
              killProcessTree(child, input.platform);
              finish({
                exitCode: 124,
                output: `${truncateOutput(combined)}\n[command timed out]`,
              });
            }, COMMAND_TIMEOUT_MS);
            child.on("close", (code) => {
              finish({ exitCode: code ?? 0, output: truncateOutput(combined) });
            });
            child.on("error", (error) => {
              finish({ exitCode: 1, output: error.message });
            });
          },
        );
        return {
          ok: result.exitCode === 0,
          kind: "command",
          command,
          exitCode: result.exitCode,
          output: result.output || `(exit code ${result.exitCode})`,
        };
      }

      default:
        return { ok: false, kind: "read", output: `Unknown tool: ${input.name}` };
    }
  } catch (error) {
    return {
      ok: false,
      kind: "read",
      output: error instanceof Error ? error.message : String(error),
    };
  }
}
