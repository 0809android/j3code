import * as Aead from "effect/crypto/Aead";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Layer from "effect/Layer";

/**
 * Application-layer E2EE for the WebSocket RPC channel: an Ed25519 host identity pinned by the
 * client, an ephemeral X25519 handshake, HKDF-SHA256, and counter-ordered XChaCha20-Poly1305
 * records (pure TypeScript, so it runs where `crypto.subtle` does not). v1 carries text for
 * direct connections; v2 adds device authentication and binary frames for the relay.
 */

/** Query parameter that asks for an E2EE session, mirroring `frameParts`. */
export const SOCKET_E2EE_QUERY_PARAM = "e2ee";

export const E2EE_REQUIRED_CODE = "E2EE_REQUIRED";

export { E2EE_HANDSHAKE_TIMEOUT, type E2eeSocket } from "./socketE2eeEngine.ts";
export {
  E2EE_IDENTITY_MISMATCH_CODE,
  E2eeIdentityMismatchError,
  type E2eeHandshakeError,
  E2eeProtocolError,
  E2eeRejectedError,
  E2eeRejectionReason,
} from "./socketE2eeRecord.ts";
export {
  type E2eeIdentityKeypair,
  decodeIdentityKey,
  encodeIdentityKey,
  generateIdentityKeypair,
  identityFingerprint,
  identityPublicKeyFromSeed,
  wrapClientSocketWithE2ee,
  wrapServerSocketWithE2ee,
} from "./socketE2eeV1.ts";
export {
  E2EE_DEVICE_ALGORITHMS,
  type E2eeDeviceAlgorithm,
  type E2eeDeviceIdentity,
  type E2eeDeviceKeypair,
  type E2eeDeviceSigner,
  deviceIdFromPublicKey,
  deviceSignerFromKeypair,
  generateDeviceKeypair,
  hostIdFromIdentityKey,
} from "./socketE2eeDevice.ts";
export {
  E2EE_FRAGMENT_BYTES,
  type E2eeV2ClientOptions,
  type E2eeV2ServerOptions,
  wrapClientSocketWithE2eeV2,
  wrapServerSocketWithE2eeV2,
} from "./socketE2eeV2.ts";

/** Layers the wrappers need. XChaCha20-Poly1305 never touches `crypto.subtle`. */
export const layerE2eeCrypto = Aead.layerWebCrypto.pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);
