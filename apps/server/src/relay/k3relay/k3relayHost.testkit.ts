import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentHttpApi,
  type K3RelayDevice,
  type K3RelayDeviceAlgorithm,
  type K3RelayHostState,
  K3RelayHostState as K3RelayHostStateSchema,
  type K3RelayPairingOffer,
  type ManagedPolicyDocument,
  type ServerSettings as ServerSettingsValue,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

import { type RelayGrant, signGrant } from "@t3tools/shared/relay";
import { layerE2eeCrypto } from "@t3tools/shared/socketE2ee";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../../auth/http.ts";
import * as ServerE2eeIdentity from "../../auth/ServerE2eeIdentity.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import {
  classifyRequestTransport,
  transportAllowedByPolicy,
} from "../../auth/transportSecurity.ts";
import { deriveAuthClientMetadata } from "../../auth/utils.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { layerServerEnvironmentHttpApi } from "../../http.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as RelayConnector from "./RelayConnector.ts";
import * as RelayDeviceLedger from "./RelayDeviceLedger.ts";

/**
 * A K3 relay host as the server runs it, minus the parts the relay does not touch: the real
 * `RelayConnector`, device ledger, `EnvironmentAuth` with its HTTP routes, the environment
 * descriptor, and an RPC socket authenticated like `ws.ts`. Its probe RPCs answer with what the
 * server concluded about the caller, and `k3relay.subscribe` streams the connector's real state.
 */

class HostTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.metadata) {}

export const RelayProbeWhoAmI = Schema.Struct({ subject: Schema.String, transport: Schema.String });

export const RelayProbeRpcs = RpcGroup.make(
  Rpc.make("relayProbe.whoami", { success: RelayProbeWhoAmI }),
  Rpc.make(WS_METHODS.k3RelaySubscribe, {
    payload: Schema.Struct({}),
    success: K3RelayHostStateSchema,
    stream: true,
  }),
);

export const TEST_ENVIRONMENT_LABEL = "Relay test host";

const layerRpcRoute = HttpRouter.add(
  "GET",
  "/ws",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const transport = classifyRequestTransport(request);
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
      Effect.orDie,
    );
    if (!transportAllowedByPolicy(transport, settings.remoteTransportPolicy)) {
      return HttpServerResponse.jsonUnsafe(
        { code: "REMOTE_TRANSPORT_NOT_ALLOWED" },
        { status: 403 },
      );
    }
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const connector = yield* RelayConnector.RelayConnector;
    const session = yield* Effect.result(auth.authenticateWebSocketUpgrade(request, "rpc"));
    if (session._tag === "Failure") {
      return HttpServerResponse.jsonUnsafe({ code: "auth_invalid" }, { status: 401 });
    }
    const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* RpcServer.make(RelayProbeRpcs).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(
        RelayProbeRpcs.toLayer({
          "relayProbe.whoami": () =>
            Effect.succeed({ subject: session.success.subject, transport }),
          [WS_METHODS.k3RelaySubscribe]: () => connector.changes,
        }),
      ),
      Effect.forkScoped,
    );
    return yield* Effect.raceFirst(
      httpEffect,
      sessions
        .awaitInvalidation(session.success.sessionId, session.success.proofKeyThumbprint)
        .pipe(Effect.ignore, Effect.as(HttpServerResponse.empty())),
    );
  }).pipe(Effect.provide(RpcSerialization.layerJson)),
);

/** Answers with what the server concluded about the request's route and address. */
const layerProbeRoute = HttpRouter.add(
  "GET",
  "/relay-probe",
  Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
    HttpServerResponse.jsonUnsafe({
      transport: classifyRequestTransport(request),
      ipAddress: deriveAuthClientMetadata({ request }).ipAddress ?? null,
    }),
  ),
);

/** The test settings service, plus the change stream the connector follows. */
const layerSettingsWithChanges = (overrides: Parameters<typeof ServerSettings.layerTest>[0]) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      const changes = yield* PubSub.unbounded<ServerSettingsValue>();
      return ServerSettings.ServerSettingsService.of({
        ...base,
        updateSettings: (patch) =>
          base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest(overrides)));

