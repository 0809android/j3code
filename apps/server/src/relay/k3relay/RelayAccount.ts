// @effect-diagnostics nodeBuiltinImport:off -- a short-lived loopback listener for the OAuth return, like the relay's own server.
import * as NodeHttp from "node:http";

import {
  K3RelayAccountError,
  type K3RelayAccountFailure,
  type K3RelayAccountPendingDevice,
  type K3RelayAccountProvider,
  type K3RelayAccountState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  ACCOUNT_LOOPBACK_PATH,
  type ApprovalPolicy,
  type HostAccountBinding,
  accountCodeSigningInput,
  accountRequestSigningInput,
  approvalRequired,
  decodeBase64url,
  defaultApprovalPolicy,
  disableApproval,
  encodeBase64url,
  isAccountProvider,
  pkceChallenge,
  readAccountSessionToken,
  relayHostId,
} from "@t3tools/shared/relay";

import * as ServerE2eeIdentity from "../../auth/ServerE2eeIdentity.ts";
import * as ServerConfig from "../../config.ts";
import * as ManagedLimits from "../../policy/managedLimits.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import { isRegistered, relayEndpoints, signWithHostSeed } from "./hostRegistration.ts";
import { relayStateDirectory } from "./RelayDeviceLedger.ts";

/**
 * This host's account at the K3 relay (spec §20.4). The provider answers a loopback listener on
 * this machine only (RFC 8252), so a sign-in link someone else started cannot add their host to
 * your account. Device tickets are checked against the account key learned here.
 */

const SIGN_IN_TIMEOUT = "10 minutes";
const MAX_RESPONSE_BYTES = 64 * 1024;

const relayFailure = (failure: K3RelayAccountFailure) => new K3RelayAccountError({ failure });

const AccountFile = Schema.Struct({
  version: Schema.Literal(1),
  relayUrl: Schema.String,
  issuer: Schema.String,
  accountId: Schema.String,
  accountKey: Schema.String,
  provider: Schema.Literals(["github", "google", "apple"]),
  signedInAt: Schema.Number,
});
type AccountFile = typeof AccountFile.Type;
const decodeAccountFile = Schema.decodeUnknownOption(Schema.fromJsonString(AccountFile));
const encodeAccountFile = Schema.encodeSync(Schema.fromJsonString(AccountFile));

const ApprovalFile = Schema.Struct({
  version: Schema.Literal(1),
  requireApproval: Schema.Boolean,
  optOutAt: Schema.NullOr(Schema.Number),
});
const decodeApprovalFile = Schema.decodeUnknownOption(Schema.fromJsonString(ApprovalFile));
const encodeApprovalFile = Schema.encodeSync(Schema.fromJsonString(ApprovalFile));

const WellKnown = Schema.Struct({
  accounts: Schema.optionalKey(
    Schema.Struct({
      providers: Schema.Array(Schema.String),
      issuer: Schema.String,
      key: Schema.String,
    }),
  ),
});
const decodeWellKnown = Schema.decodeUnknownOption(WellKnown);

const toPolicy = (file: typeof ApprovalFile.Type | null): ApprovalPolicy =>
  file === null || file.requireApproval || file.optOutAt === null
    ? defaultApprovalPolicy
    : disableApproval(file.optOutAt);

interface RelayAccountInfo {
  readonly providers: ReadonlyArray<K3RelayAccountProvider>;
  readonly issuer: string;
  readonly key: Uint8Array;
}

interface HostSession {
  readonly relayUrl: string;
  readonly token: string;
  readonly expiresAt: number;
}

const random64 = (bytes: number) =>
  Effect.map(SecureRandom.SecureRandom, (random) => random.randomBytes(bytes)).pipe(
    Effect.flatten,
    Effect.map((value) => encodeBase64url(Uint8Array.from(value))),
  );

const HTML_DONE = `<!doctype html><meta charset="utf-8"><title>K3 Code</title><p>Signed in. You can close this tab and return to K3 Code.</p>`;
const HTML_FAILED = `<!doctype html><meta charset="utf-8"><title>K3 Code</title><p>Sign-in did not finish. Return to K3 Code and try again.</p>`;

