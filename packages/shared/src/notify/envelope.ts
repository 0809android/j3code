import * as Schema from "effect/Schema";
import { randomBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { encodeBase64url } from "../relay/encoding.ts";
import {
  HPKE_ENC_BYTES,
  HPKE_KEY_BYTES,
  HPKE_TAG_BYTES,
  HpkeError,
  hpkeOpen,
  hpkeSeal,
} from "./hpke.ts";

/**
 * The envelope a host seals to one device's notification key `Nk` (spec §13): the relay and
 * APNs / FCM carry it opaque. The layout is mirrored by the iOS extension and the Android service
 * and written out in infra/k3-relay/docs/NOTIFICATIONS.md; change it only with a new version.
 */

export const NOTIFY_ENVELOPE_VERSION = 1;
export const NOTIFY_KEY_ID_BYTES = 8;
export const NOTIFY_HEADER_BYTES = 1 + NOTIFY_KEY_ID_BYTES;
export const NOTIFY_PAD_BUCKETS = [256, 512, 1024] as const;
const MAX_PADDED = NOTIFY_PAD_BUCKETS[NOTIFY_PAD_BUCKETS.length - 1]!;
export const NOTIFY_MAX_ENVELOPE_BYTES =
  NOTIFY_HEADER_BYTES + HPKE_ENC_BYTES + MAX_PADDED + HPKE_TAG_BYTES;
export const NOTIFY_MIN_ENVELOPE_BYTES =
  NOTIFY_HEADER_BYTES + HPKE_ENC_BYTES + NOTIFY_PAD_BUCKETS[0] + HPKE_TAG_BYTES;
export const NOTIFY_TEXT_MAX_CHARS = 120;
/** An alert older than this is dropped: it is stale, or the relay is replaying it. */
export const NOTIFY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const NOTIFY_FUTURE_SKEW_MS = 5 * 60 * 1000;

const INFO = new TextEncoder().encode("k3relay-v1/notify");
const KEY_ID_LABEL = new TextEncoder().encode("k3relay-v1/notify-key-id");
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const REF_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

/** `device`: a device joined the host by introduction; sent regardless of the device's choices. */
export const NOTIFY_KINDS = ["approval", "input", "completed", "failed", "test", "device"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/**
 * Deliberately small: no thread title, project name or host name. `text` is an optional short
 * fragment, and the device names the host from its own records.
 */
export interface NotifyPayload {
  readonly v: 1;
  /** Random per notification, so a replayed envelope is recognised. */
  readonly id: string;
  readonly ts: number;
  readonly kind: NotifyKind;
  readonly env: string;
  readonly thread?: string;
  readonly text?: string;
}

export type NotifyOpenFailure =
  | "malformed"
  | "unknown-key"
  | "open-failed"
  | "bad-payload"
  | "stale"
  | "replayed";

export type NotifyOpenResult =
  | {
      readonly ok: true;
      readonly payload: NotifyPayload;
      readonly keyId: string;
    }
  | { readonly ok: false; readonly reason: NotifyOpenFailure };

export class NotifyPayloadError extends Schema.TaggedError<NotifyPayloadError>()(
  "NotifyPayloadError",
  { problem: Schema.String },
) {
  override get message(): string {
    return `The notification payload is invalid: ${this.problem}.`;
  }
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** `sha256("k3relay-v1/notify-key-id" ‖ Nk)`, first 8 bytes, in hex: which key a device needs. */
export const notifyKeyId = (publicKey: Uint8Array): string => {
  if (publicKey.length !== HPKE_KEY_BYTES) throw new HpkeError({ reason: "invalid-key" });
  const input = new Uint8Array(KEY_ID_LABEL.length + publicKey.length);
  input.set(KEY_ID_LABEL);
  input.set(publicKey, KEY_ID_LABEL.length);
  return hex(sha256(input).subarray(0, NOTIFY_KEY_ID_BYTES));
};

export const newNotifyId = (): string => encodeBase64url(randomBytes(16));

const isRef = (value: unknown): value is string =>
  typeof value === "string" && REF_PATTERN.test(value);

/** The payload with every field checked, or a reason it is not one. */
const validatePayload = (value: unknown): NotifyPayload | string => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object";
  const record = value as Record<string, unknown>;
  const allowed = new Set(["v", "id", "ts", "kind", "env", "thread", "text"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) return `unknown field ${key}`;
  if (record.v !== 1) return "version";
  if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) return "id";
  if (typeof record.ts !== "number" || !Number.isSafeInteger(record.ts) || record.ts < 0) {
    return "ts";
  }
  if (!NOTIFY_KINDS.includes(record.kind as NotifyKind)) return "kind";
  if (!isRef(record.env)) return "env";
  if (record.thread !== undefined && !isRef(record.thread)) return "thread";
  if (
    record.text !== undefined &&
    (typeof record.text !== "string" ||
      record.text.length === 0 ||
      [...record.text].length > NOTIFY_TEXT_MAX_CHARS)
  ) {
    return "text";
  }
  return {
    v: 1,
    id: record.id,
    ts: record.ts,
    kind: record.kind as NotifyKind,
    env: record.env,
    ...(record.thread === undefined ? {} : { thread: record.thread as string }),
    ...(record.text === undefined ? {} : { text: record.text as string }),
  };
};

const pad = (json: Uint8Array): Uint8Array => {
  const bucket = NOTIFY_PAD_BUCKETS.find((size) => json.length + 2 <= size);
  if (bucket === undefined) throw new NotifyPayloadError({ problem: "too large" });
  const out = new Uint8Array(bucket);
  out[0] = json.length >>> 8;
  out[1] = json.length & 0xff;
  out.set(json, 2);
  return out;
};

const unpad = (padded: Uint8Array): Uint8Array | null => {
  if (!(NOTIFY_PAD_BUCKETS as ReadonlyArray<number>).includes(padded.length)) return null;
  const length = ((padded[0] ?? 0) << 8) | (padded[1] ?? 0);
  if (length + 2 > padded.length) return null;
  for (let index = 2 + length; index < padded.length; index += 1) {
    if (padded[index] !== 0) return null;
  }
  return padded.subarray(2, 2 + length);
};

/** Seals one notification to one device key. A fresh ephemeral key every time. */
export const sealNotification = (input: {
  readonly recipientPublicKey: Uint8Array;
  readonly payload: NotifyPayload;
}): Uint8Array => {
  const payload = validatePayload(input.payload);
  if (typeof payload === "string") {
    throw new NotifyPayloadError({ problem: payload });
  }
  const json = new TextEncoder().encode(
    JSON.stringify({
      v: payload.v,
      id: payload.id,
      ts: payload.ts,
      kind: payload.kind,
      env: payload.env,
      ...(payload.thread === undefined ? {} : { thread: payload.thread }),
      ...(payload.text === undefined ? {} : { text: payload.text }),
    }),
  );
  const header = new Uint8Array(NOTIFY_HEADER_BYTES);
  header[0] = NOTIFY_ENVELOPE_VERSION;
  const keyId = notifyKeyId(input.recipientPublicKey);
  for (let index = 0; index < NOTIFY_KEY_ID_BYTES; index += 1) {
    header[1 + index] = Number.parseInt(keyId.slice(index * 2, index * 2 + 2), 16);
  }
  const { enc, ciphertext } = hpkeSeal({
    recipientPublicKey: input.recipientPublicKey,
    info: INFO,
    aad: header,
    plaintext: pad(json),
  });
  const out = new Uint8Array(header.length + enc.length + ciphertext.length);
  out.set(header);
  out.set(enc, header.length);
  out.set(ciphertext, header.length + enc.length);
  return out;
};

/** Which key an envelope is for, without opening it. */
export const notifyEnvelopeKeyId = (envelope: Uint8Array): string | null => {
  if (
    envelope.length < NOTIFY_MIN_ENVELOPE_BYTES ||
    envelope.length > NOTIFY_MAX_ENVELOPE_BYTES ||
    envelope[0] !== NOTIFY_ENVELOPE_VERSION
  ) {
    return null;
  }
  return hex(envelope.subarray(1, NOTIFY_HEADER_BYTES));
};

/**
 * Remembers recent notification ids, so the same envelope delivered twice (a relay replaying it,
 * or APNs redelivering) is shown once. Bounded; older ids fall out, and the age check covers them.
 */
export interface NotifyReplayGuard {
  /** False when the id was seen already; records it otherwise. */
  readonly accept: (id: string) => boolean;
}

export const makeNotifyReplayGuard = (capacity = 512): NotifyReplayGuard => {
  const seen = new Set<string>();
  return {
    accept: (id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > capacity) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
  };
};

/**
 * Opens an envelope with the device's key for its key id. The checks run in this order, and each
 * failure has its own reason: layout, key, AEAD, payload, age, then replay.
 */
export const openNotification = (input: {
  readonly envelope: Uint8Array;
  readonly secretKeyFor: (keyId: string) => Uint8Array | undefined;
  readonly now: number;
  readonly replay?: NotifyReplayGuard;
  readonly maxAgeMs?: number;
}): NotifyOpenResult => {
  const keyId = notifyEnvelopeKeyId(input.envelope);
  if (keyId === null) return { ok: false, reason: "malformed" };
  const secretKey = input.secretKeyFor(keyId);
  if (secretKey === undefined || secretKey.length !== HPKE_KEY_BYTES) {
    return { ok: false, reason: "unknown-key" };
  }
  const header = input.envelope.subarray(0, NOTIFY_HEADER_BYTES);
  const enc = input.envelope.subarray(NOTIFY_HEADER_BYTES, NOTIFY_HEADER_BYTES + HPKE_ENC_BYTES);
  const ciphertext = input.envelope.subarray(NOTIFY_HEADER_BYTES + HPKE_ENC_BYTES);
  let padded: Uint8Array;
  try {
    padded = hpkeOpen({ enc, recipientSecretKey: secretKey, info: INFO, aad: header, ciphertext });
  } catch {
    return { ok: false, reason: "open-failed" };
  }
  const json = unpad(padded);
  if (json === null) return { ok: false, reason: "bad-payload" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  const payload = validatePayload(parsed);
  if (typeof payload === "string") return { ok: false, reason: "bad-payload" };
  const maxAge = input.maxAgeMs ?? NOTIFY_MAX_AGE_MS;
  if (payload.ts < input.now - maxAge || payload.ts > input.now + NOTIFY_FUTURE_SKEW_MS) {
    return { ok: false, reason: "stale" };
  }
  if (input.replay !== undefined && !input.replay.accept(payload.id)) {
    return { ok: false, reason: "replayed" };
  }
  return { ok: true, payload, keyId };
};
