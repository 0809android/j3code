import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runAdmin } from "./admin.ts";
import { EPOCH, newHost } from "./relay.testkit.ts";
import { RelayStore } from "./store.ts";

function withDatabase<T>(work: (env: { DB_PATH: string }, path: string) => T): T {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "k3-relay-admin-"));
  const path = NodePath.join(directory, "relay.sqlite");
  try {
    return work({ DB_PATH: path }, path);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

function run(argv: string[], env: { DB_PATH: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runAdmin(
    argv,
    { out: (text) => out.push(text), err: (text) => err.push(text) },
    env,
    () => EPOCH,
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("operator commands", () => {
  it("blocks, lists and unblocks a host by id", () =>
    withDatabase((env, path) => {
      const { hostId } = newHost();
      const blocked = run(["block", hostId], env);
      expect(blocked.code).toBe(0);
      expect(blocked.out).toContain(`blocked ${hostId}`);
      expect(run(["block", hostId], env).out).toContain("already blocked");
      expect(run(["blocked"], env).out).toBe(`${hostId}\n`);

      const store = new RelayStore(path);
      expect(store.blockedHosts()).toEqual([hostId]);
      store.close();

      expect(run(["unblock", hostId], env)).toMatchObject({ code: 0 });
      expect(run(["blocked"], env).out).toBe("");
      expect(run(["unblock", hostId], env)).toMatchObject({ code: 1 });
    }));

  it("refuses something that is not a host id, before touching the database", () =>
    withDatabase((env, path) => {
      for (const argv of [["block"], ["block", "nope"], ["unblock", "A".repeat(32)]]) {
        const result = run(argv, env);
        expect(result.code).toBe(2);
        expect(result.err).toContain("host id");
      }
      expect(NodeFS.existsSync(path)).toBe(false);
    }));

  it("makes an invitation code and stores only its hash", () =>
    withDatabase((env, path) => {
      const result = run(["invite"], env);
      expect(result.code).toBe(0);
      const code = result.out.trim();
      expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/u);
      const store = new RelayStore(path);
      const hash = NodeCrypto.createHash("sha256").update(code).digest();
      expect(store.consumeInvite(hash, EPOCH + 1)).toBe(true);
      store.close();
    }));

  it("prints the usage for an unknown command", () =>
    withDatabase((env) => {
      const result = run(["frobnicate"], env);
      expect(result.code).toBe(2);
      expect(result.err).toContain("usage:");
    }));
});
