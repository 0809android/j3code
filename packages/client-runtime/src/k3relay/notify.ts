import {
  K3_RELAY_NOTIFY_PATH,
  K3_RELAY_PROVISIONAL_ORIGIN,
  type K3RelayNotifyKinds,
  K3RelayNotifyStatus,
} from "@t3tools/contracts";
import {
  type RelayGrant,
  decodeBase64url,
  encodeBase64url,
  relaySigningInput,
} from "@t3tools/shared/relay";
import { type E2eeDeviceSigner, deviceIdFromPublicKey } from "@t3tools/shared/socketE2ee";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ConnectionTransport } from "../connection/model.ts";
import { NotificationKeyStore, type OpenedNotification } from "./notificationKeyStore.ts";
import type { K3RelayTunnelInput } from "./tunnel.ts";
import { k3relayEndpointUrl } from "./status.ts";

/**
 * A device's half of K3 relay notifications (spec §13). The notification key goes to the host,
 * inside the E2E channel; the push token goes to the relay, signed with `Dk`. Neither party gets
 * both, so the relay cannot read a notification and the host never learns the push token.
 */

export const PUSH_REGISTER_LABEL = "k3relay-v1/push-register";
export const PUSH_REMOVE_LABEL = "k3relay-v1/push-remove";
const RELAY_TIMEOUT_MS = 8_000;

export type K3RelayPushPlatform = "ios" | "ios-sandbox" | "android";

export const DEFAULT_NOTIFY_KINDS: K3RelayNotifyKinds = {
  approval: true,
  input: true,
  completed: true,
  failed: true,
};

export class K3RelayNotifyError extends Schema.TaggedError<K3RelayNotifyError>()(
  "K3RelayNotifyError",
  {
    reason: Schema.Literals([
      "unreachable",
      "unsupported",
      "revoked",
      "grant-expired",
      "unauthorized",
      "rate-limited",
      "unavailable",
      "rejected",
    ]),
  },
) {
  override get message(): string {
    return `K3 relay notifications: ${this.reason}.`;
  }
}

const decodeStatus = Schema.decodeUnknownOption(K3RelayNotifyStatus);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const hostCall = Effect.fn("K3RelayNotify.hostCall")(function* (
  transport: ConnectionTransport,
  method: "GET" | "PUT" | "DELETE" | "POST",
  path: string,
  body?: unknown,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      transport.fetch(`${K3_RELAY_PROVISIONAL_ORIGIN}${path}`, {
        method,
        signal,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: encodeJson(body) }),
      }),
    catch: () => new K3RelayNotifyError({ reason: "unreachable" }),
  });
  const json: unknown = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
  // An older host answers its own 404 from the relayed router.
  if (response.status === 404 || response.status === 405) {
    return yield* new K3RelayNotifyError({ reason: "unsupported" });
  }
  if (response.status === 429) return yield* new K3RelayNotifyError({ reason: "rate-limited" });
  if (response.status === 403) return yield* new K3RelayNotifyError({ reason: "revoked" });
  if (response.status !== 200) return yield* new K3RelayNotifyError({ reason: "rejected" });
  return json;
});

const statusFrom = (json: unknown) =>
  Effect.fromOption(decodeStatus(json)).pipe(
    Effect.mapError(() => new K3RelayNotifyError({ reason: "rejected" })),
  );

/** Gives the host this device's notification key and kinds, through the relay tunnel. */
export const registerK3RelayNotificationKey = (
  transport: ConnectionTransport,
  input: { readonly publicKey: Uint8Array; readonly kinds: K3RelayNotifyKinds },
) =>
  hostCall(transport, "PUT", K3_RELAY_NOTIFY_PATH, {
    publicKey: encodeBase64url(input.publicKey),
    kinds: input.kinds,
  }).pipe(Effect.flatMap(statusFrom));

export const readK3RelayNotificationStatus = (transport: ConnectionTransport) =>
  hostCall(transport, "GET", K3_RELAY_NOTIFY_PATH).pipe(Effect.flatMap(statusFrom));

export const unregisterK3RelayNotificationKey = (transport: ConnectionTransport) =>
  hostCall(transport, "DELETE", K3_RELAY_NOTIFY_PATH).pipe(Effect.flatMap(statusFrom));

/** Asks the host for one test notification to this device. */
export const sendK3RelayTestNotification = (transport: ConnectionTransport) =>
  hostCall(transport, "POST", `${K3_RELAY_NOTIFY_PATH}/test`).pipe(
    Effect.map((json) =>
      typeof json === "object" && json !== null
        ? String((json as { readonly delivery?: unknown }).delivery ?? "failed")
        : "failed",
    ),
  );

const relayCall = Effect.fn("K3RelayNotify.relayCall")(function* (input: {
  readonly relayUrl: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const doFetch = input.fetch ?? globalThis.fetch;
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      doFetch(k3relayEndpointUrl(input.relayUrl, input.path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodeJson(input.body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(RELAY_TIMEOUT_MS)]),
        redirect: "error",
        cache: "no-store",
      }),
    catch: () => new K3RelayNotifyError({ reason: "unreachable" }),
  });
  const json: unknown = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
  const error =
    typeof json === "object" && json !== null ? (json as { readonly error?: unknown }).error : null;
  if (response.status === 200) return;
  if (response.status === 404) return yield* new K3RelayNotifyError({ reason: "unsupported" });
  if (response.status === 503) return yield* new K3RelayNotifyError({ reason: "unavailable" });
  if (response.status === 429) return yield* new K3RelayNotifyError({ reason: "rate-limited" });
  if (response.status === 401) return yield* new K3RelayNotifyError({ reason: "unauthorized" });
  if (response.status === 403) {
    return yield* new K3RelayNotifyError({
      reason: error === "grant-expired" ? "grant-expired" : "revoked",
    });
  }
  return yield* new K3RelayNotifyError({ reason: "rejected" });
});

