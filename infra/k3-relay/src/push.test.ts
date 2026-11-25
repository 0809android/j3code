import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { loadConfig } from "./config.ts";
import { deviceIdOf } from "./crypto.ts";
import {
  APNS_TOKEN,
  FCM_TOKEN,
  FCM_UNREGISTERED,
  type FakeApns,
  type FakeFcm,
  pushRegistrationBody,
  registerPush,
  sendPush,
  startFakeApns,
  startFakeFcm,
} from "./push.testkit.ts";
import {
  connectControl,
  newEd25519,
  newHost,
  newP256,
  registerHost,
  revocationFor,
  barrier,
  withRelay,
} from "./relay.testkit.ts";

/** Stands in for a sealed envelope: random bytes, as opaque to the relay as a real one. */
const envelope = (size = 297) => NodeCrypto.randomBytes(size);

let apns: FakeApns;
let fcm: FakeFcm;

beforeEach(async () => {
  apns = await startFakeApns();
  fcm = await startFakeFcm();
});

afterEach(async () => {
  await apns.close();
  await fcm.close();
});

const configured = () => ({ apns: apns.credentials, fcm: fcm.credentials });

describe("push gateway, off", () => {
  it("answers 404 everywhere and says nothing about push when nothing is configured", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newEd25519();
      expect((await registerPush(relay, host, device)).status).toBe(404);
      const deviceId = deviceIdOf(device.alg, device.pub);
      expect((await sendPush(relay, host, deviceId, envelope())).status).toBe(404);
      const known = await relay.http("GET", "/.well-known/k3-relay");
      expect(known.json?.push).toBeUndefined();
    }));

  it("answers 503 for a platform whose credentials are missing", () =>
    withRelay({ apns: apns.credentials }, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newEd25519();
      const android = await registerPush(relay, host, device, { platform: "android" });
      expect(android.status).toBe(503);
      expect((await relay.http("GET", "/.well-known/k3-relay")).json?.push).toEqual({
        platforms: ["ios", "ios-sandbox"],
      });
    }));

  it("reads credentials all-or-nothing from the environment", () => {
    expect(loadConfig({}).apns).toBeNull();
    expect(() => loadConfig({ APNS_KEY_ID: "K" })).toThrow(/APNs/u);
    expect(() => loadConfig({ FCM_PROJECT_ID: "p", FCM_CLIENT_EMAIL: "e" })).toThrow(/FCM/u);
    const config = loadConfig({
      FCM_PROJECT_ID: "p",
      FCM_CLIENT_EMAIL: "e@x",
      FCM_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    });
    expect(config.fcm?.privateKeyPem).toContain("\nabc\n");
    expect(config.apns).toBeNull();
  });
});