/**
 * A listener on 127.0.0.1 with a port the OS picks, answering one path once. It hands back the
 * query of the first request whose `state` matches, and closes with the scope.
 */
const loopbackListener = Effect.fn("RelayAccount.loopbackListener")(function* (appState: string) {
  const received = yield* Deferred.make<URLSearchParams>();
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server, K3RelayAccountError>((resume) => {
      const instance = NodeHttp.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const done = url.pathname === ACCOUNT_LOOPBACK_PATH && req.method === "GET";
        const matches = done && url.searchParams.get("state") === appState;
        res.writeHead(matches ? 200 : 400, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        res.end(matches && url.searchParams.get("code") ? HTML_DONE : HTML_FAILED);
        if (matches) Deferred.doneUnsafe(received, Exit.succeed(url.searchParams));
      });
      instance.on("error", () => resume(Effect.fail(relayFailure("internal"))));
      instance.listen(0, "127.0.0.1", () => resume(Effect.succeed(instance)));
    }),
    (instance) =>
      Effect.sync(() => {
        instance.closeAllConnections();
        instance.close();
      }),
  );
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { received, redirect: `http://127.0.0.1:${port}${ACCOUNT_LOOPBACK_PATH}` };
});

export class RelayAccount extends Context.Service<
  RelayAccount,
  {
    readonly state: Effect.Effect<K3RelayAccountState>;
    readonly changes: Stream.Stream<K3RelayAccountState>;
    /** Starts a sign-in and returns the provider's URL, to open on this machine. */
    readonly signIn: (
      provider: K3RelayAccountProvider,
    ) => Effect.Effect<{ readonly authorizeUrl: string }, K3RelayAccountError>;
    /** Leaves the account here; devices coming through it are refused from now on. */
    readonly signOut: Effect.Effect<void, K3RelayAccountError>;
    readonly setApproval: (input: {
      readonly requireApproval: boolean;
      readonly acknowledgedRisk: boolean;
    }) => Effect.Effect<K3RelayAccountState, K3RelayAccountError>;
    /** The account this host is on at that relay, or null. */
    readonly binding: (relayUrl: string) => Effect.Effect<HostAccountBinding | null>;
    readonly approvalPolicy: Effect.Effect<ApprovalPolicy>;
    /** Set by the connector while an account device waits for approval. */
    readonly setPendingDevice: (device: K3RelayAccountPendingDevice | null) => Effect.Effect<void>;
  }
