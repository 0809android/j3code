import { K3_RELAY_GRANT_PATH, K3_RELAY_PROVISIONAL_ORIGIN } from "@t3tools/contracts";
import {
  type DevicePairingRecord,
  type RelayGrant,
  acceptRenewedGrant,
  decodeBase64url,
  encodeBase64url,
  grantNeedsRenewal,
  parseGrant,
} from "@t3tools/shared/relay";
import type { E2eeDeviceSigner } from "@t3tools/shared/socketE2ee";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as Schema from "effect/Schema";

import { K3RelayConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import { environmentMismatchError, profileMissingError } from "../connection/errors.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransport,
  K3RelayConnectionTarget,
  K3RelayFailureReason,
  PreparedConnection,
} from "../connection/model.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import { credentialConnectionId } from "../connection/routes.ts";
import { DeviceKeyStore } from "./deviceKeyStore.ts";
import { NotificationKeyStore } from "./notificationKeyStore.ts";
import { K3RelayNotificationSource, syncK3RelayNotifications } from "./notify.ts";
import { k3relayConnectionError } from "./failure.ts";
import { authorizeWithReissue, reissueK3RelaySession } from "./reissue.ts";
import { K3RelayTunnels } from "./tunnels.ts";
import { fetchK3RelayHostPresence } from "./status.ts";
import type { K3RelayTunnelInput } from "./tunnel.ts";

const isK3RelayProfile = Schema.is(K3RelayConnectionProfile);

export const K3RELAY_VIRTUAL_WS_ORIGIN = K3_RELAY_PROVISIONAL_ORIGIN.replace(/^https:/u, "wss:");

/** Runs an HTTP effect over a channel: the fetch-based client reads `Fetch` per request. */
export const overTransport =
  (transport: ConnectionTransport | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    transport === undefined
      ? effect
      : Effect.provideService(effect, FetchHttpClient.Fetch, transport.fetch as typeof fetch);

/** The tunnel input for a saved profile, or the reason it cannot connect. */
export const k3relayTunnelInput = Effect.fn("K3Relay.tunnelInput")(function* (
  profile: K3RelayConnectionProfile,
) {
  const keys = yield* Effect.serviceOption(DeviceKeyStore);
  const missingKey = () => k3relayConnectionError("device-key-missing", profile.label);
  if (Option.isNone(keys)) return yield* missingKey();
  const signer = yield* keys.value
    .load(profile.deviceKeyId)
    .pipe(
      Effect.mapError(missingKey),
      Effect.flatMap(Effect.fromOption),
      Effect.mapError(missingKey),
    );
  if (
    signer.alg !== profile.deviceAlg ||
    encodeBase64url(signer.publicKey) !== profile.devicePublicKey
  ) {
    return yield* missingKey();
  }
  const hostIdentityKey = decodeBase64url(profile.hostIdentityKey, 32);
  if (hostIdentityKey === null) {
    return yield* k3relayConnectionError("key-mismatch", profile.label);
  }
  const grant = parseGrant(profile.grant);
  if (grant === null) return yield* k3relayConnectionError("unauthorized", profile.label);
  return {
    relayUrl: profile.relayUrl,
    hostId: profile.hostId,
    hostIdentityKey,
    signer,
    grant,
  } satisfies K3RelayTunnelInput;
});

/**
 * Asks the host for a fresh grant when the saved one has under 30 days left (spec §5). Only a
 * grant the pinned host signed for this device's key is kept.
 */
export const renewK3RelayGrant = Effect.fn("K3Relay.renewGrant")(function* (input: {
  readonly record: DevicePairingRecord;
  readonly signer: E2eeDeviceSigner;
  readonly transport: ConnectionTransport;
}) {
  const now = yield* Clock.currentTimeMillis;
  if (!grantNeedsRenewal(input.record.grant, now)) return Option.none<DevicePairingRecord>();
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      input.transport.fetch(`${K3_RELAY_PROVISIONAL_ORIGIN}${K3_RELAY_GRANT_PATH}`, {
        method: "POST",
        signal,
      }),
    catch: () => "unreachable" as const,
  });
  if (response.status !== 200) return Option.none<DevicePairingRecord>();
  const body: unknown = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => "malformed" as const,
  });
  const grant =
    typeof body === "object" && body !== null ? (body as { readonly grant?: unknown }).grant : null;
  return Option.fromNullishOr(
    acceptRenewedGrant(input.record, {
      grant,
      alg: input.signer.alg,
      devicePublicKey: input.signer.publicKey,
      now: yield* Clock.currentTimeMillis,
    }),
  );
});

/**
 * When the tunnel failed without saying why (the relay did not answer the socket in time), the
 * relay's signed status names it (spec §18.3): the host offline, this device revoked, or its pass
 * expired. The connection list then says so instead of "can't reach the relay".
 */
