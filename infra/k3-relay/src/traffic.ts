import { monthKey } from "./store.ts";

export type TrafficLevel = "normal" | "warn" | "degraded";

export interface TrafficStatus {
  readonly month: string;
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly fraction: number;
  readonly level: TrafficLevel;
}

/** What an alarm carries: a threshold and numbers. Nothing that names a host or an address. */
export interface TrafficAlert {
  readonly level: "warn" | "degraded";
  readonly thresholdPercent: number;
  readonly month: string;
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly percent: number;
}

export interface HostPolicy {
  /** Weight in the fair scheduler. */
  readonly weight: number;
  /** A hard ceiling in bytes per second, or null for none. */
  readonly capBytesPerSec: number | null;
  /** Whether the host is held back from opening new sessions, and may be capped, right now. */
  readonly squeezed: boolean;
}

export interface TrafficGuardOptions {
  readonly totalBytes: () => number;
  readonly now: () => number;
  readonly budgetBytes: number;
  readonly warnFraction: number;
  readonly degradedFraction: number;
  readonly degradedHostBytesPerSec: number;
  readonly pressureWeightFactor: number;
  readonly onAlert: (alert: TrafficAlert) => void;
  /** Called when the level changes, so cached per-host policies can be dropped. */
  readonly onLevelChange: (level: TrafficLevel) => void;
}

/**
 * Watches the relay's whole monthly egress against the free allowance (spec section 9). At the
 * warn fraction: one alarm, and hosts with a reduced weight lose more of it. At the degraded
 * fraction: a second alarm, no new sessions for those hosts, a ceiling for hosts over quota.
 * Everything starts again when the UTC month turns.
 */
export class TrafficGuard {
  #alerted = { month: "", warn: false, degraded: false };
  #lastLevel: TrafficLevel = "normal";

  private readonly options: TrafficGuardOptions;

  constructor(options: TrafficGuardOptions) {
    this.options = options;
  }

  status(): TrafficStatus {
    const { options } = this;
    const usedBytes = options.totalBytes();
    const fraction = usedBytes / options.budgetBytes;
    const level: TrafficLevel =
      fraction >= options.degradedFraction
        ? "degraded"
        : fraction >= options.warnFraction
          ? "warn"
          : "normal";
    return {
      month: monthKey(options.now()),
      usedBytes,
      budgetBytes: options.budgetBytes,
      fraction,
      level,
    };
  }

  level(): TrafficLevel {
    return this.status().level;
  }

  /** Raises each alarm once a month, and reports level changes. Called on a timer. */
  evaluate(): void {
    const status = this.status();
    if (this.#alerted.month !== status.month) {
      this.#alerted = { month: status.month, warn: false, degraded: false };
    }
    const crossed: Array<[TrafficAlert["level"], number]> = [];
    if (status.level !== "normal" && !this.#alerted.warn) {
      this.#alerted.warn = true;
      crossed.push(["warn", this.options.warnFraction]);
    }
    if (status.level === "degraded" && !this.#alerted.degraded) {
      this.#alerted.degraded = true;
      crossed.push(["degraded", this.options.degradedFraction]);
    }
    if (status.level !== this.#lastLevel) {
      this.#lastLevel = status.level;
      this.options.onLevelChange(status.level);
    }
    for (const [level, fraction] of crossed) {
      this.options.onAlert({
        level,
        thresholdPercent: Math.round(fraction * 100),
        month: status.month,
        usedBytes: status.usedBytes,
        budgetBytes: status.budgetBytes,
        percent: Math.round(status.fraction * 1000) / 10,
      });
    }
  }

  /** In degraded mode only hosts with a full weight may open new sessions. */
  admitsNewSession(baseWeight: number): boolean {
    return this.level() !== "degraded" || baseWeight >= 1;
  }

  /**
   * How the current level treats a host. `baseWeight` is the weight from age and monthly
   * quota (1 is a normal host), and `overQuota` says the host is past its monthly quota.
   */
  policyFor(baseWeight: number, overQuota: boolean): HostPolicy {
    const { options } = this;
    const level = this.level();
    // A host over its monthly quota always has a base weight below 1, so `reduced` covers it.
    const reduced = baseWeight < 1;
    return {
      weight:
        level !== "normal" && reduced ? baseWeight * options.pressureWeightFactor : baseWeight,
      capBytesPerSec: level === "degraded" && overQuota ? options.degradedHostBytesPerSec : null,
      squeezed: level === "degraded" && reduced,
    };
  }
}
