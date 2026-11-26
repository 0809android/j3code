import { describe, expect, it } from "vite-plus/test";

import { base64url } from "./bytes.ts";
import type { RelayConfig } from "./config.ts";
import { LABELS, deviceIdOf, signingInput } from "./crypto.ts";
import { CLOSE } from "./server.ts";
import {
  connectControl,
  grantFor,
  newEd25519,
  newHost,
  newP256,
  open,
  openSession,
  registerHost,
  revocationFor,
  sendClientAuth,
  withRelay,
  type ClientAuthOptions,
  type ControlLink,
  type Signer,
  type TestHost,
  type TestRelay,
} from "./relay.testkit.ts";

async function withHost<T>(
  work: (relay: TestRelay, host: TestHost, control: ControlLink) => Promise<T>,
  overrides: Partial<RelayConfig> = {},
): Promise<T> {
  return withRelay(overrides, async (relay) => {
    const host = newHost();
    expect((await registerHost(relay, host)).status).toBe(201);
    const control = await connectControl(relay, host);
    return work(relay, host, control);
  });
}

async function attempt(
  relay: TestRelay,
  host: TestHost,
  device: Signer,
  options: ClientAuthOptions = {},
): Promise<number> {
  const client = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
  await sendClientAuth(client, host, device, relay.clock.now, options);
  return (await client.closed).code;
}

describe("host control authentication", () => {
  it("accepts a signed nonce and registers the control", () =>
    withHost(async (relay) => {
      expect(relay.relay.metrics.snapshot().controls).toBe(1);
    }));

  it("rejects a bad signature, an unregistered host and a malformed reply with the same close", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const unregistered = newHost();

      const bad = await open(relay.wsUrl("/v1/host/control"));
      await bad.next();
      await bad.send(
        JSON.stringify({ type: "auth", hostId: host.hostId, sig: base64url(Buffer.alloc(64)) }),
      );

      const stranger = await open(relay.wsUrl("/v1/host/control"));
      const nonce = Buffer.from(String((await stranger.json()).nonce), "base64url");
      await stranger.send(
        JSON.stringify({
          type: "auth",
          hostId: unregistered.hostId,
          sig: base64url(
            unregistered.signer.sign(signingInput(LABELS.hostControl, unregistered.hostId, nonce)),
          ),
        }),
      );

      const garbage = await open(relay.wsUrl("/v1/host/control"));
      await garbage.next();
      await garbage.send("not json");

      expect((await bad.closed).code).toBe(CLOSE.unauthorized);
      expect((await stranger.closed).code).toBe(CLOSE.unauthorized);
      expect((await garbage.closed).code).toBe(CLOSE.unauthorized);
      expect(relay.relay.metrics.snapshot().controls).toBe(0);
    }));

  it("rejects a signature captured from another connection (nonce reuse)", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const first = await open(relay.wsUrl("/v1/host/control"));
      const firstNonce = Buffer.from(String((await first.json()).nonce), "base64url");
      const captured = JSON.stringify({
        type: "auth",
        hostId: host.hostId,
        sig: base64url(host.signer.sign(signingInput(LABELS.hostControl, host.hostId, firstNonce))),
      });
      const second = await open(relay.wsUrl("/v1/host/control"));
      await second.next();
      await second.send(captured);
      expect((await second.closed).code).toBe(CLOSE.unauthorized);
      first.close();
    }));

  it("does not let a second reply on the same connection through", () =>
    withHost(async (relay, host, control) => {
      await control.peer.send(JSON.stringify({ type: "auth", hostId: host.hostId, sig: "x" }));
      expect((await control.peer.closed).code).toBe(CLOSE.badRequest);
    }));

  it("replaces the old control when the real host reconnects", () =>
    withHost(async (relay, host, first) => {
      const second = await connectControl(relay, host);
      expect((await first.peer.closed).code).toBe(CLOSE.replaced);
      expect(relay.relay.metrics.snapshot().controls).toBe(1);
      const device = newEd25519();
      const session = await openSession(relay, host, second, device);
      session.client.close();
      session.hostData.close();
    }));

  it("cannot be taken over by someone without the host key", () =>
    withHost(async (relay, host, control) => {
      const attacker = newEd25519();
      const peer = await open(relay.wsUrl("/v1/host/control"));
      const nonce = Buffer.from(String((await peer.json()).nonce), "base64url");
      await peer.send(
        JSON.stringify({
          type: "auth",
          hostId: host.hostId,
          sig: base64url(attacker.sign(signingInput(LABELS.hostControl, host.hostId, nonce))),
        }),
      );
      expect((await peer.closed).code).toBe(CLOSE.unauthorized);
      const session = await openSession(relay, host, control, newEd25519());
      expect(session.sessionId).toMatch(/^[0-9a-f]{32}$/u);
      session.client.close();
      session.hostData.close();
    }));

  it("pings with the protocol-level ping, and drops a host that stops answering", () =>
    withRelay({ pingIntervalMs: 30 }, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const live = await connectControl(relay, host);
      await new Promise((resolve) => live.peer.ws.once("ping", resolve));

      const other = newHost();
      await registerHost(relay, other);
      const mute = await open(relay.wsUrl("/v1/host/control"), { autoPong: false });
      const nonce = Buffer.from(String((await mute.json()).nonce), "base64url");
      await mute.send(
        JSON.stringify({
          type: "auth",
          hostId: other.hostId,
          sig: base64url(other.signer.sign(signingInput(LABELS.hostControl, other.hostId, nonce))),
        }),
      );
      await mute.json();
      await mute.closed;
      expect(relay.relay.metrics.snapshot().disconnects["ping-timeout"]).toBe(1);
      live.peer.close();
    }));
});