export const refineWithPresence = Effect.fn("K3Relay.refineWithPresence")(function* (
  reason: K3RelayFailureReason,
  input: K3RelayTunnelInput,
  fetch?: typeof globalThis.fetch,
) {
  if (reason !== "relay-unreachable") return reason;
  const presence = yield* fetchK3RelayHostPresence({
    relayUrl: input.relayUrl,
    hostId: input.hostId,
    signer: input.signer,
    grant: input.grant,
    ...(fetch === undefined ? {} : { fetch }),
  }).pipe(
    Effect.provide(SecureRandom.layerWebCrypto),
    Effect.orElseSucceed(() => null),
  );
  switch (presence?.kind) {
    case "reachable":
      return presence.online ? reason : "host-offline";
    case "revoked":
      return "revoked";
    case "grant-expired":
      return "grant-expired";
    default:
      return reason;
  }
});

export const pairingRecordOf = (profile: K3RelayConnectionProfile, grant: RelayGrant) =>
  ({
    relayUrl: profile.relayUrl,
    hostId: profile.hostId,
    hostIdentityKey: profile.hostIdentityKey,
    grant,
  }) satisfies DevicePairingRecord;

export const makeK3RelayBroker = Effect.fn("clientRuntime.connection.broker.makeK3Relay")(
  function* () {
    const tunnels = yield* Effect.serviceOption(K3RelayTunnels);
    const keys = yield* Effect.serviceOption(DeviceKeyStore);
    const notificationSource = yield* Effect.serviceOption(K3RelayNotificationSource);
    const notificationKeys = yield* Effect.serviceOption(NotificationKeyStore);
    const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
    const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
    const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;

    return Effect.fn("clientRuntime.connection.broker.k3relay")(function* (
      entry: ConnectionCatalogEntry & { readonly target: K3RelayConnectionTarget },
    ): Effect.fn.Return<PreparedConnection, ConnectionAttemptError> {
      const target = entry.target;
      const profile = yield* Effect.fromOption(entry.profile, () =>
        profileMissingError(target.connectionId),
      );
      if (!isK3RelayProfile(profile)) {
        return yield* profileMissingError(target.connectionId);
      }
      if (profile.environmentId !== target.environmentId) {
        return yield* environmentMismatchError({
          expected: target.environmentId,
          actual: profile.environmentId,
        });
      }
      if (Option.isNone(tunnels)) {
        return yield* k3relayConnectionError("relay-unreachable", target.label);
      }
      const input = yield* k3relayTunnelInput(profile).pipe(
        Option.isSome(keys) ? Effect.provideService(DeviceKeyStore, keys.value) : (e) => e,
      );
      const tunnel = yield* tunnels.value
        .acquire(target.connectionId, input)
        .pipe(
          Effect.catch((error) =>
            refineWithPresence(error.reason, input).pipe(
              Effect.flatMap((reason) => Effect.fail(k3relayConnectionError(reason, target.label))),
            ),
          ),
        );
      const credentialId = credentialConnectionId(target.connectionId);
      const authorized = yield* authorizeWithReissue({
        authorize: remote
          .authorizeDirectDpop({
            expectedEnvironmentId: target.environmentId,
            connectionId: credentialId,
            httpBaseUrl: K3_RELAY_PROVISIONAL_ORIGIN,
            wsBaseUrl: K3RELAY_VIRTUAL_WS_ORIGIN,
          })
          .pipe(overTransport(tunnel.transport)),
        // A lapsed session renews through the device's own credential, not a new pairing.
        reissue: reissueK3RelaySession(tunnel.transport).pipe(
          Effect.flatMap((credential) => credentials.put(credentialId, credential)),
          Effect.tapError((error) =>
            Effect.logWarning("Could not renew the relay session.", { error }),
          ),
        ),
      });
      if (Option.isSome(notificationSource) && Option.isSome(notificationKeys)) {
        // In the background: a slow or older host must not hold up the connection.
        yield* syncK3RelayNotifications({
          tunnel: input,
          transport: tunnel.transport,
          environmentId: profile.environmentId,
          hostLabel: profile.label,
          source: notificationSource.value,
          keys: notificationKeys.value,
        }).pipe(
          Effect.catch((error) =>
            Effect.logDebug("Relay notifications not synced.", { reason: error.reason }),
          ),
          Effect.provide(SecureRandom.layerWebCrypto),
          Effect.forkDetach,
        );
      }
      const renewed = yield* renewK3RelayGrant({
        record: pairingRecordOf(profile, input.grant),
        signer: input.signer,
        transport: tunnel.transport,
      }).pipe(Effect.orElseSucceed(Option.none));
      if (Option.isNone(renewed)) {
        return { ...authorized, target, transport: tunnel.transport } satisfies PreparedConnection;
      }
      const renewedProfile = new K3RelayConnectionProfile({
        ...profile,
        grant: renewed.value.grant,
      });
      yield* profiles
        .put(renewedProfile)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not save the renewed relay pass.", { error }),
          ),
        );
      // The registry adopts it too, so the next attempt presents the renewed grant.
      return {
        ...authorized,
        target,
        transport: tunnel.transport,
        renewedK3RelayProfile: renewedProfile,
      } satisfies PreparedConnection;
    });
  },
);
