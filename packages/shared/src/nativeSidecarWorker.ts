// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Manages optional local Rust NDJSON sidecar worker processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";

import * as HostProcess from "./HostProcess.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_CHARS = 16 * 1024 * 1024;

interface UnrefableStream {
  readonly ref?: () => void;
  readonly unref?: () => void;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanupAbort: () => void;
}

interface PersistentWorker {
  readonly binary: string;
  readonly child: NodeChildProcess.ChildProcessByStdio<
    NodeStream.Writable,
    NodeStream.Readable,
    null
  >;
  readonly pending: Map<string, PendingRequest>;
  buffer: string;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

interface PersistentSidecarClientOptions {
  readonly binaryBaseName: string;
  readonly envPathVar: string;
  readonly crateDirName: string;
  readonly anchorDir: string;
  readonly defaultTimeoutMs: number;
  readonly idleTimeoutMs?: number;
  readonly maxBufferChars?: number;
}

interface PersistentSidecarClient {
  readonly request: <T>(
    payload: Record<string, unknown>,
    options?: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
      readonly platform?: NodeJS.Platform;
    },
  ) => Promise<T | null>;
}

const activeWorkers = new Set<PersistentWorker>();
let globalExitHookRegistered = false;

function setWorkerRefState(worker: PersistentWorker, active: boolean): void {
  const stdout = worker.child.stdout as unknown as UnrefableStream;
  const stdin = worker.child.stdin as unknown as UnrefableStream;
  if (active) {
    stdout.ref?.();
  } else {
    worker.child.unref();
    stdout.unref?.();
    stdin.unref?.();
  }
}

function teardownWorker(worker: PersistentWorker): void {
  activeWorkers.delete(worker);
  if (worker.idleTimer !== undefined) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = undefined;
  }
  for (const [, entry] of worker.pending) {
    clearTimeout(entry.timer);
    entry.cleanupAbort();
    entry.resolve(null);
  }
  worker.pending.clear();
  try {
    worker.child.kill();
  } catch {
    // already exited
  }
}

function ensureGlobalExitHook(): void {
  if (globalExitHookRegistered) return;
  globalExitHookRegistered = true;
  process.once("exit", () => {
    for (const worker of activeWorkers) {
      teardownWorker(worker);
    }
  });
}