const layerEnvironment = Layer.effect(
  ServerEnvironment.ServerEnvironment,
  Effect.gen(function* () {
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const environmentId = yield* identity.getEnvironmentId;
    return ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.succeed({
        environmentId,
        label: TEST_ENVIRONMENT_LABEL,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      }),
    });
  }),
);

export interface K3RelayTestHostOptions {
  readonly relayUrl: string;
  readonly enabled?: boolean;
  readonly maxSessions?: number;
  readonly policy?: ManagedPolicyDocument;
}

/** Each call is a separate host: its own state directory, database, and so its own `Hk`. */
export const layerK3RelayTestHost = (options: K3RelayTestHostOptions) => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-k3relay-test-" });
  const storage = Layer.mergeAll(ServerSecretStore.layer, SqlitePersistence.layerMemory).pipe(
    Layer.provideMerge(config),
  );
  const core = EnvironmentAuth.layer.pipe(
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(Layer.mergeAll(ServerE2eeIdentity.layer, ServerEnvironment.layerIdentity)),
    Layer.provideMerge(ManagedPolicy.layerTest(options.policy)),
    Layer.provideMerge(
      layerSettingsWithChanges({
        relay: {
          enabled: options.enabled ?? true,
          url: options.relayUrl,
          maxSessions: options.maxSessions ?? 8,
        },
      }),
    ),
    Layer.provideMerge(storage),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer)),
  );
  const routes = Layer.mergeAll(
    HttpApiBuilder.layer(HostTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
      Layer.provide(layerServerEnvironmentHttpApi),
    ),
    layerRpcRoute,
    layerProbeRoute,
  ).pipe(
    // Routes read these per request, as `HttpRouter.serve` provides them in the server.
    HttpRouter.provideRequest(
      Layer.effectContext(
        Effect.context<
          | EnvironmentAuth.EnvironmentAuth
          | SessionStore.SessionStore
          | ServerSecretStore.ServerSecretStore
          | ServerSettings.ServerSettingsService
          | ServerEnvironment.ServerEnvironment
          | RelayConnector.RelayConnector
          | Digest.Digest
        >(),
      ),
    ),
  );
  return routes.pipe(
    // The connector reads the router lazily, per relayed request, so routes may come after it.
    Layer.provideMerge(Layer.mergeAll(RelayConnector.layer, RelayDeviceLedger.layer)),
    Layer.provideMerge(HttpRouter.layer),
    Layer.provideMerge(core),
    Layer.provideMerge(layerE2eeCrypto),
  );
};

// ── The relay, in this process ───────────────────────────────────────────────

/** The parts of `infra/k3-relay` these tests drive. */
export interface InProcessRelay {
  readonly store: { getHost(hostId: string): unknown };
  readonly metrics: { snapshot(): { readonly controls: number } };
  listen(): Promise<number>;
  close(): Promise<void>;
}

/**
 * The relay is its own package with its own lint and type rules, so it is loaded at run time
 * rather than type-checked as part of the server.
 */
const loadRelay = async () => {
  const testkit = (await import(
    /* @vite-ignore */ new URL(
      "../../../../../infra/k3-relay/src/relay.testkit.ts",
      import.meta.url,
    ).href
  )) as { readonly TEST_CONFIG: object };
  const server = (await import(
    /* @vite-ignore */ new URL("../../../../../infra/k3-relay/src/server.ts", import.meta.url).href
  )) as {
    readonly createRelay: (options: {
      readonly config: object;
      readonly now: () => number;
    }) => InProcessRelay;
  };
  return { config: testkit.TEST_CONFIG, createRelay: server.createRelay };
};

/**
 * A real relay on an ephemeral port for the scope. It reads the test's clock; `clock.skewMs` moves
 * it ahead, where it drops the host's revocations as stale.
 */
export const startK3RelayTestRelay = Effect.acquireRelease(
  Clock.clockWith((testClock) =>
    Effect.promise(async () => {
      const { config, createRelay } = await loadRelay();
      const clock = { skewMs: 0 };
      const relay = createRelay({
        config,
        now: () => testClock.currentTimeMillisUnsafe() + clock.skewMs,
      });
      const port = await relay.listen();
      return { relay, port, clock, url: `ws://127.0.0.1:${port}` };
    }),
  ),
  ({ relay }) => Effect.promise(() => relay.close()),
);

