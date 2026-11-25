import { describe, expect, it } from "vite-plus/test";

import { base64url } from "./bytes.ts";
import { CLOSE } from "./server.ts";
import {
  connectControl,
  grantFor,
  openPairingWindow,
  closePairingWindow,
  newEd25519,
  newHost,
  open,
  openSession,
  registerHost,
  tryOpen,
  withRelay,
  type ControlLink,
  type TestHost,
  type TestRelay,
} from "./relay.testkit.ts";

async function registered(relay: TestRelay): Promise<TestHost> {
  const host = newHost();
  await registerHost(relay, host);
  return host;
}

describe("before authentication", () => {
  it("closes a client that sends more than 4 KiB before authenticating", () =>
    withRelay({}, async (relay) => {
      const host = await registered(relay);
      const client = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await client.next();
      await client.send(Buffer.alloc(4 * 1024 + 1));
      expect((await client.closed).code).toBe(1009);
    }));

  it("closes a control connection that sends more than 4 KiB before authenticating", () =>
    withRelay({}, async (relay) => {
      const control = await open(relay.wsUrl("/v1/host/control"));
      await control.next();
      await control.send("x".repeat(4 * 1024 + 1));
      expect((await control.closed).code).toBe(1009);
    }));

  it("does not negotiate permessage-deflate, however eagerly the client asks", () =>
    withRelay({}, async (relay) => {
      const client = await open(relay.wsUrl("/v1/host/control"), { perMessageDeflate: true });
      expect(client.ws.extensions).toBe("");
      client.close();
    }));

  it("closes a connection that never answers the nonce", () =>
    withRelay({ authTimeoutMs: 60 }, async (relay) => {
      const host = await registered(relay);
      const client = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      const control = await open(relay.wsUrl("/v1/host/control"));
      expect((await client.closed).code).toBe(CLOSE.timeout);
      expect((await control.closed).code).toBe(CLOSE.timeout);
      expect(relay.relay.metrics.snapshot().disconnects["auth-timeout"]).toBe(2);
    }));

  it("raises the limit once authenticated, to 64 KiB on control and 1 MiB on a splice", () =>
    withRelay({}, async (relay) => {
      const host = await registered(relay);
      const control = await connectControl(relay, host);
      await control.peer.send(
        JSON.stringify({ type: "pairing-close", pad: "x".repeat(16 * 1024) }),
      );
      const session = await openSession(relay, host, control, newEd25519());
      await session.client.send(Buffer.alloc(512 * 1024));
      expect((await session.hostData.next()).data).toHaveLength(512 * 1024);
      await control.peer.send("x".repeat(70 * 1024));
      expect((await control.peer.closed).code).toBe(1009);
    }));

  it("limits unauthenticated connections per address, and frees the slot when one closes", () =>
    withRelay({ preAuthMaxConcurrentPerIp: 3 }, async (relay) => {
      const host = await registered(relay);
      const url = relay.wsUrl(`/v1/client/${host.hostId}`);
      const held = await Promise.all([open(url), open(url), open(url)]);
      expect(await tryOpen(url)).toEqual({ status: 429 });
      held[0]?.close();
      await held[0]?.closed;
      expect(await tryOpen(url)).toHaveProperty("peer");
      expect(relay.relay.metrics.snapshot().rejections).toBe(1);
    }));

  it("does not count authenticated connections against that limit", () =>
    withRelay({ preAuthMaxConcurrentPerIp: 2 }, async (relay) => {
      const hosts = [await registered(relay), await registered(relay), await registered(relay)];
      const controls = [];
      for (const host of hosts) controls.push(await connectControl(relay, host));
      expect(relay.relay.metrics.snapshot().controls).toBe(3);
    }));

  it("limits connection attempts per minute per address", () =>
    withRelay({ preAuthPerMinutePerIp: 5 }, async (relay) => {
      const host = await registered(relay);
      relay.clock.now += 61_000;
      const url = relay.wsUrl(`/v1/client/${host.hostId}`);
      for (let index = 0; index < 4; index += 1) (await open(url)).close();
      expect(await tryOpen(url)).toHaveProperty("peer");
      expect(await tryOpen(url)).toEqual({ status: 429 });
      expect((await relay.http("POST", "/v1/hosts", { hk: "x" })).status).toBe(429);
      relay.clock.now += 60_001;
      expect(await tryOpen(url)).toHaveProperty("peer");
    }));

  it("counts IPv6 clients by /64 and trusts the forwarding header only when told to", () =>
    withRelay({ trustProxy: true, preAuthMaxConcurrentPerIp: 1 }, async (relay) => {
      const host = await registered(relay);
      const url = relay.wsUrl(`/v1/client/${host.hostId}`);
      const as = (address: string) => ({
        headers: { "x-forwarded-for": `203.0.113.99, ${address}` },
      });
      await open(url, as("2001:db8:0:1::1"));
      expect(await tryOpen(url, as("2001:db8:0:1:ffff::2"))).toEqual({ status: 429 });
      expect(await tryOpen(url, as("2001:db8:0:2::1"))).toHaveProperty("peer");
      expect(await tryOpen(url, as("198.51.100.4"))).toHaveProperty("peer");
    }));

  it("ignores a forged forwarding header when no proxy is trusted", () =>
    withRelay({ preAuthMaxConcurrentPerIp: 1 }, async (relay) => {
      const host = await registered(relay);
      const url = relay.wsUrl(`/v1/client/${host.hostId}`);
      await open(url, { headers: { "x-forwarded-for": "198.51.100.1" } });
      expect(await tryOpen(url, { headers: { "x-forwarded-for": "198.51.100.2" } })).toEqual({
        status: 429,
      });
    }));

  it("caps the number of control connections", () =>
    withRelay({ maxControlConnections: 2 }, async (relay) => {
      await connectControl(relay, await registered(relay));
      await connectControl(relay, await registered(relay));
      expect(await tryOpen(relay.wsUrl("/v1/host/control"))).toEqual({ status: 503 });
    }));

  it("refuses unknown paths and malformed host ids", () =>
    withRelay({}, async (relay) => {
      expect(await tryOpen(relay.wsUrl("/"))).toEqual({ status: 404 });
      expect(await tryOpen(relay.wsUrl("/v1/client/NOTAHOSTID"))).toEqual({ status: 404 });
      expect(await tryOpen(relay.wsUrl("/v1/host/data/zzz?t=x"))).toEqual({ status: 404 });
    }));
});

