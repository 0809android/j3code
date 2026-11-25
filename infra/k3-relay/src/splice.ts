import type * as NodeEvents from "node:events";
import type { WebSocket } from "ws";

import type { RelayConfig } from "./config.ts";
import type { FairScheduler } from "./fair.ts";
import type { DisconnectReason, Metrics } from "./metrics.ts";
import type { HostThrottle } from "./throttle.ts";
import type { UsageMeter } from "./usage.ts";

const OPEN = 1;
const FORCE_TERMINATE_MS = 2_000;
const RESUME_BUDGET_FRACTION = 0.8;

/** Bytes waiting to be written, across every splice. One slow peer cannot take the process down. */
export class BufferBudget {
  used = 0;
  readonly waiters = new Set<() => void>();

  readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get over(): boolean {
    return this.used > this.max;
  }

  add(bytes: number): void {
    this.used += bytes;
  }

  sub(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
    if (this.waiters.size > 0 && this.used <= this.max * RESUME_BUDGET_FRACTION) {
      for (const wake of this.waiters) wake();
    }
  }
}

export interface SpliceDeps {
  readonly config: RelayConfig;
  readonly scheduler: FairScheduler;
  readonly throttle: HostThrottle;
  readonly budget: BufferBudget;
  readonly usage: UsageMeter;
  readonly metrics: Metrics;
  readonly events: NodeEvents.EventEmitter;
  readonly hostWeight: (hostId: string) => number;
}

export interface EarlyMessage {
  readonly data: Buffer;
  readonly isBinary: boolean;
}

const RESERVED_CODES = new Set([1004, 1005, 1006, 1015]);

