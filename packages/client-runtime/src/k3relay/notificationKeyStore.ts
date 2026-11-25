import {
  hpkeGenerateKeyPair,
  hpkePublicKey,
  makeNotifyReplayGuard,
  notifyEnvelopeKeyId,
  notifyKeyId,
  type NotifyOpenFailure,
  type NotifyPayload,
  openNotification,
} from "@t3tools/shared/notify";
import { decodeBase64url, encodeBase64url } from "@t3tools/shared/relay";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Where a device keeps its notification keys `Nk` (spec §13): one X25519 key per host, apart
 * from the identity key `Dk`. The secret is written where the platform's notification code can
 * read it too (iOS: the keychain group the Notification Service Extension shares; Android: the
 * native store the messaging service reads), so it is opened even while the app is not running.
 */

export class NotificationKeyStoreError extends Schema.TaggedError<NotificationKeyStoreError>()(
  "NotificationKeyStoreError",
  {
    operation: Schema.Literals(["create", "load", "remove"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** What a device needs to show an opened notification: the host it came from. */
export interface NotificationKeyContext {
  readonly hostId: string;
  readonly environmentId: string;
  /** The host's name as the device saw it at pairing. Local only, never sent anywhere. */
  readonly hostLabel: string | null;
}

export type OpenedNotification =
  | {
      readonly ok: true;
      readonly payload: NotifyPayload;
      readonly context: NotificationKeyContext;
    }
  | { readonly ok: false; readonly reason: NotifyOpenFailure | "wrong-environment" };

export class NotificationKeyStore extends Context.Service<
  NotificationKeyStore,
  {
    /** This host's key, created on first use. Returns only the public half. */
    readonly ensure: (
      context: NotificationKeyContext,
    ) => Effect.Effect<
      { readonly publicKey: Uint8Array; readonly keyId: string },
      NotificationKeyStoreError
    >;
    readonly remove: (hostId: string) => Effect.Effect<void, NotificationKeyStoreError>;
    /** Opens an envelope with whichever stored key it names; drops replays and stale ones. */
    readonly open: (envelope: Uint8Array) => Effect.Effect<OpenedNotification>;
  }
>()("@t3tools/client-runtime/k3relay/notificationKeyStore") {}

/** The platform's secret storage. Names are `k3relay.notify.<keyId>` and `k3relay.notify.host.<hostId>`. */
export interface NotificationSecretVault {
  readonly read: (name: string) => Effect.Effect<Option.Option<string>, NotificationKeyStoreError>;
  readonly write: (name: string, value: string) => Effect.Effect<void, NotificationKeyStoreError>;
  readonly remove: (name: string) => Effect.Effect<void, NotificationKeyStoreError>;
}

/** The record the native code reads as well; keep the field names stable. */
const KeyRecord = Schema.fromJsonString(
  Schema.Struct({
    v: Schema.Literal(1),
    sk: Schema.String,
    /** The public half; the Android service needs it for the HPKE context. */
    pk: Schema.String,
    hostId: Schema.String,
    env: Schema.String,
    label: Schema.NullOr(Schema.String),
  }),
);
const encodeKeyRecord = Schema.encodeSync(KeyRecord);
const decodeKeyRecord = Schema.decodeUnknownOption(KeyRecord);

export const notificationKeyName = (keyId: string) => `k3relay.notify.${keyId}`;
export const notificationHostName = (hostId: string) => `k3relay.notify.host.${hostId}`;

export const makeNotificationKeyStore = (vault: NotificationSecretVault) => {
  const replay = makeNotifyReplayGuard();

  const readRecord = (keyId: string) =>
    vault
      .read(notificationKeyName(keyId))
      .pipe(
        Effect.map((stored) =>
          Option.flatMap(stored, (value) => decodeKeyRecord(value)).pipe(Option.getOrNull),
        ),
      );

  const ensure = Effect.fn("NotificationKeyStore.ensure")(function* (
    context: NotificationKeyContext,
  ) {
    const existing = yield* vault.read(notificationHostName(context.hostId));
    if (Option.isSome(existing)) {
      const record = yield* readRecord(existing.value);
      const secretKey = record === null ? null : decodeBase64url(record.sk, 32);
      if (record !== null && secretKey !== null && record.env === context.environmentId) {
        if (record.label !== context.hostLabel) {
          yield* vault.write(
            notificationKeyName(existing.value),
            encodeKeyRecord({ ...record, label: context.hostLabel }),
          );
        }
        const publicKey = hpkePublicKey(secretKey);
        return { publicKey, keyId: notifyKeyId(publicKey) };
      }
    }
    const { secretKey, publicKey } = hpkeGenerateKeyPair();
    const keyId = notifyKeyId(publicKey);
    yield* vault.write(
      notificationKeyName(keyId),
      encodeKeyRecord({
        v: 1,
        sk: encodeBase64url(secretKey),
        pk: encodeBase64url(publicKey),
        hostId: context.hostId,
        env: context.environmentId,
        label: context.hostLabel,
      }),
    );
    yield* vault.write(notificationHostName(context.hostId), keyId);
    if (Option.isSome(existing) && existing.value !== keyId) {
      yield* vault.remove(notificationKeyName(existing.value));
    }
    return { publicKey, keyId };
  });

  const remove = Effect.fn("NotificationKeyStore.remove")(function* (hostId: string) {
    const existing = yield* vault.read(notificationHostName(hostId));
    if (Option.isNone(existing)) return;
    yield* vault.remove(notificationKeyName(existing.value));
    yield* vault.remove(notificationHostName(hostId));
  });

  const open = Effect.fn("NotificationKeyStore.open")(function* (envelope: Uint8Array) {
    const keyId = notifyEnvelopeKeyId(envelope);
    if (keyId === null) return { ok: false, reason: "malformed" } as const;
    const record = yield* readRecord(keyId).pipe(Effect.orElseSucceed(() => null));
    const secretKey = record === null ? null : decodeBase64url(record.sk, 32);
    if (record === null || secretKey === null) return { ok: false, reason: "unknown-key" } as const;
    const opened = openNotification({
      envelope,
      secretKeyFor: (id) => (id === keyId ? secretKey : undefined),
      now: yield* Clock.currentTimeMillis,
      replay,
    });
    if (!opened.ok) return opened;
    // A host can only seal to its own key, but the payload names the environment as well.
    if (opened.payload.env !== record.env)
      return { ok: false, reason: "wrong-environment" } as const;
    return {
      ok: true,
      payload: opened.payload,
      context: { hostId: record.hostId, environmentId: record.env, hostLabel: record.label },
    } as const;
  });

  return NotificationKeyStore.of({ ensure, remove, open });
};

export const makeMemoryNotificationSecretVault = (): NotificationSecretVault & {
  readonly secrets: Map<string, string>;
} => {
  const secrets = new Map<string, string>();
  return {
    secrets,
    read: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    write: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  };
};

export const layerMemoryNotificationKeyStore = () =>
  Layer.sync(NotificationKeyStore, () =>
    makeNotificationKeyStore(makeMemoryNotificationSecretVault()),
  );