describe("push gateway", () => {
  it("delivers the host's envelope to APNs unchanged, with a valid provider token", () =>
    withRelay(configured(), async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newP256();
      const deviceId = deviceIdOf(device.alg, device.pub);
      expect((await registerPush(relay, host, device)).status).toBe(200);

      const sealed = envelope();
      const sent = await sendPush(relay, host, deviceId, sealed);
      expect(sent.status).toBe(200);
      expect(apns.requests).toHaveLength(1);
      const request = apns.requests[0]!;
      expect(request.jwtValid).toBe(true);
      expect(request.path).toBe(`/3/device/${APNS_TOKEN}`);
      expect(request.headers["apns-topic"]).toBe("jp.kinocode.k3code");
      expect(request.headers["apns-push-type"]).toBe("alert");
      expect(request.body.k3).toBe(sealed.toString("base64url"));
      // Only a fixed placeholder is in the clear; the extension replaces it.
      expect(request.body.aps).toEqual({
        alert: { title: "K3 Code", body: "New activity" },
        "mutable-content": 1,
        sound: "default",
      });
    }));

  it("delivers to FCM as a data-only message, after an OAuth2 token for the service account", () =>
    withRelay(configured(), async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newEd25519();
      const deviceId = deviceIdOf(device.alg, device.pub);
      expect((await registerPush(relay, host, device, { platform: "android" })).status).toBe(200);
      const first = envelope();
      expect((await sendPush(relay, host, deviceId, first)).status).toBe(200);
      expect((await sendPush(relay, host, deviceId, envelope())).status).toBe(200);
      // One access token, reused.
      expect(fcm.tokenRequests).toEqual([200]);
      expect(fcm.requests[0]?.path).toBe("/v1/projects/k3-test/messages:send");
      expect(fcm.requests[0]?.body).toEqual({
        message: {
          token: FCM_TOKEN,
          data: { k3: first.toString("base64url") },
          android: { priority: "high", ttl: "86400s" },
        },
      });
    }));

  it("drops a token APNs or FCM call dead, and keeps it on a passing failure", () =>
    withRelay(configured(), async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const phone = newEd25519();
      const tablet = newEd25519();
      const android = newEd25519();
      const id = (signer: typeof phone) => deviceIdOf(signer.alg, signer.pub);
      await registerPush(relay, host, phone);
      await registerPush(relay, host, tablet, { platform: "ios-sandbox" });
      await registerPush(relay, host, android, { platform: "android" });

      apns.respond = () => ({ status: 500, reason: "InternalServerError" });
      expect((await sendPush(relay, host, id(phone), envelope())).status).toBe(502);
      expect(relay.relay.store.getPushTarget(host.hostId, id(phone))).toBeDefined();

      apns.respond = () => ({ status: 410, reason: "Unregistered" });
      expect((await sendPush(relay, host, id(phone), envelope())).status).toBe(410);
      expect(relay.relay.store.getPushTarget(host.hostId, id(phone))).toBeUndefined();
      expect((await sendPush(relay, host, id(phone), envelope())).status).toBe(404);

      apns.respond = () => ({ status: 400, reason: "BadDeviceToken" });
      expect((await sendPush(relay, host, id(tablet), envelope())).status).toBe(410);
      expect(relay.relay.store.getPushTarget(host.hostId, id(tablet))).toBeUndefined();

      fcm.respond = () => FCM_UNREGISTERED;
      expect((await sendPush(relay, host, id(android), envelope())).status).toBe(410);
      expect(relay.relay.store.getPushTarget(host.hostId, id(android))).toBeUndefined();
    }));

  it("refuses a send without the host's valid, fresh, single-use signature", () =>
    withRelay(configured(), async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newEd25519();
      const deviceId = deviceIdOf(device.alg, device.pub);
      await registerPush(relay, host, device);
      const sealed = envelope();
      const now = relay.clock.now;

      const stranger = newEd25519();
      const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        [
          "unsigned",
          {
            hostId: host.hostId,
            deviceId,
            ts: now,
            nonce: "n".repeat(22),
            envelope: sealed.toString("base64url"),
          },
        ],
        ["wrong key", pushBody({ signWith: stranger })],
        ["stale", pushBody({ ts: now - 120_000 })],
        ["future", pushBody({ ts: now + 120_000 })],
        ["tampered", { ...pushBody(), envelope: envelope().toString("base64url") }],
        ["unknown host", pushBodyFor(newHost())],
        ["extra field", { ...pushBody(), platform: "ios" }],
      ];
      for (const [label, body] of cases) {
        const response = await relay.http("POST", "/v1/push/send", body);
        expect(response.status, label).toBe(401);
      }
      const once = pushBody({ nonce: "replayed-nonce-0001" });
      expect((await relay.http("POST", "/v1/push/send", once)).status).toBe(200);
      expect((await relay.http("POST", "/v1/push/send", once)).status).toBe(401);
      expect(apns.requests).toHaveLength(1);

      function pushBody(options: Parameters<typeof sendBody>[1] = {}) {
        return sendBody(host, options);
      }
      function pushBodyFor(other: ReturnType<typeof newHost>) {
        return sendBody(other, {});
      }
      function sendBody(
        signer: ReturnType<typeof newHost>,
        options: { ts?: number; nonce?: string; signWith?: typeof stranger },
      ) {
        const ts = options.ts ?? now;
        const nonce = options.nonce ?? NodeCrypto.randomBytes(16).toString("base64url");
        const signature = (options.signWith ?? signer.signer).sign(
          pushSigningInput(signer.hostId, deviceId, ts, nonce, sealed),
        );
        return {
          hostId: signer.hostId,
          deviceId,
          ts,
          nonce,
          envelope: sealed.toString("base64url"),
          sig: signature.toString("base64url"),
        };
      }
    }));

  it("lets no host reach another host's device", () =>
    withRelay(configured(), async (relay) => {
      const owner = newHost();
      const other = newHost();
      await registerHost(relay, owner);
      await registerHost(relay, other);
      const device = newEd25519();
      const deviceId = deviceIdOf(device.alg, device.pub);
      await registerPush(relay, owner, device);
      // Signed by the other host for its own id: there is no target under that id.
      expect((await sendPush(relay, other, deviceId, envelope())).status).toBe(404);
      // Claiming the owner's id needs the owner's key.
      const spoofed = await sendPush(relay, other, deviceId, envelope(), { hostId: owner.hostId });
      expect(spoofed.status).toBe(401);
      expect(apns.requests).toHaveLength(0);
    }));

  it("limits sends per device and per host", () =>
    withRelay(
      { ...configured(), pushPerMinutePerDevice: 2, pushPerMinutePerHost: 3 },
      async (relay) => {
        const host = newHost();
        await registerHost(relay, host);
        const first = newEd25519();
        const second = newEd25519();
        await registerPush(relay, host, first);
        await registerPush(relay, host, second);
        const id = (signer: typeof first) => deviceIdOf(signer.alg, signer.pub);
        expect((await sendPush(relay, host, id(first), envelope())).status).toBe(200);
        expect((await sendPush(relay, host, id(first), envelope())).status).toBe(200);
        expect((await sendPush(relay, host, id(first), envelope())).status).toBe(429);
        expect((await sendPush(relay, host, id(second), envelope())).status).toBe(200);
        expect((await sendPush(relay, host, id(second), envelope())).status).toBe(429);
        relay.clock.now += 61_000;
        expect((await sendPush(relay, host, id(second), envelope())).status).toBe(200);
      },
    ));

  it("refuses an envelope over the size limit before it goes anywhere", () =>
    withRelay({ ...configured(), pushMaxEnvelopeBytes: 1200 }, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newEd25519();
      const deviceId = deviceIdOf(device.alg, device.pub);
      await registerPush(relay, host, device);
      expect((await sendPush(relay, host, deviceId, envelope(1201))).status).toBe(413);
      expect((await sendPush(relay, host, deviceId, envelope(1200))).status).toBe(200);
      expect(apns.requests).toHaveLength(1);
    }));
});

