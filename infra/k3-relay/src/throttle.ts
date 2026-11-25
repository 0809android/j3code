export interface HostThrottleOptions {
  /** The ceiling for a host in bytes per second, or null when it has none right now. */
  readonly capFor: (hostId: string) => number | null;
  readonly now: () => number;
  /** Arms a one-shot timer. Injected so tests can drive time themselves. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

interface Held {
  readonly sessionKey: string;
  readonly size: number;
  readonly release: () => void;
}

interface Entry {
  readonly hostId: string;
  tokens: number;
  lastRefill: number;
  readonly queue: Held[];
  cancel: (() => void) | null;
}

const MIN_BURST_BYTES = 16 * 1024;
const MIN_DELAY_MS = 2;

const burstFor = (cap: number): number => Math.max(cap, MIN_BURST_BYTES);

/**
 * A token bucket per host, for hosts that have a ceiling (the degraded mode of spec section 9).
 * A host without a ceiling passes straight through, nothing waits and nothing is copied. A
 * message that was held is released in order, so a host's messages never swap places.
 */
export class HostThrottle {
  readonly #entries = new Map<string, Entry>();

  private readonly options: HostThrottleOptions;

  constructor(options: HostThrottleOptions) {
    this.options = options;
  }

  /** Calls `release` now, or later when the host is over its ceiling. */
  submit(hostId: string, sessionKey: string, size: number, release: () => void): void {
    const cap = this.options.capFor(hostId);
    if (cap === null) {
      this.#flush(hostId);
      release();
      return;
    }
    let entry = this.#entries.get(hostId);
    if (!entry) {
      entry = {
        hostId,
        tokens: burstFor(cap),
        lastRefill: this.options.now(),
        queue: [],
        cancel: null,
      };
      this.#entries.set(hostId, entry);
    }
    entry.queue.push({ sessionKey, size, release });
    this.#pump(entry, cap);
  }

  /** Drops what a finished session still had waiting. */
  removeSession(sessionKey: string): void {
    for (const entry of this.#entries.values()) {
      let kept = 0;
      for (const held of entry.queue) {
        if (held.sessionKey !== sessionKey) entry.queue[kept++] = held;
      }
      entry.queue.length = kept;
    }
  }

  /** Forgets hosts that are idle and have refilled, so the table only holds active ones. */
  sweep(): void {
    for (const entry of this.#entries.values()) {
      const cap = this.options.capFor(entry.hostId);
      if (entry.queue.length > 0) continue;
      if (cap === null) {
        this.#entries.delete(entry.hostId);
        continue;
      }
      this.#refill(entry, cap);
      if (entry.tokens >= burstFor(cap)) this.#entries.delete(entry.hostId);
    }
  }

  get heldMessages(): number {
    let count = 0;
    for (const entry of this.#entries.values()) count += entry.queue.length;
    return count;
  }

  close(): void {
    for (const entry of this.#entries.values()) entry.cancel?.();
    this.#entries.clear();
  }

  #refill(entry: Entry, cap: number): void {
    const now = this.options.now();
    const elapsed = Math.max(0, now - entry.lastRefill);
    entry.lastRefill = now;
    entry.tokens = Math.min(burstFor(cap), entry.tokens + (elapsed * cap) / 1000);
  }

  #pump(entry: Entry, cap: number): void {
    entry.cancel?.();
    entry.cancel = null;
    this.#refill(entry, cap);
    while (entry.queue.length > 0 && entry.tokens > 0) {
      const held = entry.queue.shift() as Held;
      entry.tokens -= held.size;
      held.release();
    }
    if (entry.queue.length === 0) return;
    const delay = Math.max(MIN_DELAY_MS, Math.ceil(((1 - entry.tokens) / cap) * 1000));
    entry.cancel = this.options.schedule(() => {
      entry.cancel = null;
      const current = this.options.capFor(entry.hostId);
      if (current === null) this.#flush(entry.hostId);
      else this.#pump(entry, current);
    }, delay);
  }

  /** The ceiling is gone: let everything held go, in order, and stop tracking the host. */
  #flush(hostId: string): void {
    const entry = this.#entries.get(hostId);
    if (!entry) return;
    this.#entries.delete(hostId);
    entry.cancel?.();
    entry.cancel = null;
    for (const held of entry.queue.splice(0)) held.release();
  }
}
