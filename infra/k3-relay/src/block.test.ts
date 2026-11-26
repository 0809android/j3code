import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { base64url } from "./bytes.ts";
import { LABELS, signingInput } from "./crypto.ts";
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
  tryOpen,
  withRelay,
  type TestHost,
  type TestRelay,
} from "./relay.testkit.ts";
import { CLOSE } from "./server.ts";
import { RelayStore } from "./store.ts";

/** A host with the right key tries to open its control connection, and we see how it ends. */
async function controlAttempt(relay: TestRelay, host: TestHost) {
  const peer = await open(relay.wsUrl("/v1/host/control"));
  const challenge = await peer.json();
  const nonce = Buffer.from(String(challenge.nonce), "base64url");
  const sig = host.signer.sign(signingInput(LABELS.hostControl, host.hostId, nonce));
  await peer.send(JSON.stringify({ type: "auth", hostId: host.hostId, sig: base64url(sig) }));
  return peer.closed;
}

const BLOCKED = { code: CLOSE.blocked, reason: "blocked" };

describe("blocking a host", () => {
  it("cuts off control and data at once and refuses every way back in", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const device = newEd25519();
      const session = await openSession(relay, host, control, device);
      const waiting = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await sendClientAuth(waiting, host, newEd25519(), relay.clock.now);
      expect(await control.peer.json()).toMatchObject({ type: "session-open" });

      relay.relay.store.blockHost(host.hostId, relay.clock.now);
      relay.relay.syncBlocked();

      expect(await control.peer.closed).toEqual(BLOCKED);
      expect(await session.client.closed).toEqual(BLOCKED);
      expect(await session.hostData.closed).toEqual(BLOCKED);
      expect(await waiting.closed).toEqual(BLOCKED);
      expect(relay.relay.metrics.snapshot()).toMatchObject({
        sessions: 0,
        disconnects: { blocked: 3 },
      });

      expect(await controlAttempt(relay, host)).toEqual(BLOCKED);

      const returning = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await sendClientAuth(returning, host, device, relay.clock.now);
      expect(await returning.closed).toEqual(BLOCKED);

      expect(await tryOpen(relay.wsUrl(`/v1/client/${host.hostId}?pairing=1`))).toEqual({
        status: 404,
      });

      const status = await relay.http(
        "POST",
        `/v1/client/${host.hostId}/status`,
        statusBody(host, device, relay.clock.now),
      );
      expect(status.json).toMatchObject({ online: false, state: "blocked" });
    }));

  it("leaves other hosts alone, and a block that did not change nothing", () =>
    withRelay({}, async (relay) => {
      const bad = newHost();
      const good = newHost();
      await registerHost(relay, bad);
      await registerHost(relay, good);
      const goodControl = await connectControl(relay, good);
      const session = await openSession(relay, good, goodControl, newEd25519());
      await connectControl(relay, bad);

      relay.relay.syncBlocked();
      relay.relay.store.blockHost(bad.hostId, relay.clock.now);
      relay.relay.syncBlocked();
      relay.relay.syncBlocked();

      expect(await controlAttempt(relay, bad)).toEqual(BLOCKED);
      expect(relay.relay.metrics.snapshot()).toMatchObject({ sessions: 1 });
      await session.client.send(Buffer.from("still here"));
      expect((await session.hostData.next()).data.toString()).toBe("still here");
    }));

  it("lets the host back in when it is unblocked", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      relay.relay.store.blockHost(host.hostId, relay.clock.now);
      relay.relay.syncBlocked();
      expect(await control.peer.closed).toEqual(BLOCKED);
      expect(await controlAttempt(relay, host)).toEqual(BLOCKED);

      expect(relay.relay.store.unblockHost(host.hostId)).toBe(true);
      relay.relay.syncBlocked();
      const again = await connectControl(relay, host);
      again.peer.close();
    }));

  it("still honours BLOCKED_HOSTS from the settings", async () => {
    const host = newHost();
    await withRelay({ blockedHosts: [host.hostId] }, async (relay) => {
      expect((await registerHost(relay, host)).status).toBe(201);
      expect(await controlAttempt(relay, host)).toEqual(BLOCKED);
      const other = newHost();
      await registerHost(relay, other);
      (await connectControl(relay, other)).peer.close();
    });
  });

  it("keeps a block over a restart", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "k3-relay-block-"));
    const dbPath = NodePath.join(directory, "relay.sqlite");
    const host = newHost();
    try {
      await withRelay({ dbPath }, async (relay) => {
        await registerHost(relay, host);
        (await connectControl(relay, host)).peer.close();
      });
      const store = new RelayStore(dbPath);
      expect(store.blockHost(host.hostId, EPOCH)).toBe(true);
      expect(store.blockHost(host.hostId, EPOCH)).toBe(false);
      store.close();
      await withRelay({ dbPath }, async (relay) => {
        expect(await controlAttempt(relay, host)).toEqual(BLOCKED);
      });
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
