// @effect-diagnostics nodeBuiltinImport:off -- the relay persists to node:sqlite and hashes the schema.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import type { DeviceAlg } from "./crypto.ts";

const DAY_MS = 86_400_000;

/**
 * Everything the relay persists. There is no column for an IP address, a device name,
 * a project name or any traffic content, and `grant_json` is written from parsed fields only.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hosts (
  host_id TEXT PRIMARY KEY,
  hk BLOB NOT NULL,
  registered_day INTEGER NOT NULL,
  last_seen_day INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS grants (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  dk BLOB NOT NULL,
  alg TEXT NOT NULL,
  grant_json TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, device_id)
) STRICT;
CREATE TABLE IF NOT EXISTS revocations (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  sig TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, device_id)
) STRICT;
CREATE TABLE IF NOT EXISTS invites (
  code_hash BLOB PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS usage (
  host_id TEXT NOT NULL,
  month TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (host_id, month)
) STRICT;
CREATE TABLE IF NOT EXISTS blocked_hosts (
  host_id TEXT PRIMARY KEY,
  blocked_at INTEGER NOT NULL
) STRICT;
`;

export const SCHEMA_HASH = NodeCrypto.createHash("sha256").update(SCHEMA_SQL).digest("hex");

export interface HostRow {
  readonly hostId: string;
  readonly hk: Buffer;
  readonly registeredDay: number;
  readonly lastSeenDay: number;
}

export interface GrantRow {
  readonly hostId: string;
  readonly deviceId: string;
  readonly dk: Buffer;
  readonly alg: DeviceAlg;
  readonly grantJson: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface PurgeResult {
  readonly hosts: number;
  readonly grants: number;
  readonly revocations: number;
  readonly invites: number;
  readonly usage: number;
}

type Row = Record<string, NodeSqlite.SQLOutputValue>;

export class RelayStore {
  readonly #db: NodeSqlite.DatabaseSync;
  readonly #statements = new Map<string, NodeSqlite.StatementSync>();

  constructor(path: string) {
    this.#db = new NodeSqlite.DatabaseSync(path);
    if (path !== ":memory:") {
      this.#db.exec("PRAGMA journal_mode = WAL");
      this.#db.exec("PRAGMA synchronous = NORMAL");
    }
    this.#db.exec("PRAGMA busy_timeout = 2000");
    this.#db.exec(SCHEMA_SQL);
  }

  #stmt(sql: string): NodeSqlite.StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  ping(): boolean {
    return this.#stmt("SELECT 1 AS ok").get()?.ok === 1;
  }

  getHost(hostId: string): HostRow | undefined {
    const row = this.#stmt(
      "SELECT host_id, hk, registered_day, last_seen_day FROM hosts WHERE host_id = ?",
    ).get(hostId) as Row | undefined;
    if (!row) return undefined;
    return {
      hostId: String(row.host_id),
      hk: Buffer.from(row.hk as Uint8Array),
      registeredDay: Number(row.registered_day),
      lastSeenDay: Number(row.last_seen_day),
    };
  }

  hostCount(): number {
    return Number(this.#stmt("SELECT COUNT(*) AS n FROM hosts").get()?.n ?? 0);
  }

  /** Returns true when the host is new. Registering the same key again changes nothing. */
  insertHost(hostId: string, hk: Uint8Array, day: number): boolean {
    const result = this.#stmt(
      "INSERT OR IGNORE INTO hosts (host_id, hk, registered_day, last_seen_day) VALUES (?, ?, ?, ?)",
    ).run(hostId, hk, day, day);
    return Number(result.changes) > 0;
  }

  touchHost(hostId: string, day: number): void {
    this.#stmt("UPDATE hosts SET last_seen_day = ? WHERE host_id = ? AND last_seen_day <> ?").run(
      day,
      hostId,
      day,
    );
  }

  grantCount(hostId: string): number {
    return Number(
      this.#stmt("SELECT COUNT(*) AS n FROM grants WHERE host_id = ?").get(hostId)?.n ?? 0,
    );
  }

  hasGrant(hostId: string, deviceId: string): boolean {
    return (
      this.#stmt("SELECT 1 AS ok FROM grants WHERE host_id = ? AND device_id = ?").get(
        hostId,
        deviceId,
      ) !== undefined
    );
  }

  upsertGrant(row: GrantRow): void {
    this.#stmt(
      `INSERT INTO grants (host_id, device_id, dk, alg, grant_json, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (host_id, device_id) DO UPDATE SET
         dk = excluded.dk, alg = excluded.alg, grant_json = excluded.grant_json,
         issued_at = excluded.issued_at, expires_at = excluded.expires_at
       WHERE excluded.issued_at >= grants.issued_at`,
    ).run(row.hostId, row.deviceId, row.dk, row.alg, row.grantJson, row.issuedAt, row.expiresAt);
  }

  getGrant(hostId: string, deviceId: string): GrantRow | undefined {
    const row = this.#stmt(
      "SELECT host_id, device_id, dk, alg, grant_json, issued_at, expires_at FROM grants WHERE host_id = ? AND device_id = ?",
    ).get(hostId, deviceId) as Row | undefined;
    if (!row) return undefined;
    return {
      hostId: String(row.host_id),
      deviceId: String(row.device_id),
      dk: Buffer.from(row.dk as Uint8Array),
      alg: String(row.alg) as DeviceAlg,
      grantJson: String(row.grant_json),
      issuedAt: Number(row.issued_at),
      expiresAt: Number(row.expires_at),
    };
  }

  /** Keeps the latest revocation time. A grant issued at or before it is revoked. */
  upsertRevocation(
    hostId: string,
    deviceId: string,
    revokedAt: number,
    sig: string,
    now: number,
  ): void {
    this.#stmt(
      `INSERT INTO revocations (host_id, device_id, revoked_at, sig, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (host_id, device_id) DO UPDATE SET
         revoked_at = excluded.revoked_at, sig = excluded.sig, created_at = excluded.created_at
       WHERE excluded.revoked_at > revocations.revoked_at`,
    ).run(hostId, deviceId, revokedAt, sig, now);
  }

  getRevokedAt(hostId: string, deviceId: string): number | undefined {
    const row = this.#stmt(
      "SELECT revoked_at FROM revocations WHERE host_id = ? AND device_id = ?",
    ).get(hostId, deviceId);
    return row ? Number(row.revoked_at) : undefined;
  }

  addInvite(codeHash: Uint8Array, expiresAt: number): void {
    this.#stmt("INSERT OR IGNORE INTO invites (code_hash, expires_at) VALUES (?, ?)").run(
      codeHash,
      expiresAt,
    );
  }

  /** One statement, so two requests cannot both spend the same code. */
  consumeInvite(codeHash: Uint8Array, now: number): boolean {
    const result = this.#stmt(
      "UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
    ).run(now, codeHash, now);
    return Number(result.changes) > 0;
  }

  /** Returns true when the host was not blocked before. */
  blockHost(hostId: string, now: number): boolean {
    const result = this.#stmt(
      "INSERT OR IGNORE INTO blocked_hosts (host_id, blocked_at) VALUES (?, ?)",
    ).run(hostId, now);
    return Number(result.changes) > 0;
  }

  /** Returns true when the host was blocked. */
  unblockHost(hostId: string): boolean {
    const result = this.#stmt("DELETE FROM blocked_hosts WHERE host_id = ?").run(hostId);
    return Number(result.changes) > 0;
  }

  blockedHosts(): string[] {
    return this.#stmt("SELECT host_id FROM blocked_hosts ORDER BY host_id")
      .all()
      .map((row) => String(row.host_id));
  }

  getUsage(hostId: string, month: string): number {
    const row = this.#stmt("SELECT bytes FROM usage WHERE host_id = ? AND month = ?").get(
      hostId,
      month,
    );
    return row ? Number(row.bytes) : 0;
  }

  /** Everything the relay carried in a month, over all hosts. Survives a restart. */
  sumUsage(month: string): number {
    const row = this.#stmt("SELECT COALESCE(SUM(bytes), 0) AS n FROM usage WHERE month = ?").get(
      month,
    );
    return Number(row?.n ?? 0);
  }

  setUsage(hostId: string, month: string, bytes: number): void {
    this.#stmt(
      `INSERT INTO usage (host_id, month, bytes) VALUES (?, ?, ?)
       ON CONFLICT (host_id, month) DO UPDATE SET bytes = excluded.bytes`,
    ).run(hostId, month, bytes);
  }

  /**
   * A consistent copy of the whole database in one new file (`VACUUM INTO`), taken while the
   * relay keeps running. It fails if the file exists. The copy is checked before it is trusted,
   * and removed again when the check fails.
   */
  snapshotTo(destPath: string): SnapshotInfo {
    if (NodeFS.existsSync(destPath)) throw new Error("the destination already exists");
    this.#db.prepare("VACUUM INTO ?").run(destPath);
    try {
      NodeFS.chmodSync(destPath, 0o600);
      return verifySnapshot(destPath);
    } catch (error) {
      NodeFS.rmSync(destPath, { force: true });
      throw error;
    }
  }

  transaction(work: () => void): void {
    this.#db.exec("BEGIN");
    try {
      work();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Retention (spec section 10). */
  purge(
    now: number,
    retention: {
      readonly hostIdleDays: number;
      readonly grantAfterExpiryDays: number;
      readonly revocationDays: number;
      readonly inviteAfterUseDays: number;
    },
  ): PurgeResult {
    const count = (result: NodeSqlite.StatementResultingChanges) => Number(result.changes);
    let result: PurgeResult = { hosts: 0, grants: 0, revocations: 0, invites: 0, usage: 0 };
    this.transaction(() => {
      const idleBefore = Math.floor(now / DAY_MS) - retention.hostIdleDays;
      const idleHosts = "SELECT host_id FROM hosts WHERE last_seen_day < ?";
      this.#stmt(`DELETE FROM grants WHERE host_id IN (${idleHosts})`).run(idleBefore);
      this.#stmt(`DELETE FROM revocations WHERE host_id IN (${idleHosts})`).run(idleBefore);
      this.#stmt(`DELETE FROM usage WHERE host_id IN (${idleHosts})`).run(idleBefore);
      const hosts = count(this.#stmt("DELETE FROM hosts WHERE last_seen_day < ?").run(idleBefore));

      const revocationBefore = now - retention.revocationDays * DAY_MS;
      this.#stmt(
        `DELETE FROM grants WHERE EXISTS (
           SELECT 1 FROM revocations r
           WHERE r.host_id = grants.host_id AND r.device_id = grants.device_id
             AND r.created_at < ?)`,
      ).run(revocationBefore);
      const grants = count(
        this.#stmt("DELETE FROM grants WHERE expires_at < ?").run(
          now - retention.grantAfterExpiryDays * DAY_MS,
        ),
      );
      const revocations = count(
        this.#stmt("DELETE FROM revocations WHERE created_at < ?").run(revocationBefore),
      );
      const invites = count(
        this.#stmt(
          "DELETE FROM invites WHERE (used_at IS NOT NULL AND used_at < ?) OR expires_at < ?",
        ).run(
          now - retention.inviteAfterUseDays * DAY_MS,
          now - retention.inviteAfterUseDays * DAY_MS,
        ),
      );
      const usage = count(
        this.#stmt("DELETE FROM usage WHERE month < ?").run(monthKey(now - 62 * DAY_MS)),
      );
      result = { hosts, grants, revocations, invites, usage };
    });
    return result;
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }
}

export interface SnapshotInfo {
  readonly hosts: number;
  readonly bytes: number;
}

/** Opens a snapshot read-only and refuses it unless SQLite's own check passes. */
export function verifySnapshot(path: string): SnapshotInfo {
  const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA integrity_check").get();
    if (check?.integrity_check !== "ok") throw new Error("snapshot failed the integrity check");
    const hosts = Number(db.prepare("SELECT COUNT(*) AS n FROM hosts").get()?.n ?? 0);
    return { hosts, bytes: NodeFS.statSync(path).size };
  } finally {
    db.close();
  }
}

export function monthKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
