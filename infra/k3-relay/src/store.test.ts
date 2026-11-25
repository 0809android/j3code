import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { RelayStore, SCHEMA_HASH, SCHEMA_SQL, monthKey } from "./store.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const RETENTION = {
  hostIdleDays: 365,
  grantAfterExpiryDays: 30,
  revocationDays: 30,
  inviteAfterUseDays: 30,
};

const grantRow = (deviceId: string, issuedAt: number, expiresAt: number) => ({
  hostId: "h".repeat(32),
  deviceId,
  dk: Buffer.alloc(32, 1),
  alg: "ed25519" as const,
  grantJson: "{}",
  issuedAt,
  expiresAt,
});

describe("RelayStore", () => {
  it("registers a host once and tracks the last-seen day", () => {
    const store = new RelayStore(":memory:");
    expect(store.insertHost("a".repeat(32), Buffer.alloc(32, 5), 100)).toBe(true);
    expect(store.insertHost("a".repeat(32), Buffer.alloc(32, 6), 200)).toBe(false);
    expect(store.getHost("a".repeat(32))?.hk.equals(Buffer.alloc(32, 5))).toBe(true);
    store.touchHost("a".repeat(32), 150);
    expect(store.getHost("a".repeat(32))?.lastSeenDay).toBe(150);
    expect(store.hostCount()).toBe(1);
  });

  it("keeps the newest revocation and the newest grant", () => {
    const store = new RelayStore(":memory:");
    store.upsertRevocation("h".repeat(32), "d".repeat(32), 500, "sig", NOW);
    store.upsertRevocation("h".repeat(32), "d".repeat(32), 300, "older", NOW);
    expect(store.getRevokedAt("h".repeat(32), "d".repeat(32))).toBe(500);
    store.upsertGrant(grantRow("d".repeat(32), 200, 900));
    store.upsertGrant(grantRow("d".repeat(32), 100, 5));
    expect(store.getGrant("h".repeat(32), "d".repeat(32))?.issuedAt).toBe(200);
  });

  it("spends an invite exactly once, and not after it expires", () => {
    const store = new RelayStore(":memory:");
    const hash = NodeCrypto.createHash("sha256").update("code").digest();
    store.addInvite(hash, NOW + 1_000);
    expect(store.consumeInvite(hash, NOW)).toBe(true);
    expect(store.consumeInvite(hash, NOW)).toBe(false);
    const late = NodeCrypto.createHash("sha256").update("late").digest();
    store.addInvite(late, NOW + 1_000);
    expect(store.consumeInvite(late, NOW + 2_000)).toBe(false);
  });

  it("applies the retention periods from the spec", () => {
    const store = new RelayStore(":memory:");
    const today = Math.floor(NOW / DAY);
    store.insertHost("idle".padEnd(32, "a"), Buffer.alloc(32), today - 400);
    store.insertHost("live".padEnd(32, "a"), Buffer.alloc(32), today - 400);
    store.touchHost("live".padEnd(32, "a"), today - 10);
    store.upsertGrant({
      ...grantRow("1".repeat(32), NOW, NOW - 31 * DAY),
      hostId: "live".padEnd(32, "a"),
    });
    store.upsertGrant({
      ...grantRow("2".repeat(32), NOW, NOW - 29 * DAY),
      hostId: "live".padEnd(32, "a"),
    });
    store.upsertGrant({
      ...grantRow("3".repeat(32), NOW, NOW + 60 * DAY),
      hostId: "live".padEnd(32, "a"),
    });
    store.upsertRevocation(
      "live".padEnd(32, "a"),
      "3".repeat(32),
      NOW - 40 * DAY,
      "s",
      NOW - 40 * DAY,
    );
    store.upsertRevocation("live".padEnd(32, "a"), "4".repeat(32), NOW, "s", NOW - 10 * DAY);
    store.setUsage("live".padEnd(32, "a"), monthKey(NOW - 200 * DAY), 5);
    store.setUsage("live".padEnd(32, "a"), monthKey(NOW), 7);

    const result = store.purge(NOW, RETENTION);
    expect(result.hosts).toBe(1);
    expect(store.getHost("idle".padEnd(32, "a"))).toBeUndefined();
    expect(store.getHost("live".padEnd(32, "a"))).toBeDefined();
    expect(store.hasGrant("live".padEnd(32, "a"), "1".repeat(32))).toBe(false);
    expect(store.hasGrant("live".padEnd(32, "a"), "2".repeat(32))).toBe(true);
    expect(store.hasGrant("live".padEnd(32, "a"), "3".repeat(32))).toBe(false);
    expect(store.getRevokedAt("live".padEnd(32, "a"), "3".repeat(32))).toBeUndefined();
    expect(store.getRevokedAt("live".padEnd(32, "a"), "4".repeat(32))).toBe(NOW);
    expect(store.getUsage("live".padEnd(32, "a"), monthKey(NOW - 200 * DAY))).toBe(0);
    expect(store.getUsage("live".padEnd(32, "a"), monthKey(NOW))).toBe(7);
  });

  it("stores no column that could hold an address, a name or content", () => {
    expect(SCHEMA_SQL).not.toMatch(/\b(ip|addr|address|name|label|content|payload|user_agent)\b/iu);
    expect(SCHEMA_HASH).toMatch(/^[0-9a-f]{64}$/u);
  });
});
