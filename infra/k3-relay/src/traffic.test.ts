import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { alertPayload, createAlertNotifier } from "./alerts.ts";
import { loadConfig } from "./config.ts";
import {
  EPOCH,
  connectControl,
  newEd25519,
  newHost,
  open,
  openSession,
  registerHost,
  sendClientAuth,
  statusBody,
  withRelay,
} from "./relay.testkit.ts";
import { CLOSE, type Logger } from "./server.ts";
import { RelayStore, monthKey } from "./store.ts";
import { HostThrottle } from "./throttle.ts";
import { TrafficGuard, type TrafficAlert, type TrafficLevel } from "./traffic.ts";
import { UsageMeter } from "./usage.ts";

const DAY = 86_400_000;

function makeGuard() {
  const state = { total: 0, now: EPOCH };
  const alerts: TrafficAlert[] = [];
  const levels: TrafficLevel[] = [];
  const guard = new TrafficGuard({
    totalBytes: () => state.total,
    now: () => state.now,
    budgetBytes: 1000,
    warnFraction: 0.7,
    degradedFraction: 0.9,
    degradedHostBytesPerSec: 125,
    pressureWeightFactor: 0.5,
    onAlert: (alert) => alerts.push(alert),
    onLevelChange: (level) => levels.push(level),
  });
  return { guard, state, alerts, levels };
}

describe("traffic guard", () => {
  it("stays quiet below 70% of the monthly budget", () => {
    const { guard, state, alerts } = makeGuard();
    state.total = 699;
    guard.evaluate();
    expect(guard.level()).toBe("normal");
    expect(alerts).toEqual([]);
  });

  it("raises the first alarm at exactly 70%, once, and the second at 90%, once", () => {
    const { guard, state, alerts, levels } = makeGuard();
    state.total = 700;
    guard.evaluate();
    guard.evaluate();
    expect(guard.level()).toBe("warn");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      level: "warn",
      thresholdPercent: 70,
      usedBytes: 700,
      budgetBytes: 1000,
      percent: 70,
    });

    state.total = 900;
    guard.evaluate();
    guard.evaluate();
    expect(guard.level()).toBe("degraded");
    expect(alerts.map((alert) => [alert.level, alert.thresholdPercent])).toEqual([
      ["warn", 70],
      ["degraded", 90],
    ]);
    expect(levels).toEqual(["warn", "degraded"]);
  });

  it("raises both alarms, in order, when usage jumps straight past 90%", () => {
    const { guard, state, alerts } = makeGuard();
    state.total = 950;
    guard.evaluate();
    expect(alerts.map((alert) => alert.level)).toEqual(["warn", "degraded"]);
    expect(alerts[1]?.percent).toBe(95);
  });

  it("starts again when the UTC month turns", () => {
    const { guard, state, alerts, levels } = makeGuard();
    state.total = 950;
    guard.evaluate();
    expect(alerts).toHaveLength(2);

    state.now += 40 * DAY;
    state.total = 0;
    guard.evaluate();
    expect(guard.level()).toBe("normal");
    expect(guard.status().month).toBe(monthKey(state.now));
    expect(alerts).toHaveLength(2);
    expect(levels.at(-1)).toBe("normal");

    state.total = 720;
    guard.evaluate();
    expect(alerts).toHaveLength(3);
    expect(alerts[2]).toMatchObject({ level: "warn", month: monthKey(state.now) });
  });

  it("squeezes the lowest weights first from the first alarm, and touches no settled host", () => {
    const { guard, state } = makeGuard();
    expect(guard.policyFor(0.5, false)).toMatchObject({ weight: 0.5, capBytesPerSec: null });

    state.total = 750;
    expect(guard.policyFor(1, false)).toEqual({ weight: 1, capBytesPerSec: null, squeezed: false });
    expect(guard.policyFor(0.5, false)).toMatchObject({ weight: 0.25, capBytesPerSec: null });
    expect(guard.policyFor(0.25, true)).toMatchObject({ weight: 0.125, capBytesPerSec: null });
    expect(guard.admitsNewSession(0.25)).toBe(true);
  });

  it("when degraded, holds back new sessions of low-weight hosts and caps hosts over quota", () => {
    const { guard, state } = makeGuard();
    state.total = 900;
    expect(guard.policyFor(1, false)).toEqual({ weight: 1, capBytesPerSec: null, squeezed: false });
    expect(guard.policyFor(0.5, false)).toEqual({
      weight: 0.25,
      capBytesPerSec: null,
      squeezed: true,
    });
    expect(guard.policyFor(0.25, true)).toEqual({
      weight: 0.125,
      capBytesPerSec: 125,
      squeezed: true,
    });
    expect(guard.admitsNewSession(1)).toBe(true);
    expect(guard.admitsNewSession(0.5)).toBe(false);
    expect(guard.admitsNewSession(0.25)).toBe(false);
  });
});

