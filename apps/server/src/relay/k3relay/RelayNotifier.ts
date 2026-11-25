import {
  type K3RelayNotifyKinds,
  K3RelayNotifyKinds as K3RelayNotifyKindsSchema,
  type K3RelayNotifyRegistration,
  type K3RelayNotifyStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type NotifyKind,
  newNotifyId,
  notifyKeyId,
  sealNotification,
} from "@t3tools/shared/notify";
import {
  decodeBase64url,
  encodeBase64url,
  relayHostId,
  relaySigningInput,
} from "@t3tools/shared/relay";

import * as ServerE2eeIdentity from "../../auth/ServerE2eeIdentity.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ManagedLimits from "../../policy/managedLimits.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import { relayEndpoints, signWithHostSeed } from "./hostRegistration.ts";
import * as RelayDeviceLedger from "./RelayDeviceLedger.ts";
import { relayStateDirectory } from "./RelayDeviceLedger.ts";

const PUSH_SEND_LABEL = "k3relay-v1/push-send";
const SEND_TIMEOUT = "10 seconds";
const TEST_MIN_INTERVAL_MS = 10_000;
const OWNER_ONLY = 0o600;

const RegisteredDevice = Schema.Struct({
  deviceId: Schema.String,
  publicKey: Schema.String,
  kinds: K3RelayNotifyKindsSchema,
  updatedAt: Schema.Number,
});
type RegisteredDevice = typeof RegisteredDevice.Type;

const NotifyFile = Schema.Struct({
  version: Schema.Literal(1),
  devices: Schema.Array(RegisteredDevice),
});
const decodeNotifyFile = Schema.decodeUnknownEffect(Schema.fromJsonString(NotifyFile));
const encodeNotifyFile = Schema.encodeEffect(Schema.fromJsonString(NotifyFile));

export class RelayNotifyError extends Schema.TaggedError<RelayNotifyError>()("RelayNotifyError", {
  reason: Schema.Literals(["invalid-key", "inactive-device", "too-many-requests", "storage"]),
}) {
  override get message(): string {
    return `K3 relay notification registration failed: ${this.reason}.`;
  }
}

/** What a sent notification came to at the relay. Logged by kind only, never with content. */
export type RelayNotifyDelivery =
  | "sent"
  | "relay-disabled"
  | "notifications-off"
  | "not-registered"
  | "kind-off"
  | "inactive-device"
  | "no-target"
  | "gone"
  | "failed";

const kindAllowed = (kinds: K3RelayNotifyKinds, kind: NotifyKind): boolean =>
  kind === "test" ? true : kinds[kind];

/**
 * End-to-end encrypted notifications through the K3 relay (spec §13). Devices register their
 * notification key `Nk` here, inside the E2E channel; the host seals each notification to each
 * device's key and hands the envelope to the relay, signed with `Hk`. The relay and APNs / FCM
 * see only the envelope. Nothing happens while the relay or relay notifications are off.
 */
export class RelayNotifier extends Context.Service<
  RelayNotifier,
  {
    readonly register: (
      deviceId: string,
      registration: K3RelayNotifyRegistration,
    ) => Effect.Effect<K3RelayNotifyStatus, RelayNotifyError>;
    readonly status: (deviceId: string) => Effect.Effect<K3RelayNotifyStatus>;
    readonly unregister: (deviceId: string) => Effect.Effect<void>;
    readonly registeredDeviceIds: Effect.Effect<ReadonlySet<string>>;
    /** Seals one notification for every active device that wants this kind, and sends them. */
    readonly notify: (input: {
      readonly kind: Exclude<NotifyKind, "test">;
      readonly threadId: string;
    }) => Effect.Effect<ReadonlyArray<RelayNotifyDelivery>>;
    /** A test notification to the asking device only. */
    readonly sendTest: (deviceId: string) => Effect.Effect<RelayNotifyDelivery, RelayNotifyError>;
  }
