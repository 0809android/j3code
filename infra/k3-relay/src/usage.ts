import { monthKey, type RelayStore } from "./store.ts";

interface UsageEntry {
  month: string;
  bytes: number;
  dirty: boolean;
}

/**
 * Bytes the relay carried for each host this month, both directions, each byte once. Direct
 * connections never reach the relay, so they never show up here. Kept in memory and written
 * out in batches.
 */
export class UsageMeter {
  readonly #entries = new Map<string, UsageEntry>();

  private readonly store: RelayStore;
  private readonly now: () => number;

  constructor(store: RelayStore, now: () => number) {
    this.store = store;
    this.now = now;
  }

  #entry(hostId: string): UsageEntry {
    const month = monthKey(this.now());
    let entry = this.#entries.get(hostId);
    if (!entry || entry.month !== month) {
      if (entry?.dirty) this.store.setUsage(hostId, entry.month, entry.bytes);
      entry = { month, bytes: this.store.getUsage(hostId, month), dirty: false };
      this.#entries.set(hostId, entry);
    }
    return entry;
  }

  add(hostId: string, bytes: number): void {
    const entry = this.#entry(hostId);
    entry.bytes += bytes;
    entry.dirty = true;
  }

  monthBytes(hostId: string): number {
    return this.#entry(hostId).bytes;
  }

  /** Writes changed counters, then forgets the hosts that did nothing since the last flush. */
  flush(): void {
    const dirty = [...this.#entries].filter(([, entry]) => entry.dirty);
    if (dirty.length > 0) {
      this.store.transaction(() => {
        for (const [hostId, entry] of dirty) this.store.setUsage(hostId, entry.month, entry.bytes);
      });
    }
    for (const [hostId, entry] of this.#entries) {
      if (entry.dirty) entry.dirty = false;
      else this.#entries.delete(hostId);
    }
  }
}
