/**
 * End-to-end encrypted notifications (K3 Relay spec §13): HPKE to the device's notification key
 * `Nk`, and the envelope the relay carries to APNs / FCM without being able to read it.
 */

export {
  HPKE_AEAD_ID,
  HPKE_ENC_BYTES,
  HPKE_KDF_ID,
  HPKE_KEM_ID,
  HPKE_KEY_BYTES,
  HpkeError,
  hpkeGenerateKeyPair,
  hpkePublicKey,
} from "./hpke.ts";
export {
  NOTIFY_ENVELOPE_VERSION,
  NOTIFY_KINDS,
  NOTIFY_MAX_AGE_MS,
  NOTIFY_MAX_ENVELOPE_BYTES,
  NOTIFY_TEXT_MAX_CHARS,
  type NotifyKind,
  type NotifyOpenFailure,
  type NotifyOpenResult,
  type NotifyPayload,
  NotifyPayloadError,
  type NotifyReplayGuard,
  makeNotifyReplayGuard,
  newNotifyId,
  notifyEnvelopeKeyId,
  notifyKeyId,
  openNotification,
  sealNotification,
} from "./envelope.ts";