>()("t3/relay/k3relay/RelayAccount") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const identity = yield* ServerE2eeIdentity.ServerE2eeIdentity;
  const http = yield* HttpClient.HttpClient;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
  >();
  const layerScope = yield* Effect.scope;
  const policyAllowed = ManagedLimits.allowsRelay(managedPolicy);
  const directory = relayStateDirectory(config.stateDir, path);
  const accountPath = path.join(directory, "account.json");
  const approvalPath = path.join(directory, "approval.json");
  const lock = yield* Semaphore.make(1);

  const readAccount = fs.readFileString(accountPath).pipe(
    Effect.map((text) => {
      const file = decodeAccountFile(text);
      return file._tag === "Some" ? file.value : null;
    }),
    Effect.orElseSucceed(() => null),
  );
  const readApproval = fs.readFileString(approvalPath).pipe(
    Effect.map((text) => {
      const file = decodeApprovalFile(text);
      return file._tag === "Some" ? file.value : null;
    }),
    Effect.orElseSucceed(() => null),
  );

  let providers: ReadonlyArray<K3RelayAccountProvider> = [];
  let pendingSignIn: Fiber.Fiber<void> | undefined;
  let lastError: K3RelayAccountFailure | null = null;
  let pendingDevice: K3RelayAccountPendingDevice | null = null;
  let hostSession: HostSession | undefined;

  const buildState = Effect.gen(function* () {
    const account = yield* readAccount;
    const approval = yield* readApproval;
    const policy = toPolicy(approval);
    return {
      availableProviders: providers,
      signedIn: account !== null,
      provider: account?.provider ?? null,
      signedInAt: account?.signedInAt ?? null,
      signInPending: pendingSignIn !== undefined,
      lastError,
      requireApproval: approvalRequired(policy),
      approvalOptOutAt: policy.optOut?.chosenAt ?? null,
      pendingDevice,
    } satisfies K3RelayAccountState;
  });
  const output = yield* SubscriptionRef.make(yield* buildState);
  const publish = Effect.flatMap(buildState, (state) => SubscriptionRef.set(output, state));

  const currentEndpoints = Effect.gen(function* () {
    if (!policyAllowed) return yield* relayFailure("policy-disallowed");
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => relayFailure("internal")),
    );
    if (!settings.relay.enabled) return yield* relayFailure("disabled");
    const endpoints = relayEndpoints(settings.relay.url);
    if (endpoints === null) return yield* relayFailure("internal");
    return endpoints;
  });

  const postJson = (url: string, body: unknown) =>
    http.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
      Effect.flatMap((response) =>
        Effect.map(
          Effect.orElseSucceed(response.text, () => ""),
          (text) => {
            let json: unknown = null;
            try {
              json = text.length <= MAX_RESPONSE_BYTES ? JSON.parse(text) : null;
            } catch {
              json = null;
            }
            return { status: response.status, json: json as Record<string, unknown> | null };
          },
        ),
      ),
      Effect.mapError(() => relayFailure("relay-unreachable")),
    );

  /** The relay's account offer: providers, issuer, and the key its tickets are signed with. */
  const fetchRelayInfo = (relayUrl: string) =>
    http.get(`${relayUrl}/.well-known/k3-relay`).pipe(
      Effect.flatMap((response) => response.json),
      Effect.mapError(() => relayFailure("relay-unreachable")),
      Effect.flatMap((json) => {
        const decoded = decodeWellKnown(json);
        const accounts = decoded._tag === "Some" ? decoded.value.accounts : undefined;
        const key = accounts ? decodeBase64url(accounts.key, 32) : null;
        if (accounts === undefined || key === null) return Effect.succeed(null);
        return Effect.succeed({
          providers: accounts.providers.filter(isAccountProvider),
          issuer: accounts.issuer,
          key,
        } satisfies RelayAccountInfo);
      }),
    );

  const refreshProviders = Effect.gen(function* () {
    const endpoints = yield* Effect.option(currentEndpoints);
    if (endpoints._tag === "None") {
      providers = [];
      return;
    }
    const info = yield* Effect.orElseSucceed(fetchRelayInfo(endpoints.value.http), () => null);
    providers = info?.providers ?? [];
  });

  /** A call to the relay's account API, signed by `Hk` over the path, token, time and nonce. */
  const accountCall = Effect.fn("RelayAccount.accountCall")(function* (
    relayUrl: string,
    seed: Uint8Array,
    hostKey: Uint8Array,
    token: string,
    path: string,
    params: ReadonlyArray<readonly [string, string]> = [],
  ) {
    const ts = yield* Clock.currentTimeMillis;
    const nonce = yield* random64(18);
    const sig = signWithHostSeed(
      seed,
      accountRequestSigningInput(
        path,
        token,
        ts,
        nonce,
        params.map(([, value]) => value),
      ),
    );
    return yield* postJson(`${relayUrl}${path}`, {
      token,
      alg: "ed25519",
      key: encodeBase64url(hostKey),
      ts,
      nonce,
      sig: encodeBase64url(sig),
      ...Object.fromEntries(params),
    });
  });

  /** After the browser came back: code for a session, then put this host on the account. */
  const finishSignIn = Effect.fn("RelayAccount.finishSignIn")(function* (input: {
    readonly relayUrl: string;
    readonly provider: K3RelayAccountProvider;
    readonly info: RelayAccountInfo;
    readonly seed: Uint8Array;
    readonly hostKey: Uint8Array;
    readonly verifier: string;
    readonly redirect: string;
    readonly query: URLSearchParams;
  }) {
    if (input.query.get("error") !== null) return yield* relayFailure("sign-in-cancelled");
    const code = input.query.get("code");
    if (code === null || code.length === 0 || code.length > 128) {
      return yield* relayFailure("sign-in-failed");
    }
    const ts = yield* Clock.currentTimeMillis;
    const sig = signWithHostSeed(input.seed, accountCodeSigningInput(code, ts));
    const redeemed = yield* postJson(`${input.relayUrl}/v1/account/token`, {
      code,
      verifier: input.verifier,
      redirect: input.redirect,
      ts,
      sig: encodeBase64url(sig),
    });
    const token = redeemed.json?.token;
    const claims = readAccountSessionToken(token, input.info.key);
    if (
      redeemed.status !== 200 ||
      typeof token !== "string" ||
      claims === null ||
      claims.use !== "host" ||
      claims.kid !== relayHostId(input.hostKey) ||
      claims.iss !== input.info.issuer
    ) {
      return yield* relayFailure("sign-in-failed");
    }
    const added = yield* accountCall(
      input.relayUrl,
      input.seed,
      input.hostKey,
      token,
      "/v1/account/hosts/add",
    );
    if (added.status !== 200) return yield* relayFailure("sign-in-failed");
    const signedInAt = yield* Clock.currentTimeMillis;
    hostSession = { relayUrl: input.relayUrl, token, expiresAt: claims.exp };
    yield* writeFileStringAtomically({
      filePath: accountPath,
      contents: `${encodeAccountFile({
        version: 1,
        relayUrl: input.relayUrl,
        issuer: input.info.issuer,
        accountId: claims.sub,
        accountKey: encodeBase64url(input.info.key),
        provider: input.provider,
        signedInAt,
      } satisfies AccountFile)}\n`,
    }).pipe(Effect.mapError(() => relayFailure("internal")));
  });

  const stopPendingSignIn = Effect.suspend(() => {
    const fiber = pendingSignIn;
    pendingSignIn = undefined;
    return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
  });

  const signIn = Effect.fn("RelayAccount.signIn")(function* (provider: K3RelayAccountProvider) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const endpoints = yield* currentEndpoints;
        const keys = yield* identity.getKeypair.pipe(
          Effect.mapError(() => relayFailure("internal")),
        );
        const hostId = relayHostId(keys.publicKey);
        const registered = yield* isRegistered(directory, endpoints, hostId).pipe(
          Effect.provide(services),
        );
        if (!registered) return yield* relayFailure("not-registered");
        const info = yield* fetchRelayInfo(endpoints.http);
        providers = info?.providers ?? [];
        if (info === null || !info.providers.includes(provider)) {
          yield* publish;
          return yield* relayFailure("provider-unavailable");
        }
        yield* stopPendingSignIn;
        const verifier = yield* random64(32).pipe(Effect.provide(services));
        const appState = yield* random64(24).pipe(Effect.provide(services));
        // The listener lives exactly as long as the wait for the browser, not this call.
        const scope = yield* Scope.make();
        const closeListener = Scope.close(scope, Exit.void);
        const started = yield* Effect.gen(function* () {
          const listener = yield* loopbackListener(appState).pipe(Scope.provide(scope));
          const reply = yield* postJson(`${endpoints.http}/v1/account/oauth/${provider}/start`, {
            use: "host",
            alg: "ed25519",
            key: encodeBase64url(keys.publicKey),
            challenge: pkceChallenge(verifier),
            redirect: listener.redirect,
            state: appState,
          });
          const url = reply.json?.authorizeUrl;
          if (reply.status !== 200 || typeof url !== "string") {
            return yield* relayFailure(
              reply.status === 404 ? "provider-unavailable" : "sign-in-failed",
            );
          }
          return { listener, authorizeUrl: url };
        }).pipe(Effect.onError(() => closeListener));
        const { listener, authorizeUrl } = started;
        lastError = null;
        pendingSignIn = yield* Deferred.await(listener.received).pipe(
          Effect.timeoutOrElse({
            duration: SIGN_IN_TIMEOUT,
            orElse: () => Effect.fail(relayFailure("sign-in-cancelled")),
          }),
          Effect.flatMap((query) =>
            finishSignIn({
              relayUrl: endpoints.http,
              provider,
              info,
              seed: keys.seed,
              hostKey: keys.publicKey,
              verifier,
              redirect: listener.redirect,
              query,
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              lastError = error.failure;
            }),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              pendingSignIn = undefined;
              return publish;
            }),
          ),
          Effect.ensuring(closeListener),
          Effect.forkIn(layerScope),
        );
        yield* publish;
        return { authorizeUrl };
      }),
    );
  });

  const signOut = lock
    .withPermit(
      Effect.gen(function* () {
        yield* stopPendingSignIn;
        const account = yield* readAccount;
        const session = hostSession;
        hostSession = undefined;
        const now = yield* Clock.currentTimeMillis;
        // Best effort: the relay's list loses this host while the session lasts. Either way, the
        // host refuses account devices from now on, since it no longer knows an account.
        if (account !== null && session !== undefined && session.expiresAt > now) {
          const keys = yield* Effect.option(identity.getKeypair);
          if (keys._tag === "Some") {
            yield* accountCall(
              session.relayUrl,
              keys.value.seed,
              keys.value.publicKey,
              session.token,
              "/v1/account/hosts/remove",
              [["hostId", relayHostId(keys.value.publicKey)]],
            ).pipe(Effect.ignore);
          }
        }
        yield* fs.remove(accountPath).pipe(Effect.ignore);
        lastError = null;
        yield* publish;
      }),
    )
    .pipe(Effect.withSpan("RelayAccount.signOut"));

  const setApproval = Effect.fn("RelayAccount.setApproval")(function* (input: {
    readonly requireApproval: boolean;
    readonly acknowledgedRisk: boolean;
  }) {
    if (!input.requireApproval && !input.acknowledgedRisk) {
      return yield* relayFailure("risk-not-acknowledged");
    }
    const now = yield* Clock.currentTimeMillis;
    yield* writeFileStringAtomically({
      filePath: approvalPath,
      contents: `${encodeApprovalFile({
        version: 1,
        requireApproval: input.requireApproval,
        optOutAt: input.requireApproval ? null : now,
      })}\n`,
    }).pipe(
      Effect.provide(services),
      Effect.mapError(() => relayFailure("internal")),
    );
    yield* publish;
    return yield* SubscriptionRef.get(output);
  });

  const binding = (relayUrl: string) =>
    Effect.map(readAccount, (account): HostAccountBinding | null => {
      if (account === null || account.relayUrl !== relayUrl) return null;
      const accountKey = decodeBase64url(account.accountKey, 32);
      return accountKey === null
        ? null
        : { issuer: account.issuer, accountId: account.accountId, accountKey };
    });

  yield* refreshProviders.pipe(Effect.andThen(publish), Effect.forkIn(layerScope));
  const settingsChanges = yield* settingsService.subscribeChanges;
  yield* settingsChanges.pipe(
    Stream.runForEach(() => refreshProviders.pipe(Effect.andThen(publish))),
    Effect.forkIn(layerScope),
  );

  return RelayAccount.of({
    state: SubscriptionRef.get(output),
    changes: SubscriptionRef.changes(output),
    signIn: Effect.fn("RelayAccount.signInFromClient")(
      function* (provider: K3RelayAccountProvider) {
        return yield* signIn(provider);
      },
      Effect.provide(services),
      Effect.tapError((error) =>
        Effect.suspend(() => {
          lastError = error.failure;
          return publish;
        }),
      ),
    ),
    signOut: signOut.pipe(Effect.provide(services)),
    setApproval,
    binding,
    approvalPolicy: Effect.map(readApproval, toPolicy),
    setPendingDevice: Effect.fn("RelayAccount.setPendingDevice")(function* (
      device: K3RelayAccountPendingDevice | null,
    ) {
      pendingDevice = device;
      yield* publish;
    }),
  });
});

export const layer = Layer.effect(RelayAccount, make);
