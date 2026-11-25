import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { base64url } from "./bytes.ts";
import { deviceIdOf } from "./crypto.ts";
import { registrationSigningInput, solveChallenge, type PowChallenge } from "./pow.ts";
import { SCHEMA_HASH } from "./store.ts";
import {
  connectControl,
  grantFor,
  newEd25519,
  newHost,
  open,
  openSession,
  registerHost,
  revocationFor,
  sendClientAuth,
  statusBody,
  withRelay,
} from "./relay.testkit.ts";

const DEVICE_NAME = "Kino's iPhone 17";
const CONTENT = "SECRET-TERMINAL-OUTPUT-rm-rf";
const INVITE = "invite-code-plaintext-7f3a";

describe("what the relay keeps", () => {
  it("writes no address, device name, content or invite code to the database or the logs", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "k3-relay-privacy-"));
    const dbPath = NodePath.join(directory, "relay.sqlite");
    let logs: string[] = [];
    let hostId = "";
    try {
      await withRelay({ dbPath, requireInvite: true }, async (relay) => {
        relay.relay.store.addInvite(
          NodeCrypto.createHash("sha256").update(INVITE).digest(),
          relay.clock.now + 60_000,
        );
        const host = newHost();
        hostId = host.hostId;
        const hk = base64url(host.signer.pub);
        const challenge = (await relay.http("POST", "/v1/hosts", { hk })).json
          ?.challenge as PowChallenge;
        const nonce = solveChallenge(host.signer.pub, challenge);
        const sig = base64url(
          host.signer.sign(registrationSigningInput(host.signer.pub, challenge.mac, nonce)),
        );
        expect(
          (await relay.http("POST", "/v1/hosts", { hk, challenge, nonce, sig, invite: INVITE }))
            .status,
        ).toBe(201);

        const control = await connectControl(relay, host);
        const device = newEd25519();
        const deviceId = deviceIdOf(device.alg, device.pub);

        const named = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
        await sendClientAuth(named, host, device, relay.clock.now, {
          sendAs: { deviceName: DEVICE_NAME },
        });
        await named.closed;

        const grantWithName = { ...grantFor(host, device, relay.clock.now), name: DEVICE_NAME };
        await control.peer.send(
          JSON.stringify({
            type: "grant-register",
            grant: grantWithName,
            dk: base64url(device.pub),
          }),
        );
        expect(await control.peer.json()).toMatchObject({ type: "error" });
        await control.peer.send(
          JSON.stringify({
            type: "grant-register",
            grant: grantFor(host, device, relay.clock.now),
            dk: base64url(device.pub),
          }),
        );

        const session = await openSession(relay, host, control, device);
        await session.client.send(Buffer.from(CONTENT));
        await session.hostData.next();
        await session.hostData.send(Buffer.from(CONTENT));
        await session.client.next();
        await relay.http(
          "POST",
          `/v1/client/${host.hostId}/status`,
          statusBody(host, device, relay.clock.now),
        );
        await relay.http("GET", `/secret-path/${DEVICE_NAME}`);
        await control.peer.send(
          JSON.stringify({ type: "revoke", ...revocationFor(host, deviceId, relay.clock.now) }),
        );
        await session.client.closed;
        logs = relay.logs;
      });

      expect(logs.length).toBeGreaterThan(0);
      const needles = [DEVICE_NAME, CONTENT, INVITE, "127.0.0.1", "::ffff:", "::1", "secret-path"];
      const raw = NodeFS.readdirSync(directory)
        .map((name) => NodeFS.readFileSync(NodePath.join(directory, name)).toString("latin1"))
        .join("\n");
      expect(raw).toContain(hostId);
      for (const needle of needles) {
        expect(raw, `file bytes contain ${needle}`).not.toContain(needle);
        expect(logs.join("\n"), `logs contain ${needle}`).not.toContain(needle);
      }

      const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name));
      expect(tables.toSorted()).toEqual([
        "blocked_hosts",
        "grants",
        "hosts",
        "invites",
        "revocations",
        "usage",
      ]);
      for (const table of tables) {
        const columns = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => String(row.name));
        expect(columns.join(",")).not.toMatch(
          /(^|,)(ip|addr|address|name|device_name|label|content|payload)(,|$)/u,
        );
        const dump = JSON.stringify(
          db.prepare(`SELECT * FROM ${table}`).all(),
          (_key, value: unknown) => (value instanceof Uint8Array ? base64url(value) : value),
        );
        for (const needle of needles) expect(dump).not.toContain(needle);
      }
      expect(db.prepare("SELECT COUNT(*) AS n FROM grants").get()?.n).toBe(1);
      db.close();
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prints no access log: only lifecycle lines, with no paths, methods or host ids", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      await openSession(relay, host, control, newEd25519());
      await relay.http("GET", "/health");
      await relay.http("GET", "/nope");
      const events = relay.logs.map((line) => (JSON.parse(line) as { event: string }).event);
      expect(new Set(events)).toEqual(new Set(["listening", "purged"]));
      const text = relay.logs.join("\n");
      expect(text).not.toMatch(/\/v1|GET|POST|health/u);
      expect(text).not.toContain(host.hostId);
    }));
});

