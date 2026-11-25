export interface FairItem {
  readonly hostId: string;
  readonly sessionKey: string;
  readonly size: number;
  readonly weight: number;
  readonly run: () => void;
}

export interface FairSchedulerOptions {
  readonly bytesPerSecond: number;
  readonly burstBytes: number;
  readonly quantumBytes: number;
  readonly now: () => number;
  /** Arms a one-shot timer. Injected so tests can drive time themselves. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

interface SessionQueue {
  readonly key: string;
  readonly items: FairItem[];
  deficit: number;
  visited: boolean;
  queuedBytes: number;
}

interface HostQueue {
  readonly hostId: string;
  readonly sessions: SessionQueue[];
  weight: number;
  deficit: number;
  visited: boolean;
}

const MIN_DELAY_MS = 2;
const MIN_WEIGHT = 0.05;

/**
 * A global token bucket (set below the real uplink) in front of a two-level deficit round
 * robin, hosts first, then sessions inside a host. While tokens last nothing waits. Once they
 * run out, every host with data waiting gets an equal share, scaled by its weight.
 */
export class FairScheduler {
  readonly #hosts: HostQueue[] = [];
  readonly #bySession = new Map<string, SessionQueue>();
  readonly #byHost = new Map<string, HostQueue>();
  #tokens: number;
  #lastRefill: number;
  #cancelTimer: (() => void) | null = null;
  #backlog = 0;

  private readonly options: FairSchedulerOptions;

  constructor(options: FairSchedulerOptions) {
    this.options = options;
    this.#tokens = options.burstBytes;
    this.#lastRefill = options.now();
  }

  get queuedMessages(): number {
    return this.#backlog;
  }

  queuedBytes(sessionKey: string): number {
    return this.#bySession.get(sessionKey)?.queuedBytes ?? 0;
  }

  submit(item: FairItem): void {
    this.#refill();
    if (this.#backlog === 0 && this.#tokens > 0) {
      this.#tokens -= item.size;
      item.run();
      return;
    }
    this.#enqueue(item);
    this.#arm();
  }

  /** Serves what the bucket allows. Called from the timer, and by tests after moving time. */
  pump(): void {
    this.#cancelTimer = null;
    this.#refill();
    while (this.#backlog > 0 && this.#tokens > 0) {
      const item = this.#next();
      if (!item) break;
      this.#tokens -= item.size;
      item.run();
    }
    this.#arm();
  }

  removeSession(sessionKey: string): void {
    const session = this.#bySession.get(sessionKey);
    if (!session) return;
    this.#backlog -= session.items.length;
    session.items.length = 0;
    this.#dropSession(session);
  }

  close(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }

  #refill(): void {
    const now = this.options.now();
    const elapsed = Math.max(0, now - this.#lastRefill);
    this.#lastRefill = now;
    this.#tokens = Math.min(
      this.options.burstBytes,
      this.#tokens + (elapsed * this.options.bytesPerSecond) / 1000,
    );
  }

  #arm(): void {
    if (this.#backlog === 0 || this.#cancelTimer) return;
    const deficit = Math.max(0, 1 - this.#tokens);
    const delay = Math.max(MIN_DELAY_MS, Math.ceil((deficit / this.options.bytesPerSecond) * 1000));
    this.#cancelTimer = this.options.schedule(() => this.pump(), delay);
  }

  #enqueue(item: FairItem): void {
    let host = this.#byHost.get(item.hostId);
    if (!host) {
      host = {
        hostId: item.hostId,
        sessions: [],
        weight: Math.max(MIN_WEIGHT, item.weight),
        deficit: 0,
        visited: false,
      };
      this.#byHost.set(item.hostId, host);
      this.#hosts.push(host);
    }
    let session = this.#bySession.get(item.sessionKey);
    if (!session) {
      session = { key: item.sessionKey, items: [], deficit: 0, visited: false, queuedBytes: 0 };
      this.#bySession.set(item.sessionKey, session);
      host.sessions.push(session);
    }
    session.items.push(item);
    session.queuedBytes += item.size;
    this.#backlog += 1;
  }

  #dropSession(session: SessionQueue): void {
    this.#bySession.delete(session.key);
    for (const host of this.#hosts) {
      const index = host.sessions.indexOf(session);
      if (index < 0) continue;
      host.sessions.splice(index, 1);
      if (host.sessions.length === 0) {
        this.#hosts.splice(this.#hosts.indexOf(host), 1);
        this.#byHost.delete(host.hostId);
      }
      return;
    }
  }

  #next(): FairItem | undefined {
    const quantum = this.options.quantumBytes;
    while (this.#hosts.length > 0) {
      const host = this.#hosts[0];
      if (!host) return undefined;
      if (!host.visited) {
        host.deficit += quantum * host.weight;
        host.visited = true;
      }
      const session = this.#pickSession(host, quantum);
      const head = session?.items[0];
      if (!session || !head) {
        this.#rotateHost(host);
        continue;
      }
      if (head.size > host.deficit) {
        this.#rotateHost(host);
        continue;
      }
      host.deficit -= head.size;
      session.deficit -= head.size;
      session.items.shift();
      session.queuedBytes -= head.size;
      this.#backlog -= 1;
      if (session.items.length === 0) {
        this.#dropSession(session);
        if (!this.#byHost.has(host.hostId)) host.deficit = 0;
      }
      return head;
    }
    return undefined;
  }

  #pickSession(host: HostQueue, quantum: number): SessionQueue | undefined {
    for (let attempts = host.sessions.length * 64; attempts > 0; attempts -= 1) {
      const session = host.sessions[0];
      if (!session) return undefined;
      if (!session.visited) {
        session.deficit += quantum;
        session.visited = true;
      }
      const head = session.items[0];
      if (head && head.size <= session.deficit) return session;
      session.visited = false;
      host.sessions.push(host.sessions.shift() as SessionQueue);
    }
    return host.sessions[0];
  }

  #rotateHost(host: HostQueue): void {
    host.visited = false;
    this.#hosts.push(this.#hosts.shift() as HostQueue);
  }
}
