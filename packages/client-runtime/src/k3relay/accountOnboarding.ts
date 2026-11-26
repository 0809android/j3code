import type { EnvironmentId } from "@t3tools/contracts";
import type { AccountProvider } from "@t3tools/shared/relay";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Socket from "effect/socket/Socket";
import * as HttpClient from "effect/http/HttpClient";

import type { ConnectionAttemptError } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import type * as Persistence from "../platform/persistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  type K3RelayAccountClientError,
  type K3RelayAccountHost,
  type K3RelayAccountOffer,
  type K3RelayAccountPendingSignIn,
  type K3RelayAccountSession,
  completeK3RelayAccountSignIn,
  connectK3RelayAccountHost,
  fetchK3RelayAccountOffer,
  listK3RelayAccountHosts,
  startK3RelayAccountSignIn,
} from "./account.ts";
import { DeviceKeyStore } from "./deviceKeyStore.ts";
import {
  type K3RelayPairingError,
  type K3RelayPairingProgress,
  saveK3RelayPairedDevice,
} from "./pairing.ts";

/**
 * The device side of accounts (spec §20) as one service, so web, desktop and mobile screens
 * reach it the same way as QR pairing. Sessions and sign-ins in progress stay in memory, held
 * by the screen; this service only owns their keys.
 */
export class K3RelayAccountOnboarding extends Context.Service<
  K3RelayAccountOnboarding,
  {
    /** What the relay offers, from `/.well-known/k3-relay`: the providers it turned on. */
    readonly offer: (
      relayUrl: string,
    ) => Effect.Effect<K3RelayAccountOffer, K3RelayAccountClientError>;
    /** Starts a sign-in. Open `authorizeUrl` in a browser that returns to `redirect`. */
    readonly startSignIn: (input: {
      readonly relayUrl: string;
      readonly provider: AccountProvider;
      readonly redirect?: string;
    }) => Effect.Effect<
      { readonly authorizeUrl: string; readonly pending: K3RelayAccountPendingSignIn },
      K3RelayAccountClientError
    >;
    /** Redeems the browser's callback. A sign-in that fails here is over: its key is dropped. */
    readonly completeSignIn: (
      pending: K3RelayAccountPendingSignIn,
      callbackUrl: string,
    ) => Effect.Effect<K3RelayAccountSession, K3RelayAccountClientError>;
    /** Ends a sign-in or a session on this device by dropping its key. */
    readonly forget: (keyId: string) => Effect.Effect<void>;
    readonly listHosts: (
      session: K3RelayAccountSession,
    ) => Effect.Effect<ReadonlyArray<K3RelayAccountHost>, K3RelayAccountClientError>;
    /** Knocks on the host, waits for its user to approve, then saves the environment. */
    readonly connectHost: (
      input: {
        readonly session: K3RelayAccountSession;
        readonly host: K3RelayAccountHost;
        readonly deviceName: string;
      },
      onProgress: (progress: K3RelayPairingProgress) => Effect.Effect<void>,
    ) => Effect.Effect<
      EnvironmentId,
      | K3RelayAccountClientError
      | K3RelayPairingError
      | ConnectionAttemptError
      | Persistence.ConnectionPersistenceError
    >;
  }
>()("@t3tools/client-runtime/k3relay/accountOnboarding/K3RelayAccountOnboarding") {}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const context = yield* Effect.context<
    HttpClient.HttpClient | ClientCapabilities.ClientPresentation | Socket.WebSocketConstructor
  >();
  const keys = yield* Effect.serviceOption(DeviceKeyStore);
  const dpop = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const provided = Effect.provide(
    Layer.mergeAll(
      Layer.succeedContext(context),
      SecureRandom.layerWebCrypto,
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
    ),
  );
  const optional = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Option.isSome(keys) ? Effect.provideService(DeviceKeyStore, keys.value) : (self) => self,
      Option.isSome(dpop)
        ? Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, dpop.value)
        : (self) => self,
    );
  const forget = (keyId: string) =>
    Option.isSome(keys) ? Effect.ignore(keys.value.remove(keyId)) : Effect.void;

  return K3RelayAccountOnboarding.of({
    offer: Effect.fn("K3RelayAccountOnboarding.offer")(function* (relayUrl) {
      return yield* fetchK3RelayAccountOffer(relayUrl);
    }, provided),
    startSignIn: Effect.fn("K3RelayAccountOnboarding.startSignIn")(function* (input) {
      return yield* optional(startK3RelayAccountSignIn(input));
    }, provided),
    completeSignIn: Effect.fn("K3RelayAccountOnboarding.completeSignIn")(function* (
      pending,
      callbackUrl,
    ) {
      return yield* completeK3RelayAccountSignIn(pending, callbackUrl).pipe(
        Effect.onError(() => forget(pending.keyId)),
      );
    }, provided),
    forget,
    listHosts: Effect.fn("K3RelayAccountOnboarding.listHosts")(function* (session) {
      return yield* listK3RelayAccountHosts(session);
    }, provided),
    connectHost: Effect.fn("K3RelayAccountOnboarding.connectHost")(function* (input, onProgress) {
      const paired = yield* optional(
        connectK3RelayAccountHost(
          input.session,
          input.host,
          { deviceName: input.deviceName },
          onProgress,
        ),
      );
      yield* onProgress({ phase: "redeeming" });
      return yield* optional(saveK3RelayPairedDevice(paired));
    }, provided),
  });
});

export const layer = Layer.effect(K3RelayAccountOnboarding, make);