export function createPersistentSidecarClient(
  config: PersistentSidecarClientOptions,
): PersistentSidecarClient {
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxBufferChars = config.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  let cachedBinaryPath: string | null | undefined;
  let activeWorker: PersistentWorker | null = null;
  let requestCounter = 0;

  function resolveBinary(platform?: NodeJS.Platform): string | null {
    if (process.env.J3CODE_DISABLE_NATIVE_ACCELERATORS === "1") {
      return null;
    }
    const explicit = process.env[config.envPathVar]?.trim();
    if (explicit) {
      return NodeFS.existsSync(explicit) ? explicit : null;
    }
    if (cachedBinaryPath !== undefined) {
      return cachedBinaryPath;
    }

    const resolvedPlatform = platform ?? HostProcess.Platform.defaultValue();
    const exe =
      resolvedPlatform === "win32" ? `${config.binaryBaseName}.exe` : config.binaryBaseName;
    const cargoTargetDir = process.env.CARGO_TARGET_DIR?.trim();
    const resourcesPath = (process as unknown as { readonly resourcesPath?: string }).resourcesPath;
    const candidates = [
      ...(resourcesPath ? [NodePath.join(resourcesPath, "j3-native", exe)] : []),
      NodePath.resolve(config.anchorDir, "../../../../apps/desktop/prod-resources/j3-native", exe),
      NodePath.resolve(config.anchorDir, "../../../apps/desktop/prod-resources/j3-native", exe),
      ...(cargoTargetDir
        ? [
            NodePath.join(cargoTargetDir, "release", exe),
            NodePath.join(cargoTargetDir, "debug", exe),
          ]
        : []),
      NodePath.resolve(
        config.anchorDir,
        `../../../../native/${config.crateDirName}/target/release`,
        exe,
      ),
      NodePath.resolve(
        config.anchorDir,
        `../../../../native/${config.crateDirName}/target/debug`,
        exe,
      ),
      NodePath.resolve(
        config.anchorDir,
        `../../../native/${config.crateDirName}/target/release`,
        exe,
      ),
      NodePath.resolve(
        config.anchorDir,
        `../../../native/${config.crateDirName}/target/debug`,
        exe,
      ),
    ];

    for (const candidate of candidates) {
      try {
        if (NodeFS.statSync(candidate).isFile()) {
          cachedBinaryPath = candidate;
          return candidate;
        }
      } catch {
        // candidate missing
      }
    }
    cachedBinaryPath = null;
    return null;
  }

  function closeWorker(worker: PersistentWorker): void {
    if (activeWorker === worker) {
      activeWorker = null;
    }
    teardownWorker(worker);
  }

  function scheduleIdleShutdown(worker: PersistentWorker): void {
    if (worker.idleTimer !== undefined) {
      clearTimeout(worker.idleTimer);
      worker.idleTimer = undefined;
    }
    if (worker.pending.size > 0) return;
    setWorkerRefState(worker, false);
    const timer = setTimeout(() => {
      if (worker.pending.size === 0) {
        closeWorker(worker);
      }
    }, idleTimeoutMs);
    timer.unref();
    worker.idleTimer = timer;
  }

  function getOrSpawnWorker(binary: string): PersistentWorker {
    if (
      activeWorker !== null &&
      activeWorker.binary === binary &&
      activeWorker.child.exitCode === null
    ) {
      return activeWorker;
    }
    if (activeWorker !== null) {
      closeWorker(activeWorker);
    }
    ensureGlobalExitHook();
    const child = NodeChildProcess.spawn(binary, ["--serve"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const worker: PersistentWorker = {
      binary,
      child,
      pending: new Map(),
      buffer: "",
      idleTimer: undefined,
    };
    activeWorkers.add(worker);
    setWorkerRefState(worker, false);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (worker.buffer.length + chunk.length > maxBufferChars) {
        closeWorker(worker);
        return;
      }
      worker.buffer += chunk;
      let nl = worker.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = worker.buffer.slice(0, nl).trim();
        worker.buffer = worker.buffer.slice(nl + 1);
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line) as { readonly id?: string; readonly result?: unknown };
            if (parsed.id !== undefined) {
              const entry = worker.pending.get(parsed.id);
              if (entry) {
                worker.pending.delete(parsed.id);
                clearTimeout(entry.timer);
                entry.cleanupAbort();
                entry.resolve(parsed.result ?? null);
              }
            }
          } catch {
            // ignore malformed line
          }
        }
        nl = worker.buffer.indexOf("\n");
      }
      scheduleIdleShutdown(worker);
    });
    child.on("error", () => closeWorker(worker));
    child.on("close", () => closeWorker(worker));
    child.stdin.on("error", () => closeWorker(worker));
    activeWorker = worker;
    return worker;
  }

  function request<T>(
    payload: Record<string, unknown>,
    options?: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
      readonly platform?: NodeJS.Platform;
    },
  ): Promise<T | null> {
    if (options?.signal?.aborted) {
      return Promise.resolve(null);
    }
    const binary = resolveBinary(options?.platform);
    if (!binary) {
      return Promise.resolve(null);
    }

    const worker = getOrSpawnWorker(binary);
    if (worker.idleTimer !== undefined) {
      clearTimeout(worker.idleTimer);
      worker.idleTimer = undefined;
    }
    setWorkerRefState(worker, true);
    const id = String(++requestCounter);
    const timeoutMs = options?.timeoutMs ?? config.defaultTimeoutMs;
    const signal = options?.signal;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        worker.pending.delete(id);
        clearTimeout(timer);
        cleanupAbort();
        resolve(value);
        if (worker.pending.size === 0 && activeWorker === worker) {
          scheduleIdleShutdown(worker);
        }
      };

      const onAbort = () => {
        // Resolve the cancelled caller immediately without killing sibling requests.
        finish(null);
      };
      const cleanupAbort = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        // Only tear down the shared worker if no other sibling requests are in flight;
        // if the worker is truly hung, the final request will tear it down on its own timeout.
        const isLastPending = worker.pending.size <= 1;
        finish(null);
        if (isLastPending) {
          closeWorker(worker);
        }
      }, timeoutMs);
      timer.unref();

      worker.pending.set(id, {
        resolve: (value) => finish(value as T | null),
        timer,
        cleanupAbort,
      });

      try {
        worker.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch {
        finish(null);
        closeWorker(worker);
      }
    });
  }

  return { request };
}