describe("push registration", () => {
  it("needs the device's own signature over the token and a valid grant", () =>
    withRelay(configured(), async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newEd25519();
      const now = relay.clock.now;
      expect((await registerPush(relay, host, device, { signWith: newEd25519() })).status).toBe(
        401,
      );
      expect((await registerPush(relay, host, device, { ts: now - 120_000 })).status).toBe(401);
      expect((await registerPush(relay, host, device, { token: "not hex" })).status).toBe(400);
      const nonce = "same-nonce-twice-01";
      expect((await registerPush(relay, host, device, { nonce })).status).toBe(200);
      expect((await registerPush(relay, host, device, { nonce })).status).toBe(401);
      // A newer token replaces the old one for the same host and device.
      const next = "b2".repeat(32);
      expect((await registerPush(relay, host, device, { token: next })).status).toBe(200);
      const deviceId = deviceIdOf(device.alg, device.pub);
      expect(relay.relay.store.getPushTarget(host.hostId, deviceId)?.token).toBe(next);
    }));

  it("a revocation drops the device's token, and a revoked device cannot add one back", () =>
    withRelay(configured(), async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const control = await connectControl(relay, host);
      const device = newEd25519();
      const deviceId = deviceIdOf(device.alg, device.pub);
      expect((await registerPush(relay, host, device)).status).toBe(200);
      relay.clock.now += 1;
      await control.peer.send(
        JSON.stringify({ type: "revoke", ...revocationFor(host, deviceId, relay.clock.now) }),
      );
      await barrier(control);
      expect(relay.relay.store.getPushTarget(host.hostId, deviceId)).toBeUndefined();
      expect((await sendPush(relay, host, deviceId, envelope())).status).toBe(404);
      // A grant issued before the revocation is revoked: the device is told so, and kept out.
      const again = await relay.http(
        "POST",
        `/v1/client/${host.hostId}/push`,
        pushRegistrationBody(host, device, relay.clock.now - 1),
      );
      expect(again.status).toBe(403);
      expect(relay.relay.store.getPushTarget(host.hostId, deviceId)).toBeUndefined();
      control.peer.close();
    }));

  it("a device removes its own token", () =>
    withRelay(configured(), async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      const device = newEd25519();
      const deviceId = deviceIdOf(device.alg, device.pub);
      await registerPush(relay, host, device);
      expect((await registerPush(relay, host, device, { remove: true })).status).toBe(200);
      expect(relay.relay.store.getPushTarget(host.hostId, deviceId)).toBeUndefined();
    }));

  it("caps the tokens one host can hold", () =>
    withRelay({ ...configured(), maxPushTargetsPerHost: 2 }, async (relay) => {
      const host = newHost();
      await registerHost(relay, host);
      expect((await registerPush(relay, host, newEd25519())).status).toBe(200);
      expect((await registerPush(relay, host, newEd25519())).status).toBe(200);
      expect((await registerPush(relay, host, newEd25519())).status).toBe(429);
    }));
});