describe("control connection", () => {
  it("closes a host that floods it with messages", () =>
    withRelay({ controlMessagesPerMinute: 5 }, async (relay) => {
      const control = await connectControl(relay, await registered(relay));
      for (let index = 0; index < 6; index += 1)
        await control.peer.send(JSON.stringify({ type: "pairing-close" }));
      expect((await control.peer.closed).code).toBe(CLOSE.limit);
    }));

  it("closes on an unknown message type and on binary frames", () =>
    withRelay({}, async (relay) => {
      const first = await connectControl(relay, await registered(relay));
      await first.peer.send(JSON.stringify({ type: "shell" }));
      expect((await first.peer.closed).code).toBe(CLOSE.badRequest);
      const second = await connectControl(relay, await registered(relay));
      await second.peer.send(Buffer.from([1, 2, 3]));
      expect((await second.peer.closed).code).toBe(CLOSE.badRequest);
    }));

  it("refuses to store a grant it cannot verify, and caps stored grants per host", () =>
    withRelay({ maxGrantsPerHost: 1 }, async (relay) => {
      const host = await registered(relay);
      const control = await connectControl(relay, host);
      const device = newEd25519();
      const forged = grantFor({ ...host, signer: newEd25519() }, device, relay.clock.now);
      await control.peer.send(
        JSON.stringify({ type: "grant-register", grant: forged, dk: base64url(device.pub) }),
      );
      expect(await control.peer.json()).toEqual({ type: "error", code: "invalid-grant" });

      const grant = grantFor(host, device, relay.clock.now);
      await control.peer.send(
        JSON.stringify({ type: "grant-register", grant, dk: base64url(device.pub) }),
      );
      const other = newEd25519();
      await control.peer.send(
        JSON.stringify({
          type: "grant-register",
          grant: grantFor(host, other, relay.clock.now),
          dk: base64url(other.pub),
        }),
      );
      expect(await control.peer.json()).toEqual({ type: "error", code: "limit" });
      expect(relay.relay.store.grantCount(host.hostId)).toBe(1);
    }));

  it("only lets a host register grants for itself", () =>
    withRelay({}, async (relay) => {
      const host = await registered(relay);
      const victim = await registered(relay);
      const control = await connectControl(relay, host);
      const device = newEd25519();
      await control.peer.send(
        JSON.stringify({
          type: "grant-register",
          grant: grantFor(victim, device, relay.clock.now),
          dk: base64url(device.pub),
        }),
      );
      expect(await control.peer.json()).toEqual({ type: "error", code: "invalid-grant" });
      expect(relay.relay.store.grantCount(victim.hostId)).toBe(0);
    }));
});

