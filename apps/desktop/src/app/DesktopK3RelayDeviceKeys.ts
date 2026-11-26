import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * K3 Relay device keys (spec §13): one small secret per pairing, each encrypted with the OS
 * keychain through `safeStorage` and kept in an owner-only file. Without OS encryption nothing
 * is stored, so the renderer's pairing fails instead of keeping a key in the clear.
 */

const KEY_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/u;
const OWNER_ONLY = 0o600;

const DeviceKeyFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    keys: Schema.Record(Schema.String, Schema.String),
  }),
);
const decodeDeviceKeyFile = Schema.decodeUnknownOption(DeviceKeyFile);
const encodeDeviceKeyFile = Schema.encodeEffect(DeviceKeyFile);

export class DesktopK3RelayDeviceKeysError extends Schema.TaggedError<DesktopK3RelayDeviceKeysError>()(
  "DesktopK3RelayDeviceKeysError",
  {
    operation: Schema.Literals(["read", "write", "remove", "encrypt", "decrypt"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `K3 Relay device key ${this.operation} failed.`;
  }
}

export class DesktopK3RelayDeviceKeys extends Context.Service<
  DesktopK3RelayDeviceKeys,
  {
    readonly read: (
      keyId: string,
    ) => Effect.Effect<Option.Option<string>, DesktopK3RelayDeviceKeysError>;
    /** False when the OS offers no encryption: the key is not stored. */
    readonly write: (
      keyId: string,
      secret: string,
    ) => Effect.Effect<boolean, DesktopK3RelayDeviceKeysError>;
    readonly remove: (keyId: string) => Effect.Effect<boolean, DesktopK3RelayDeviceKeysError>;
  }
>()("@t3tools/desktop/app/DesktopK3RelayDeviceKeys") {}

export const isDeviceKeyId = (keyId: string) => KEY_ID_PATTERN.test(keyId);

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const filePath = path.join(environment.stateDir, "k3relay-device-keys.json");
  const lock = yield* Semaphore.make(1);
  const fail = (operation: DesktopK3RelayDeviceKeysError["operation"]) => (cause: unknown) =>
    new DesktopK3RelayDeviceKeysError({ operation, cause });

  const readKeys = fileSystem.readFileString(filePath).pipe(
    Effect.map((raw) => Option.getOrUndefined(decodeDeviceKeyFile(raw))?.keys ?? {}),
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<Record<string, string>>({})
        : Effect.fail(fail("read")(error)),
    ),
  );

  const writeKeys = Effect.fn("DesktopK3RelayDeviceKeys.writeKeys")(
    function* (keys: Record<string, string>) {
      const encoded = yield* encodeDeviceKeyFile({ version: 1, keys });
      const tempPath = `${filePath}.tmp`;
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFileString(tempPath, encoded, { mode: OWNER_ONLY });
      yield* fileSystem.chmod(tempPath, OWNER_ONLY);
      yield* fileSystem.rename(tempPath, filePath);
    },
    Effect.mapError(fail("write")),
  );

  return DesktopK3RelayDeviceKeys.of({
    read: Effect.fn("DesktopK3RelayDeviceKeys.read")(function* (keyId) {
      const stored = (yield* readKeys)[keyId];
      if (stored === undefined) return Option.none<string>();
      const bytes = yield* Effect.fromResult(Base64.decode(stored)).pipe(
        Effect.mapError(fail("decrypt")),
      );
      return Option.some(
        yield* safeStorage.decryptString(bytes).pipe(Effect.mapError(fail("decrypt"))),
      );
    }),
    write: Effect.fn("DesktopK3RelayDeviceKeys.write")(function* (keyId, secret) {
      const available = yield* safeStorage.isEncryptionAvailable.pipe(
        Effect.mapError(fail("encrypt")),
      );
      if (!available) return false;
      const encrypted = yield* safeStorage
        .encryptString(secret)
        .pipe(Effect.mapError(fail("encrypt")));
      yield* lock.withPermits(1)(
        Effect.flatMap(readKeys, (keys) =>
          writeKeys({ ...keys, [keyId]: Base64.encode(encrypted) }),
        ),
      );
      return true;
    }),
    remove: Effect.fn("DesktopK3RelayDeviceKeys.remove")(function* (keyId) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const keys = yield* readKeys;
          if (!(keyId in keys)) return false;
          const { [keyId]: _removed, ...rest } = keys;
          yield* writeKeys(rest);
          return true;
        }),
      );
    }),
  });
});

export const layer = Layer.effect(DesktopK3RelayDeviceKeys, make);
