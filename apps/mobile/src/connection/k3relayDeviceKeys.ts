import {
  DeviceKeyStore,
  DeviceKeyStoreError,
  type DeviceSecretVault,
  makeSoftwareDeviceKeyStore,
} from "@t3tools/client-runtime/k3relay";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SecureStore from "expo-secure-store";

/**
 * K3 Relay device keys (spec §13, P1): software Ed25519 secrets in the Keychain / Keystore, for
 * this device only, never in backups, readable after the first unlock so a reconnect in the
 * background still works.
 */
const deviceOnly = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
} satisfies SecureStore.SecureStoreOptions;

// SecureStore keys allow only letters, digits, ".", "-" and "_".
const storeKey = (keyId: string) => `k3relay.device.${keyId.replace(/[^A-Za-z0-9._-]/gu, "_")}`;

const vaultError = (operation: DeviceKeyStoreError["operation"]) => () =>
  new DeviceKeyStoreError({ operation, detail: "The device keychain is unavailable." });

const secureStoreVault: DeviceSecretVault = {
  read: (keyId) =>
    Effect.tryPromise({
      try: () => SecureStore.getItemAsync(storeKey(keyId), deviceOnly),
      catch: vaultError("load"),
    }).pipe(Effect.map(Option.fromNullishOr)),
  write: (keyId, secret) =>
    Effect.tryPromise({
      try: () => SecureStore.setItemAsync(storeKey(keyId), secret, deviceOnly),
      catch: vaultError("create"),
    }),
  remove: (keyId) =>
    Effect.tryPromise({
      try: () => SecureStore.deleteItemAsync(storeKey(keyId), deviceOnly),
      catch: vaultError("remove"),
    }),
};

export const layer = Layer.effect(
  DeviceKeyStore,
  makeSoftwareDeviceKeyStore(secureStoreVault, "ed25519"),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
