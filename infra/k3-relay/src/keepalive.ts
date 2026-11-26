import type { Logger } from "./server.ts";

const TIMEOUT_MS = 5_000;

export interface SelfPingOptions {
  readonly url: string;
  readonly intervalMs: number;
  readonly fetch: typeof fetch;
  readonly logger: Logger;
}

/**
 * A light request from the relay to its own public URL, now and then, so the machine is never
 * completely idle (spec section 11: the always-free instance can be reclaimed when CPU and
 * network stay low). It carries nothing and is not counted as relayed traffic. It also shows
 * in the logs, once per streak, when the relay cannot reach itself from outside.
 */
export class SelfPing {
  ok = 0;
  failed = 0;
  #failing = false;
  #timer: NodeJS.Timeout | null = null;

  private readonly options: SelfPingOptions;

  constructor(options: SelfPingOptions) {
    this.options = options;
  }

  start(): void {
    if (this.#timer || this.options.intervalMs <= 0) return;
    this.#timer = setInterval(() => void this.ping(), this.options.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Never throws. Returns whether the relay answered itself. */
  async ping(): Promise<boolean> {
    let ok = false;
    let code = "unknown";
    try {
      const response = await this.options.fetch(this.options.url, {
        method: "GET",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.text();
      ok = response.ok;
      code = String(response.status);
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      code = typeof name === "string" ? name : "unknown";
    }
    if (ok) {
      this.ok += 1;
      if (this.#failing) this.options.logger.info("self-ping-recovered");
      this.#failing = false;
    } else {
      this.failed += 1;
      if (!this.#failing) this.options.logger.error("self-ping-failed", { code });
      this.#failing = true;
    }
    return ok;
  }
}
