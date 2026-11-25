import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { deviceIdOf } from "./crypto.ts";
import {
  connectControl,
  eventOnce,
  newEd25519,
  newHost,
  open,
  openSession,
  registerHost,
  revocationFor,
  sendClientAuth,
  tryOpen,
  withRelay,
  type ControlLink,
  type TestHost,
  type TestRelay,
} from "./relay.testkit.ts";
import type { RelayConfig } from "./config.ts";
import { CLOSE } from "./server.ts";

async function withSession<T>(
  overrides: Partial<RelayConfig>,
  work: (
    relay: TestRelay,
    session: Awaited<ReturnType<typeof openSession>>,
    host: TestHost,
    control: ControlLink,
  ) => Promise<T>,
): Promise<T> {
  return withRelay(overrides, async (relay) => {
    const host = newHost();
    await registerHost(relay, host);
    const control = await connectControl(relay, host);
    const session = await openSession(relay, host, control, newEd25519());
    return work(relay, session, host, control);
  });
}

const numbered = (index: number, size: number): Buffer => {
  const buffer = NodeCrypto.randomBytes(size);
  buffer.writeUInt32BE(index, 0);
  return buffer;
};

describe("splice", () => {
  it("passes binary frames both ways, byte for byte and in order", () =>
    withSession({}, async (_relay, { client, hostData }) => {
      const upstream = [numbered(0, 4), numbered(1, 100), numbered(2, 16 * 1024)];
      for (const frame of upstream) await client.send(frame);
      for (const frame of upstream) {
        const received = await hostData.next();
        expect(received.isBinary).toBe(true);
        expect(received.data.equals(frame)).toBe(true);
      }
      const downstream = [numbered(3, 8), numbered(4, 256 * 1024)];
      for (const frame of downstream) await hostData.send(frame);
      for (const frame of downstream) {
        const received = await client.next();
        expect(received.isBinary).toBe(true);
        expect(received.data.equals(frame)).toBe(true);
      }
    }));

  it("keeps text as text and does not look inside", () =>
    withSession({}, async (_relay, { client, hostData }) => {
      await client.send('{"type":"auth","not":"parsed by the relay"}');
      const received = await hostData.next();
      expect(received.isBinary).toBe(false);
      expect(received.data.toString("utf8")).toBe('{"type":"auth","not":"parsed by the relay"}');
    }));

  it("allows messages up to the post-auth limit and closes on anything larger", () =>
    withSession({ postAuthMaxPayload: 64 * 1024 }, async (_relay, { client, hostData }) => {
      await client.send(numbered(1, 64 * 1024));
      expect((await hostData.next()).data).toHaveLength(64 * 1024);
      await client.send(numbered(2, 64 * 1024 + 1));
      expect((await client.closed).code).toBe(1009);
      expect((await hostData.closed).code).toBeGreaterThanOrEqual(1000);
    }));

  it("closes the host side when the client closes, with the same code and reason", () =>
    withSession({}, async (relay, { client, hostData }) => {
      client.close(4001, "bye");
      expect(await hostData.closed).toEqual({ code: 4001, reason: "bye" });
      expect(await client.closed).toMatchObject({ code: 4001 });
      expect(relay.relay.metrics.snapshot().disconnects["peer-closed"]).toBe(1);
      expect(relay.relay.metrics.snapshot().sessions).toBe(0);
    }));

  it("closes the client when the host data socket closes", () =>
    withSession({}, async (_relay, { client, hostData }) => {
      hostData.close(1000, "host done");
      expect(await client.closed).toEqual({ code: 1000, reason: "host done" });
    }));

  it("closes both sides when a socket dies without a closing handshake", () =>
    withSession({}, async (_relay, { client, hostData }) => {
      hostData.ws.terminate();
      expect((await client.closed).code).toBeGreaterThanOrEqual(1000);
    }));

  it("counts the bytes it relayed, once per byte, for the host", () =>
    withSession({}, async (relay, { client, hostData }) => {
      await client.send(numbered(0, 1000));
      await hostData.next();
      await hostData.send(numbered(0, 500));
      await client.next();
      expect(relay.relay.metrics.snapshot().relayedBytes).toBe(1500);
    }));

  it("delivers everything intact when the shared bandwidth bucket runs dry", () =>
    withSession(
      { globalBandwidthBytesPerSec: 4_000_000, globalBurstBytes: 16 * 1024 },
      async (_relay, { client, hostData }) => {
        const frames = Array.from({ length: 16 }, (_, index) => numbered(index, 64 * 1024));
        for (const frame of frames) await hostData.send(frame);
        for (const frame of frames) expect((await client.next()).data.equals(frame)).toBe(true);
      },
    ));
});