// ── A promise-shaped handle, for tests outside this package ──────────────────

/**
 * What a test in another package (the client runtime) needs from a real host. Plain values and
 * promises only, so nothing of this package's types or Effect services crosses the boundary.
 */
export interface K3RelayTestHost {
  readonly hostId: string;
  readonly hostIdentityKey: Uint8Array;
  readonly environmentId: string;
  readonly state: () => Promise<K3RelayHostState>;
  /** Resolves with the first state, current or next, that passes `predicate`. */
  readonly awaitState: (
    predicate: (state: K3RelayHostState) => boolean,
    timeoutMs?: number,
  ) => Promise<K3RelayHostState>;
  readonly createPairingOffer: () => Promise<K3RelayPairingOffer>;
  readonly approvePairing: (deviceId: string) => Promise<K3RelayDevice>;
  readonly rejectPairing: () => Promise<void>;
  readonly revokeDevice: (deviceId: string) => Promise<K3RelayDevice>;
  /** A grant this host signs, as if issued at `issuedAt`, for a device key. */
  readonly signGrant: (input: {
    readonly alg: K3RelayDeviceAlgorithm;
    readonly devicePublicKey: Uint8Array;
    readonly issuedAt: number;
  }) => Promise<RelayGrant>;
  readonly dispose: () => Promise<void>;
}

export interface K3RelayTestRelayHandle {
  readonly url: string;
  readonly dispose: () => Promise<void>;
}

const runtimeLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerE2eeCrypto);

export const startK3RelayTestRelayHandle = async (): Promise<K3RelayTestRelayHandle> => {
  const runtime = ManagedRuntime.make(runtimeLayer);
  const scope = await runtime.runPromise(Scope.make());
  const dispose = async () => {
    await runtime.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  };
  try {
    const { url } = await runtime.runPromise(startK3RelayTestRelay.pipe(Scope.provide(scope)));
    return { url, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
};

export const startK3RelayTestHost = async (
  options: K3RelayTestHostOptions,
): Promise<K3RelayTestHost> => {
  const runtime = ManagedRuntime.make(
    layerK3RelayTestHost(options).pipe(Layer.provideMerge(runtimeLayer)),
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Services<typeof runtime>>,
  ) => runtime.runPromise(effect);
  const awaitState = (predicate: (state: K3RelayHostState) => boolean, timeoutMs = 20_000) =>
    run(
      Effect.flatMap(RelayConnector.RelayConnector, (connector) =>
        connector.changes.pipe(
          Stream.filter(predicate),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.timeout(timeoutMs),
        ),
      ),
    );
  try {
    const { keypair, environmentId } = await run(
      Effect.gen(function* () {
        const keypair = yield* (yield* ServerE2eeIdentity.ServerE2eeIdentity).getKeypair;
        const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
        return { keypair, environmentId };
      }),
    );
    const connected = await awaitState((state) => state.status === "connected");
    return {
      hostId: connected.hostId ?? "",
      hostIdentityKey: keypair.publicKey,
      environmentId,
      state: () => run(Effect.flatMap(RelayConnector.RelayConnector, (c) => c.state)),
      awaitState,
      createPairingOffer: () =>
        run(Effect.flatMap(RelayConnector.RelayConnector, (c) => c.createPairingOffer)),
      approvePairing: (deviceId) =>
        run(Effect.flatMap(RelayConnector.RelayConnector, (c) => c.approvePairing(deviceId))),
      rejectPairing: () =>
        run(Effect.flatMap(RelayConnector.RelayConnector, (c) => c.rejectPairing)),
      revokeDevice: (deviceId) =>
        run(Effect.flatMap(RelayConnector.RelayConnector, (c) => c.revokeDevice(deviceId))),
      signGrant: (input) =>
        run(
          signGrant({
            hostIdentitySeed: keypair.seed,
            alg: input.alg,
            devicePublicKey: input.devicePublicKey,
            now: input.issuedAt,
            nonce: `test-grant-${input.issuedAt}`.padEnd(24, "0"),
          }),
        ),
      dispose: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
};