describe("alarm notices", () => {
  const alert: TrafficAlert = {
    level: "warn",
    thresholdPercent: 70,
    month: "2027-01",
    usedBytes: 7_000_000_000_000,
    budgetBytes: 10_000_000_000_000,
    percent: 70,
  };

  function capture() {
    const lines: string[] = [];
    const logger: Logger = {
      info: (event, fields) => lines.push(JSON.stringify({ event, ...fields })),
      error: (event, fields) => lines.push(JSON.stringify({ event, ...fields })),
    };
    return { lines, logger };
  }

  it("sends a subject and numbers, and nothing else", () => {
    const payload = alertPayload(alert);
    expect(Object.keys(payload).toSorted()).toEqual([
      "budgetBytes",
      "level",
      "month",
      "percent",
      "subject",
      "text",
      "thresholdPercent",
      "usedBytes",
    ]);
    expect(payload.subject).toBe("k3-relay: monthly transfer reached 70% of the budget");
  });

  it("prints one line and posts the payload to the webhook", async () => {
    const { lines, logger } = capture();
    const sent: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const fetchMock = ((url: string, init?: RequestInit) => {
      sent.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    createAlertNotifier({
      logger,
      webhookUrl: "https://alerts.example.test/hook",
      fetch: fetchMock,
    })(alert);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ event: "alert", thresholdPercent: 70 });
    expect(sent).toEqual([
      { url: "https://alerts.example.test/hook", method: "POST", body: alertPayload(alert) },
    ]);
  });

  it("prints the line and posts nothing when no webhook is configured", async () => {
    const { lines, logger } = capture();
    const fetchMock = (() => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    await createAlertNotifier({ logger, webhookUrl: null, fetch: fetchMock })(alert);
    expect(lines).toHaveLength(1);
  });

  it("logs a failed webhook by its error name only, and never throws", async () => {
    const { lines, logger } = capture();
    const fetchMock = (() =>
      Promise.reject(
        Object.assign(new Error("connect to 203.0.113.9 failed"), { name: "TimeoutError" }),
      )) as unknown as typeof fetch;
    await createAlertNotifier({
      logger,
      webhookUrl: "https://alerts.example.test/hook",
      fetch: fetchMock,
    })(alert);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "{}")).toEqual({
      event: "alert-webhook-failed",
      code: "TimeoutError",
    });
    expect(lines.join("\n")).not.toContain("203.0.113.9");
  });
});