/** Registers (or, with `token: null`, removes) this device's push token for one host. */
export const registerK3RelayPushToken = Effect.fn("K3RelayNotify.registerPushToken")(
  function* (input: {
    readonly relayUrl: string;
    readonly hostId: string;
    readonly signer: E2eeDeviceSigner;
    readonly grant: RelayGrant;
    readonly push: { readonly platform: K3RelayPushPlatform; readonly token: string } | null;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    const random = yield* SecureRandom.SecureRandom;
    const ts = yield* Clock.currentTimeMillis;
    const nonce = encodeBase64url(Uint8Array.from(yield* random.randomBytes(16)));
    const deviceId = deviceIdFromPublicKey(input.signer.alg, input.signer.publicKey);
    const message =
      input.push === null
        ? relaySigningInput(PUSH_REMOVE_LABEL, input.hostId, deviceId, String(ts), nonce)
        : relaySigningInput(
            PUSH_REGISTER_LABEL,
            input.hostId,
            deviceId,
            String(ts),
            nonce,
            input.push.platform,
            input.push.token,
          );
    const sig = yield* input.signer
      .sign(message)
      .pipe(Effect.mapError(() => new K3RelayNotifyError({ reason: "unauthorized" })));
    yield* relayCall({
      relayUrl: input.relayUrl,
      path: `/v1/client/${input.hostId}/push${input.push === null ? "/remove" : ""}`,
      body: {
        alg: input.signer.alg,
        dk: encodeBase64url(input.signer.publicKey),
        grant: input.grant,
        ts,
        nonce,
        ...(input.push === null ? {} : { platform: input.push.platform, token: input.push.token }),
        sig: encodeBase64url(sig),
      },
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
  },
);

/** Opens the `k3` field of a received push (APNs payload or FCM data) with the stored keys. */
export const openK3RelayPush = Effect.fn("K3RelayNotify.openPush")(function* (envelope: unknown) {
  const bytes = decodeBase64url(envelope);
  if (bytes === null) return { ok: false, reason: "malformed" } satisfies OpenedNotification;
  const store = yield* NotificationKeyStore;
  return yield* store.open(bytes);
});

/** What this device wants from relay notifications right now; `null` when they are off here. */
export interface K3RelayNotificationChoice {
  readonly kinds: K3RelayNotifyKinds;
  /** `null` until the platform hands out a push token (permission not granted yet). */
  readonly push: { readonly platform: K3RelayPushPlatform; readonly token: string } | null;
}

/** Provided by apps that can receive pushes (mobile). Without it, nothing is registered. */
export class K3RelayNotificationSource extends Context.Service<
  K3RelayNotificationSource,
  { readonly current: Effect.Effect<K3RelayNotificationChoice | null> }
>()("@t3tools/client-runtime/k3relay/notify/K3RelayNotificationSource") {}

const sameKinds = (left: K3RelayNotifyKinds | null, right: K3RelayNotifyKinds) =>
  left !== null &&
  left.approval === right.approval &&
  left.input === right.input &&
  left.completed === right.completed &&
  left.failed === right.failed;

// Reconnects are frequent and the relay limits registrations; a token it has is not sent again.
const registeredTokens = new Map<string, string>();

/**
 * Brings one host and the relay in line with this device's choice, after a relay connection
 * opens: the key and kinds to the host, the push token to the relay, or both withdrawn when the
 * device turned notifications off. Best effort; the next connection tries again.
 */
export const syncK3RelayNotifications = Effect.fn("K3RelayNotify.sync")(function* (input: {
  readonly tunnel: K3RelayTunnelInput;
  readonly transport: ConnectionTransport;
  readonly environmentId: string;
  readonly hostLabel: string | null;
  readonly source: K3RelayNotificationSource["Service"];
  readonly keys: NotificationKeyStore["Service"];
}) {
  const { tunnel, transport } = input;
  const deviceId = deviceIdFromPublicKey(tunnel.signer.alg, tunnel.signer.publicKey);
  const cacheKey = `${tunnel.hostId}:${deviceId}`;
  const relayInput = {
    relayUrl: tunnel.relayUrl,
    hostId: tunnel.hostId,
    signer: tunnel.signer,
    grant: tunnel.grant,
  };
  const choice = yield* input.source.current;
  if (choice === null) {
    const status = yield* readK3RelayNotificationStatus(transport);
    if (status.registered) yield* unregisterK3RelayNotificationKey(transport);
    if (registeredTokens.has(cacheKey)) {
      yield* registerK3RelayPushToken({ ...relayInput, push: null });
      registeredTokens.delete(cacheKey);
    }
    return;
  }
  if (choice.push === null) return;
  const key = yield* input.keys
    .ensure({
      hostId: tunnel.hostId,
      environmentId: input.environmentId,
      hostLabel: input.hostLabel,
    })
    .pipe(Effect.mapError(() => new K3RelayNotifyError({ reason: "unavailable" })));
  const status = yield* readK3RelayNotificationStatus(transport);
  if (!status.registered || status.keyId !== key.keyId || !sameKinds(status.kinds, choice.kinds)) {
    yield* registerK3RelayNotificationKey(transport, {
      publicKey: key.publicKey,
      kinds: choice.kinds,
    });
  }
  const tokenKey = `${choice.push.platform}:${choice.push.token}`;
  if (registeredTokens.get(cacheKey) !== tokenKey) {
    yield* registerK3RelayPushToken({ ...relayInput, push: choice.push });
    registeredTokens.set(cacheKey, tokenKey);
  }
});