describe("what the relay keeps of a notification", () => {
  it("writes neither the envelope nor anything from it to the database or the logs", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "k3-relay-push-"));
    const dbPath = NodePath.join(directory, "relay.sqlite");
    const sealed = envelope();
    let logs: string[] = [];
    try {
      await withRelay({ ...configured(), dbPath }, async (relay) => {
        const host = newHost();
        await registerHost(relay, host);
        const device = newEd25519();
        const android = newEd25519();
        await registerPush(relay, host, device);
        await registerPush(relay, host, android, { platform: "android" });
        await sendPush(relay, host, deviceIdOf(device.alg, device.pub), sealed);
        await sendPush(relay, host, deviceIdOf(android.alg, android.pub), sealed);
        apns.respond = () => ({ status: 500 });
        await sendPush(relay, host, deviceIdOf(device.alg, device.pub), sealed);
        logs = relay.logs;
      });
      const raw = NodeFS.readdirSync(directory)
        .map((name) => NodeFS.readFileSync(NodePath.join(directory, name)).toString("latin1"))
        .join("\n");
      const needles = [
        sealed.toString("base64url"),
        sealed.toString("latin1"),
        sealed.subarray(0, 24).toString("hex"),
      ];
      for (const needle of needles) {
        expect(raw.includes(needle), "database holds the envelope").toBe(false);
        expect(logs.join("\n").includes(needle), "logs hold the envelope").toBe(false);
      }
      // The token is stored (that is the table's purpose), but never logged.
      expect(raw).toContain(APNS_TOKEN);
      expect(logs.join("\n")).not.toContain(APNS_TOKEN);
      expect(logs.join("\n")).not.toContain(FCM_TOKEN);
      expect(logs.some((line) => line.includes("push-upstream-failed"))).toBe(true);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function pushSigningInput(
  hostId: string,
  deviceId: string,
  ts: number,
  nonce: string,
  sealed: Buffer,
): Buffer {
  const parts = ["k3relay-v1/push-send", hostId, deviceId, String(ts), nonce].map((part) =>
    Buffer.from(part, "utf8"),
  );
  const all = [...parts, sealed];
  return Buffer.concat(
    all.flatMap((part) => {
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(part.length, 0);
      return [prefix, part];
    }),
  );
}
