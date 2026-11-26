import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as HostProcess from "../HostProcess.ts";
import {
  type E2eeDeviceAlgorithm,
  type E2eeDeviceIdentity,
  isCanonicalDevicePublicKey,
} from "../socketE2eeDevice.ts";
import { E2eeRejectedError, timingSafeEqual } from "../socketE2eeRecord.ts";
import { decodeBase64url, encodeBase64url, isRelayId, relayDeviceId } from "./encoding.ts";

/**
 * The host's device ledger (spec §5): the only authority on which devices may connect and
 * which are revoked. Grants and the relay's revocation copy are advisory; the host checks this
 * ledger on every handshake.
 */

export const LedgerDeviceStatus = Schema.Literals(["active", "revoked"]);
export type LedgerDeviceStatus = typeof LedgerDeviceStatus.Type;

/** Lets an approved device introduce new devices and revoke ordinary ones (spec §18.2). */
export const LedgerDevicePermission = Schema.Literals(["devices:invite"]);
export type LedgerDevicePermission = typeof LedgerDevicePermission.Type;

/**
 * How the host's ledger came to hold the device. Every route is an approval recorded here; an
 * introduction also names the introducing device.
 */
export const LedgerApprovalRoute = Schema.Literals(["host", "qr", "account", "introduction"]);
export type LedgerApprovalRoute = typeof LedgerApprovalRoute.Type;

export const LedgerDevice = Schema.Struct({
  /** The relay device id, `base32(sha256(lp32(alg) ‖ lp32(Dk)))`, as grants carry it. */
  deviceId: Schema.String,
  alg: Schema.Literals(["ed25519", "p256"]),
  /** `Dk`, base64url. */
  publicKey: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  lastSeenAt: Schema.NullOr(Schema.Number),
  status: LedgerDeviceStatus,
  revokedAt: Schema.NullOr(Schema.Number),
  /** Absent in ledgers written before introductions: no permissions. */
  permissions: Schema.optionalKey(Schema.Array(LedgerDevicePermission)),
  /** Absent in ledgers written before introductions. */
  approvedVia: Schema.optionalKey(LedgerApprovalRoute),
  /** The introducing device's id, present exactly when `approvedVia` is `introduction`. */
  introducedBy: Schema.optionalKey(Schema.String),
});
export type LedgerDevice = typeof LedgerDevice.Type;

/** An introduced device never invites, even if a hand-edited ledger says otherwise. */
export const deviceCanInvite = (device: LedgerDevice | undefined): boolean =>
  device?.status === "active" &&
  device.approvedVia !== "introduction" &&
  (device.permissions ?? []).includes("devices:invite");

const LedgerFile = Schema.Struct({
  version: Schema.Literal(1),
  devices: Schema.Array(LedgerDevice),
});
const decodeLedgerFile = Schema.decodeUnknownEffect(Schema.fromJsonString(LedgerFile));
const encodeLedgerFile = Schema.encodeEffect(Schema.fromJsonString(LedgerFile));

export class LedgerStoreError extends Schema.TaggedError<LedgerStoreError>()("LedgerStoreError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const DeviceLedgerErrorReason = Schema.Literals([
  "unknown-device",
  "already-registered",
  "invalid-name",
  "invalid-key",
  "invalid-route",
  "introduced-device",
]);
export type DeviceLedgerErrorReason = typeof DeviceLedgerErrorReason.Type;

export class DeviceLedgerError extends Schema.TaggedError<DeviceLedgerError>()(
  "DeviceLedgerError",
  { reason: DeviceLedgerErrorReason },
) {
  override get message(): string {
    return `The device ledger refused the change: ${this.reason}.`;
  }
}

const isDeviceLedgerError = Schema.is(DeviceLedgerError);

/** Where the ledger lives. Snapshots keep stores trivial; the ledger serializes writers. */
export interface LedgerStore {
  readonly load: Effect.Effect<ReadonlyArray<LedgerDevice>, LedgerStoreError>;
  readonly save: (devices: ReadonlyArray<LedgerDevice>) => Effect.Effect<void, LedgerStoreError>;
}

const MAX_NAME_CODE_POINTS = 64;
const MAX_NAME_BYTES = 256;
// Control, format (bidi overrides, zero-width), line/paragraph separators: they can disguise a
// name on the approval screen. Lone surrogates (Cs) too, without `isWellFormed`, which Hermes and
// the web build's ES2023 target lack.
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

/** A device name the approval screen can show as-is: 1–64 characters, nothing invisible. */
export const isValidDeviceName = (name: unknown): name is string =>
  typeof name === "string" &&
  name.length > 0 &&
  name === name.trim() &&
  [...name].length <= MAX_NAME_CODE_POINTS &&
  new TextEncoder().encode(name).length <= MAX_NAME_BYTES &&
  !UNSAFE_NAME_CHARS.test(name);