describe("backpressure", () => {
  const CHUNK = 256 * 1024;

  it("pauses the sender when the receiver is slow, then delivers everything in order", () =>
    withSession(
      { backpressureHighWaterBytes: 64 * 1024, backpressureCloseMs: 60_000 },
      async (relay, { client, hostData }) => {
        client.ws.pause();
        const paused = eventOnce(relay.relay, "backpressure-pause");
        const total = 96;
        const sends = Array.from({ length: total }, (_, index) =>
          hostData.send(numbered(index, CHUNK)),
        );
        await paused;
        const resumed = eventOnce(relay.relay, "backpressure-resume");
        client.ws.resume();
        for (let index = 0; index < total; index += 1) {
          const frame = await client.next();
          expect(frame.data.readUInt32BE(0)).toBe(index);
          expect(frame.data).toHaveLength(CHUNK);
        }
        await Promise.all(sends);
        await resumed;
        const metrics = relay.relay.metrics.snapshot();
        expect(metrics.backpressurePauses).toBeGreaterThan(0);
        expect(metrics.maxBufferedAmount).toBeLessThanOrEqual(64 * 1024 + CHUNK);
        expect(metrics.disconnects.backpressure).toBeUndefined();
      },
    ));

  it("pauses on the global buffer budget even when each socket is under its own limit", () =>
    withSession(
      {
        backpressureHighWaterBytes: 64 * 1024 * 1024,
        bufferBudgetBytes: 512 * 1024,
        backpressureCloseMs: 60_000,
      },
      async (relay, { client, hostData }) => {
        client.ws.pause();
        const paused = eventOnce(relay.relay, "backpressure-pause");
        const total = 96;
        const sends = Array.from({ length: total }, (_, index) =>
          hostData.send(numbered(index, CHUNK)),
        );
        await paused;
        client.ws.resume();
        for (let index = 0; index < total; index += 1) {
          expect((await client.next()).data.readUInt32BE(0)).toBe(index);
        }
        await Promise.all(sends);
        expect(relay.relay.metrics.snapshot().bufferedBytes).toBe(0);
      },
    ));

  it("does not pause a quiet session because another one is flooding the shared budget", () =>
    withRelay(
      {
        backpressureHighWaterBytes: 64 * 1024 * 1024,
        bufferBudgetBytes: 256 * 1024,
        backpressureCloseMs: 60_000,
      },
      async (relay) => {
        const flooder = newHost();
        const quiet = newHost();
        await registerHost(relay, flooder);
        await registerHost(relay, quiet);
        const flooderControl = await connectControl(relay, flooder);
        const quietControl = await connectControl(relay, quiet);
        const slow = await openSession(relay, flooder, flooderControl, newEd25519());
        const small = await openSession(relay, quiet, quietControl, newEd25519());

        const pausedSessions = new Set<string>();
        relay.relay.events.on("backpressure-pause", (event: { sessionId: string }) =>
          pausedSessions.add(event.sessionId),
        );
        slow.client.ws.pause();
        const paused = eventOnce(relay.relay, "backpressure-pause");
        const sends = Array.from({ length: 24 }, (_, index) =>
          slow.hostData.send(numbered(index, 256 * 1024)),
        );
        await paused;
        expect(relay.relay.metrics.snapshot().bufferedBytes).toBeGreaterThan(256 * 1024);

        for (let index = 0; index < 5; index += 1) {
          await small.client.send(numbered(index, 1000));
          expect((await small.hostData.next()).data.readUInt32BE(0)).toBe(index);
        }
        expect(pausedSessions.has(slow.sessionId)).toBe(true);
        expect(pausedSessions.has(small.sessionId)).toBe(false);

        slow.client.ws.resume();
        for (let index = 0; index < 24; index += 1) await slow.client.next();
        await Promise.all(sends);
      },
    ));

  it("disconnects a receiver that stays stuck, closing the sender with 1013", () =>
    withSession(
      { backpressureHighWaterBytes: 64 * 1024, backpressureCloseMs: 100 },
      async (relay, { client, hostData }) => {
        client.ws.pause();
        for (let index = 0; index < 160; index += 1)
          hostData.send(numbered(index, CHUNK)).catch(() => {});
        expect((await hostData.closed).code).toBe(1013);
        const metrics = relay.relay.metrics.snapshot();
        expect(metrics.disconnects.backpressure).toBe(1);
        expect(metrics.backpressureCloses).toBe(1);
        expect(metrics.bufferedBytes).toBe(0);
      },
    ));
});

