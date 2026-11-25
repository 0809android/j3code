import { describe, expect, it } from "vite-plus/test";

import { deviceIdOf } from "./crypto.ts";
import {
  connectControl,
  grantFor,
  newEd25519,
  newHost,
  newP256,
  openSession,
  registerHost,
  revocationFor,
  statusBody,
  withRelay,
  type StatusOptions,
  type TestRelay,
} from "./relay.testkit.ts";

const status = (relay: TestRelay, hostId: string, body: unknown) =>
  relay.http("POST", `/v1/client/${hostId}/status`, body);

describe("status", () => {
  it("answers offline, then online, to a device holding a valid grant", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newP256();
      const offline = await status(relay, host.hostId, statusBody(host, device, relay.clock.now));
      expect(offline.status).toBe(200);
      expect(offline.json).toMatchObject({ online: false });

      const control = await connectControl(relay, host);
      const online = await status(relay, host.hostId, statusBody(host, device, relay.clock.now));
      expect(online.json).toMatchObject({ online: true, month: { bytes: 0 } });
      control.peer.close();
    }));

  it("reports this month's relayed bytes and the limit, for the settings meter", () =>
    withRelay({ monthlyQuotaBytes: 1234 }, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const device = newEd25519();
      const session = await openSession(relay, host, control, device);
      await session.client.send(Buffer.alloc(700));
      await session.hostData.next();
      const response = await status(relay, host.hostId, statusBody(host, device, relay.clock.now));
      expect(response.json).toMatchObject({ month: { bytes: 700, limit: 1234 } });
    }));

  it("cannot tell an unknown host from a bad signature, a bad grant, a stale request or a replay", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newEd25519();
      const now = relay.clock.now;
      const unknown = newHost();

      const cases: ReadonlyArray<
        readonly [string, string, StatusOptions & { hostFor?: typeof unknown }]
      > = [
        ["unknown host", unknown.hostId, { hostFor: unknown }],
        ["wrong device signature", host.hostId, { signWith: newEd25519() }],
        [
          "grant from another signer",
          host.hostId,
          { grant: grantFor({ ...host, signer: newEd25519() }, device, now) },
        ],
        ["stale timestamp", host.hostId, { ts: now - 120_000 }],
        ["future timestamp", host.hostId, { ts: now + 120_000 }],
      ];
      const responses = [];
      for (const [, hostId, options] of cases) {
        const target = options.hostFor ?? host;
        responses.push(await status(relay, hostId, statusBody(target, device, now, options)));
      }
      const replayBody = statusBody(host, device, now);
      expect((await status(relay, host.hostId, replayBody)).status).toBe(200);
      responses.push(await status(relay, host.hostId, replayBody));

      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(response.text).toBe(responses[0]?.text);
      }
    }));

  it("tells an authenticated device that it is revoked or expired, and nothing about presence", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const device = newEd25519();
      const now = relay.clock.now;
      const expired = grantFor(host, device, now - 1_000_000, { expiresAt: now - 1 });
      const expiredResponse = await status(
        relay,
        host.hostId,
        statusBody(host, device, now, { grant: expired }),
      );
      expect(expiredResponse.status).toBe(403);
      expect(expiredResponse.json).toEqual({ error: "grant-expired" });

      await control.peer.send(
        JSON.stringify({
          type: "revoke",
          ...revocationFor(host, deviceIdOf(device.alg, device.pub), now),
        }),
      );
      await relay.http("POST", "/v1/grants/revoke", {
        hostId: host.hostId,
        ...revocationFor(host, deviceIdOf(device.alg, device.pub), now),
      });
      const revoked = await status(relay, host.hostId, statusBody(host, device, now));
      expect(revoked.status).toBe(403);
      expect(revoked.json).toEqual({ error: "revoked" });
      expect(revoked.text).not.toContain("online");
    }));

  it("limits a device to 12 questions a minute", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newEd25519();
      const codes: number[] = [];
      for (let index = 0; index < 13; index += 1) {
        codes.push(
          (await status(relay, host.hostId, statusBody(host, device, relay.clock.now))).status,
        );
      }
      expect(codes.slice(0, 12).every((code) => code === 200)).toBe(true);
      expect(codes[12]).toBe(429);
      relay.clock.now += 60_001;
      expect(
        (await status(relay, host.hostId, statusBody(host, device, relay.clock.now))).status,
      ).toBe(200);
    }));
});