describe("configuration", () => {
  it("takes the webhook, the self-ping and the egress settings from the environment", () => {
    const config = loadConfig({
      K3_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
      K3_SELF_PING_URL: "https://relay.example.test/health",
      K3_SELF_PING_INTERVAL_SEC: "300",
      EGRESS_BUDGET_BYTES: "5000",
      DEGRADED_HOST_MBPS: "2",
    });
    expect(config).toMatchObject({
      alertWebhookUrl: "https://alerts.example.test/hook",
      selfPingUrl: "https://relay.example.test/health",
      selfPingIntervalMs: 300_000,
      egressBudgetBytes: 5000,
      degradedHostBytesPerSec: 250_000,
    });
  });

  it("is off by default", () => {
    expect(loadConfig({})).toMatchObject({
      alertWebhookUrl: null,
      selfPingUrl: null,
      selfPingIntervalMs: 0,
      egressBudgetBytes: 10_000_000_000_000,
      egressWarnFraction: 0.7,
      egressDegradedFraction: 0.9,
    });
  });

  it("refuses an alarm webhook in the clear, and thresholds in the wrong order", () => {
    expect(() => loadConfig({ K3_ALERT_WEBHOOK_URL: "http://alerts.example.test/hook" })).toThrow(
      /https/u,
    );
    expect(() => loadConfig({ K3_ALERT_WEBHOOK_URL: "not a url" })).toThrow(/URL/u);
    expect(() => loadConfig({ K3_ALERT_WEBHOOK_URL: "http://127.0.0.1:9/hook" })).not.toThrow();
    expect(() => loadConfig({ EGRESS_WARN_FRACTION: "0.95" })).toThrow(/EGRESS_WARN_FRACTION/u);
    expect(() => loadConfig({ EGRESS_DEGRADED_FRACTION: "1.5" })).toThrow(/EGRESS_WARN_FRACTION/u);
  });
});

