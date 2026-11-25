import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";

import * as HostProcess from "../HostProcess.ts";
import { deviceIdentity } from "../socketE2eeDevice.ts";
import { encodeBase64url, relayDeviceId } from "./encoding.ts";
import {
  type LedgerDevice,
  type LedgerStore,
  LedgerStoreError,
  isValidDeviceName,
  ledgerVerifyDevice,
  makeDeviceLedger,
  makeJsonFileLedgerStore,
  makeMemoryLedgerStore,
} from "./ledger.ts";

const NOW = 1_800_000_000_000;
const edKey = (n: number) => ed25519.getPublicKey(new Uint8Array(32).fill(n));
const p256Key = p256.getPublicKey(new Uint8Array(32).fill(0x22), false);
const isPosix = HostProcess.Platform.defaultValue() !== "win32";

const rejection = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.flip(effect), (error) =>
    typeof error === "object" && error !== null && "reason" in error ? error.reason : error,
  );

describe("device ledger", () => {
  it.effect("adds, lists, renames, revokes and records connections", () =>
    Effect.gen(function* () {
      const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
      const phone = yield* ledger.add({
        alg: "ed25519",
        publicKey: edKey(1),
        name: "Phone",
        now: NOW,
      });
      const laptop = yield* ledger.add({
        alg: "p256",
        publicKey: p256Key,
        name: "Laptop",
        now: NOW,
      });
      assert.strictEqual(phone.deviceId, relayDeviceId("ed25519", edKey(1)));
      assert.deepStrictEqual(
        (yield* ledger.list).map((device) => device.name),
        ["Phone", "Laptop"],
      );
      assert.strictEqual(
        (yield* ledger.rename(phone.deviceId, "Kino's phone")).name,
        "Kino's phone",
      );
      assert.strictEqual((yield* ledger.markSeen(laptop.deviceId, NOW + 5)).lastSeenAt, NOW + 5);
      assert.strictEqual((yield* ledger.markSeen(laptop.deviceId, NOW + 1)).lastSeenAt, NOW + 5);
      const revoked = yield* ledger.revoke(phone.deviceId, NOW + 10);
      assert.deepStrictEqual([revoked.status, revoked.revokedAt], ["revoked", NOW + 10]);
      // Revoking again keeps the first revocation time.
      assert.strictEqual((yield* ledger.revoke(phone.deviceId, NOW + 20)).revokedAt, NOW + 10);
      assert.strictEqual(
        yield* rejection(ledger.markSeen(phone.deviceId, NOW + 30)),
        "unknown-device",
      );
      assert.strictEqual(yield* rejection(ledger.revoke("a".repeat(32), NOW)), "unknown-device");
    }),
  );

  it.effect("refuses duplicates, bad keys and names that could disguise a device", () =>
    Effect.gen(function* () {
      const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
      const base = { alg: "ed25519", publicKey: edKey(2), name: "Phone", now: NOW } as const;
      yield* ledger.add(base);
      assert.strictEqual(yield* rejection(ledger.add(base)), "already-registered");
      assert.strictEqual(
        yield* rejection(ledger.add({ ...base, publicKey: edKey(3).subarray(1) })),
        "invalid-key",
      );
      for (const name of ["", " Phone", "Pho\nne", "evil‮enohp", "a​b", "x".repeat(65)]) {
        assert.isFalse(isValidDeviceName(name), JSON.stringify(name));
        assert.strictEqual(
          yield* rejection(ledger.add({ ...base, publicKey: edKey(4), name })),
          "invalid-name",
        );
      }
      assert.isTrue(isValidDeviceName("キノの iPhone 15"));
      const id = relayDeviceId("ed25519", edKey(2));
      assert.strictEqual(yield* rejection(ledger.rename(id, "bad\u0007")), "invalid-name");
    }),
  );

  it.effect("lets a revoked device back only as a new registration", () =>
    Effect.gen(function* () {
      const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
      const input = { alg: "ed25519", publicKey: edKey(5), name: "Old", now: NOW } as const;
      const first = yield* ledger.add(input);
      yield* ledger.revoke(first.deviceId, NOW + 1);
      const again = yield* ledger.add({ ...input, name: "New", now: NOW + 2 });
      assert.deepStrictEqual(
        [again.status, again.revokedAt, again.createdAt, again.name],
        ["active", null, NOW + 2, "New"],
      );
      assert.strictEqual((yield* ledger.list).length, 1);
    }),
  );

  it.effect("serializes concurrent changes so none is lost", () =>
    Effect.gen(function* () {
      const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
      yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index + 10),
        (n) => ledger.add({ alg: "ed25519", publicKey: edKey(n), name: `D${n}`, now: NOW }),
        { concurrency: "unbounded" },
      );
      assert.strictEqual((yield* ledger.list).length, 20);
    }),
  );
});

