import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { runAdmin } from "./admin.ts";
import { EPOCH } from "./relay.testkit.ts";
import { RelayStore } from "./store.ts";

const HOST = "h".repeat(32);

function inDirectory<T>(work: (directory: string) => T): T {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "k3-relay-backup-"));
  try {
    return work(directory);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

function seed(store: RelayStore) {
  store.insertHost(HOST, Buffer.alloc(32, 7), 100);
  store.upsertGrant({
    hostId: HOST,
    deviceId: "d".repeat(32),
    dk: Buffer.alloc(32, 3),
    alg: "ed25519",
    grantJson: "{}",
    issuedAt: EPOCH,
    expiresAt: EPOCH + 1000,
  });
  store.setUsage(HOST, "2027-01", 4242);
  store.blockHost("b".repeat(32), EPOCH);
}

describe("database snapshot", () => {
  it("copies everything, including what is still in the write-ahead log, into one private file", () =>
    inDirectory((directory) => {
      const store = new RelayStore(NodePath.join(directory, "relay.sqlite"));
      seed(store);
      const destination = NodePath.join(directory, "copy.sqlite");

      const info = store.snapshotTo(destination);

      expect(info.hosts).toBe(1);
      expect(info.bytes).toBe(NodeFS.statSync(destination).size);
      expect(NodeFS.statSync(destination).mode & 0o777).toBe(0o600);
      expect(
        NodeFS.readdirSync(directory)
          .filter((name) => name.startsWith("copy"))
          .toSorted(),
      ).toEqual(["copy.sqlite"]);

      // The relay keeps working, and the copy does not follow it.
      store.setUsage(HOST, "2027-01", 9999);
      const copy = new NodeSqlite.DatabaseSync(destination, { readOnly: true });
      expect(copy.prepare("SELECT bytes FROM usage").get()?.bytes).toBe(4242);
      expect(copy.prepare("SELECT COUNT(*) AS n FROM grants").get()?.n).toBe(1);
      expect(copy.prepare("SELECT COUNT(*) AS n FROM blocked_hosts").get()?.n).toBe(1);
      copy.close();
      store.close();
    }));

  it("can be opened as the relay's database again, which is how a restore works", () =>
    inDirectory((directory) => {
      const store = new RelayStore(NodePath.join(directory, "relay.sqlite"));
      seed(store);
      store.snapshotTo(NodePath.join(directory, "copy.sqlite"));
      store.close();

      const restored = new RelayStore(NodePath.join(directory, "copy.sqlite"));
      expect(restored.getHost(HOST)?.registeredDay).toBe(100);
      expect(restored.getGrant(HOST, "d".repeat(32))?.alg).toBe("ed25519");
      expect(restored.sumUsage("2027-01")).toBe(4242);
      expect(restored.blockedHosts()).toEqual(["b".repeat(32)]);
      restored.close();
    }));

  it("refuses to overwrite a file", () =>
    inDirectory((directory) => {
      const store = new RelayStore(NodePath.join(directory, "relay.sqlite"));
      const destination = NodePath.join(directory, "copy.sqlite");
      NodeFS.writeFileSync(destination, "precious");
      expect(() => store.snapshotTo(destination)).toThrow();
      expect(NodeFS.readFileSync(destination, "utf8")).toBe("precious");
      store.close();
    }));
});

describe("backup command", () => {
  function run(argv: string[], dbPath: string) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runAdmin(
      argv,
      { out: (text) => out.push(text), err: (text) => err.push(text) },
      { DB_PATH: dbPath },
    );
    return { code, out: out.join(""), err: err.join("") };
  }

  it("writes a snapshot and says how big it is", () =>
    inDirectory((directory) => {
      const dbPath = NodePath.join(directory, "relay.sqlite");
      const store = new RelayStore(dbPath);
      seed(store);
      const destination = NodePath.join(directory, "relay-test.sqlite");

      const result = run(["backup", destination], dbPath);

      expect(result.code).toBe(0);
      expect(result.out).toContain(`snapshot written to ${destination} (1 hosts,`);
      expect(NodeFS.existsSync(destination)).toBe(true);
      store.close();
    }));

  it("fails, with a reason and without a file, when the destination exists or is missing", () =>
    inDirectory((directory) => {
      const dbPath = NodePath.join(directory, "relay.sqlite");
      new RelayStore(dbPath).close();
      const existing = NodePath.join(directory, "taken.sqlite");
      NodeFS.writeFileSync(existing, "x");
      expect(run(["backup", existing], dbPath)).toMatchObject({ code: 1 });
      expect(run(["backup", existing], dbPath).err).toContain("backup failed");
      expect(run(["backup"], dbPath)).toMatchObject({ code: 2 });
      expect(
        run(["backup", NodePath.join(directory, "no", "such", "dir.sqlite")], dbPath).code,
      ).toBe(1);
    }));
});