describe("pairing connections", () => {
  async function withOpenWindow<T>(
    overrides: Parameters<typeof withRelay>[0],
    work: (relay: TestRelay, host: TestHost, control: ControlLink) => Promise<T>,
  ): Promise<T> {
    return withRelay(overrides, async (relay) => {
      const host = await registered(relay);
      const control = await connectControl(relay, host);
      await openPairingWindow(control, relay.clock.now + 300_000);
      return work(relay, host, control);
    });
  }

  it("is refused unless the host has opened a window, and a closed window looks like no host", () =>
    withRelay({}, async (relay) => {
      const host = await registered(relay);
      const url = `/v1/client/${host.hostId}?pairing=1`;
      expect(await tryOpen(relay.wsUrl(url))).toEqual({ status: 404 });
      const control = await connectControl(relay, host);
      expect(await tryOpen(relay.wsUrl(url))).toEqual({ status: 404 });
      expect(await tryOpen(relay.wsUrl(`/v1/client/${newHost().hostId}?pairing=1`))).toEqual({
        status: 404,
      });
      control.peer.close();
    }));

  it("splices an anonymous client to the host while the window is open", () =>
    withOpenWindow({}, async (relay, host, control) => {
      const client = await open(relay.wsUrl(`/v1/client/${host.hostId}?pairing=1`));
      const opened = await control.peer.json();
      expect(opened).toMatchObject({ type: "session-open", kind: "pairing" });
      expect(opened).not.toHaveProperty("deviceId");
      const data = await open(
        relay.wsUrl(`/v1/host/data/${String(opened.sessionId)}?t=${String(opened.token)}`),
      );
      expect(await client.json()).toEqual({ type: "accepted" });
      await client.send(Buffer.from("hello host"));
      expect((await data.next()).data.toString()).toBe("hello host");
    }));

  it("allows one pairing connection at a time per host", () =>
    withOpenWindow({}, async (relay, host) => {
      const url = relay.wsUrl(`/v1/client/${host.hostId}?pairing=1`);
      const first = await open(url);
      expect(await tryOpen(url)).toEqual({ status: 429 });
      first.close();
      await first.closed;
      expect(await tryOpen(url)).toHaveProperty("peer");
    }));

  it("allows a fixed number of attempts an hour per host, then waits", () =>
    withOpenWindow({ pairingAttemptsPerHour: 3 }, async (relay, host, control) => {
      const url = relay.wsUrl(`/v1/client/${host.hostId}?pairing=1`);
      for (let index = 0; index < 3; index += 1) {
        const client = await open(url);
        client.close();
        await client.closed;
        await control.peer.next();
      }
      expect(await tryOpen(url)).toEqual({ status: 429 });
      relay.clock.now += 3_600_001;
      await openPairingWindow(control, relay.clock.now + 300_000);
      expect(await tryOpen(url)).toHaveProperty("peer");
    }));

  it("closes the window after its expiry, and when the host closes it", () =>
    withOpenWindow({}, async (relay, host, control) => {
      const url = relay.wsUrl(`/v1/client/${host.hostId}?pairing=1`);
      relay.clock.now += 300_001;
      expect(await tryOpen(url)).toEqual({ status: 404 });
      await openPairingWindow(control, relay.clock.now + 60_000);
      await closePairingWindow(control);
      expect(await tryOpen(url)).toEqual({ status: 404 });
    }));

  it("closes the window when the control connection drops", () =>
    withOpenWindow({}, async (relay, host, control) => {
      control.peer.close();
      await control.peer.closed;
      expect(await tryOpen(relay.wsUrl(`/v1/client/${host.hostId}?pairing=1`))).toEqual({
        status: 404,
      });
    }));

  it("never keeps a window open longer than the relay's maximum", () =>
    withRelay({ pairingWindowMaxMs: 1_000 }, async (relay) => {
      const host = await registered(relay);
      const control = await connectControl(relay, host);
      await openPairingWindow(control, relay.clock.now + 86_400_000);
      relay.clock.now += 1_001;
      expect(await tryOpen(relay.wsUrl(`/v1/client/${host.hostId}?pairing=1`))).toEqual({
        status: 404,
      });
    }));

  it("ends a pairing connection that outlives its time budget", () =>
    withOpenWindow({ pairingSessionMaxMs: 60 }, async (relay, host) => {
      const client = await open(relay.wsUrl(`/v1/client/${host.hostId}?pairing=1`));
      expect((await client.closed).code).toBe(1000);
      expect(await tryOpen(relay.wsUrl(`/v1/client/${host.hostId}?pairing=1`))).toHaveProperty(
        "peer",
      );
    }));
});