describe("ledgerVerifyDevice", () => {
  it.effect("accepts active devices and refuses unknown and revoked ones", () =>
    Effect.gen(function* () {
      const ledger = yield* makeDeviceLedger(makeMemoryLedgerStore());
      const verify = ledgerVerifyDevice(ledger);
      const device = yield* ledger.add({
        alg: "ed25519",
        publicKey: edKey(6),
        name: "P",
        now: NOW,
      });
      // The E2EE identity carries its own (u16-prefixed) id; the adapter must not rely on it.
      yield* verify(deviceIdentity("ed25519", edKey(6)));
      assert.strictEqual(
        yield* rejection(verify(deviceIdentity("ed25519", edKey(7)))),
        "unknown-device",
      );
      assert.strictEqual(
        yield* rejection(verify(deviceIdentity("p256", p256Key))),
        "unknown-device",
      );
      yield* ledger.revoke(device.deviceId, NOW + 1);
      assert.strictEqual(yield* rejection(verify(deviceIdentity("ed25519", edKey(6)))), "revoked");
    }),
  );

  it.effect("refuses a key that does not match the stored one", () =>
    Effect.gen(function* () {
      const forged: LedgerDevice = {
        deviceId: relayDeviceId("ed25519", edKey(8)),
        alg: "ed25519",
        publicKey: encodeBase64url(edKey(9)),
        name: "Forged",
        createdAt: NOW,
        lastSeenAt: null,
        status: "active",
        revokedAt: null,
      };
      const verify = ledgerVerifyDevice(yield* makeDeviceLedger(makeMemoryLedgerStore([forged])));
      assert.strictEqual(
        yield* rejection(verify(deviceIdentity("ed25519", edKey(8)))),
        "key-mismatch",
      );
    }),
  );

  it.effect("refuses every device while the ledger cannot be read", () =>
    Effect.gen(function* () {
      const broken: LedgerStore = {
        load: Effect.fail(new LedgerStoreError({ detail: "disk gone" })),
        save: () => Effect.void,
      };
      const verify = ledgerVerifyDevice(yield* makeDeviceLedger(broken));
      assert.strictEqual(
        yield* rejection(verify(deviceIdentity("ed25519", edKey(6)))),
        "host-policy",
      );
    }),
  );
});

it.layer(NodeServices.layer)("JSON file ledger store", (it) => {
  const tempLedger = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "k3-ledger-" });
    const nested = path.join(dir, "nested");
    return { fs, dir, nested, file: path.join(nested, "devices.json") };
  });

  it.effect("round-trips through an owner-only file and starts empty when missing", () =>
    Effect.gen(function* () {
      const { fs, dir, nested, file } = yield* tempLedger;
      const store = yield* makeJsonFileLedgerStore(file);
      assert.deepStrictEqual(yield* store.load, []);
      const ledger = yield* makeDeviceLedger(store);
      const added = yield* ledger.add({ alg: "p256", publicKey: p256Key, name: "Tab", now: NOW });
      assert.deepStrictEqual(yield* (yield* makeJsonFileLedgerStore(file)).load, [added]);
      if (isPosix) assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
      // Only the ledger remains: the temp file was renamed into place, not left beside it.
      assert.deepStrictEqual(yield* fs.readDirectory(dir), ["nested"]);
      assert.deepStrictEqual(yield* fs.readDirectory(nested), ["devices.json"]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!isPosix)("narrows an existing, more open ledger file to 0600", () =>
    Effect.gen(function* () {
      const { fs, nested, file } = yield* tempLedger;
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.writeFileString(file, '{"version":1,"devices":[]}');
      yield* fs.chmod(file, 0o644);
      const ledger = yield* makeDeviceLedger(yield* makeJsonFileLedgerStore(file));
      yield* ledger.add({ alg: "ed25519", publicKey: edKey(1), name: "P", now: NOW });
      assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps every concurrent change and leaves a complete file", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* tempLedger;
      const ledger = yield* makeDeviceLedger(yield* makeJsonFileLedgerStore(file));
      yield* Effect.forEach(
        Array.from({ length: 12 }, (_, index) => index + 40),
        (n) => ledger.add({ alg: "ed25519", publicKey: edKey(n), name: `D${n}`, now: NOW }),
        { concurrency: "unbounded" },
      );
      const parsed = JSON.parse(yield* fs.readFileString(file)) as { devices: unknown[] };
      assert.strictEqual(parsed.devices.length, 12);
    }).pipe(Effect.scoped),
  );

  it.effect("fails, rather than starting empty, on a corrupt or inconsistent file", () =>
    Effect.gen(function* () {
      const { fs, nested, file } = yield* tempLedger;
      yield* fs.makeDirectory(nested, { recursive: true });
      const store = yield* makeJsonFileLedgerStore(file);
      yield* fs.writeFileString(file, '{"version":1,"devices":[');
      assert.isTrue(Exit.isFailure(yield* Effect.exit(store.load)));
      const swapped: LedgerDevice = {
        deviceId: relayDeviceId("ed25519", edKey(1)),
        alg: "ed25519",
        publicKey: encodeBase64url(edKey(2)),
        name: "Swapped",
        createdAt: NOW,
        lastSeenAt: null,
        status: "active",
        revokedAt: null,
      };
      yield* fs.writeFileString(file, JSON.stringify({ version: 1, devices: [swapped] }));
      const exit = yield* Effect.exit(store.load);
      assert.isTrue(Exit.isFailure(exit));
      const verify = ledgerVerifyDevice(yield* makeDeviceLedger(store));
      assert.strictEqual(
        yield* rejection(verify(deviceIdentity("ed25519", edKey(1)))),
        "host-policy",
      );
    }).pipe(Effect.scoped),
  );
});
