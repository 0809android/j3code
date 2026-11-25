import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type K3RelayHostApi,
  K3RelayHostApiError,
  type K3RelayHostDevice,
  type K3RelayHostState,
  type K3RelayPendingDevice,
} from "./relayHostContract.ts";

export const DEFAULT_K3_RELAY_URL = "https://relay.k3.kinocode.jp/";

export const initialFakeHostState: K3RelayHostState = {
  enabled: false,
  relayUrl: DEFAULT_K3_RELAY_URL,
  status: "disabled",
  statusDetail: null,
  allowedByPolicy: true,
  networkAccessEnabled: false,
  offer: null,
  pending: null,
  devices: [],
};

export interface FakeK3RelayHostApi extends K3RelayHostApi {
  readonly ref: SubscriptionRef.SubscriptionRef<K3RelayHostState>;
  /** What a device's verified claim does on the host: it waits for approval. */
  readonly simulateClaim: (pending: K3RelayPendingDevice) => Effect.Effect<void>;
}

/** An in-memory host for tests and for building the settings screen before the host exists. */
export const makeFakeK3RelayHostApi = Effect.fn("K3RelayFakeHostApi.make")(function* (
  initial: Partial<K3RelayHostState> = {},
  options: { readonly now?: () => number } = {},
) {
  const clock = yield* Clock.Clock;
  const now = options.now ?? (() => clock.currentTimeMillisUnsafe());
  const ref = yield* SubscriptionRef.make<K3RelayHostState>({
    ...initialFakeHostState,
    ...initial,
  });
  const update = (f: (state: K3RelayHostState) => K3RelayHostState) =>
    SubscriptionRef.update(ref, f);
  const requireEnabled = Effect.flatMap(SubscriptionRef.get(ref), (state) =>
    state.enabled
      ? Effect.void
      : Effect.fail(new K3RelayHostApiError({ detail: "The relay is turned off." })),
  );
  const requirePending = (deviceId: string) =>
    Effect.flatMap(SubscriptionRef.get(ref), (state) =>
      state.pending?.deviceId === deviceId
        ? Effect.succeed(state.pending)
        : Effect.fail(new K3RelayHostApiError({ detail: "No device is waiting for approval." })),
    );
  const requireDevice = (deviceId: string) =>
    Effect.flatMap(SubscriptionRef.get(ref), (state) =>
      state.devices.some((device) => device.deviceId === deviceId)
        ? Effect.void
        : Effect.fail(new K3RelayHostApiError({ detail: "Unknown device." })),
    );
  const mapDevice = (deviceId: string, f: (device: K3RelayHostDevice) => K3RelayHostDevice) =>
    update((state) => ({
      ...state,
      devices: state.devices.map((device) => (device.deviceId === deviceId ? f(device) : device)),
    }));

  const api: FakeK3RelayHostApi = {
    ref,
    state: SubscriptionRef.changes(ref),
    setEnabled: (enabled) =>
      update((state) => ({
        ...state,
        enabled: enabled && state.allowedByPolicy,
        status: enabled && state.allowedByPolicy ? "online" : "disabled",
        offer: enabled ? state.offer : null,
        pending: enabled ? state.pending : null,
      })),
    setRelayUrl: (relayUrl) =>
      Effect.flatMap(
        Effect.try({
          try: () => new URL(relayUrl).href,
          catch: () => new K3RelayHostApiError({ detail: "The relay URL is invalid." }),
        }),
        (href) => update((state) => ({ ...state, relayUrl: href })),
      ),
    createOffer: Effect.gen(function* () {
      yield* requireEnabled;
      const offer = {
        link: `k3relay://pair?v=1&relay=fake&host=fake&hk=fake&exp=${now() + 300_000}#s=fake`,
        expiresAt: now() + 300_000,
      };
      yield* update((state) => ({ ...state, offer, pending: null }));
      return offer;
    }),
    cancelOffer: update((state) => ({ ...state, offer: null, pending: null })),
    approve: Effect.fn("K3RelayFakeHostApi.approve")(function* (deviceId) {
      const pending = yield* requirePending(deviceId);
      yield* update((state) => ({
        ...state,
        offer: null,
        pending: null,
        devices: [
          ...state.devices.filter((device) => device.deviceId !== deviceId),
          {
            deviceId,
            name: pending.name,
            alg: pending.alg,
            approvedAt: now(),
            revokedAt: null,
            lastSeenAt: null,
          },
        ],
      }));
    }),
    reject: (deviceId) =>
      Effect.flatMap(requirePending(deviceId), () =>
        update((state) => ({ ...state, offer: null, pending: null })),
      ),
    revokeDevice: (deviceId) =>
      Effect.flatMap(requireDevice(deviceId), () =>
        mapDevice(deviceId, (device) => ({ ...device, revokedAt: device.revokedAt ?? now() })),
      ),
    renameDevice: Effect.fn("K3RelayFakeHostApi.renameDevice")(function* (deviceId, name) {
      yield* requireDevice(deviceId);
      const trimmed = name.trim();
      if (trimmed.length === 0 || trimmed.length > 64) {
        return yield* new K3RelayHostApiError({ detail: "The device name is invalid." });
      }
      yield* mapDevice(deviceId, (device) => ({ ...device, name: trimmed }));
    }),
    simulateClaim: (pending) => update((state) => ({ ...state, pending })),
  };
  return api;
});
