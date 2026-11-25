import {
  type DeviceSecretVault,
  DeviceKeyStore,
  DeviceKeyStoreError,
  type WebDeviceKeyRecord,
  type WebDeviceKeyRecordStore,
  makeSoftwareDeviceKeyStore,
  makeWebCryptoDeviceKeyStore,
} from "@t3tools/client-runtime/k3relay";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const DATABASE = "t3code-k3relay-device-keys";
const STORE = "keys";

const request = <A>(open: () => IDBRequest<A>) =>
  new Promise<A>((resolve, reject) => {
    const pending = open();
    pending.addEventListener("success", () => resolve(pending.result));
    pending.addEventListener("error", () => reject(pending.error));
  });

let database: Promise<IDBDatabase> | undefined;
const openDatabase = () => {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1);
    opening.addEventListener("upgradeneeded", () => opening.result.createObjectStore(STORE));
    opening.addEventListener("success", () => resolve(opening.result));
    opening.addEventListener("error", () => {
      database = undefined;
      reject(opening.error);
    });
  });
  return database;
};

const store = async (mode: IDBTransactionMode) =>
  (await openDatabase()).transaction(STORE, mode).objectStore(STORE);

/** IndexedDB keeps `CryptoKey` objects structured-cloned, so a non-extractable key stays one. */
export const indexedDbDeviceKeyRecords: WebDeviceKeyRecordStore = {
  get: async (keyId) => {
    const keys = await store("readonly");
    return (await request(() => keys.get(keyId))) as WebDeviceKeyRecord | undefined;
  },
  put: async (keyId, record) => {
    const keys = await store("readwrite");
    await request(() => keys.put(record, keyId));
  },
  delete: async (keyId) => {
    const keys = await store("readwrite");
    await request(() => keys.delete(keyId));
  },
};

/** The desktop shell keeps device keys encrypted with the OS keychain (Electron `safeStorage`). */
export interface DesktopK3RelayDeviceKeys {
  readonly read: (keyId: string) => Promise<string | null>;
  readonly write: (keyId: string, secret: string) => Promise<boolean>;
  readonly remove: (keyId: string) => Promise<boolean>;
}

const vaultError = (operation: DeviceKeyStoreError["operation"]) => () =>
  new DeviceKeyStoreError({ operation, detail: "The desktop key store is unavailable." });

export const desktopDeviceSecretVault = (bridge: DesktopK3RelayDeviceKeys): DeviceSecretVault => ({
  read: (keyId) =>
    Effect.tryPromise({ try: () => bridge.read(keyId), catch: vaultError("load") }).pipe(
      Effect.map(Option.fromNullishOr),
    ),
  write: (keyId, secret) =>
    Effect.tryPromise({ try: () => bridge.write(keyId, secret), catch: vaultError("create") }).pipe(
      Effect.filterOrFail((saved) => saved, vaultError("create")),
      Effect.asVoid,
    ),
  remove: (keyId) =>
    Effect.tryPromise({ try: () => bridge.remove(keyId), catch: vaultError("remove") }).pipe(
      Effect.asVoid,
    ),
});

export const layer = Layer.effect(
  DeviceKeyStore,
  Effect.suspend(() => {
    const desktop = window.k3relayDeviceKeys;
    return desktop === undefined
      ? makeWebCryptoDeviceKeyStore(indexedDbDeviceKeyRecords)
      : makeSoftwareDeviceKeyStore(desktopDeviceSecretVault(desktop));
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