describe("addresses", () => {
  const needles = ["203.0.113.77", "198.51.100.8", "2001:db8:abcd", "2001:0db8:abcd", "127.0.0.1"];
  const via = (address: string) => ({ "x-forwarded-for": address });

  it("are counted per day in memory, by /64 for IPv6, and never reach the database or the logs", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "k3-relay-ip-"));
    const dbPath = NodePath.join(directory, "relay.sqlite");
    let logs: string[] = [];
    try {
      await withRelay({ dbPath, trustProxy: true, registrationsPerIpPerDay: 2 }, async (relay) => {
        const status = async (address: string) =>
          (await registerHost(relay, newHost(), via(address))).status;
        expect(await status("203.0.113.77")).toBe(201);
        expect(await status("203.0.113.77")).toBe(201);
        expect(await status("203.0.113.77")).toBe(429);
        expect(await status("198.51.100.8")).toBe(201);

        expect(await status("2001:db8:abcd:12::5")).toBe(201);
        expect(await status("2001:db8:abcd:12:ffff::9")).toBe(201);
        expect(await status("2001:db8:abcd:12::77")).toBe(429);
        expect(await status("2001:db8:abcd:13::1")).toBe(201);
        logs = relay.logs;
      });
      expect(logs.length).toBeGreaterThan(0);
      const raw = NodeFS.readdirSync(directory)
        .map((name) => NodeFS.readFileSync(NodePath.join(directory, name)).toString("latin1"))
        .join("\n");
      for (const needle of needles) {
        expect(raw, `file bytes contain ${needle}`).not.toContain(needle);
        expect(logs.join("\n"), `logs contain ${needle}`).not.toContain(needle);
      }
      const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      expect(db.prepare("SELECT COUNT(*) AS n FROM hosts").get()?.n).toBe(6);
      db.close();
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("public endpoints", () => {
  it("/health says ok and nothing else, in particular no counts", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      await connectControl(relay, host);
      const response = await relay.http("GET", "/health");
      expect(response.status).toBe(200);
      expect(response.text).toBe('{"ok":true}');
    }));

  it("/.well-known/k3-relay publishes the build and the limits", () =>
    withRelay({ gitCommit: "abc1234", imageDigest: "sha256:feed" }, async (relay) => {
      const response = await relay.http("GET", "/.well-known/k3-relay");
      expect(response.json).toMatchObject({
        name: "k3-relay",
        gitCommit: "abc1234",
        imageDigest: "sha256:feed",
        schemaHash: SCHEMA_HASH,
        limits: {
          preAuthMaxPayload: 4096,
          postAuthMaxPayload: 1_048_576,
          maxSessionsPerHost: 16,
          bufferBudgetBytes: 200 * 1024 * 1024,
          monthlyQuotaBytes: 200_000_000_000,
          requireInvite: false,
        },
      });
    }));

  it("/metrics answers the machine itself, never a proxied request", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const session = await openSession(relay, host, control, newEd25519());
      await session.client.send(Buffer.alloc(2000));
      await session.hostData.next();
      session.client.close();
      await session.hostData.closed;

      const local = await relay.http("GET", "/metrics");
      expect(local.status).toBe(200);
      expect(local.json).toMatchObject({
        sessions: 0,
        sessionsOpened: 1,
        peakSessions: 1,
        controls: 1,
        relayedBytes: 2000,
        disconnects: { "peer-closed": 1 },
      });
      expect(local.json).toHaveProperty("memory.rssBytes");
      expect(local.json).toHaveProperty("bandwidthMbpsP95");
      expect(local.json).toHaveProperty("maxBufferedAmount");
      expect(local.json).toHaveProperty("webSockets");

      for (const header of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
        const proxied = await relay.http("GET", "/metrics", undefined, { [header]: "203.0.113.5" });
        expect(proxied.status).toBe(404);
      }
    }));

  it("answers unknown routes without naming the server", () =>
    withRelay({}, async (relay) => {
      const response = await relay.http("GET", "/v1/anything");
      expect(response.status).toBe(404);
      expect(response.headers.get("server")).toBeNull();
      expect(response.headers.get("x-powered-by")).toBeNull();
    }));
});