const isConsistent = (device: LedgerDevice): boolean => {
  const key = decodeBase64url(device.publicKey);
  return (
    key !== null &&
    isRelayId(device.deviceId) &&
    isCanonicalDevicePublicKey(device.alg, key) &&
    relayDeviceId(device.alg, key) === device.deviceId &&
    (device.status === "revoked") === (device.revokedAt !== null) &&
    (device.approvedVia === "introduction") === (device.introducedBy !== undefined) &&
    (device.introducedBy === undefined || isRelayId(device.introducedBy))
  );
};

/** Keeps everything in memory; for tests and hosts that persist elsewhere. */
export const makeMemoryLedgerStore = (initial: ReadonlyArray<LedgerDevice> = []): LedgerStore => {
  let devices = initial;
  return {
    load: Effect.sync(() => devices),
    save: (next) =>
      Effect.sync(() => {
        devices = next;
      }),
  };
};

const OWNER_ONLY = 0o600;

/**
 * A JSON file, written atomically (temp file, fsync, rename) and kept owner-only (`0600`),
 * including when an older copy was more open.
 */
export const makeJsonFileLedgerStore = Effect.fn("relay.makeJsonFileLedgerStore")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const platform = yield* HostProcess.Platform;
  const storeError = (detail: string) => () => new LedgerStoreError({ detail });

  const load = Effect.gen(function* () {
    const exists = yield* fs.exists(filePath);
    if (!exists) return [];
    const text = yield* fs.readFileString(filePath);
    const file = yield* decodeLedgerFile(text).pipe(
      Effect.mapError(storeError("The device ledger file is corrupt.")),
    );
    if (!file.devices.every(isConsistent)) {
      return yield* new LedgerStoreError({ detail: "The device ledger file is inconsistent." });
    }
    return file.devices;
  }).pipe(Effect.catchTags({ PlatformError: storeError("The device ledger could not be read.") }));

  const save = Effect.fn("relay.ledgerFile.save")(
    function* (devices: ReadonlyArray<LedgerDevice>) {
      const contents = yield* encodeLedgerFile({ version: 1, devices }).pipe(
        Effect.mapError(storeError("The device ledger could not be encoded.")),
      );
      // The atomic write keeps the replaced file's mode, so narrow it first.
      if (platform !== "win32" && (yield* fs.exists(filePath))) {
        yield* fs.chmod(filePath, OWNER_ONLY);
      }
      yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` });
    },
    Effect.catchTags({ PlatformError: storeError("The device ledger could not be written.") }),
    Effect.provide(context),
  );

  return { load, save } satisfies LedgerStore;
});

export interface AddDeviceInput {
  readonly alg: E2eeDeviceAlgorithm;
  readonly publicKey: Uint8Array;
  readonly name: string;
  readonly now: number;
  readonly approvedVia?: LedgerApprovalRoute | undefined;
  /** Required for, and only for, `approvedVia: "introduction"`. */
  readonly introducedBy?: string | undefined;
}

export interface DeviceLedger {
  readonly list: Effect.Effect<ReadonlyArray<LedgerDevice>, LedgerStoreError>;
  readonly get: (deviceId: string) => Effect.Effect<LedgerDevice | undefined, LedgerStoreError>;
  /**
   * Registers an approved device, always without permissions: only the host's user grants them
   * (`setPermissions`), so an introduced device can never introduce another. A revoked device
   * comes back only through a new approval.
   */
  readonly add: (
    input: AddDeviceInput,
  ) => Effect.Effect<LedgerDevice, DeviceLedgerError | LedgerStoreError>;
  readonly revoke: (
    deviceId: string,
    now: number,
  ) => Effect.Effect<LedgerDevice, DeviceLedgerError | LedgerStoreError>;
  readonly rename: (
    deviceId: string,
    name: string,
  ) => Effect.Effect<LedgerDevice, DeviceLedgerError | LedgerStoreError>;
  /**
   * The host's user grants or withdraws permissions of an active device. An introduced device
   * never gets any.
   */
  readonly setPermissions: (
    deviceId: string,
    permissions: ReadonlyArray<LedgerDevicePermission>,
  ) => Effect.Effect<LedgerDevice, DeviceLedgerError | LedgerStoreError>;
  /** Records a successful connection of an active device. */
  readonly markSeen: (
    deviceId: string,
    now: number,
  ) => Effect.Effect<LedgerDevice, DeviceLedgerError | LedgerStoreError>;
}

export const makeDeviceLedger = Effect.fn("relay.makeDeviceLedger")(function* (store: LedgerStore) {
  const lock = yield* Semaphore.make(1);

  /** Read-modify-write under the lock, so concurrent changes never lose each other. */
  const update = (
    deviceId: string,
    change: (device: LedgerDevice) => LedgerDevice | DeviceLedgerError,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        const devices = yield* store.load;
        const current = devices.find((device) => device.deviceId === deviceId);
        if (current === undefined) {
          return yield* new DeviceLedgerError({ reason: "unknown-device" });
        }
        const next = change(current);
        if (isDeviceLedgerError(next)) return yield* next;
        yield* store.save(devices.map((device) => (device.deviceId === deviceId ? next : device)));
        return next;
      }),
    );

  const add = (input: AddDeviceInput) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (!isCanonicalDevicePublicKey(input.alg, input.publicKey)) {
          return yield* new DeviceLedgerError({ reason: "invalid-key" });
        }
        if (!isValidDeviceName(input.name)) {
          return yield* new DeviceLedgerError({ reason: "invalid-name" });
        }
        const introduced = input.approvedVia === "introduction";
        if (
          introduced !== (input.introducedBy !== undefined) ||
          (input.introducedBy !== undefined && !isRelayId(input.introducedBy))
        ) {
          return yield* new DeviceLedgerError({ reason: "invalid-route" });
        }
        const deviceId = relayDeviceId(input.alg, input.publicKey);
        const devices = yield* store.load;
        const existing = devices.find((device) => device.deviceId === deviceId);
        if (existing?.status === "active") {
          return yield* new DeviceLedgerError({ reason: "already-registered" });
        }
        const device: LedgerDevice = {
          deviceId,
          alg: input.alg,
          publicKey: encodeBase64url(input.publicKey),
          name: input.name,
          createdAt: input.now,
          lastSeenAt: null,
          status: "active",
          revokedAt: null,
          permissions: [],
          ...(input.approvedVia === undefined ? {} : { approvedVia: input.approvedVia }),
          ...(input.introducedBy === undefined ? {} : { introducedBy: input.introducedBy }),
        };
        yield* store.save([...devices.filter((entry) => entry.deviceId !== deviceId), device]);
        return device;
      }),
    );

  return {
    list: store.load,
    get: (deviceId) =>
      Effect.map(store.load, (devices) => devices.find((device) => device.deviceId === deviceId)),
    add,
    revoke: (deviceId, now) =>
      update(deviceId, (device) =>
        device.status === "revoked" ? device : { ...device, status: "revoked", revokedAt: now },
      ),
    rename: (deviceId, name) =>
      update(deviceId, (device) =>
        isValidDeviceName(name)
          ? { ...device, name }
          : new DeviceLedgerError({ reason: "invalid-name" }),
      ),
    setPermissions: (deviceId, permissions) =>
      update(deviceId, (device) => {
        if (device.status !== "active") return new DeviceLedgerError({ reason: "unknown-device" });
        // Introductions do not chain, whoever asks (spec §18.2).
        if (device.approvedVia === "introduction" && permissions.length > 0) {
          return new DeviceLedgerError({ reason: "introduced-device" });
        }
        return { ...device, permissions: [...new Set(permissions)] };
      }),
    markSeen: (deviceId, now) =>
      update(deviceId, (device) =>
        device.status === "active"
          ? { ...device, lastSeenAt: Math.max(device.lastSeenAt ?? 0, now) }
          : new DeviceLedgerError({ reason: "unknown-device" }),
      ),
  } satisfies DeviceLedger;
});

/**
 * `verifyDevice` for the E2EE v2 server: unknown keys are `unknown-device`, revoked ones
 * `revoked`. The id is recomputed from the key in the relay's encoding, never taken from the
 * identity, and the stored key must match byte for byte. A ledger that cannot be read refuses.
 */
export const ledgerVerifyDevice =
  (ledger: Pick<DeviceLedger, "get">) =>
  (identity: E2eeDeviceIdentity): Effect.Effect<void, E2eeRejectedError> =>
    Effect.gen(function* () {
      const device = yield* ledger.get(relayDeviceId(identity.alg, identity.publicKey));
      if (device === undefined) {
        return yield* new E2eeRejectedError({ reason: "unknown-device" });
      }
      if (device.status === "revoked") return yield* new E2eeRejectedError({ reason: "revoked" });
      const stored = decodeBase64url(device.publicKey);
      if (
        device.alg !== identity.alg ||
        stored === null ||
        !timingSafeEqual(stored, identity.publicKey)
      ) {
        return yield* new E2eeRejectedError({ reason: "key-mismatch" });
      }
    }).pipe(
      Effect.catchTags({
        LedgerStoreError: (error) =>
          Effect.logWarning("Device ledger unavailable; refusing the device.", error).pipe(
            Effect.andThen(Effect.fail(new E2eeRejectedError({ reason: "host-policy" }))),
          ),
      }),
    );
