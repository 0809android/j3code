import {
  type E2eeDeviceAlgorithm,
  type E2eeDeviceKeypair,
  type E2eeDeviceSigner,
  E2eeProtocolError,
  deviceSignerFromKeypair,
  generateDeviceKeypair,
} from "@t3tools/shared/socketE2ee";
import { decodeBase64url, encodeBase64url } from "@t3tools/shared/relay";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Where a device keeps its relay identity keys (`Dk`, spec §13). Each pairing gets its own key,
 * so the relay cannot tell that two hosts are used from the same device. Secrets never leave
 * the store: callers only get a signer.
 */

export class DeviceKeyStoreError extends Schema.TaggedError<DeviceKeyStoreError>()(
  "DeviceKeyStoreError",
  {
    operation: Schema.Literals(["create", "load", "remove", "sign"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class DeviceKeyStore extends Context.Service<
  DeviceKeyStore,
  {
    /** Creates (or replaces) the key named `keyId`. */
    readonly create: (keyId: string) => Effect.Effect<E2eeDeviceSigner, DeviceKeyStoreError>;
    readonly load: (
      keyId: string,
    ) => Effect.Effect<Option.Option<E2eeDeviceSigner>, DeviceKeyStoreError>;
    readonly remove: (keyId: string) => Effect.Effect<void, DeviceKeyStoreError>;
  }
>()("@t3tools/client-runtime/k3relay/deviceKeyStore") {}

const storeError = (operation: DeviceKeyStoreError["operation"], detail: string) => () =>
  new DeviceKeyStoreError({ operation, detail });

// ── Software keys (desktop safeStorage, mobile SecureStore, web fallback) ──────────────────

/** A place that keeps one small secret string per key id, encrypted by the platform. */
export interface DeviceSecretVault {
  readonly read: (keyId: string) => Effect.Effect<Option.Option<string>, DeviceKeyStoreError>;
  readonly write: (keyId: string, secret: string) => Effect.Effect<void, DeviceKeyStoreError>;
  readonly remove: (keyId: string) => Effect.Effect<void, DeviceKeyStoreError>;
}

const SoftwareKeyRecord = Schema.fromJsonString(
  Schema.Struct({
    v: Schema.Literal(1),
    alg: Schema.Literals(["ed25519", "p256"]),
    sk: Schema.String,
    pk: Schema.String,
  }),
);
const encodeSoftwareKey = Schema.encodeSync(SoftwareKeyRecord);
const decodeSoftwareKey = Schema.decodeUnknownOption(SoftwareKeyRecord);

const PUBLIC_KEY_LENGTH: Record<E2eeDeviceAlgorithm, number> = { ed25519: 32, p256: 65 };

export const encodeSoftwareDeviceKey = (keypair: E2eeDeviceKeypair): string =>
  encodeSoftwareKey({
    v: 1,
    alg: keypair.alg,
    sk: encodeBase64url(keypair.secretKey),
    pk: encodeBase64url(keypair.publicKey),
  });

export const decodeSoftwareDeviceKey = (stored: string): E2eeDeviceKeypair | null => {
  const record = Option.getOrNull(decodeSoftwareKey(stored));
  if (record === null) return null;
  const secretKey = decodeBase64url(record.sk, 32);
  const publicKey = decodeBase64url(record.pk, PUBLIC_KEY_LENGTH[record.alg]);
  return secretKey === null || publicKey === null
    ? null
    : { alg: record.alg, secretKey, publicKey };
};

/** Keys whose secret is a byte string the platform vault encrypts (spec §13, P1: Ed25519). */
export const makeSoftwareDeviceKeyStore = Effect.fn("DeviceKeyStore.makeSoftware")(function* (
  vault: DeviceSecretVault,
  alg: E2eeDeviceAlgorithm = "ed25519",
) {
  const random = yield* SecureRandom.SecureRandom;
  return DeviceKeyStore.of({
    create: Effect.fn("DeviceKeyStore.create")(function* (keyId) {
      const keypair = yield* generateDeviceKeypair(alg).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
        Effect.mapError(storeError("create", "Could not create a device key.")),
      );
      yield* vault.write(keyId, encodeSoftwareDeviceKey(keypair));
      return deviceSignerFromKeypair(keypair);
    }),
    load: Effect.fn("DeviceKeyStore.load")(function* (keyId) {
      const stored = yield* vault.read(keyId);
      if (Option.isNone(stored)) return Option.none<E2eeDeviceSigner>();
      const keypair = decodeSoftwareDeviceKey(stored.value);
      if (keypair === null) {
        return yield* new DeviceKeyStoreError({
          operation: "load",
          detail: "The stored device key is unreadable.",
        });
      }
      return Option.some(deviceSignerFromKeypair(keypair));
    }),
    remove: vault.remove,
  });
});

/** A vault that lives as long as its layer, for tests. */
export const makeMemoryDeviceSecretVault = (): DeviceSecretVault & {
  readonly secrets: Map<string, string>;
} => {
  const secrets = new Map<string, string>();
  return {
    secrets,
    read: (keyId) => Effect.sync(() => Option.fromNullishOr(secrets.get(keyId))),
    write: (keyId, secret) => Effect.sync(() => void secrets.set(keyId, secret)),
    remove: (keyId) => Effect.sync(() => void secrets.delete(keyId)),
  };
};

export const layerMemory = (alg: E2eeDeviceAlgorithm = "ed25519") =>
  Layer.effect(DeviceKeyStore, makeSoftwareDeviceKeyStore(makeMemoryDeviceSecretVault(), alg)).pipe(
    Layer.provide(SecureRandom.layerWebCrypto),
  );

// ── WebCrypto keys (web) ────────────────────────────────────────────────────

export type WebDeviceKeyRecord =
  | { readonly kind: "webcrypto-p256"; readonly keyPair: CryptoKeyPair }
  | { readonly kind: "software"; readonly keypair: E2eeDeviceKeypair };

/** IndexedDB on the web: it stores `CryptoKey` objects without exposing their secret. */
export interface WebDeviceKeyRecordStore {
  readonly get: (keyId: string) => Promise<WebDeviceKeyRecord | undefined>;
  readonly put: (keyId: string, record: WebDeviceKeyRecord) => Promise<void>;
  readonly delete: (keyId: string) => Promise<void>;
}

const P256_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const P256_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** WebCrypto ECDSA already returns the raw `r‖s` signature the E2EE layer wants (no DER). */
export const webCryptoP256Signer = Effect.fn("DeviceKeyStore.webCryptoP256Signer")(function* (
  keyPair: CryptoKeyPair,
  subtle: SubtleCrypto,
) {
  const publicKey = new Uint8Array(
    yield* Effect.tryPromise({
      try: () => subtle.exportKey("raw", keyPair.publicKey),
      catch: storeError("load", "Could not read the device key."),
    }),
  );
  return {
    alg: "p256",
    publicKey,
    sign: (message) =>
      Effect.tryPromise({
        try: async () =>
          new Uint8Array(
            await subtle.sign(P256_SIGN, keyPair.privateKey, Uint8Array.from(message)),
          ),
        catch: () => new E2eeProtocolError({ detail: "The device key could not sign." }),
      }),
  } satisfies E2eeDeviceSigner;
});

/**
 * Non-extractable P-256 keys where WebCrypto has them (spec §18.4, `alg: p256`); otherwise
 * Ed25519 in software, kept in the same IndexedDB store.
 */
export const makeWebCryptoDeviceKeyStore = Effect.fn("DeviceKeyStore.makeWebCrypto")(function* (
  records: WebDeviceKeyRecordStore,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
) {
  const random = yield* SecureRandom.SecureRandom;
  const fromRecord = (record: WebDeviceKeyRecord) =>
    record.kind === "webcrypto-p256" && subtle !== null
      ? webCryptoP256Signer(record.keyPair, subtle)
      : record.kind === "software"
        ? Effect.succeed(deviceSignerFromKeypair(record.keypair))
        : Effect.fail(
            new DeviceKeyStoreError({
              operation: "load",
              detail: "This browser cannot use the stored device key.",
            }),
          );
  const createP256 = Effect.fn("DeviceKeyStore.createP256")(function* (keyId: string) {
    if (subtle === null) return Option.none<E2eeDeviceSigner>();
    const generated = yield* Effect.tryPromise({
      try: () => subtle.generateKey(P256_ALGORITHM, false, ["sign", "verify"]),
      catch: storeError("create", "Could not create a device key."),
    }).pipe(Effect.option);
    if (Option.isNone(generated)) return Option.none<E2eeDeviceSigner>();
    const record: WebDeviceKeyRecord = { kind: "webcrypto-p256", keyPair: generated.value };
    yield* Effect.tryPromise({
      try: () => records.put(keyId, record),
      catch: storeError("create", "Could not save the device key."),
    });
    return Option.some(yield* fromRecord(record));
  });
  return DeviceKeyStore.of({
    create: Effect.fn("DeviceKeyStore.create")(function* (keyId) {
      const p256 = yield* createP256(keyId);
      if (Option.isSome(p256)) return p256.value;
      const keypair = yield* generateDeviceKeypair("ed25519").pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
        Effect.mapError(storeError("create", "Could not create a device key.")),
      );
      yield* Effect.tryPromise({
        try: () => records.put(keyId, { kind: "software", keypair }),
        catch: storeError("create", "Could not save the device key."),
      });
      return deviceSignerFromKeypair(keypair);
    }),
    load: Effect.fn("DeviceKeyStore.load")(function* (keyId) {
      const record = yield* Effect.tryPromise({
        try: () => records.get(keyId),
        catch: storeError("load", "Could not read the device key."),
      });
      return record === undefined ? Option.none() : Option.some(yield* fromRecord(record));
    }),
    remove: Effect.fn("DeviceKeyStore.remove")(function* (keyId) {
      yield* Effect.tryPromise({
        try: () => records.delete(keyId),
        catch: storeError("remove", "Could not delete the device key."),
      });
    }),
  });
});
