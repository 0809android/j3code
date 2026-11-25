import {
  K3RelayNotificationSource,
  NotificationKeyStore,
  NotificationKeyStoreError,
  type NotificationSecretVault,
  type OpenedNotification,
  makeNotificationKeyStore,
} from "@t3tools/client-runtime/k3relay";
import { decodeBase64url } from "@t3tools/shared/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import * as MobilePreferences from "../../persistence/mobile-preferences";
import { supportsAgentAwarenessPush } from "./capabilities";
import { resolveApsEnvironment } from "./registrationPayload";

/**
 * K3 relay notifications on this device (spec §13): where each host's notification key `Nk`
 * lives, and what the relay broker registers after a relay connection opens. iOS keeps the key in
 * the app's first keychain group, which the Notification Service Extension shares; Android also
 * hands it to the native messaging service, which keeps it wrapped by an Android Keystore key.
 */

const keychainOptions = {
  keychainService: "k3relay.notify",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
} satisfies SecureStore.SecureStoreOptions;

interface AndroidRelayNotify {
  setRelayNotifyKey?(name: string, value: string, scheme: string): void;
  removeRelayNotifyKey?(name: string): void;
}

const androidNative =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidRelayNotify>("T3AgentNotifications")
    : null;

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "k3code";
}

const vaultError = (operation: NotificationKeyStoreError["operation"]) => () =>
  new NotificationKeyStoreError({ operation, detail: "The notification keychain is unavailable." });

const vault: NotificationSecretVault = {
  read: (name) =>
    Effect.tryPromise({
      try: () => SecureStore.getItemAsync(name, keychainOptions),
      catch: vaultError("load"),
    }).pipe(Effect.map(Option.fromNullishOr)),
  write: (name, value) =>
    Effect.tryPromise({
      try: async () => {
        await SecureStore.setItemAsync(name, value, keychainOptions);
        androidNative?.setRelayNotifyKey?.(name, value, appScheme());
      },
      catch: vaultError("create"),
    }),
  remove: (name) =>
    Effect.tryPromise({
      try: async () => {
        await SecureStore.deleteItemAsync(name, keychainOptions);
        androidNative?.removeRelayNotifyKey?.(name);
      },
      catch: vaultError("remove"),
    }),
};

/** One store for the app: the relay broker registers with it, and taps open envelopes with it. */
export const mobileNotificationKeyStore = makeNotificationKeyStore(vault);

export const DEFAULT_K3_RELAY_NOTIFICATIONS: MobilePreferences.K3RelayNotificationPreferences = {
  enabled: false,
  approval: true,
  input: true,
  completed: true,
  failed: true,
};

const pushPlatform = () =>
  Platform.OS === "android"
    ? ("android" as const)
    : resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant) === "sandbox"
      ? ("ios-sandbox" as const)
      : ("ios" as const);

const devicePushToken = Effect.tryPromise({
  try: async () => {
    const permissions = await Notifications.getPermissionsAsync();
    if (!permissions.granted) return null;
    const token = await Notifications.getDevicePushTokenAsync();
    return token.type === Platform.OS && typeof token.data === "string" && token.data.length > 0
      ? token.data
      : null;
  },
  catch: () => null,
}).pipe(Effect.orElseSucceed(() => null));

const layerSource = Layer.effect(
  K3RelayNotificationSource,
  Effect.gen(function* () {
    const preferences = yield* MobilePreferences.MobilePreferencesStore;
    return K3RelayNotificationSource.of({
      current: Effect.gen(function* () {
        if (!supportsAgentAwarenessPush()) return null;
        const stored = yield* preferences.load.pipe(Effect.orElseSucceed(() => ({})));
        const choice =
          (stored as MobilePreferences.Preferences).k3relayNotifications ??
          DEFAULT_K3_RELAY_NOTIFICATIONS;
        if (!choice.enabled) return null;
        const token = yield* devicePushToken;
        return {
          kinds: {
            approval: choice.approval,
            input: choice.input,
            completed: choice.completed,
            failed: choice.failed,
          },
          push: token === null ? null : { platform: pushPlatform(), token },
        };
      }),
    });
  }),
);

export const layer = Layer.merge(
  Layer.succeed(NotificationKeyStore, mobileNotificationKeyStore),
  layerSource,
);

/**
 * A tap on a notification the extension could not open (iOS keeps the envelope in `k3` then):
 * the app opens it itself, so the tap still lands on the thread.
 */
export const openK3RelayNotificationData = (
  data: Record<string, unknown> | null,
): Promise<OpenedNotification | null> => {
  const envelope = data === null ? null : decodeBase64url(data.k3);
  if (envelope === null) return Promise.resolve(null);
  return Effect.runPromise(mobileNotificationKeyStore.open(envelope));
};
