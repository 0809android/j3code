import { describe, expect, it } from "vite-plus/test";

import { ExpiringSet, PreAuthLimiter, SlidingWindow, ipKey } from "./limits.ts";

describe("ipKey", () => {
  it("keeps IPv4 as is and folds IPv4-mapped IPv6 onto it", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("groups IPv6 by /64, however the address is written", () => {
    const key = ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(key).toBe("2001:0db8:0001:0002::/64");
    expect(ipKey("2001:db8:1:2::1")).toBe(key);
    expect(ipKey("2001:DB8:1:2:ffff:ffff:ffff:ffff%eth0")).toBe(key);
    expect(ipKey("2001:db8:1:3::1")).not.toBe(key);
    expect(ipKey("::1")).toBe("0000:0000:0000:0000::/64");
  });

  it("does not trust garbage", () => {
    expect(ipKey("not an address")).toBe("unknown");
    expect(ipKey("")).toBe("unknown");
  });
});

describe("SlidingWindow", () => {
  it("allows `max` hits per window and frees them as time passes", () => {
    const clock = { now: 1_000 };
    const window = new SlidingWindow(60_000, 3, () => clock.now);
    expect([1, 2, 3, 4].map(() => window.tryHit("a"))).toEqual([true, true, true, false]);
    expect(window.tryHit("b")).toBe(true);
    clock.now += 60_001;
    expect(window.tryHit("a")).toBe(true);
    window.sweep();
    expect(window.size).toBe(1);
  });
});

describe("PreAuthLimiter", () => {
  it("caps concurrent connections per key and releases them once", () => {
    const clock = { now: 0 };
    const limiter = new PreAuthLimiter(2, 1_000, () => clock.now);
    const first = limiter.admit("ip");
    const second = limiter.admit("ip");
    expect(first && second).toBeTruthy();
    expect(limiter.admit("ip")).toBeNull();
    expect(limiter.admit("other")).not.toBeNull();
    first?.();
    first?.();
    expect(limiter.admit("ip")).not.toBeNull();
    expect(limiter.admit("ip")).toBeNull();
  });

  it("caps connections per minute, whether or not they are still open", () => {
    const clock = { now: 0 };
    const limiter = new PreAuthLimiter(100, 3, () => clock.now);
    for (let index = 0; index < 3; index += 1) limiter.admit("ip")?.();
    expect(limiter.admit("ip")).toBeNull();
    expect(limiter.hit("ip")).toBe(false);
    clock.now += 60_001;
    expect(limiter.admit("ip")).not.toBeNull();
  });
});

describe("ExpiringSet", () => {
  it("rejects a repeat until it expires", () => {
    const clock = { now: 0 };
    const set = new ExpiringSet(() => clock.now);
    expect(set.add("x", 1_000)).toBe(true);
    expect(set.add("x", 1_000)).toBe(false);
    clock.now = 1_001;
    expect(set.add("x", 1_000)).toBe(true);
    clock.now = 5_000;
    set.sweep();
    expect(set.size).toBe(0);
  });
});
