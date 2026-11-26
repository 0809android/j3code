import * as NodeNet from "node:net";

const MINUTE_MS = 60_000;

/**
 * The key an IP address is counted under. IPv4-mapped IPv6 is folded to IPv4, and IPv6 is
 * grouped by /64 so one customer's whole prefix is one client. Never stored, only counted.
 */
export function ipKey(address: string): string {
  const zoneless = address.split("%")[0] ?? address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(zoneless);
  const plain = mapped?.[1] ?? zoneless;
  if (NodeNet.isIPv4(plain)) return plain;
  if (!NodeNet.isIPv6(plain)) return "unknown";
  const hextets = expandIpv6(plain);
  return `${hextets.slice(0, 4).join(":")}::/64`;
}

function expandIpv6(address: string): string[] {
  let text = address.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text)?.[1];
  if (tail) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    text =
      text.slice(0, -tail.length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head = "", rest] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = rest === undefined ? 0 : 8 - front.length - back.length;
  const groups = [...front, ...Array.from({ length: Math.max(missing, 0) }, () => "0"), ...back];
  return groups.map((group) => group.padStart(4, "0"));
}

/** Counts events per key inside a trailing window. */
export class SlidingWindow {
  readonly #hits = new Map<string, number[]>();

  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(windowMs: number, max: number, now: () => number) {
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
  }

  #recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const hits = this.#hits.get(key);
    if (!hits) return [];
    let start = 0;
    while (start < hits.length && (hits[start] ?? 0) <= cutoff) start += 1;
    if (start > 0) hits.splice(0, start);
    if (hits.length === 0) this.#hits.delete(key);
    return hits;
  }

  count(key: string): number {
    return this.#recent(key).length;
  }

  /** Records a hit and returns true, or returns false without recording when the key is full. */
  tryHit(key: string): boolean {
    const hits = this.#recent(key);
    if (hits.length >= this.max) return false;
    if (hits.length === 0) this.#hits.set(key, hits);
    hits.push(this.now());
    return true;
  }

  sweep(): void {
    for (const key of this.#hits.keys()) this.#recent(key);
  }

  get size(): number {
    return this.#hits.size;
  }
}

/** Unauthenticated connections: a concurrency cap and a per-minute cap, per client key. */
export class PreAuthLimiter {
  readonly #open = new Map<string, number>();
  readonly #perMinute: SlidingWindow;

  private readonly maxConcurrent: number;

  constructor(maxConcurrent: number, perMinute: number, now: () => number) {
    this.maxConcurrent = maxConcurrent;
    this.#perMinute = new SlidingWindow(MINUTE_MS, perMinute, now);
  }

  /** For WebSocket upgrades. The returned function gives the concurrent slot back, once. */
  admit(key: string): (() => void) | null {
    if ((this.#open.get(key) ?? 0) >= this.maxConcurrent) return null;
    if (!this.#perMinute.tryHit(key)) return null;
    this.#open.set(key, (this.#open.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#open.get(key) ?? 1) - 1;
      if (remaining <= 0) this.#open.delete(key);
      else this.#open.set(key, remaining);
    };
  }

  /** For plain HTTP requests: the per-minute cap only. */
  hit(key: string): boolean {
    return this.#perMinute.tryHit(key);
  }

  sweep(): void {
    this.#perMinute.sweep();
  }

  get trackedKeys(): number {
    return this.#open.size;
  }
}

/** A set whose members expire. `add` returns false when the member is already present. */
export class ExpiringSet {
  readonly #expiry = new Map<string, number>();

  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  add(key: string, ttlMs: number): boolean {
    const existing = this.#expiry.get(key);
    if (existing !== undefined && existing > this.now()) return false;
    this.#expiry.set(key, this.now() + ttlMs);
    return true;
  }

  has(key: string): boolean {
    const existing = this.#expiry.get(key);
    return existing !== undefined && existing > this.now();
  }

  sweep(): void {
    const now = this.now();
    for (const [key, expiry] of this.#expiry) if (expiry <= now) this.#expiry.delete(key);
  }

  get size(): number {
    return this.#expiry.size;
  }
}
