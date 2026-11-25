import { assert, describe, expect, it } from "@effect/vitest";
import { newNotifyId, sealNotification } from "@t3tools/shared/notify";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import {
  makeMemoryNotificationSecretVault,
  makeNotificationKeyStore,
  notificationHostName,
  notificationKeyName,
} from "./notificationKeyStore.ts";

const HOST = { hostId: "h".repeat(32), environmentId: "env-1", hostLabel: "Studio Mac" };

const sealFor = (publicKey: Uint8Array, env: string, ts: number) =>
  sealNotification({
    recipientPublicKey: publicKey,
    payload: { v: 1, id: newNotifyId(), ts, kind: "input", env, thread: "t-1" },
  });

describe("NotificationKeyStore", () => {
  it.effect("keeps one key per host, readable by name for the native code", () =>
    Effect.gen(function* () {
      const vault = makeMemoryNotificationSecretVault();
      const store = makeNotificationKeyStore(vault);
      const first = yield* store.ensure(HOST);
      const again = yield* store.ensure(HOST);
      expect(again.keyId).toBe(first.keyId);
      expect(vault.secrets.get(notificationHostName(HOST.hostId))).toBe(first.keyId);
      const record = JSON.parse(vault.secrets.get(notificationKeyName(first.keyId)) ?? "{}");
      expect(record).toMatchObject({
        v: 1,
        hostId: HOST.hostId,
        env: "env-1",
        label: "Studio Mac",
      });
      const other = yield* store.ensure({ ...HOST, hostId: "g".repeat(32) });
      assert.notStrictEqual(other.keyId, first.keyId);
    }),
  );

  it.effect("opens a sealed notification, and refuses one naming another environment", () =>
    Effect.gen(function* () {
      const store = makeNotificationKeyStore(makeMemoryNotificationSecretVault());
      const { publicKey } = yield* store.ensure(HOST);
      const opened = yield* store.open(sealFor(publicKey, "env-1", yield* Clock.currentTimeMillis));
      assert(opened.ok);
      expect(opened.context).toEqual(HOST);
      expect(
        yield* store.open(sealFor(publicKey, "env-2", yield* Clock.currentTimeMillis)),
      ).toEqual({
        ok: false,
        reason: "wrong-environment",
      });
    }),
  );

  it.effect("a removed key opens nothing, and a re-paired host gets a new key", () =>
    Effect.gen(function* () {
      const vault = makeMemoryNotificationSecretVault();
      const store = makeNotificationKeyStore(vault);
      const { publicKey, keyId } = yield* store.ensure(HOST);
      const envelope = sealFor(publicKey, "env-1", yield* Clock.currentTimeMillis);
      yield* store.remove(HOST.hostId);
      expect(vault.secrets.size).toBe(0);
      expect(yield* store.open(envelope)).toEqual({ ok: false, reason: "unknown-key" });
      // Paired again under another environment id: the old key is not reused.
      const next = yield* store.ensure({ ...HOST, environmentId: "env-9" });
      assert.notStrictEqual(next.keyId, keyId);
    }),
  );
});
