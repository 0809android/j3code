import {
  K3_RELAY_BOOTSTRAP_PATH,
  K3_RELAY_PROVISIONAL_ORIGIN,
  K3RelayBootstrapResponse,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { exchangeRemoteDpopAccessToken } from "../authorization/remote.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { DpopConnectionCredential } from "../connection/catalog.ts";
import type { ConnectionAttemptError, ConnectionTransport } from "../connection/model.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

/**
 * A relay device whose session lapsed (past its renewal window, or refused) gets a new one by
 * itself, without pairing again (spec §5): the host issues a one-time bootstrap credential to the
 * E2E-authenticated device, re-checking its ledger first, and the device redeems it with its
 * DPoP key. A revoked device never gets here: the relay and the host turn its tunnel away.
 */

export class K3RelayReissueError extends Schema.TaggedError<K3RelayReissueError>()(
  "K3RelayReissueError",
  {
    reason: Schema.Literals(["refused", "unreachable", "malformed", "dpop-unavailable"]),
    status: Schema.optionalKey(Schema.Number),
  },
) {}

const decodeBootstrap = Schema.decodeUnknownOption(K3RelayBootstrapResponse);

/** Asks the host for a bootstrap credential over the tunnel and redeems it for a session. */
export const reissueK3RelaySession = Effect.fn("K3Relay.reissueSession")(function* (
  transport: ConnectionTransport,
) {
  const dpop = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  if (Option.isNone(dpop)) return yield* new K3RelayReissueError({ reason: "dpop-unavailable" });
  const presentation = yield* Effect.serviceOption(ClientCapabilities.ClientPresentation);
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      transport.fetch(`${K3_RELAY_PROVISIONAL_ORIGIN}${K3_RELAY_BOOTSTRAP_PATH}`, {
        method: "POST",
        signal,
      }),
    catch: () => new K3RelayReissueError({ reason: "unreachable" }),
  });
  if (response.status !== 200) {
    yield* Effect.promise(
      () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
    );
    return yield* new K3RelayReissueError({ reason: "refused", status: response.status });
  }
  const body: unknown = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => new K3RelayReissueError({ reason: "malformed" }),
  });
  const bootstrap = decodeBootstrap(body);
  if (Option.isNone(bootstrap)) return yield* new K3RelayReissueError({ reason: "malformed" });
  const proof = yield* dpop.value
    .createProof({
      method: "POST",
      url: environmentEndpointUrl(K3_RELAY_PROVISIONAL_ORIGIN, "/oauth/token"),
    })
    .pipe(Effect.mapError(() => new K3RelayReissueError({ reason: "dpop-unavailable" })));
  const access = yield* exchangeRemoteDpopAccessToken({
    httpBaseUrl: K3_RELAY_PROVISIONAL_ORIGIN,
    credential: bootstrap.value.bootstrapToken,
    ...(Option.isSome(presentation) ? { clientMetadata: presentation.value.metadata } : {}),
    dpopProof: proof,
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, transport.fetch as typeof fetch),
    Effect.mapError(() => new K3RelayReissueError({ reason: "refused" })),
  );
  return new DpopConnectionCredential({
    accessToken: access.access_token,
    expiresAtEpochMs: (yield* Clock.currentTimeMillis) + access.expires_in * 1_000,
  });
});

/** The host refused the saved session itself (not the route, not the network). */
const sessionRefused = (error: ConnectionAttemptError) =>
  error._tag === "ConnectionBlockedError" && error.reason === "authentication";

/**
 * Authorizes with the saved session; when the host refuses it, gets a new session once through
 * the device's own credential and tries again. Any other failure, or a failed reissue, is the
 * original failure.
 */
export const authorizeWithReissue = <A, R1, R2>(input: {
  readonly authorize: Effect.Effect<A, ConnectionAttemptError, R1>;
  readonly reissue: Effect.Effect<void, unknown, R2>;
}): Effect.Effect<A, ConnectionAttemptError, R1 | R2> =>
  input.authorize.pipe(
    Effect.catchIf(sessionRefused, (refused) =>
      input.reissue.pipe(
        Effect.matchEffect({
          onFailure: () => Effect.fail(refused),
          onSuccess: () => input.authorize,
        }),
      ),
    ),
  );
