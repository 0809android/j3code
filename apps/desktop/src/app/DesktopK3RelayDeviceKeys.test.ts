import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopK3RelayDeviceKeys from "./DesktopK3RelayDeviceKeys.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const layerSafeStorage = (available: boolean) =>
  Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`sealed:${value}`)),
    decryptString: (value) => Effect.succeed(textDecoder.decode(value).slice("sealed:".length)),
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

const layerFor = (baseDir: string, available: boolean) =>
  DesktopK3RelayDeviceKeys.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/src",
          homeDirectory: baseDir,
          platform: "darwin",
          processArch: "arm64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: true,
          resourcesPath: "/missing/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ K3CODE_HOME: baseDir })),
          ),
        ),
        layerSafeStorage(available),
        NodeServices.layer,
      ),
    ),
  );

describe("DesktopK3RelayDeviceKeys", () => {
  it.effect("keeps keys sealed by the OS keychain in an owner-only file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* Effect.gen(function* () {
        const keys = yield* DesktopK3RelayDeviceKeys.DesktopK3RelayDeviceKeys;
        assert.isTrue(yield* keys.write("k3relay:host:abc", "secret-key"));
        assert.deepStrictEqual(yield* keys.read("k3relay:host:abc"), Option.some("secret-key"));
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const file = path.join(environment.stateDir, "k3relay-device-keys.json");
        const raw = yield* fileSystem.readFileString(file);
        assert.notInclude(raw, "secret-key");
        const info = yield* fileSystem.stat(file);
        assert.strictEqual(Number(info.mode) & 0o777, 0o600);
        assert.isTrue(yield* keys.remove("k3relay:host:abc"));
        assert.isTrue(Option.isNone(yield* keys.read("k3relay:host:abc")));
      }).pipe(
        Effect.provide(Layer.merge(layerFor(baseDir, true), DesktopEnvironmentLayer(baseDir))),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stores nothing when the OS offers no encryption", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* Effect.gen(function* () {
        const keys = yield* DesktopK3RelayDeviceKeys.DesktopK3RelayDeviceKeys;
        assert.isFalse(yield* keys.write("k3relay:host:abc", "secret-key"));
        assert.isTrue(Option.isNone(yield* keys.read("k3relay:host:abc")));
      }).pipe(Effect.provide(layerFor(baseDir, false)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("accepts only plain key ids", () => {
    assert.isTrue(DesktopK3RelayDeviceKeys.isDeviceKeyId("k3relay:abc:DEF-_1"));
    assert.isFalse(DesktopK3RelayDeviceKeys.isDeviceKeyId("../escape"));
    assert.isFalse(DesktopK3RelayDeviceKeys.isDeviceKeyId(""));
  });
});

function DesktopEnvironmentLayer(baseDir: string) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ K3CODE_HOME: baseDir })),
    ),
  );
}