/** A close code from a peer is only forwarded when it is allowed on the wire. */
export function forwardableCode(code: number): number {
  if (RESERVED_CODES.has(code)) return 1000;
  if ((code >= 1000 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1000;
}

function truncateReason(reason: string): string {
  let text = reason;
  while (Buffer.byteLength(text) > 120) text = text.slice(0, -1);
  return text;
}

class Pipe {
  #queued = 0;
  #inflight = 0;
  #paused = false;
  #pauseTimer: NodeJS.Timeout | null = null;
  #dead = false;
  readonly #wake = () => this.evaluate();

  private readonly splice: Splice;
  private readonly src: WebSocket;
  private readonly dst: WebSocket;

  constructor(splice: Splice, src: WebSocket, dst: WebSocket) {
    this.splice = splice;
    this.src = src;
    this.dst = dst;
  }

  get pending(): number {
    return this.#queued + this.#inflight;
  }

  push(data: Buffer, isBinary: boolean): void {
    if (this.#dead) return;
    const { deps } = this.splice;
    const size = data.length;
    this.#queued += size;
    deps.budget.add(size);
    deps.usage.add(this.splice.hostId, size);
    deps.metrics.recordRelayed(size);
    // A host with a ceiling (degraded mode) waits in the throttle; any other host goes straight on.
    deps.throttle.submit(this.splice.hostId, this.splice.id, size, () =>
      deps.scheduler.submit({
        hostId: this.splice.hostId,
        sessionKey: this.splice.id,
        size,
        weight: deps.hostWeight(this.splice.hostId),
        run: () => this.#send(data, isBinary, size),
      }),
    );
    this.evaluate();
  }

  #send(data: Buffer, isBinary: boolean, size: number): void {
    if (this.#dead) return;
    this.#queued -= size;
    if (this.dst.readyState !== OPEN) {
      this.splice.deps.budget.sub(size);
      return;
    }
    this.#inflight += size;
    this.dst.send(data, { binary: isBinary, compress: false }, (error) => {
      if (this.#dead) return;
      this.#inflight -= size;
      this.splice.deps.budget.sub(size);
      if (error) this.splice.end("error", 1011, "send failed");
      else this.evaluate();
    });
    this.splice.deps.metrics.recordBuffered(this.dst.bufferedAmount);
    this.evaluate();
  }

  /**
   * A socket pauses for its own backlog, or for the shared budget, but only when it holds more
   * than a small floor itself: a quiet session is never stopped by somebody else's flood.
   */
  evaluate(): void {
    if (this.#dead) return;
    const { config, budget } = this.splice.deps;
    const level = this.#queued + this.dst.bufferedAmount;
    const high = config.backpressureHighWaterBytes;
    if (!this.#paused) {
      const overBudget = budget.over && this.pending > config.budgetPauseFloorBytes;
      if (level > high || overBudget) this.#pause();
    } else if (level <= high / 2 && !budget.over) {
      this.#resume();
    } else if (!budget.over) {
      budget.waiters.delete(this.#wake);
    }
  }

  #pause(): void {
    const { deps } = this.splice;
    this.#paused = true;
    this.src.pause();
    deps.metrics.backpressurePauses += 1;
    deps.events.emit("backpressure-pause", { sessionId: this.splice.id });
    if (deps.budget.over) deps.budget.waiters.add(this.#wake);
    this.#pauseTimer = setTimeout(() => {
      deps.metrics.backpressureCloses += 1;
      this.splice.end("backpressure", 1013, "backpressure", this.dst);
    }, deps.config.backpressureCloseMs);
    this.#pauseTimer.unref();
  }

  #resume(): void {
    this.#paused = false;
    if (this.#pauseTimer) clearTimeout(this.#pauseTimer);
    this.#pauseTimer = null;
    this.splice.deps.budget.waiters.delete(this.#wake);
    this.src.resume();
    this.splice.deps.events.emit("backpressure-resume", { sessionId: this.splice.id });
  }

  /** Gives back what this pipe still holds in the shared budget. */
  dispose(): void {
    if (this.#dead) return;
    this.#dead = true;
    if (this.#pauseTimer) clearTimeout(this.#pauseTimer);
    this.splice.deps.budget.waiters.delete(this.#wake);
    this.splice.deps.budget.sub(this.pending);
    this.src.resume();
  }
}

/**
 * Joins a client socket and a host data socket and passes messages across as they are, text
 * stays text and binary stays binary. Nothing is parsed. When either side closes, the other
 * closes with the same code.
 */
export class Splice {
  readonly #toHost: Pipe;
  readonly #toClient: Pipe;
  #ended = false;

  readonly deps: SpliceDeps;
  readonly id: string;
  readonly hostId: string;
  private readonly client: WebSocket;
  private readonly host: WebSocket;
  private readonly onEnded: (reason: DisconnectReason) => void;

  constructor(
    deps: SpliceDeps,
    id: string,
    hostId: string,
    client: WebSocket,
    host: WebSocket,
    onEnded: (reason: DisconnectReason) => void,
  ) {
    this.deps = deps;
    this.id = id;
    this.hostId = hostId;
    this.client = client;
    this.host = host;
    this.onEnded = onEnded;
    this.#toHost = new Pipe(this, client, host);
    this.#toClient = new Pipe(this, host, client);
  }

  start(early: ReadonlyArray<EarlyMessage>): void {
    this.client.on("message", (data, isBinary) => this.#forward(this.#toHost, data, isBinary));
    this.host.on("message", (data, isBinary) => this.#forward(this.#toClient, data, isBinary));
    this.client.on("close", (code, reason) => this.#peerClosed(code, reason));
    this.host.on("close", (code, reason) => this.#peerClosed(code, reason));
    this.client.on("error", () => this.end("error", 1011, "error"));
    this.host.on("error", () => this.end("error", 1011, "error"));
    this.client.resume();
    for (const message of early) this.#toHost.push(message.data, message.isBinary);
  }

  #forward(pipe: Pipe, data: unknown, isBinary: boolean): void {
    try {
      pipe.push(data as Buffer, isBinary);
    } catch {
      this.end("error", 1011, "internal error");
    }
  }

  get ended(): boolean {
    return this.#ended;
  }

  #peerClosed(code: number, reason: Buffer): void {
    this.end("peer-closed", forwardableCode(code), reason.toString("utf8"));
  }

  /** Closes both sides once. `drop` is terminated outright (a peer that stopped reading). */
  end(reason: DisconnectReason, code: number, text: string, drop?: WebSocket): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#toHost.dispose();
    this.#toClient.dispose();
    this.deps.scheduler.removeSession(this.id);
    this.deps.throttle.removeSession(this.id);
    const safeText = truncateReason(text);
    for (const socket of [this.client, this.host]) {
      if (socket === drop) {
        socket.terminate();
        continue;
      }
      if (socket.readyState === OPEN) {
        socket.close(code, safeText);
        const timer = setTimeout(() => socket.terminate(), FORCE_TERMINATE_MS);
        timer.unref();
        socket.once("close", () => clearTimeout(timer));
      }
    }
    this.onEnded(reason);
  }
}
