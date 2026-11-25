import * as NodeCrypto from "node:crypto";

import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/nist";
import { describe, expect, it } from "vite-plus/test";

import { base64url, decodeBase64url, lengthPrefixed } from "./bytes.ts";
import {
  deviceIdOf,
  hostIdOf,
  parseGrant,
  signingInput,
  verifyGrantSignature,
  verifySignature,
} from "./crypto.ts";
import { EPOCH, grantFor, newEd25519, newHost, newP256 } from "./relay.testkit.ts";

const message = signingInput("k3relay-v1/test", "a", Buffer.from([1, 2, 3]));

describe("identifiers", () => {
  it("derives 32-character lowercase base32 ids, with the algorithm inside the device id", () => {
    const key = Buffer.alloc(32, 7);
    expect(hostIdOf(key)).toMatch(/^[a-z2-7]{32}$/u);
    expect(deviceIdOf("ed25519", key)).not.toBe(deviceIdOf("p256", key));
    expect(deviceIdOf("ed25519", key)).toBe(deviceIdOf("ed25519", Buffer.from(key)));
  });

  it("length-prefixes parts so concatenations cannot be shifted", () => {
    expect(lengthPrefixed("ab", "c").equals(lengthPrefixed("a", "bc"))).toBe(false);
    expect(signingInput("l", "x").subarray(0, 4).readUInt32BE(0)).toBe(1);
  });

  it("accepts only the canonical base64url spelling", () => {
    const bytes = Buffer.from([251, 255, 190]);
    expect(decodeBase64url(base64url(bytes))?.equals(bytes)).toBe(true);
    expect(decodeBase64url(`${base64url(bytes)}=`)).toBeNull();
    expect(decodeBase64url("+/+/")).toBeNull();
    expect(decodeBase64url("AB", 1)).toBeNull();
  });
});

describe("signatures interoperate with the client libraries", () => {
  it("verifies Ed25519 from @noble/curves", () => {
    const secret = ed25519.utils.randomPrivateKey();
    const signature = ed25519.sign(message, secret);
    expect(verifySignature("ed25519", ed25519.getPublicKey(secret), message, signature)).toBe(true);
    expect(verifySignature("ed25519", ed25519.getPublicKey(secret), Buffer.from("x"), signature)).toBe(false);
  });

  it("verifies P-256 from @noble/curves (X9.63 key, r||s signature)", () => {
    const secret = p256.utils.randomPrivateKey();
    const signature = p256.sign(message, secret, { prehash: true, lowS: false }).toCompactRawBytes();
    const publicKey = p256.getPublicKey(secret, false);
    expect(publicKey).toHaveLength(65);
    expect(verifySignature("p256", publicKey, message, signature)).toBe(true);
    const flipped = Buffer.from(signature);
    flipped[10] = (flipped[10] ?? 0) ^ 1;
    expect(verifySignature("p256", publicKey, message, flipped)).toBe(false);
  });

  it("verifies P-256 from WebCrypto, which is what browsers will send", async () => {
    const pair = await NodeCrypto.webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const raw = Buffer.from(await NodeCrypto.webcrypto.subtle.exportKey("raw", pair.publicKey));
    expect(raw[0]).toBe(4);
    const signature = Buffer.from(
      await NodeCrypto.webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        message,
      ),
    );
    expect(verifySignature("p256", raw, message, signature)).toBe(true);
    expect(verifySignature("ed25519", raw.subarray(1, 33), message, signature)).toBe(false);
  });

  it("rejects wrong key lengths, wrong signature lengths and keys that are not on the curve", () => {
    const signer = newP256();
    const signature = signer.sign(message);
    expect(verifySignature("p256", signer.pub.subarray(0, 64), message, signature)).toBe(false);
    expect(verifySignature("p256", signer.pub, message, signature.subarray(0, 63))).toBe(false);
    const offCurve = Buffer.from(signer.pub);
    offCurve[64] = (offCurve[64] ?? 0) ^ 1;
    expect(verifySignature("p256", offCurve, message, signature)).toBe(false);
  });
});

describe("grants", () => {
  const host = newHost();
  const device = newEd25519();

  it("accepts a well-formed grant and checks the host signature", () => {
    const grant = parseGrant(grantFor(host, device, EPOCH));
    expect(grant).not.toBeNull();
    expect(grant && verifyGrantSignature(grant, host.signer.pub)).toBe(true);
    expect(grant && verifyGrantSignature(grant, newHost().signer.pub)).toBe(false);
  });

  it("rejects a grant that carries a name, scopes or any other field", () => {
    const grant = grantFor(host, device, EPOCH);
    expect(parseGrant({ ...grant, name: "Kino's iPhone" })).toBeNull();
    expect(parseGrant({ ...grant, scopes: ["admin"] })).toBeNull();
  });

  it("rejects malformed values", () => {
    const grant = grantFor(host, device, EPOCH);
    expect(parseGrant({ ...grant, v: 2 })).toBeNull();
    expect(parseGrant({ ...grant, alg: "rsa" })).toBeNull();
    expect(parseGrant({ ...grant, expiresAt: grant.issuedAt })).toBeNull();
    expect(parseGrant({ ...grant, hostId: "SHORT" })).toBeNull();
    expect(parseGrant({ ...grant, sig: "AAAA" })).toBeNull();
    expect(parseGrant(null)).toBeNull();
  });

  it("detects any changed field", () => {
    const grant = grantFor(host, device, EPOCH);
    const changed = [
      { ...grant, expiresAt: grant.expiresAt + 1 },
      { ...grant, issuedAt: grant.issuedAt - 1 },
      { ...grant, deviceId: deviceIdOf("ed25519", newEd25519().pub) },
      { ...grant, alg: "p256" as const },
      { ...grant, nonce: base64url(NodeCrypto.randomBytes(16)) },
    ];
    for (const candidate of changed) {
      const parsed = parseGrant(candidate);
      expect(parsed && verifyGrantSignature(parsed, host.signer.pub)).toBe(false);
    }
  });
});