describe("client authentication", () => {
  it.each([
    ["ed25519", newEd25519],
    ["p256", newP256],
  ])("lets a device with a valid grant in (%s), and tells the host", (_name, make) =>
    withHost(async (relay, host, control) => {
      const device = make();
      const client = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await sendClientAuth(client, host, device, relay.clock.now);
      const opened = await control.peer.json();
      expect(opened).toMatchObject({
        type: "session-open",
        kind: "client",
        deviceId: deviceIdOf(device.alg, device.pub),
      });
      expect(String(opened.token)).toMatch(/^[A-Za-z0-9_-]{22}$/u);
      expect(await client.json()).toEqual({ type: "accepted" });
      client.close();
    }),
  );

  const rejections: ReadonlyArray<
    readonly [string, number, (host: TestHost, device: Signer, now: number) => ClientAuthOptions]
  > = [
    ["a signature by a different key", CLOSE.unauthorized, () => ({ signWith: newEd25519() })],
    [
      "a grant whose expiry was extended (tampered)",
      CLOSE.unauthorized,
      (host, device, now) => ({
        grant: { ...grantFor(host, device, now), expiresAt: now + 10 * 365 * 86_400_000 },
      }),
    ],
    [
      "a grant signed by someone other than the host",
      CLOSE.unauthorized,
      (host, device, now) => ({ grant: grantFor({ ...host, signer: newEd25519() }, device, now) }),
    ],
    [
      "a grant issued to another device (deviceId mismatch)",
      CLOSE.unauthorized,
      (host, _device, now) => ({ grant: grantFor(host, newEd25519(), now) }),
    ],
    [
      "a grant for a different algorithm than the key",
      CLOSE.unauthorized,
      (host, device, now) => ({ grant: grantFor(host, device, now, { alg: "p256" }) }),
    ],
    [
      "a grant for another host",
      CLOSE.unauthorized,
      (host, device, now) => ({ grant: grantFor(host, device, now, { hostId: newHost().hostId }) }),
    ],
    [
      "a grant issued in the future",
      CLOSE.unauthorized,
      (host, device, now) => ({ grant: grantFor(host, device, now + 3_600_000) }),
    ],
    [
      "an expired grant",
      CLOSE.grantExpired,
      (host, device, now) => ({
        grant: grantFor(host, device, now - 1_000_000, { expiresAt: now - 1 }),
      }),
    ],
    [
      "a grant that carries a device name",
      CLOSE.unauthorized,
      (host, device, now) => ({
        grant: { ...grantFor(host, device, now), name: "Kino's iPhone" } as never,
      }),
    ],
    [
      "an extra field in the auth frame",
      CLOSE.badRequest,
      () => ({ sendAs: { deviceName: "Kino's iPhone" } }),
    ],
  ];

  it.each(rejections)("rejects %s", (_name, code, build) =>
    withHost(async (relay, host) => {
      const device = newEd25519();
      expect(await attempt(relay, host, device, build(host, device, relay.clock.now))).toBe(code);
      expect(relay.relay.metrics.snapshot().sessionsOpened).toBe(0);
    }),
  );

  it("rejects the auth frame of another connection (nonce reuse)", () =>
    withHost(async (relay, host) => {
      const device = newEd25519();
      const first = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      const staleNonce = Buffer.from(String((await first.json()).nonce), "base64url");
      first.close();
      const second = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await sendClientAuth(second, host, device, relay.clock.now, { nonceOverride: staleNonce });
      expect((await second.closed).code).toBe(CLOSE.unauthorized);
      expect(relay.relay.metrics.snapshot().sessionsOpened).toBe(0);
    }));

  it("does not accept a second frame on the same connection", () =>
    withHost(async (relay, host) => {
      const client = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
      await client.next();
      await client.send("{}");
      await client.send("{}");
      expect((await client.closed).code).toBe(CLOSE.badRequest);
    }));

  it("treats an unknown host exactly like a wrong signature", () =>
    withHost(async (relay, host) => {
      const device = newEd25519();
      const unknown = newHost();
      const client = await open(relay.wsUrl(`/v1/client/${unknown.hostId}`));
      await sendClientAuth(client, unknown, device, relay.clock.now);
      const known = await attempt(relay, host, device, { signWith: newEd25519() });
      expect(known).toBe(CLOSE.unauthorized);
      const unknownClose = await client.closed;
      expect(unknownClose).toEqual({ code: CLOSE.unauthorized, reason: "unauthorized" });
    }));

  it("says the host is offline only after the device proved itself", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newEd25519();
      expect(await attempt(relay, host, device)).toBe(CLOSE.hostOffline);
      expect(await attempt(relay, host, device, { signWith: newEd25519() })).toBe(
        CLOSE.unauthorized,
      );
    }));

  describe("revocation", () => {
    it("refuses a grant revoked over the control connection, but accepts a newer one", () =>
      withHost(async (relay, host, control) => {
        const device = newEd25519();
        const deviceId = deviceIdOf(device.alg, device.pub);
        await control.peer.send(
          JSON.stringify({ type: "revoke", ...revocationFor(host, deviceId, relay.clock.now) }),
        );
        const revoked = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
        await sendClientAuth(revoked, host, device, relay.clock.now);
        expect((await revoked.closed).code).toBe(CLOSE.revoked);

        relay.clock.now += 10;
        const again = await open(relay.wsUrl(`/v1/client/${host.hostId}`));
        await sendClientAuth(again, host, device, relay.clock.now);
        expect(await control.peer.json()).toMatchObject({ type: "session-open" });
        again.close();
      }));

    it("refuses a grant revoked over HTTP, and a forged revocation changes nothing", () =>
      withHost(
        async (relay, host) => {
          const device = newEd25519();
          const deviceId = deviceIdOf(device.alg, device.pub);
          const forged = revocationFor(
            { ...host, signer: newEd25519() },
            deviceId,
            relay.clock.now,
          );
          const rejected = await relay.http("POST", "/v1/grants/revoke", {
            hostId: host.hostId,
            ...forged,
          });
          expect(rejected.status).toBe(401);
          expect(await attempt(relay, host, device)).not.toBe(CLOSE.revoked);

          const ok = await relay.http("POST", "/v1/grants/revoke", {
            hostId: host.hostId,
            ...revocationFor(host, deviceId, relay.clock.now),
          });
          expect(ok.status).toBe(200);
          expect(await attempt(relay, host, device)).toBe(CLOSE.revoked);
        },
        { sessionSetupMs: 100 },
      ));

    it("does not reveal a revocation to someone who cannot sign as that device", () =>
      withHost(async (relay, host, control) => {
        const device = newEd25519();
        await control.peer.send(
          JSON.stringify({
            type: "revoke",
            ...revocationFor(host, deviceIdOf(device.alg, device.pub), relay.clock.now),
          }),
        );
        expect(await attempt(relay, host, device, { signWith: newEd25519() })).toBe(
          CLOSE.unauthorized,
        );
      }));

    it("ignores a stale revocation replayed later (older than five minutes)", () =>
      withHost(async (relay, host) => {
        const device = newEd25519();
        const stale = revocationFor(
          host,
          deviceIdOf(device.alg, device.pub),
          relay.clock.now - 10 * 60_000,
        );
        const response = await relay.http("POST", "/v1/grants/revoke", {
          hostId: host.hostId,
          ...stale,
        });
        expect(response.status).toBe(401);
      }));
  });
});
