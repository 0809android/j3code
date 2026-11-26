import type { TrafficStatus } from "./traffic.ts";

export type DisconnectReason =
  | "normal"
  | "peer-closed"
  | "auth-failed"
  | "auth-timeout"
  | "setup-timeout"
  | "host-offline"
  | "backpressure"
  | "limit"
  | "degraded"
  | "blocked"
  | "replaced"
  | "revoked"
  | "ping-timeout"
  | "oversize"
  | "shutdown"
  | "error";

const SAMPLE_CAPACITY = 300;

export interface MetricsGauges {
  readonly sessions: () => number;
  readonly waitingSessions: () => number;
  readonly controls: () => number;
  readonly sockets: () => number;
  readonly bufferedBytes: () => number;
  readonly traffic: () => TrafficStatus;
  readonly selfPing: () => { enabled: boolean; ok: number; failed: number };
}

function percentile(values: ReadonlyArray<number>, fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Counters kept in memory only (spec section 11): concurrent sessions, memory, bandwidth,
 * socket count, the largest `bufferedAmount` seen, and why connections ended.
 */
export class Metrics {
  readonly disconnects = new Map<DisconnectReason, number>();
  readonly startedAt: number;
  relayedBytes = 0;
  sentBytes = 0;
  maxBufferedAmount = 0;
  backpressurePauses = 0;
  backpressureCloses = 0;
  sessionsOpened = 0;
  peakSessions = 0;
  rejections = 0;
  #secondBytes = 0;
  #secondBuffered = 0;
  #lastCpu = process.cpuUsage();
  #lastSampleAt: number;
  readonly #mbps: number[] = [];
  readonly #cpu: number[] = [];
  readonly #rss: number[] = [];
  readonly #buffered: number[] = [];

  private readonly gauges: MetricsGauges;
  private readonly now: () => number;

  constructor(gauges: MetricsGauges, now: () => number) {
    this.gauges = gauges;
    this.now = now;
    this.startedAt = now();
    this.#lastSampleAt = now();
  }

  recordDisconnect(reason: DisconnectReason): void {
    this.disconnects.set(reason, (this.disconnects.get(reason) ?? 0) + 1);
  }

  /** Bytes accepted from a peer to pass on. This is what the monthly count is made of. */
  recordRelayed(bytes: number): void {
    this.relayedBytes += bytes;
  }

  /** Bytes whose write finished: what actually left, and what the bandwidth figures measure. */
  recordSent(bytes: number): void {
    this.sentBytes += bytes;
    this.#secondBytes += bytes;
  }

  recordBuffered(amount: number): void {
    if (amount > this.maxBufferedAmount) this.maxBufferedAmount = amount;
    if (amount > this.#secondBuffered) this.#secondBuffered = amount;
  }

  recordSessionOpened(): void {
    this.sessionsOpened += 1;
    this.peakSessions = Math.max(this.peakSessions, this.gauges.sessions());
  }

  /** Called once a second. Keeps the last five minutes for the percentiles. */
  sample(): void {
    const now = this.now();
    const seconds = Math.max(0.001, (now - this.#lastSampleAt) / 1000);
    const cpu = process.cpuUsage(this.#lastCpu);
    this.#lastCpu = process.cpuUsage();
    this.#lastSampleAt = now;
    this.#push(this.#mbps, (this.#secondBytes * 8) / 1_000_000 / seconds);
    this.#push(this.#cpu, ((cpu.user + cpu.system) / 1_000_000 / seconds) * 100);
    this.#push(this.#rss, process.memoryUsage().rss);
    this.#push(this.#buffered, this.#secondBuffered);
    this.#secondBytes = 0;
    this.#secondBuffered = 0;
  }

  #push(series: number[], value: number): void {
    series.push(value);
    if (series.length > SAMPLE_CAPACITY) series.shift();
  }

  #traffic() {
    const { month, usedBytes, budgetBytes, fraction, level } = this.gauges.traffic();
    return { month, usedBytes, budgetBytes, percent: Math.round(fraction * 1000) / 10, level };
  }

  snapshot() {
    const memory = process.memoryUsage();
    return {
      uptimeSeconds: Math.floor((this.now() - this.startedAt) / 1000),
      sessions: this.gauges.sessions(),
      waitingSessions: this.gauges.waitingSessions(),
      peakSessions: this.peakSessions,
      sessionsOpened: this.sessionsOpened,
      controls: this.gauges.controls(),
      webSockets: this.gauges.sockets(),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
      rssP95Bytes: percentile(this.#rss, 0.95),
      cpuPercent: this.#cpu.at(-1) ?? 0,
      cpuPercentP95: percentile(this.#cpu, 0.95),
      relayedBytes: this.relayedBytes,
      sentBytes: this.sentBytes,
      bandwidthMbps: this.#mbps.at(-1) ?? 0,
      bandwidthMbpsP95: percentile(this.#mbps, 0.95),
      bufferedBytes: this.gauges.bufferedBytes(),
      maxBufferedAmount: this.maxBufferedAmount,
      maxBufferedAmountRecent: Math.max(this.#secondBuffered, ...this.#buffered, 0),
      selfPing: this.gauges.selfPing(),
      backpressurePauses: this.backpressurePauses,
      backpressureCloses: this.backpressureCloses,
      rejections: this.rejections,
      traffic: this.#traffic(),
      disconnects: Object.fromEntries(this.disconnects),
    };
  }
}
