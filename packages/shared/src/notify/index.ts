/**
 * End-to-end encrypted notifications (K3 Relay spec §13): HPKE to the device's notification key
 * `Nk`, and the envelope the relay carries to APNs / FCM without being able to read it.
 */

export { HpkeError, hpkeGenerateKeyPair, hpkePublicKey } from "./hpke.ts";
export {
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
