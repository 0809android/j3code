import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { base64url } from "./bytes.ts";
import {
  leadingZeroBits,
  powDigest,
  registrationSigningInput,
  solveChallenge,
  type PowChallenge,
} from "./pow.ts";
import {
  newEd25519,
  newHost,
  registerHost,
  withRelay,
  type TestHost,
  type TestRelay,
} from "./relay.testkit.ts";

async function challengeFor(relay: TestRelay, host: TestHost): Promise<PowChallenge> {
  const response = await relay.http("POST", "/v1/hosts", { hk: base64url(host.signer.pub) });
  expect(response.status).toBe(428);
  return response.json?.challenge as PowChallenge;
}

function solved(host: TestHost, challenge: PowChallenge, overrides: Record<string, unknown> = {}) {
  const nonce = solveChallenge(host.signer.pub, challenge);
  const sig = base64url(
    host.signer.sign(registrationSigningInput(host.signer.pub, challenge.mac, nonce)),
  );
  return { hk: base64url(host.signer.pub), challenge, nonce, sig, ...overrides };
}

describe("host registration", () => {
  it("registers a host after proof of work and a signature, and is idempotent", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      const first = await registerHost(relay, host);
      expect(first).toEqual({ status: 201, hostId: host.hostId });
      expect(await registerHost(relay, host)).toEqual({ status: 200, hostId: host.hostId });
      expect(relay.relay.store.hostCount()).toBe(1);
    }));

  it("refuses to replay a solved challenge", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      const body = solved(host, await challengeFor(relay, host));
      expect((await relay.http("POST", "/v1/hosts", body)).status).toBe(201);
      const replay = await relay.http("POST", "/v1/hosts", body);
      expect(replay.status).toBe(409);
      expect(replay.json).toEqual({ error: "pow-replayed" });
    }));

  it("ties the challenge to the key it was issued for", () =>
    withRelay({}, async (relay) => {
      const victim = newHost();
      const attacker = newHost();
      const challenge = await challengeFor(relay, victim);
      const body = solved(attacker, challenge);
      const response = await relay.http("POST", "/v1/hosts", body);
      expect(response.status).toBe(403);
      expect(response.json).toEqual({ error: "pow-forged" });
      expect(relay.relay.store.hostCount()).toBe(0);
    }));

  it("does not register a key whose owner did not sign", () =>
    withRelay({}, async (relay) => {
      const host = newHost();
      const challenge = await challengeFor(relay, host);
      const nonce = solveChallenge(host.signer.pub, challenge);
      const forged = base64url(
        newEd25519().sign(registrationSigningInput(host.signer.pub, challenge.mac, nonce)),
      );
      const response = await relay.http("POST", "/v1/hosts", {
        hk: base64url(host.signer.pub),
        challenge,
        nonce,
        sig: forged,
      });
      expect(response.status).toBe(401);
      expect(relay.relay.store.hostCount()).toBe(0);
    }));

  it("rejects too little work, an old challenge and a tampered difficulty", () =>
    withRelay({ powBaseDifficulty: 12 }, async (relay) => {
      const host = newHost();
      const challenge = await challengeFor(relay, host);
      let weak = "AAAAAAAAAAA";
      for (
        let counter = 0;
        leadingZeroBits(
          powDigest(host.signer.pub, challenge.mac, Buffer.from(weak, "base64url")),
        ) >= 12;
        counter += 1
      ) {
        weak = base64url(NodeCrypto.randomBytes(8));
      }
      const underWork = await relay.http(
        "POST",
        "/v1/hosts",
        solved(host, challenge, { nonce: weak }),
      );
      expect(underWork.json).toEqual({ error: "pow-work" });

      const cheaper = await relay.http(
        "POST",
        "/v1/hosts",
        solved(host, { ...challenge, difficulty: 0 }),
      );
      expect(cheaper.json).toEqual({ error: "pow-forged" });

      const body = solved(host, challenge);
      relay.clock.now += 5 * 60_000 + 1;
      const stale = await relay.http("POST", "/v1/hosts", body);
      expect(stale.json).toEqual({ error: "pow-expired" });
      expect(relay.relay.store.hostCount()).toBe(0);
    }));

  it("raises the difficulty while many hosts are registering", () =>
    withRelay(
      { powBaseDifficulty: 2, powLoadExtraDifficulty: 6, powLoadThresholdPerMinute: 2 },
      async (relay) => {
        const probe = newHost();
        expect((await challengeFor(relay, probe)).difficulty).toBe(2);
        for (let index = 0; index < 3; index += 1) await registerHost(relay, newHost());
        expect((await challengeFor(relay, probe)).difficulty).toBe(8);
        relay.clock.now += 61_000;
        expect((await challengeFor(relay, probe)).difficulty).toBe(2);
      },
    ));

  it("limits registrations per address per day", () =>
    withRelay({ registrationsPerIpPerDay: 2 }, async (relay) => {
      expect((await registerHost(relay, newHost())).status).toBe(201);
      expect((await registerHost(relay, newHost())).status).toBe(201);
      expect((await registerHost(relay, newHost())).status).toBe(429);
      relay.clock.now += 24 * 3_600_000 + 1;
      expect((await registerHost(relay, newHost())).status).toBe(201);
    }));

  it("stops registering when the host table is full", () =>
    withRelay({ maxHosts: 1 }, async (relay) => {
      expect((await registerHost(relay, newHost())).status).toBe(201);
      expect((await registerHost(relay, newHost())).status).toBe(503);
    }));

  it("rejects malformed and oversized bodies", () =>
    withRelay({}, async (relay) => {
      expect((await relay.http("POST", "/v1/hosts", "{")).status).toBe(400);
      expect((await relay.http("POST", "/v1/hosts", { hk: "short" })).status).toBe(400);
      expect((await relay.http("POST", "/v1/hosts", { hk: "x".repeat(20_000) })).status).toBe(413);
      expect((await relay.http("GET", "/v1/hosts")).status).toBe(404);
    }));
});

describe("invite-only relays (REQUIRE_INVITE=1)", () => {
  it("accepts a host only with an unused invite code", () =>
    withRelay({ requireInvite: true }, async (relay) => {
      const code = "invite-for-test";
      relay.relay.store.addInvite(
        NodeCrypto.createHash("sha256").update(code).digest(),
        relay.clock.now + 60_000,
      );

      const without = newHost();
      expect(
        (await relay.http("POST", "/v1/hosts", solved(without, await challengeFor(relay, without))))
          .status,
      ).toBe(403);

      const wrong = newHost();
      const wrongBody = solved(wrong, await challengeFor(relay, wrong), { invite: "guess" });
      expect((await relay.http("POST", "/v1/hosts", wrongBody)).status).toBe(403);

      const right = newHost();
      const rightBody = solved(right, await challengeFor(relay, right), { invite: code });
      expect((await relay.http("POST", "/v1/hosts", rightBody)).status).toBe(201);

      const reuse = newHost();
      const reuseBody = solved(reuse, await challengeFor(relay, reuse), { invite: code });
      expect((await relay.http("POST", "/v1/hosts", reuseBody)).status).toBe(403);
      expect(relay.relay.store.hostCount()).toBe(1);
    }));

  it("needs no invite when the relay is open (the default)", () =>
    withRelay({}, async (relay) => {
      expect((await registerHost(relay, newHost())).status).toBe(201);
    }));
});