describe("usage meter, over restarts and months", () => {
  const HOST_A = "a".repeat(32);
  const HOST_B = "b".repeat(32);

  it("keeps counting where it stopped after a restart, and starts at zero in a new month", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "k3-relay-usage-"));
    const path = NodePath.join(directory, "relay.sqlite");
    const clock = { now: EPOCH };
    try {
      const first = new RelayStore(path);
      const before = new UsageMeter(first, () => clock.now);
      before.add(HOST_A, 300);
      before.add(HOST_B, 200);
      expect(before.totalBytes()).toBe(500);
      before.flush();
      first.close();

      const second = new RelayStore(path);
      const after = new UsageMeter(second, () => clock.now);
      expect(after.totalBytes()).toBe(500);
      expect(after.monthBytes(HOST_A)).toBe(300);
      after.add(HOST_A, 50);
      expect(after.totalBytes()).toBe(550);
      expect(after.monthBytes(HOST_A)).toBe(350);

      const oldMonth = monthKey(clock.now);
      clock.now += 40 * DAY;
      expect(after.totalBytes()).toBe(0);
      expect(after.monthBytes(HOST_A)).toBe(0);
      after.add(HOST_B, 10);
      expect(after.totalBytes()).toBe(10);
      after.flush();
      expect(second.sumUsage(oldMonth)).toBe(550);
      expect(second.sumUsage(monthKey(clock.now))).toBe(10);
      second.close();
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function makeThrottle(initialCap: number | null) {
  const clock = { now: 0 };
  const cap = { value: initialCap };
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const throttle = new HostThrottle({
    capFor: () => cap.value,
    now: () => clock.now,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  });
  const released: number[] = [];
  const submit = (index: number, size: number, sessionKey = "s") =>
    throttle.submit("host", sessionKey, size, () => released.push(index));
  /** Fires armed timers, in order, until the clock reaches `untilMs` or none is left. */
  const runUntil = (untilMs: number) => {
    while (timers.length > 0 && clock.now < untilMs) {
      const timer = timers.shift();
      if (!timer) break;
      clock.now += timer.delayMs;
      timer.callback();
    }
  };
  return { throttle, clock, cap, timers, released, submit, runUntil };
}

describe("host throttle", () => {
  it("passes a host without a ceiling straight through, with no timer", () => {
    const ctx = makeThrottle(null);
    for (let index = 0; index < 5; index += 1) ctx.submit(index, 1_000_000);
    expect(ctx.released).toEqual([0, 1, 2, 3, 4]);
    expect(ctx.throttle.heldMessages).toBe(0);
    expect(ctx.timers).toHaveLength(0);
  });

  it("holds a capped host to its rate after the first burst, and keeps its messages in order", () => {
    const ctx = makeThrottle(1000);
    const SIZE = 4096;
    const BURST = 16 * 1024;
    for (let index = 0; index < 20; index += 1) ctx.submit(index, SIZE);
    expect(ctx.released).toHaveLength(4);
    expect(ctx.throttle.heldMessages).toBe(16);

    ctx.runUntil(30_000);
    // Everything released so far fits the burst plus what the rate allowed, to within one message.
    expect(ctx.clock.now).toBeGreaterThanOrEqual(30_000);
    expect(ctx.released.length * SIZE).toBeLessThanOrEqual(BURST + ctx.clock.now + SIZE);
    expect(ctx.released.length * SIZE).toBeGreaterThan(BURST + ctx.clock.now - 2 * SIZE);

    ctx.runUntil(Number.POSITIVE_INFINITY);
    expect(ctx.released).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(ctx.clock.now).toBeGreaterThanOrEqual(60_000);
    expect(ctx.throttle.heldMessages).toBe(0);
  });

  it("lets everything held go, in order, as soon as the ceiling is lifted", () => {
    const ctx = makeThrottle(1000);
    for (let index = 0; index < 8; index += 1) ctx.submit(index, 4096);
    expect(ctx.throttle.heldMessages).toBe(4);
    ctx.cap.value = null;
    ctx.submit(8, 4096);
    expect(ctx.released).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ctx.throttle.heldMessages).toBe(0);
    expect(ctx.timers).toHaveLength(0);
  });

  it("notices a lifted ceiling when its timer fires", () => {
    const ctx = makeThrottle(1000);
    for (let index = 0; index < 6; index += 1) ctx.submit(index, 4096);
    expect(ctx.released).toHaveLength(4);
    ctx.cap.value = null;
    ctx.runUntil(Number.POSITIVE_INFINITY);
    expect(ctx.released).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("forgets what a finished session had waiting, and keeps the others", () => {
    const ctx = makeThrottle(1000);
    for (let index = 0; index < 4; index += 1) ctx.submit(index, 4096, "first");
    ctx.submit(4, 4096, "gone");
    ctx.submit(5, 4096, "kept");
    ctx.submit(6, 4096, "gone");
    expect(ctx.throttle.heldMessages).toBe(3);
    ctx.throttle.removeSession("gone");
    expect(ctx.throttle.heldMessages).toBe(1);
    ctx.runUntil(Number.POSITIVE_INFINITY);
    expect(ctx.released).toEqual([0, 1, 2, 3, 5]);
  });
});

describe("degraded operation in a running relay", () => {
  const WEBHOOK = "https://alerts.example.test/hook";

  function webhookRecorder() {
    const calls: Array<Record<string, unknown>> = [];
    let wake: (() => void) | null = null;
    const fetchMock = ((_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      wake?.();
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    const reached = (count: number) =>
      calls.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            wake = () => {
              if (calls.length >= count) resolve();
            };
          });
    return { calls, fetchMock, reached };
  }

  it("alarms at 70% and 90%, refuses new hosts new sessions, and spares settled hosts", async () => {
    const { calls, fetchMock, reached } = webhookRecorder();
    await withRelay(
      { egressBudgetBytes: 1000, trafficCheckMs: 10, alertWebhookUrl: WEBHOOK },
      async (relay) => {
        const host = newHost();
        await registerHost(relay, host);
        const control = await connectControl(relay, host);
        const device = newEd25519();
        const session = await openSession(relay, host, control, device);

        await session.client.send(Buffer.alloc(699));
        await session.hostData.next();
        expect(relay.relay.metrics.snapshot().traffic).toMatchObject({ level: "normal" });

        await session.client.send(Buffer.alloc(1));
        await session.hostData.next();
        await reached(1);
        expect(calls[0]).toMatchObject({
          level: "warn",
          thresholdPercent: 70,
          usedBytes: 700,
          budgetBytes: 1000,
        });
        expect(relay.relay.metrics.snapshot().traffic).toMatchObject({
          level: "warn",
          percent: 70,
        });

        // 70% to 90%: still open to new sessions, even for a new host.
        const another = await openSession(relay, host, control, newEd25519());
        another.client.close();

        await session.client.send(Buffer.alloc(200));
        await session.hostData.next();
        await reached(2);
        expect(calls[1]).toMatchObject({ level: "degraded", thresholdPercent: 90, usedBytes: 900 });
        expect(relay.relay.metrics.snapshot().traffic).toMatchObject({
          level: "degraded",
          usedBytes: 900,
          percent: 90,
        });

        const refused = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
        await sendClientAuth(refused, host, newEd25519(), relay.clock.now);
        expect(await refused.closed).toEqual({ code: CLOSE.limit, reason: "degraded" });
        expect(relay.relay.metrics.snapshot().disconnects.degraded).toBe(1);

        // The device that is already connected keeps working.
        await session.client.send(Buffer.alloc(10));
        expect((await session.hostData.next()).data).toHaveLength(10);

        // Its screen can say why: the host is a new one, so it is among the first to be squeezed.
        const status = await relay.http(
          "POST",
          `/v1/client/${host.hostId}/status`,
          statusBody(host, device, relay.clock.now),
        );
        expect(status.json).toMatchObject({ state: "squeezed" });

        // A week later the host is settled and is let in.
        relay.clock.now += 8 * DAY;
        const settled = await openSession(relay, host, control, newEd25519());
        settled.client.close();
        const later = await relay.http(
          "POST",
          `/v1/client/${host.hostId}/status`,
          statusBody(host, device, relay.clock.now),
        );
        expect(later.json).toMatchObject({ state: "ok" });

        // What went out: a subject and numbers. No host id, no address.
        const sent = JSON.stringify(calls);
        expect(sent).not.toContain(host.hostId);
        expect(sent).not.toContain("127.0.0.1");
        expect(relay.logs.filter((line) => line.includes('"event":"alert"'))).toHaveLength(2);
        expect(relay.logs.join("\n")).not.toContain(host.hostId);
      },
      { fetch: fetchMock },
    );
  });

  it("lifts the squeeze when the UTC month turns", () =>
    withRelay({ egressBudgetBytes: 1000, newHostAgeDays: 3650 }, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const session = await openSession(relay, host, control, newEd25519());
      await session.client.send(Buffer.alloc(950));
      await session.hostData.next();
      expect(relay.relay.metrics.snapshot().traffic.level).toBe("degraded");

      const refused = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await sendClientAuth(refused, host, newEd25519(), relay.clock.now);
      expect((await refused.closed).reason).toBe("degraded");

      relay.clock.now += 40 * DAY;
      expect(relay.relay.metrics.snapshot().traffic).toMatchObject({
        level: "normal",
        usedBytes: 0,
        month: monthKey(relay.clock.now),
      });
      const admitted = await openSession(relay, host, control, newEd25519());
      admitted.client.close();
    }));

  it("keeps counting across a restart, and tells the operator again that it is over 70%", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "k3-relay-restart-"));
    const dbPath = NodePath.join(directory, "relay.sqlite");
    try {
      await withRelay({ dbPath, egressBudgetBytes: 1000 }, async (relay) => {
        const host = newHost();
        await registerHost(relay, host);
        const control = await connectControl(relay, host);
        const session = await openSession(relay, host, control, newEd25519());
        await session.client.send(Buffer.alloc(800));
        await session.hostData.next();
      });
      await withRelay({ dbPath, egressBudgetBytes: 1000 }, async (relay) => {
        expect(relay.relay.metrics.snapshot().traffic).toMatchObject({
          level: "warn",
          usedBytes: 800,
        });
        expect(relay.logs.filter((line) => line.includes('"event":"alert"'))).toHaveLength(1);
      });
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