describe("session setup", () => {
  it("accepts the data socket only with the right token, only once, and only in time", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const client = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await sendClientAuth(client, host, newEd25519(), relay.clock.now);
      const opened = await control.peer.json();
      const base = `/v1/host/data/${String(opened.sessionId)}`;

      expect(await tryOpen(relay.wsUrl(`${base}?t=${"A".repeat(22)}`))).toEqual({ status: 401 });
      expect(await tryOpen(relay.wsUrl(`${base}`))).toEqual({ status: 401 });
      expect(await tryOpen(relay.wsUrl(`${base}?t=short`))).toEqual({ status: 401 });
      expect(
        await tryOpen(relay.wsUrl(`/v1/host/data/${"0".repeat(32)}?t=${String(opened.token)}`)),
      ).toEqual({
        status: 401,
      });

      const good = await tryOpen(relay.wsUrl(`${base}?t=${String(opened.token)}`));
      expect("peer" in good).toBe(true);
      expect(await tryOpen(relay.wsUrl(`${base}?t=${String(opened.token)}`))).toEqual({
        status: 401,
      });
      if ("peer" in good) good.peer.close();
    }));

  it("refuses a token after its 10 seconds are up", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const client = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await sendClientAuth(client, host, newEd25519(), relay.clock.now);
      const opened = await control.peer.json();
      relay.clock.now += 10_001;
      expect(
        await tryOpen(
          relay.wsUrl(`/v1/host/data/${String(opened.sessionId)}?t=${String(opened.token)}`),
        ),
      ).toEqual({ status: 401 });
      client.close();
    }));

  it("closes the client when the host does not open its data socket in time", () =>
    withRelay({ sessionSetupMs: 80 }, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const client = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await sendClientAuth(client, host, newEd25519(), relay.clock.now);
      await control.peer.json();
      expect((await client.closed).code).toBe(CLOSE.timeout);
      expect(relay.relay.metrics.snapshot().disconnects["setup-timeout"]).toBe(1);
      expect(relay.relay.metrics.snapshot().sessions).toBe(0);
    }));

  it("closes waiting clients when the host's control connection goes away", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const client = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await sendClientAuth(client, host, newEd25519(), relay.clock.now);
      await control.peer.json();
      control.peer.close();
      expect((await client.closed).code).toBe(CLOSE.hostOffline);
    }));

  it("keeps a running session alive when the control connection drops", () =>
    withSession({}, async (_relay, { client, hostData }, _host, control) => {
      control.peer.close();
      await control.peer.closed;
      await client.send(numbered(1, 10));
      expect((await hostData.next()).data).toHaveLength(10);
    }));

  it("closes both ends of a live session when the host revokes that device", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const device = newEd25519();
      const session = await openSession(relay, host, control, device);
      await control.peer.send(
        JSON.stringify({
          type: "revoke",
          ...revocationFor(host, deviceIdOf(device.alg, device.pub), relay.clock.now),
        }),
      );
      expect((await session.client.closed).code).toBe(CLOSE.revoked);
      expect((await session.hostData.closed).code).toBe(CLOSE.revoked);
    }));
});

describe("session limits", () => {
  it("caps concurrent sessions per host, and frees a slot when one ends", () =>
    withRelay({ maxSessionsPerHost: 2, maxSessionsPerDevice: 8 }, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const first = await openSession(relay, host, control, newEd25519());
      await openSession(relay, host, control, newEd25519());
      const third = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await sendClientAuth(third, host, newEd25519(), relay.clock.now);
      expect((await third.closed).code).toBe(CLOSE.limit);

      first.client.close();
      await first.hostData.closed;
      const again = await openSession(relay, host, control, newEd25519());
      expect(again.sessionId).toHaveLength(32);
    }));

  it("caps concurrent sessions per device", () =>
    withRelay({ maxSessionsPerDevice: 1 }, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const device = newEd25519();
      await openSession(relay, host, control, device);
      const second = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await sendClientAuth(second, host, device, relay.clock.now);
      expect((await second.closed).code).toBe(CLOSE.limit);
      await openSession(relay, host, control, newEd25519());
    }));

  it("caps sessions across the whole relay", () =>
    withRelay({ maxSessions: 1 }, async (relay) => {
      const first = newHost();
      const second = newHost();
      await registerHost(relay, first);
      await registerHost(relay, second);
      const firstControl = await connectControl(relay, first);
      const secondControl = await connectControl(relay, second);
      await openSession(relay, first, firstControl, newEd25519());
      const client = await open(relay.wsUrl(`/v1/client/${second.hostId}`));
      await sendClientAuth(client, second, newEd25519(), relay.clock.now);
      expect((await client.closed).code).toBe(CLOSE.limit);
      expect(secondControl.peer.ws.readyState).toBe(1);
    }));
});
