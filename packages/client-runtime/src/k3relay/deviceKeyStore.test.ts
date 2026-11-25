import { assert, describe, it } from "@effect/vitest";
import { relaySigningInput } from "@t3tools/shared/relay";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import {
  type WebDeviceKeyRecord,
  makeMemoryDeviceSecretVault,
  makeSoftwareDeviceKeyStore,
  makeWebCryptoDeviceKeyStore,
} from "./deviceKeyStore.ts";

const memoryRecords = () => {
  const records = new Map<string, WebDeviceKeyRecord>();
  return {
    records,
    get: async (keyId: string) => records.get(keyId),
    put: async (keyId: string, record: WebDeviceKeyRecord) => void records.set(keyId, record),
    delete: async (keyId: string) => void records.delete(keyId),
  };
};

const verifyP256 = async (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Uint8Array.from(signature),
    Uint8Array.from(message),
  );
};

describe("DeviceKeyStore", () => {
  it.effect("keeps software keys in the vault and gives back the same signer", () =>
    Effect.gen(function* () {
      const vault = makeMemoryDeviceSecretVault();
      const store = yield* makeSoftwareDeviceKeyStore(vault);
      const created = yield* store.create("k1");
      assert.strictEqual(created.alg, "ed25519");
      const loaded = Option.getOrThrow(yield* store.load("k1"));
      assert.deepStrictEqual(loaded.publicKey, created.publicKey);
      yield* store.remove("k1");
      assert.isTrue(Option.isNone(yield* store.load("k1")));
      vault.secrets.set("k2", "{not json");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(store.load("k2"))));
    }).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
  );

  it.live("makes non-extractable P-256 keys with WebCrypto and signs r‖s, never DER", () =>
    Effect.gen(function* () {
      const records = memoryRecords();
      const store = yield* makeWebCryptoDeviceKeyStore(records, crypto.subtle);
      const signer = yield* store.create("web");
      assert.strictEqual(signer.alg, "p256");
      assert.strictEqual(signer.publicKey.length, 65);
      const stored = records.records.get("web");
      assert.strictEqual(stored?.kind, "webcrypto-p256");
      if (stored?.kind === "webcrypto-p256") assert.isFalse(stored.keyPair.privateKey.extractable);
      const message = relaySigningInput("k3relay-v1/client", "host", "device", new Uint8Array(32));
      const signature = yield* signer.sign(message);
      assert.strictEqual(signature.length, 64);
      assert.isTrue(yield* Effect.promise(() => verifyP256(signer.publicKey, message, signature)));
      const reloaded = Option.getOrThrow(yield* store.load("web"));
      assert.deepStrictEqual(reloaded.publicKey, signer.publicKey);
    }).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
  );

  it.live("falls back to Ed25519 in software where WebCrypto has no P-256", () =>
    Effect.gen(function* () {
      const records = memoryRecords();
      const store = yield* makeWebCryptoDeviceKeyStore(records, null);
      const signer = yield* store.create("fallback");
      assert.strictEqual(signer.alg, "ed25519");
      assert.strictEqual(records.records.get("fallback")?.kind, "software");
      const loaded = Option.getOrThrow(yield* store.load("fallback"));
      assert.deepStrictEqual(loaded.publicKey, signer.publicKey);
    }).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
  );
});
