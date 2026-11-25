import { describe, expect, it } from "vite-plus/test";

import { FairScheduler } from "./fair.ts";

const RATE = 1_000_000;

function makeScheduler(burstBytes = 16_384) {
  const clock = { now: 0 };
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const scheduler = new FairScheduler({
    bytesPerSecond: RATE,
    burstBytes,
    quantumBytes: 8_192,
    now: () => clock.now,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  });
  return { scheduler, clock, timers };
}

function backlog(
  scheduler: FairScheduler,
  served: Map<string, number>,
  hostId: string,
  sessions: number,
  perSession: number,
  size: number,
  weight = 1,
) {
  for (let session = 0; session < sessions; session += 1) {
    for (let index = 0; index < perSession; index += 1) {
      scheduler.submit({
        hostId,
        sessionKey: `${hostId}/${session}`,
        size,
        weight,
        run: () => served.set(hostId, (served.get(hostId) ?? 0) + size),
      });
    }
  }
}

function runFor(ctx: ReturnType<typeof makeScheduler>, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 5) {
    ctx.clock.now += 5;
    ctx.scheduler.pump();
  }
}

describe("fair scheduler", () => {
  it("never delays anything while tokens remain (work-conserving)", () => {
    const ctx = makeScheduler(100_000);
    const served = new Map<string, number>();
    backlog(ctx.scheduler, served, "solo", 1, 3, 10_000);
    expect(served.get("solo")).toBe(30_000);
    expect(ctx.scheduler.queuedMessages).toBe(0);
    expect(ctx.timers).toHaveLength(0);
  });

  it("lets a lone backlogged session use the whole rate", () => {
    const ctx = makeScheduler();
    const served = new Map<string, number>();
    backlog(ctx.scheduler, served, "solo", 1, 2_000, 8_192);
    runFor(ctx, 1_000);
    expect(served.get("solo") ?? 0).toBeGreaterThan(RATE * 0.95);
    expect(served.get("solo") ?? 0).toBeLessThan(RATE * 1.05);
  });

  it("splits the rate by host, not by how many sessions a host opens", () => {
    const ctx = makeScheduler();
    const served = new Map<string, number>();
    backlog(ctx.scheduler, served, "one", 1, 600, 8_192);
    backlog(ctx.scheduler, served, "sixteen", 16, 40, 8_192);
    runFor(ctx, 2_000);
    const one = served.get("one") ?? 0;
    const sixteen = served.get("sixteen") ?? 0;
    expect(one / (one + sixteen)).toBeGreaterThan(0.45);
    expect(one / (one + sixteen)).toBeLessThan(0.55);
  });

  it("shares equally between the sessions of one host", () => {
    const ctx = makeScheduler();
    const perSession = new Map<string, number>();
    for (const key of ["a", "b"]) {
      for (let index = 0; index < 400; index += 1) {
        ctx.scheduler.submit({
          hostId: "host",
          sessionKey: key,
          size: 8_192,
          weight: 1,
          run: () => perSession.set(key, (perSession.get(key) ?? 0) + 8_192),
        });
      }
    }
    runFor(ctx, 1_500);
    const a = perSession.get("a") ?? 0;
    const b = perSession.get("b") ?? 0;
    expect(Math.abs(a - b) / (a + b)).toBeLessThan(0.05);
  });

  it("gives a lower-weight host a proportionally smaller share, without starving it", () => {
    const ctx = makeScheduler();
    const served = new Map<string, number>();
    backlog(ctx.scheduler, served, "old", 1, 600, 8_192, 1);
    backlog(ctx.scheduler, served, "new", 1, 600, 8_192, 0.25);
    runFor(ctx, 2_000);
    const old = served.get("old") ?? 0;
    const fresh = served.get("new") ?? 0;
    expect(fresh).toBeGreaterThan(0);
    expect(fresh / old).toBeGreaterThan(0.2);
    expect(fresh / old).toBeLessThan(0.3);
  });

  it("serves messages larger than a quantum, and keeps order within a session", () => {
    const ctx = makeScheduler();
    const order: number[] = [];
    for (const [index, size] of [1_000_000, 10, 500_000].entries()) {
      ctx.scheduler.submit({
        hostId: "h",
        sessionKey: "s",
        size,
        weight: 1,
        run: () => order.push(index),
      });
    }
    runFor(ctx, 3_000);
    expect(order).toEqual([0, 1, 2]);
  });

  it("drops a closed session's queue and reports queued bytes per session", () => {
    const ctx = makeScheduler();
    const served = new Map<string, number>();
    backlog(ctx.scheduler, served, "h", 1, 5, 10_000);
    expect(ctx.scheduler.queuedBytes("h/0")).toBe(30_000);
    ctx.scheduler.removeSession("h/0");
    expect(ctx.scheduler.queuedBytes("h/0")).toBe(0);
    expect(ctx.scheduler.queuedMessages).toBe(0);
  });
});