>()("t3/relay/k3relay/RelayNotifier") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const identity = yield* ServerE2eeIdentity.ServerE2eeIdentity;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const ledger = yield* RelayDeviceLedger.RelayDeviceLedger;
  const http = yield* HttpClient.HttpClient;
  const platform = yield* HostProcess.Platform;
  const fileContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const policyAllowed = ManagedLimits.allowsRelay(managedPolicy);
  const filePath = path.join(relayStateDirectory(config.stateDir, path), "notify.json");
  const lock = yield* Semaphore.make(1);
  const lastTest = new Map<string, number>();

  const load = Effect.gen(function* () {
    if (!(yield* fs.exists(filePath))) return new Map<string, RegisteredDevice>();
    const file = yield* decodeNotifyFile(yield* fs.readFileString(filePath));
    return new Map(file.devices.map((device) => [device.deviceId, device]));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not read K3 relay notification registrations", cause).pipe(
        Effect.as(new Map<string, RegisteredDevice>()),
      ),
    ),
  );
  const devices = yield* load;

  const save = Effect.gen(function* () {
    const contents = yield* encodeNotifyFile({ version: 1, devices: [...devices.values()] });
    if (platform !== "win32" && (yield* fs.exists(filePath))) yield* fs.chmod(filePath, OWNER_ONLY);
    yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` });
  }).pipe(
    Effect.provide(fileContext),
    Effect.mapError(() => new RelayNotifyError({ reason: "storage" })),
  );

  const hostEnabled = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => policyAllowed && settings.relay.enabled && settings.relay.notifications,
    ),
    Effect.orElseSucceed(() => false),
  );

  const statusOf = (device: RegisteredDevice | undefined) =>
    Effect.map(hostEnabled, (enabled) => ({
      registered: device !== undefined,
      keyId: device === undefined ? null : notifyKeyId(decodeBase64url(device.publicKey, 32)!),
      kinds: device?.kinds ?? null,
      hostEnabled: enabled,
    }));

  const isActive = (deviceId: string) =>
    ledger.get(deviceId).pipe(
      Effect.map((device) => device?.status === "active"),
      Effect.orElseSucceed(() => false),
    );

  const register = Effect.fn("RelayNotifier.register")(function* (
    deviceId: string,
    registration: K3RelayNotifyRegistration,
  ) {
    const publicKey = decodeBase64url(registration.publicKey, 32);
    // notifyKeyId refuses keys of the wrong length; a low-order key fails at the first seal.
    if (publicKey === null) return yield* new RelayNotifyError({ reason: "invalid-key" });
    if (!(yield* isActive(deviceId))) {
      return yield* new RelayNotifyError({ reason: "inactive-device" });
    }
    const next: RegisteredDevice = {
      deviceId,
      publicKey: encodeBase64url(publicKey),
      kinds: registration.kinds,
      updatedAt: yield* Clock.currentTimeMillis,
    };
    yield* lock.withPermit(
      Effect.suspend(() => {
        devices.set(deviceId, next);
        return save;
      }),
    );
    return yield* statusOf(next);
  });

  const unregister = (deviceId: string) =>
    lock.withPermit(
      Effect.suspend(() => (devices.delete(deviceId) ? Effect.ignore(save) : Effect.void)),
    );

  /** One envelope to one device, signed by `Hk`. */
  const deliver = Effect.fn("RelayNotifier.deliver")(function* (
    device: RegisteredDevice,
    kind: NotifyKind,
    threadId: string | undefined,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null || !policyAllowed || !settings.relay.enabled) {
      return "relay-disabled" as const;
    }
    if (!settings.relay.notifications) return "notifications-off" as const;
    if (!kindAllowed(device.kinds, kind)) return "kind-off" as const;
    if (!(yield* isActive(device.deviceId))) return "inactive-device" as const;
    const endpoints = relayEndpoints(settings.relay.url);
    const publicKey = decodeBase64url(device.publicKey, 32);
    if (endpoints === null || publicKey === null) return "failed" as const;
    const now = yield* Clock.currentTimeMillis;
    const envelope = yield* Effect.try({
      try: () =>
        sealNotification({
          recipientPublicKey: publicKey,
          payload: {
            v: 1,
            id: newNotifyId(),
            ts: now,
            kind,
            env: environmentId,
            ...(threadId === undefined ? {} : { thread: threadId }),
          },
        }),
      catch: () => "seal-failed" as const,
    }).pipe(Effect.orElseSucceed(() => null));
    if (envelope === null) return "failed" as const;
    const keypair = yield* identity.getKeypair.pipe(Effect.orElseSucceed(() => null));
    if (keypair === null) return "failed" as const;
    const hostId = relayHostId(keypair.publicKey);
    const nonce = newNotifyId();
    const sig = signWithHostSeed(
      keypair.seed,
      relaySigningInput(PUSH_SEND_LABEL, hostId, device.deviceId, String(now), nonce, envelope),
    );
    const response = yield* http
      .execute(
        HttpClientRequest.post(`${endpoints.http}/v1/push/send`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            hostId,
            deviceId: device.deviceId,
            ts: now,
            nonce,
            envelope: encodeBase64url(envelope),
            sig: encodeBase64url(sig),
          }),
        ),
      )
      .pipe(
        Effect.timeout(SEND_TIMEOUT),
        Effect.orElseSucceed(() => null),
      );
    if (response === null) return "failed" as const;
    if (response.status === 200) return "sent" as const;
    if (response.status === 404) return "no-target" as const;
    if (response.status === 410) return "gone" as const;
    return "failed" as const;
  });

  const environmentId = yield* environment.getEnvironmentId;

  const notify: RelayNotifier["Service"]["notify"] = Effect.fn("RelayNotifier.notify")(
    function* (input) {
      if (!(yield* hostEnabled)) return [];
      const targets = [...devices.values()];
      const results = yield* Effect.forEach(
        targets,
        (device) => deliver(device, input.kind, input.threadId),
        { concurrency: 4 },
      );
      yield* Effect.logDebug("K3 relay notifications", { kind: input.kind, results });
      return results;
    },
  );

  const sendTest = Effect.fn("RelayNotifier.sendTest")(function* (deviceId: string) {
    const now = yield* Clock.currentTimeMillis;
    const last = lastTest.get(deviceId);
    if (last !== undefined && now - last < TEST_MIN_INTERVAL_MS) {
      return yield* new RelayNotifyError({ reason: "too-many-requests" });
    }
    lastTest.set(deviceId, now);
    const device = devices.get(deviceId);
    if (device === undefined) return "not-registered" as const;
    return yield* deliver(device, "test", undefined);
  });

  return RelayNotifier.of({
    register,
    status: Effect.fn("RelayNotifier.status")(function* (deviceId: string) {
      return yield* statusOf(devices.get(deviceId));
    }),
    unregister,
    registeredDeviceIds: Effect.sync(() => new Set(devices.keys())),
    notify,
    sendTest,
  });
});

export const layer = Layer.effect(RelayNotifier, make).pipe(Layer.provide(RelayDeviceLedger.layer));
