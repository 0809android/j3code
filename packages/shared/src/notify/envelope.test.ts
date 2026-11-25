import { describe, expect, it } from "@effect/vitest";

import {
  NOTIFY_HEADER_BYTES,
  NOTIFY_MAX_AGE_MS,
  NOTIFY_MAX_ENVELOPE_BYTES,
  NOTIFY_TEXT_MAX_CHARS,
  type NotifyPayload,
  NotifyPayloadError,
  makeNotifyReplayGuard,
  newNotifyId,
  notifyEnvelopeKeyId,
  notifyKeyId,
  openNotification,
  sealNotification,
} from "./envelope.ts";
import { hpkeGenerateKeyPair } from "./hpke.ts";

const NOW = 1_800_000_000_000;

const payload = (overrides: Partial<NotifyPayload> = {}): NotifyPayload => ({
  v: 1,
  id: newNotifyId(),
  ts: NOW,
  kind: "approval",
  env: "env-1234",
  thread: "thread-5678",
  ...overrides,
});

const device = hpkeGenerateKeyPair();
const keyId = notifyKeyId(device.publicKey);
const keys = (id: string) => (id === keyId ? device.secretKey : undefined);

describe("notification envelopes", () => {
  it("round-trips, and carries only the header in the clear", () => {
    const sent = payload({ text: "npm test" });
    const envelope = sealNotification({ recipientPublicKey: device.publicKey, payload: sent });
    expect(notifyEnvelopeKeyId(envelope)).toBe(keyId);
    const opened = openNotification({ envelope, secretKeyFor: keys, now: NOW });
    expect(opened).toEqual({ ok: true, payload: sent, keyId });
    const raw = Buffer.from(envelope).toString("latin1");
    for (const needle of ["env-1234", "thread-5678", "npm test", "approval"]) {
      expect(raw).not.toContain(needle);
    }
  });

  it("another device's key cannot open it, even when it claims the same key id", () => {
    const envelope = sealNotification({ recipientPublicKey: device.publicKey, payload: payload() });
    const other = hpkeGenerateKeyPair();
    expect(openNotification({ envelope, secretKeyFor: () => undefined, now: NOW })).toEqual({
      ok: false,
      reason: "unknown-key",
    });
    expect(openNotification({ envelope, secretKeyFor: () => other.secretKey, now: NOW })).toEqual({
      ok: false,
      reason: "open-failed",
    });
  });

  it("every flipped bit is caught: the header by the AAD, the rest by the AEAD", () => {
    const envelope = sealNotification({ recipientPublicKey: device.publicKey, payload: payload() });
    for (let index = 0; index < envelope.length; index += 1) {
      const tampered = Uint8Array.from(envelope);
      tampered[index] = (tampered[index] ?? 0) ^ 0x80;
      const opened = openNotification({
        envelope: tampered,
        // Even a device that ignored the key id would not open a changed header.
        secretKeyFor: () => device.secretKey,
        now: NOW,
      });
      expect(opened.ok, `byte ${index}`).toBe(false);
    }
  });

  it("refuses truncated, extended and wrong-version envelopes before any crypto", () => {
    const envelope = sealNotification({ recipientPublicKey: device.publicKey, payload: payload() });
    const cases = [
      envelope.subarray(0, envelope.length - 1),
      new Uint8Array([...envelope, 0]),
      Uint8Array.of(2, ...envelope.subarray(1)),
      new Uint8Array(NOTIFY_HEADER_BYTES),
      new Uint8Array(NOTIFY_MAX_ENVELOPE_BYTES + 1),
    ];
    for (const candidate of cases) {
      const opened = openNotification({
        envelope: candidate,
        secretKeyFor: () => device.secretKey,
        now: NOW,
      });
      expect(opened.ok).toBe(false);
    }
    expect(notifyEnvelopeKeyId(new Uint8Array(NOTIFY_MAX_ENVELOPE_BYTES + 1))).toBeNull();
  });

  it("pads to a fixed bucket, so the length says little about the content", () => {
    const short = sealNotification({ recipientPublicKey: device.publicKey, payload: payload() });
    const longer = sealNotification({
      recipientPublicKey: device.publicKey,
      payload: payload({ text: "x".repeat(60) }),
    });
    expect(short.length).toBe(longer.length);
    const largest = sealNotification({
      recipientPublicKey: device.publicKey,
      payload: payload({ text: "あ".repeat(NOTIFY_TEXT_MAX_CHARS), thread: "t".repeat(128) }),
    });
    expect(largest.length).toBeLessThanOrEqual(NOTIFY_MAX_ENVELOPE_BYTES);
    // APNs and FCM each take 4 KB; base64url of the largest envelope stays far below.
    expect(Buffer.from(largest).toString("base64url").length).toBeLessThan(2048);
  });

  it("refuses to seal a payload that is too large or not minimal", () => {
    const tooLong = payload({ text: "x".repeat(NOTIFY_TEXT_MAX_CHARS + 1) });
    expect(() =>
      sealNotification({ recipientPublicKey: device.publicKey, payload: tooLong }),
    ).toThrow(NotifyPayloadError);
    const withTitle = { ...payload(), title: "Secret project" } as unknown as NotifyPayload;
    expect(() =>
      sealNotification({ recipientPublicKey: device.publicKey, payload: withTitle }),
    ).toThrow(NotifyPayloadError);
    const badKind = { ...payload(), kind: "anything" } as unknown as NotifyPayload;
    expect(() =>
      sealNotification({ recipientPublicKey: device.publicKey, payload: badKind }),
    ).toThrow(NotifyPayloadError);
  });

  it("drops a replayed envelope, and one that is too old or from the future", () => {
    const replay = makeNotifyReplayGuard();
    const envelope = sealNotification({ recipientPublicKey: device.publicKey, payload: payload() });
    expect(openNotification({ envelope, secretKeyFor: keys, now: NOW, replay }).ok).toBe(true);
    expect(openNotification({ envelope, secretKeyFor: keys, now: NOW, replay })).toEqual({
      ok: false,
      reason: "replayed",
    });
    expect(
      openNotification({ envelope, secretKeyFor: keys, now: NOW + NOTIFY_MAX_AGE_MS + 1 }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(openNotification({ envelope, secretKeyFor: keys, now: NOW - 10 * 60_000 })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("a replay guard stays bounded and still catches recent ids", () => {
    const replay = makeNotifyReplayGuard(4);
    for (const id of ["a", "b", "c", "d", "e"]) expect(replay.accept(id)).toBe(true);
    expect(replay.accept("e")).toBe(false);
    expect(replay.accept("a")).toBe(true);
  });
});
