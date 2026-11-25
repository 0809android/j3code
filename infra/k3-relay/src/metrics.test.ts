import { describe, expect, it } from "vite-plus/test";

import { SelfPing } from "./keepalive.ts";
import { Metrics, type MetricsGauges } from "./metrics.ts";
import { withRelay } from "./relay.testkit.ts";
import type { Logger } from "./server.ts";

const gauges: MetricsGauges = {
  sessions: () => 0,
  waitingSessions: () => 0,
  controls: () => 0,
  sockets: () => 0,
  bufferedBytes: () => 0,
  traffic: () => ({
    month: "2027-01",
    usedBytes: 0,
    budgetBytes: 1,
    fraction: 0,
    level: "normal",
  }),
  selfPing: () => ({ enabled: false, ok: 0, failed: 0 }),
};

function makeMetrics() {
  const clock = { now: 0 };
  return { metrics: new Metrics(gauges, () => clock.now), clock };
}

describe("measurements for the move-up decision", () => {
  it("measures outgoing bandwidth from bytes that were written, with a 95th percentile", () => {
    const { metrics, clock } = makeMetrics();
    metrics.recordRelayed(999);
    for (const bytes of [1_250_000, 2_500_000, 3_750_000]) {
      metrics.recordSent(bytes);
      clock.now += 1000;
      metrics.sample();
    }
    const snapshot = metrics.snapshot();
    expect(snapshot.bandwidthMbps).toBe(30);
    expect(snapshot.bandwidthMbpsP95).toBe(30);
    expect(snapshot.sentBytes).toBe(7_500_000);
    expect(snapshot.relayedBytes).toBe(999);
  });

  it("keeps the all-time and the recent largest bufferedAmount apart", () => {
    const { metrics } = makeMetrics();
    metrics.recordBuffered(500);
    metrics.sample();
    metrics.recordBuffered(100);
    metrics.sample();
    metrics.recordBuffered(700);
    expect(metrics.snapshot()).toMatchObject({
      maxBufferedAmount: 700,
      maxBufferedAmountRecent: 700,
    });

    for (let second = 0; second < 300; second += 1) metrics.sample();
    expect(metrics.snapshot()).toMatchObject({
      maxBufferedAmount: 700,
      maxBufferedAmountRecent: 0,
    });
  });

  it("reports CPU and memory percentiles from the process", () => {
    const { metrics, clock } = makeMetrics();
    for (let second = 0; second < 3; second += 1) {
      clock.now += 1000;
      metrics.sample();
    }
    const snapshot = metrics.snapshot();
    expect(Number.isFinite(snapshot.cpuPercentP95)).toBe(true);
    expect(snapshot.cpuPercentP95).toBeGreaterThanOrEqual(0);
    expect(snapshot.rssP95Bytes).toBeGreaterThan(0);
  });

  it("counts why connections ended", () => {
    const { metrics } = makeMetrics();
    for (const reason of ["backpressure", "backpressure", "blocked", "degraded"] as const) {
      metrics.recordDisconnect(reason);
    }
    expect(metrics.snapshot().disconnects).toEqual({ backpressure: 2, blocked: 1, degraded: 1 });
  });

  it("starts with nothing relayed, nothing sent and the self-ping off", () =>
    withRelay({}, async (relay) => {
      expect(relay.relay.metrics.snapshot()).toMatchObject({
        relayedBytes: 0,
        sentBytes: 0,
        selfPing: { enabled: false, ok: 0, failed: 0 },
      });
    }));
});

function capture() {
  const lines: string[] = [];
  const logger: Logger = {
    info: (event, fields) => lines.push(JSON.stringify({ event, ...fields })),
    error: (event, fields) => lines.push(JSON.stringify({ event, ...fields })),
  };
  return { lines, logger };
}

const URL_TO_PING = "https://relay.example.test/health";

describe("self-ping", () => {
  it("counts an answer", async () => {
    const { lines, logger } = capture();
    const asked: string[] = [];
    const fetchMock = ((url: string) => {
      asked.push(url);
      return Promise.resolve(new Response('{"ok":true}'));
    }) as unknown as typeof fetch;
    const ping = new SelfPing({ url: URL_TO_PING, intervalMs: 1000, fetch: fetchMock, logger });
    expect(await ping.ping()).toBe(true);
    expect(asked).toEqual([URL_TO_PING]);
    expect({ ok: ping.ok, failed: ping.failed, lines }).toEqual({ ok: 1, failed: 0, lines: [] });
  });

  it("says once when it cannot reach itself, and once when it can again", async () => {
    const { lines, logger } = capture();
    const outcomes: Array<() => Promise<Response>> = [
      () => Promise.resolve(new Response("down", { status: 502 })),
      () => Promise.reject(Object.assign(new Error("boom"), { name: "TimeoutError" })),
      () => Promise.resolve(new Response('{"ok":true}')),
    ];
    const fetchMock = (() =>
      (outcomes.shift() as () => Promise<Response>)()) as unknown as typeof fetch;
    const ping = new SelfPing({ url: URL_TO_PING, intervalMs: 1000, fetch: fetchMock, logger });

    expect(await ping.ping()).toBe(false);
    expect(await ping.ping()).toBe(false);
    expect(await ping.ping()).toBe(true);

    expect({ ok: ping.ok, failed: ping.failed }).toEqual({ ok: 1, failed: 2 });
    expect(lines).toEqual([
      JSON.stringify({ event: "self-ping-failed", code: "502" }),
      JSON.stringify({ event: "self-ping-recovered" }),
    ]);
    expect(lines.join("\n")).not.toContain("example.test");
  });

  it("does not run when the interval is zero", async () => {
    const { logger } = capture();
    let calls = 0;
    const fetchMock = (() => {
      calls += 1;
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch;
    const ping = new SelfPing({ url: URL_TO_PING, intervalMs: 0, fetch: fetchMock, logger });
    ping.start();
    ping.stop();
    expect(calls).toBe(0);
  });

  it("runs in the relay on its interval when configured, and shows in the metrics", async () => {
    let wake: (() => void) | null = null;
    const asked = new Promise<string>((resolve) => {
      wake = () => resolve(URL_TO_PING);
    });
    const fetchMock = ((url: string) => {
      if (url === URL_TO_PING) wake?.();
      return Promise.resolve(new Response('{"ok":true}'));
    }) as unknown as typeof fetch;
    await withRelay(
      { selfPingUrl: URL_TO_PING, selfPingIntervalMs: 10 },
      async (relay) => {
        expect(await asked).toBe(URL_TO_PING);
        expect(relay.relay.metrics.snapshot().selfPing.enabled).toBe(true);
      },
      { fetch: fetchMock },
    );
  });
});
