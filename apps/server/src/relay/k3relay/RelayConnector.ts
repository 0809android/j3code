import {
  K3_RELAY_BOOTSTRAP_PATH,
  K3_RELAY_GRANT_PATH,
  K3RelayConnectionError,
  type K3RelayConnectionStatus,
  type K3RelayDevice,
  K3RelayError,
  type K3RelayHostState,
  type K3RelayPairingOffer,
  type K3RelayPairingState,
  type K3RelaySettings,
  type ServerSettings,
  k3RelayE2eeEnvironmentId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Aead from "effect/crypto/Aead";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import {
  MUX_DEFAULT_LIMITS,
  type MuxHttpRequest,
  type MuxHttpResponse,
  type MuxLimits,
  makeMuxHost,
} from "@t3tools/shared/mux";
import {
  type AddDeviceWindow,
  type HostPairingState,
  type LedgerDevice,
  type PairingReplyMessage,
  approvePairing,
  approvalRequired,
  cancelPairing,
  consumeAddDeviceWindow,
  decideAccountApproval,
  decodeBase64url,
  encodeBase64url,
  grantNeedsRenewal,
  grantRegisterFrame,
  initialHostPairingState,
  isAddDeviceWindowOpen,
  issueGrant,
  ledgerVerifyDevice,
  openAddDeviceWindow,
  openPairingWindow,
  pairingCloseFrame,
  pairingOpenFrame,
  rejectPairing,
  relayHostId,
  relaySigningInput,
  signRevocation,
  submitAccountClaim,
  submitPairingClaim,
  tickPairing,
} from "@t3tools/shared/relay";
import {
  type E2eeSessionInfo,
  E2eeRejectedError,
  type E2eeRejectionReason,
  layerE2eeCrypto,
  requireAuthenticatedDevice,
  wrapServerSocketWithE2eeV2,
} from "@t3tools/shared/socketE2ee";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerE2eeIdentity from "../../auth/ServerE2eeIdentity.ts";
import * as ServerConfig from "../../config.ts";
import * as ManagedLimits from "../../policy/managedLimits.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ServerActivation from "../../serverActivation.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import {
  type RelayEndpoints,
  forgetRegistration,
  isRegistered,
  recordRegistration,
  registerHost,
  relayEndpoints,
  signWithHostSeed,
} from "./hostRegistration.ts";
import { captureRelayRouter, makeRelayMuxHandler, type RelayLocalRoute } from "./RelayBridge.ts";
import * as RelayAccount from "./RelayAccount.ts";
import * as RelayDeviceLedger from "./RelayDeviceLedger.ts";
import { relayStateDirectory } from "./RelayDeviceLedger.ts";
import { openRelayWebSocket } from "./relaySockets.ts";

/** An E2E record is at most one 16 KiB fragment plus framing; control frames are small JSON. */
const RELAY_MAX_PAYLOAD = 64 * 1024;
/** Mux frames are at most 16 KiB, so a larger E2E frame is never legitimate. */
const SESSION_MAX_FRAME_BYTES = 64 * 1024;
const PAIRING_MAX_FRAME_BYTES = 16 * 1024;
const PAIRING_CLAIM_TIMEOUT = "60 seconds";
const CONTROL_READY_TIMEOUT = "15 seconds";
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const BOOTSTRAP_MIN_INTERVAL_MS = 5_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/u;
const DATA_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const LABEL_HOST_CONTROL = "k3relay-v1/host-control";

/** Relay close codes (infra/k3-relay README). */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_BLOCKED = 4423;

interface ConnectionView {
  readonly status: K3RelayConnectionStatus;
  readonly error: K3RelayConnectionError | null;
  readonly registered: boolean;
  readonly hostId: string | null;
}

interface LiveSession {
  readonly deviceId: string;
  readonly close: (reason: E2eeRejectionReason) => Effect.Effect<void>;
}

type AuthenticatedSession = Extract<E2eeSessionInfo, { readonly deviceAuthenticated: true }>;

/** Why one control connection ended; the supervisor shows it and reconnects. */
class RelayControlError extends Schema.TaggedError<RelayControlError>()("RelayControlError", {
  error: K3RelayConnectionError,
}) {
  override get message(): string {
    return `The K3 relay control connection ended: ${this.error}.`;
  }
}

const isRelayControlError = Schema.is(RelayControlError);
const isE2eeRejectedError = Schema.is(E2eeRejectedError);

const encodeFrame = (frame: object): string => JSON.stringify(frame);

const relayError = (failure: K3RelayError["failure"]) => new K3RelayError({ failure });

const toDevice = (device: LedgerDevice, sessions: Iterable<LiveSession>): K3RelayDevice => {
  let connectedSessions = 0;
  for (const session of sessions) if (session.deviceId === device.deviceId) connectedSessions += 1;
  return {
    deviceId: device.deviceId,
    name: device.name,
    alg: device.alg,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    status: device.status,
    revokedAt: device.revokedAt,
    connectedSessions,
  };
};

const pairingView = (state: HostPairingState): K3RelayPairingState => {
  switch (state.phase) {
    case "idle":
      return { phase: "idle" };
    case "open":
      return { phase: "open", expiresAt: state.offer.expiresAt };
    case "awaiting-approval":
      return {
        phase: "awaiting-approval",
        deviceId: state.device.deviceId,
        deviceName: state.device.name,
        alg: state.device.alg,
        confirmationCode: state.confirmationCode,
        approvalDeadline: state.approvalDeadline,
      };
    case "closed":
      return { phase: "closed", reason: state.reason };
  }
};

const muxLimitsFor = (settings: K3RelaySettings): Partial<MuxLimits> => ({
  maxBufferedBytes: settings.maxSessionBufferBytes,
  maxStreams: Math.max(
    4,
    Math.min(
      MUX_DEFAULT_LIMITS.maxStreams,
      Math.floor(settings.maxSessionBufferBytes / MUX_DEFAULT_LIMITS.streamWindowBytes),
    ),
  ),
});

const jsonResponse = (status: number, body: unknown): MuxHttpResponse<never> => ({
  status,
  headers: [
    ["content-type", "application/json"],
    ["cache-control", "no-store"],
  ],
  body: JSON.stringify(body),
});

const orInternalError = <E>(effect: Effect.Effect<MuxHttpResponse<never>, E>) =>
  Effect.catchCause(effect, () => Effect.succeed(jsonResponse(500, { error: "internal" })));

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const closeCodeOf = (error: unknown): number | undefined =>
  Socket.isSocketError(error) && error.reason._tag === "SocketCloseError"
    ? error.reason.code
    : undefined;

/**
 * The host's K3 relay connection (spec §3–§8): registers `Hk` with the relay, keeps the control
 * socket up, answers each `session-open` with a data socket, E2EE v2 and the in-process mux
 * bridge, and runs pairing and the device ledger. Off by default, and never started when the
 * managed policy does not allow the relay.
 */
export class RelayConnector extends Context.Service<
  RelayConnector,
  {
    readonly state: Effect.Effect<K3RelayHostState>;
    /** The current state, then every change. */
    readonly changes: Stream.Stream<K3RelayHostState>;
    /** Opens the 5-minute pairing window and the 10-minute "Add device" window. */
    readonly createPairingOffer: Effect.Effect<K3RelayPairingOffer, K3RelayError>;
    readonly cancelPairing: Effect.Effect<void, K3RelayError>;
    /** The user compared the confirmation codes for this device and approved it. */
    readonly approvePairing: (deviceId: string) => Effect.Effect<K3RelayDevice, K3RelayError>;
    readonly rejectPairing: Effect.Effect<void, K3RelayError>;
    readonly revokeDevice: (deviceId: string) => Effect.Effect<K3RelayDevice, K3RelayError>;
    readonly renameDevice: (
      deviceId: string,
      name: string,
    ) => Effect.Effect<K3RelayDevice, K3RelayError>;
  }
>()("t3/relay/k3relay/RelayConnector") {}

const make = Effect.gen(function* () {
  const relayRouter = yield* captureRelayRouter(yield* HttpRouter.HttpRouter);
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const identity = yield* ServerE2eeIdentity.ServerE2eeIdentity;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const ledger = yield* RelayDeviceLedger.RelayDeviceLedger;
  const account = yield* RelayAccount.RelayAccount;
  const http = yield* HttpClient.HttpClient;
  const services = yield* Effect.context<
    Aead.Aead | SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path
  >();
  const layerScope = yield* Effect.scope;
  const policyAllowed = ManagedLimits.allowsRelay(managedPolicy);
  const directory = relayStateDirectory(config.stateDir, path);
  const withServices = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Aead.Aead | SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path
    >,
  ) => Effect.provide(effect, services);

  const connection = yield* Ref.make<ConnectionView>({
    status: "disabled",
    error: policyAllowed ? null : "policy-disallowed",
    registered: false,
    hostId: null,
  });
  const sessions = new Map<string, LiveSession>();
  let activeSessions = 0;
  let controlWriter: ((frame: object) => Effect.Effect<void>) | undefined;
  let endpoints: RelayEndpoints | undefined;

  const pairingLock = yield* Semaphore.make(1);
  let pairing: HostPairingState = initialHostPairingState;
  let addDeviceWindow: AddDeviceWindow | null = null;
  let pendingDecision: Deferred.Deferred<PairingReplyMessage> | undefined;
  let pairingTimer: Fiber.Fiber<void> | undefined;
  const bootstrapIssuedAt = new Map<string, number>();

  const currentSettings = settingsService.getSettings.pipe(Effect.orDie);

  const buildState = Effect.gen(function* () {
    const settings = yield* currentSettings;
    const view = yield* Ref.get(connection);
    const devices = yield* ledger.list.pipe(Effect.orElseSucceed(() => []));
    const live = [...sessions.values()];
    return {
      enabled: settings.relay.enabled,
      policyAllowed,
      transportPolicyAllowed: settings.remoteTransportPolicy === "any",
      relayUrl: settings.relay.url,
      status: view.status,
      error: view.error,
      registered: view.registered,
      hostId: view.hostId,
      activeSessions: live.length,
      connectedDevices: new Set(live.map((session) => session.deviceId)).size,
      maxSessions: settings.relay.maxSessions,
      reachableWhenNetworkAccessOff: policyAllowed && settings.relay.enabled,
      requireApproval: approvalRequired(yield* account.approvalPolicy),
      pairing: pairingView(pairing),
      devices: devices.map((device) => toDevice(device, live)),
    } satisfies K3RelayHostState;
  });

  const output = yield* SubscriptionRef.make(yield* buildState);
  const publishLock = yield* Semaphore.make(1);
  /** The account device waiting for approval, shown on the account's state while it waits. */
  let accountPending: string | undefined;
  const publish = publishLock.withPermit(
    Effect.gen(function* () {
      if (
        accountPending !== undefined &&
        (pairing.phase !== "awaiting-approval" || pairing.device.deviceId !== accountPending)
      ) {
        accountPending = undefined;
        yield* account.setPendingDevice(null);
      }
      yield* SubscriptionRef.set(output, yield* buildState);
    }),
  );
  const setConnection = (patch: Partial<ConnectionView>) =>
    Ref.update(connection, (view) => ({ ...view, ...patch })).pipe(Effect.andThen(publish));

  const sendControl = (frame: object) =>
    Effect.suspend(() => (controlWriter === undefined ? Effect.void : controlWriter(frame)));

  const hostKeys = identity.getKeypair.pipe(
    Effect.map((keypair) => ({ ...keypair, hostId: relayHostId(keypair.publicKey) })),
  );

  // ── Pairing ────────────────────────────────────────────────────────────────

  /** Hands a waiting pairing session its answer; a no-op when nothing waits. */
  const settlePending = (reply: PairingReplyMessage) =>
    Effect.suspend(() => {
      const pending = pendingDecision;
      pendingDecision = undefined;
      return pending === undefined ? Effect.void : Deferred.succeed(pending, reply);
    });

  const stopPairingTimer = Effect.suspend(() => {
    const timer = pairingTimer;
    pairingTimer = undefined;
    return timer === undefined ? Effect.void : Fiber.interrupt(timer);
  });

  /** Applies the pairing clock once the window or the approval deadline passes. */
  const schedulePairingTimer = Effect.fn("RelayConnector.schedulePairingTimer")(function* (
    deadline: number,
  ) {
    yield* stopPairingTimer;
    const now = yield* Clock.currentTimeMillis;
    pairingTimer = yield* Effect.sleep(Math.max(0, deadline - now)).pipe(
      Effect.andThen(
        pairingLock.withPermit(
          Effect.gen(function* () {
            const wasOpen = pairing.phase === "open";
            const next = tickPairing(pairing, yield* Clock.currentTimeMillis);
            if (next === pairing) return;
            pairing = next;
            if (wasOpen) yield* sendControl(pairingCloseFrame());
            yield* settlePending({ type: "pairing-rejected", reason: "expired" });
            yield* publish;
          }),
        ),
      ),
      Effect.forkIn(layerScope),
    );
  });

  const requireUsable = Effect.gen(function* () {
    if (!policyAllowed) return yield* relayError("policy-disallowed");
    const settings = yield* currentSettings;
    if (!settings.relay.enabled) return yield* relayError("disabled");
    const resolved = relayEndpoints(settings.relay.url);
    if (resolved === null) return yield* relayError("internal");
    return resolved;
  });

  const createPairingOffer = pairingLock
    .withPermit(
      Effect.gen(function* () {
        const resolved = yield* requireUsable;
        const keys = yield* hostKeys.pipe(Effect.mapError(() => relayError("internal")));
        const now = yield* Clock.currentTimeMillis;
        yield* settlePending({ type: "pairing-rejected", reason: "rejected" });
        const opened = yield* withServices(
          openPairingWindow({
            hostIdentitySeed: keys.seed,
            relayUrl: resolved.http,
            now,
            previous: pairing,
          }),
        ).pipe(Effect.mapError(() => relayError("internal")));
        pairing = opened.state;
        addDeviceWindow = openAddDeviceWindow({ kind: "host-user" }, now);
        yield* sendControl(pairingOpenFrame(opened.offer));
        yield* schedulePairingTimer(opened.offer.expiresAt);
        yield* publish;
        return {
          link: opened.link,
          relayUrl: opened.offer.relayUrl,
          hostId: opened.offer.hostId,
          hostIdentityKey: encodeBase64url(opened.offer.hostIdentityKey),
          expiresAt: opened.offer.expiresAt,
        } satisfies K3RelayPairingOffer;
      }),
    )
    .pipe(Effect.withSpan("RelayConnector.createPairingOffer"));

  const closePairing = Effect.fn("RelayConnector.closePairing")(function* (
    reply: PairingReplyMessage,
    next: (state: HostPairingState) => HostPairingState,
  ) {
    if (pairing.phase !== "open" && pairing.phase !== "awaiting-approval") {
      return yield* relayError("no-pending-pairing");
    }
    const wasOpen = pairing.phase === "open";
    pairing = next(pairing);
    if (wasOpen) yield* sendControl(pairingCloseFrame());
    yield* settlePending(reply);
    yield* stopPairingTimer;
    yield* publish;
  });

  const cancelPairingWindow = pairingLock
    .withPermit(closePairing({ type: "pairing-rejected", reason: "rejected" }, cancelPairing))
    .pipe(Effect.withSpan("RelayConnector.cancelPairing"));

  const rejectPendingPairing = pairingLock
    .withPermit(
      Effect.suspend(() =>
        pairing.phase === "awaiting-approval"
          ? closePairing(rejectPairing(pairing).reply, (state) => rejectPairing(state).state)
          : closePairing({ type: "pairing-rejected", reason: "rejected" }, cancelPairing),
      ),
    )
    .pipe(Effect.withSpan("RelayConnector.rejectPairing"));

  /** Approves the device waiting in the pairing state. The caller holds `pairingLock`. */
  const approveLocked = Effect.fn("RelayConnector.approveLocked")(function* (deviceId: string) {
    return yield* Effect.gen(function* () {
      if (!policyAllowed) return yield* relayError("policy-disallowed");
      const now = yield* Clock.currentTimeMillis;
      pairing = tickPairing(pairing, now);
      if (pairing.phase !== "awaiting-approval" || pairing.device.deviceId !== deviceId) {
        yield* publish;
        return yield* relayError("no-pending-pairing");
      }
      const waiting = pairing;
      const keys = yield* hostKeys.pipe(Effect.mapError(() => relayError("internal")));
      const credential = yield* auth
        .issueRelayDeviceBootstrapCredential({ deviceId, label: waiting.device.name })
        .pipe(Effect.mapError(() => relayError("internal")));
      const approved = yield* withServices(
        approvePairing(waiting, {
          hostIdentitySeed: keys.seed,
          ledger,
          bootstrapToken: credential.credential,
          now,
        }),
      ).pipe(
        Effect.tapError(() => auth.revokeRelayDevice(deviceId).pipe(Effect.ignore)),
        Effect.mapError(() => relayError("internal")),
      );
      pairing = approved.state;
      if (addDeviceWindow !== null) addDeviceWindow = consumeAddDeviceWindow(addDeviceWindow);
      yield* sendControl(approved.relayFrame);
      yield* settlePending(approved.reply);
      yield* stopPairingTimer;
      yield* publish;
      return toDevice(approved.device, sessions.values());
    });
  });

  const approveDevice = Effect.fn("RelayConnector.approvePairing")(function* (deviceId: string) {
    return yield* pairingLock.withPermit(approveLocked(deviceId));
  });

  /**
   * A claim inside an anonymous session opened through an account (`?account=1`, spec §20.3).
   * Unlike QR pairing it needs no open window: it waits for the user with codes to compare. The
   * relay's ticket is checked against the account this host signed in to; only a recorded
   * opt-out approves without the user.
   */
  const receiveAccountClaim = (transcriptHash: Uint8Array, message: unknown) =>
    pairingLock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const relayUrl = endpoints?.http;
        const keys = yield* Effect.option(hostKeys);
        const binding = relayUrl === undefined ? null : yield* account.binding(relayUrl);
        if (relayUrl === undefined || keys._tag === "None") {
          return { reply: { type: "pairing-rejected", reason: "rejected" } } as const satisfies {
            reply: PairingReplyMessage;
          };
        }
        const wasOpen = pairing.phase === "open";
        const result = submitAccountClaim(pairing, {
          transcriptHash,
          message,
          now,
          relayUrl,
          hostIdentityKey: keys.value.publicKey,
          binding,
        });
        if (result.outcome.kind === "rejected") {
          const reason =
            result.outcome.reason === "not-on-account" ? "invalid-claim" : result.outcome.reason;
          return { reply: { type: "pairing-rejected", reason } } as const satisfies {
            reply: PairingReplyMessage;
          };
        }
        pairing = result.state;
        if (wasOpen) yield* sendControl(pairingCloseFrame());
        const deviceId = result.outcome.state.device.deviceId;
        const decision = decideAccountApproval({
          policy: yield* account.approvalPolicy,
          window: addDeviceWindow,
          now,
        });
        const pending = yield* Deferred.make<PairingReplyMessage>();
        pendingDecision = pending;
        if (decision.kind === "auto-approve") {
          // `approveLocked` answers through `pendingDecision`, as a user's approval does.
          const approved = yield* Effect.result(approveLocked(deviceId));
          if (approved._tag === "Failure") {
            if (pendingDecision === pending) pendingDecision = undefined;
            pairing = cancelPairing(pairing);
            yield* publish;
            return { reply: { type: "pairing-rejected", reason: "rejected" } } as const satisfies {
              reply: PairingReplyMessage;
            };
          }
          return { decision: pending } as const;
        }
        accountPending = deviceId;
        yield* account.setPendingDevice({ deviceId, oneTap: decision.kind === "one-tap" });
        yield* schedulePairingTimer(result.outcome.state.approvalDeadline);
        yield* publish;
        return { decision: pending } as const;
      }),
    );

  /**
   * A claim that arrived inside an anonymous pairing session. Only claims made while the host's
   * "Add device" window is open are considered; a verified one waits for the user's decision.
   */
  const receiveClaim = (transcriptHash: Uint8Array, message: unknown) =>
    pairingLock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (!isAddDeviceWindowOpen(addDeviceWindow, now)) {
          return {
            reply: { type: "pairing-rejected", reason: "no-window" },
          } as const satisfies { reply: PairingReplyMessage };
        }
        const wasOpen = pairing.phase === "open";
        const result = submitPairingClaim(pairing, { transcriptHash, message, now });
        pairing = result.state;
        if (result.outcome.kind === "rejected") {
          if (wasOpen && result.state.phase === "closed") {
            yield* sendControl(pairingCloseFrame());
            yield* stopPairingTimer;
          }
          yield* publish;
          return { reply: result.outcome.reply } as const;
        }
        const decision = yield* Deferred.make<PairingReplyMessage>();
        pendingDecision = decision;
        // `S` is spent: the relay need not admit more pairing connections.
        yield* sendControl(pairingCloseFrame());
        if (pairing.phase === "awaiting-approval") {
          yield* schedulePairingTimer(pairing.approvalDeadline);
        }
        yield* publish;
        return { decision } as const;
      }),
    );

  /** The pairing session dropped while waiting; its device can no longer receive a grant. */
  const abandonClaim = (decision: Deferred.Deferred<PairingReplyMessage>) =>
    pairingLock.withPermit(
      Effect.gen(function* () {
        if (pendingDecision !== decision) return;
        pendingDecision = undefined;
        pairing = cancelPairing(pairing);
        yield* stopPairingTimer;
        yield* publish;
      }),
    );

  const servePairing = Effect.fn("RelayConnector.servePairing")(function* (
    socket: Socket.Socket,
    seed: Uint8Array,
    hostId: string,
    route: "qr" | "account",
  ) {
    const e2ee = yield* wrapServerSocketWithE2eeV2(socket, {
      environmentId: k3RelayE2eeEnvironmentId(hostId),
      identitySeed: seed,
      // Pairing sessions are anonymous; a device that authenticates here has no business pairing.
      verifyDevice: () => Effect.fail(new E2eeRejectedError({ reason: "host-policy" })),
      requireDeviceAuth: false,
      requireGrant: false,
      acceptV1: false,
      maxFrameBytes: PAIRING_MAX_FRAME_BYTES,
    });
    const reader = yield* e2ee.reader;
    const info = yield* e2ee.sessionInfo;
    if (info.version !== 2 || info.deviceAuthenticated) {
      return yield* e2ee.closeWithReason("host-policy");
    }
    const writer = yield* e2ee.writer;
    const frames = yield* reader.pull.pipe(Effect.timeout(PAIRING_CLAIM_TIMEOUT));
    const first = frames[0];
    const message = typeof first === "string" ? parseJson(first) : undefined;
    if (route === "account") {
      const received = yield* receiveAccountClaim(info.transcriptHash, message);
      let reply: PairingReplyMessage;
      if ("reply" in received) {
        reply = received.reply;
      } else {
        const answered = yield* Effect.raceFirst(
          Deferred.await(received.decision).pipe(Effect.asSome),
          reader.pull.pipe(Effect.ignore, Effect.as(Option.none<PairingReplyMessage>())),
        );
        if (Option.isNone(answered)) return yield* abandonClaim(received.decision);
        reply = answered.value;
      }
      yield* writer.write(encodeFrame(reply));
      return yield* writer.write(new Socket.CloseEvent(1000));
    }
    const received = yield* receiveClaim(info.transcriptHash, message);
    let reply: PairingReplyMessage;
    if ("reply" in received) {
      reply = received.reply;
    } else {
      const answered = yield* Effect.raceFirst(
        Deferred.await(received.decision).pipe(Effect.asSome),
        // Anything more from the device, or its close, ends the claim.
        reader.pull.pipe(Effect.ignore, Effect.as(Option.none<PairingReplyMessage>())),
      );
      if (Option.isNone(answered)) return yield* abandonClaim(received.decision);
      reply = answered.value;
    }
    yield* writer.write(encodeFrame(reply));
    yield* writer.write(new Socket.CloseEvent(1000));
  });

  // ── Device sessions ────────────────────────────────────────────────────────

  const verifyActiveDevice = ledgerVerifyDevice(ledger);

  const renewGrant = Effect.fn("RelayConnector.renewGrant")(function* (info: AuthenticatedSession) {
    const now = yield* Clock.currentTimeMillis;
    if (info.grant !== undefined && !grantNeedsRenewal(info.grant, now)) {
      return jsonResponse(200, { grant: null });
    }
    const keys = yield* hostKeys;
    const grant = yield* withServices(
      issueGrant({
        hostIdentitySeed: keys.seed,
        alg: info.device.alg,
        devicePublicKey: info.device.publicKey,
        now,
      }),
    );
    yield* sendControl(grantRegisterFrame(grant, info.device.publicKey));
    return jsonResponse(200, { grant });
  });

  const issueBootstrap = Effect.fn("RelayConnector.issueBootstrap")(function* (
    info: AuthenticatedSession,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const deviceId = info.device.deviceId;
    const last = bootstrapIssuedAt.get(deviceId);
    if (last !== undefined && now - last < BOOTSTRAP_MIN_INTERVAL_MS) {
      return jsonResponse(429, { error: "too-many-requests" });
    }
    const device = yield* ledger.get(deviceId);
    if (device === undefined) return jsonResponse(403, { error: "unknown-device" });
    bootstrapIssuedAt.set(deviceId, now);
    const issued = yield* auth.issueRelayDeviceBootstrapCredential({
      deviceId,
      label: device.name,
    });
    return jsonResponse(200, {
      bootstrapToken: issued.credential,
      expiresAt: issued.expiresAt.epochMilliseconds,
    });
  });

  /** The device-only routes; each call first re-checks the ledger, which may have changed. */
  const localRoutes =
    (info: AuthenticatedSession): RelayLocalRoute =>
    (request: MuxHttpRequest) => {
      const pathname = request.path.split("?")[0];
      if (pathname !== K3_RELAY_GRANT_PATH && pathname !== K3_RELAY_BOOTSTRAP_PATH) {
        return undefined;
      }
      if (request.method.toUpperCase() !== "POST") {
        return Effect.succeed(jsonResponse(405, { error: "method-not-allowed" }));
      }
      const route =
        pathname === K3_RELAY_GRANT_PATH
          ? orInternalError(renewGrant(info))
          : orInternalError(issueBootstrap(info));
      return verifyActiveDevice(info.device).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed(jsonResponse(403, { error: error.reason })),
          onSuccess: () => route,
        }),
      );
    };

  const serveDevice = Effect.fn("RelayConnector.serveDevice")(function* (
    sessionId: string,
    socket: Socket.Socket,
    seed: Uint8Array,
    hostId: string,
    relaySettings: K3RelaySettings,
  ) {
    let reserved = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (reserved) activeSessions -= 1;
      }),
    );
    const e2ee = yield* wrapServerSocketWithE2eeV2(socket, {
      environmentId: k3RelayE2eeEnvironmentId(hostId),
      identitySeed: seed,
      verifyDevice: (device) =>
        verifyActiveDevice(device).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (activeSessions >= relaySettings.maxSessions) {
                return Effect.fail(new E2eeRejectedError({ reason: "limit" }));
              }
              activeSessions += 1;
              reserved = true;
              return Effect.void;
            }),
          ),
        ),
      requireDeviceAuth: true,
      requireGrant: true,
      acceptV1: false,
      maxFrameBytes: SESSION_MAX_FRAME_BYTES,
    });
    const authenticated: Effect.Effect<AuthenticatedSession, Socket.SocketError> =
      e2ee.sessionInfo.pipe(
        Effect.filterOrElse(
          (info: E2eeSessionInfo): info is AuthenticatedSession => info.deviceAuthenticated,
          () => Effect.die("The relay session is not device-authenticated."),
        ),
      );
    const mux = yield* makeMuxHost({
      socket: requireAuthenticatedDevice(e2ee),
      handler: (open, stream) =>
        Effect.flatMap(authenticated, (info) =>
          makeRelayMuxHandler({
            relay: relayRouter,
            deviceId: info.device.deviceId,
            local: localRoutes(info),
          })(open, stream),
        ),
      limits: muxLimitsFor(relaySettings),
    });
    const info = yield* authenticated;
    const deviceId = info.device.deviceId;
    sessions.set(sessionId, {
      deviceId,
      close: (reason) => Effect.ignore(e2ee.closeWithReason(reason)),
    });
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        sessions.delete(sessionId);
        return publish;
      }),
    );
    // A revocation that landed during the handshake must still cut this session.
    const recheck = yield* Effect.exit(verifyActiveDevice(info.device));
    if (Exit.isFailure(recheck)) {
      const failure = Option.getOrUndefined(Exit.findErrorOption(recheck));
      return yield* Effect.ignore(
        e2ee.closeWithReason(isE2eeRejectedError(failure) ? failure.reason : "host-policy"),
      );
    }
    yield* ledger.markSeen(deviceId, yield* Clock.currentTimeMillis).pipe(Effect.ignore);
    yield* publish;
    yield* mux.closed;
  });

  const serveSession = (
    endpoint: RelayEndpoints,
    frame: { readonly sessionId: string; readonly token: string; readonly kind: string },
    seed: Uint8Array,
    hostId: string,
    relaySettings: K3RelaySettings,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* openRelayWebSocket(
          `${endpoint.ws}/v1/host/data/${frame.sessionId}?t=${frame.token}`,
          { maxPayload: RELAY_MAX_PAYLOAD },
        );
        if (frame.kind === "pairing") return yield* servePairing(socket, seed, hostId, "qr");
        if (frame.kind === "account") return yield* servePairing(socket, seed, hostId, "account");
        return yield* serveDevice(frame.sessionId, socket, seed, hostId, relaySettings);
      }),
    ).pipe(
      withServices,
      Effect.catchCause((cause) =>
        Effect.logDebug("K3 relay session ended", { kind: frame.kind, cause }),
      ),
    );

  // ── Control connection ─────────────────────────────────────────────────────

  const connectOnce = (
    endpoint: RelayEndpoints,
    seed: Uint8Array,
    hostId: string,
    relaySettings: K3RelaySettings,
    onReady: Effect.Effect<void>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (!(yield* isRegistered(directory, endpoint, hostId))) {
          yield* registerHost(endpoint, seed).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.mapError(() => new RelayControlError({ error: "registration-failed" })),
          );
          yield* recordRegistration(
            directory,
            endpoint,
            hostId,
            yield* Clock.currentTimeMillis,
          ).pipe(Effect.mapError(() => new RelayControlError({ error: "registration-failed" })));
        }
        yield* setConnection({ registered: true });
        const socket = yield* openRelayWebSocket(`${endpoint.ws}/v1/host/control`, {
          maxPayload: RELAY_MAX_PAYLOAD,
        });
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        const queued: Array<string | Uint8Array> = [];
        const nextMessage = Effect.gen(function* () {
          if (queued.length === 0) queued.push(...(yield* reader.pull));
          const frame = queued.shift();
          const value = typeof frame === "string" ? parseJson(frame) : undefined;
          return typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {};
        });
        const challenge = yield* nextMessage.pipe(Effect.timeout(CONTROL_READY_TIMEOUT));
        const nonce = decodeBase64url(challenge.nonce, 32);
        if (challenge.type !== "nonce" || nonce === null) {
          return yield* new RelayControlError({ error: "network" });
        }
        const sig = signWithHostSeed(seed, relaySigningInput(LABEL_HOST_CONTROL, hostId, nonce));
        yield* writer.write(encodeFrame({ type: "auth", hostId, sig: encodeBase64url(sig) }));
        const ready = yield* nextMessage.pipe(Effect.timeout(CONTROL_READY_TIMEOUT));
        if (ready.type !== "ready") return yield* new RelayControlError({ error: "unauthorized" });
        controlWriter = (frame) => writer.write(encodeFrame(frame)).pipe(Effect.ignore);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            controlWriter = undefined;
          }),
        );
        yield* onReady;
        yield* setConnection({ status: "connected", error: null });
        if (pairing.phase === "open") yield* sendControl(pairingOpenFrame(pairing.offer));
        while (true) {
          const message = yield* nextMessage;
          if (message.type !== "session-open") continue;
          const { sessionId, token, kind } = message;
          if (
            typeof sessionId !== "string" ||
            typeof token !== "string" ||
            (kind !== "client" && kind !== "pairing" && kind !== "account") ||
            !SESSION_ID_PATTERN.test(sessionId) ||
            !DATA_TOKEN_PATTERN.test(token)
          ) {
            continue;
          }
          yield* Effect.forkScoped(
            serveSession(endpoint, { sessionId, token, kind }, seed, hostId, relaySettings),
          );
        }
      }),
    ).pipe(
      Effect.catch((error) => {
        if (isRelayControlError(error)) return Effect.fail(error);
        const code = closeCodeOf(error);
        if (code === CLOSE_UNAUTHORIZED) {
          // The relay no longer knows this host (a reset database): register again next time.
          return forgetRegistration(directory).pipe(
            Effect.andThen(Effect.fail(new RelayControlError({ error: "unauthorized" }))),
          );
        }
        return Effect.fail(
          new RelayControlError({ error: code === CLOSE_BLOCKED ? "blocked" : "network" }),
        );
      }),
    );

  /** Keeps the control connection up for one settings value, with backoff and jitter. */
  const superviseConnection = Effect.fn("RelayConnector.superviseConnection")(function* (
    relaySettings: K3RelaySettings,
  ) {
    const resolved = relayEndpoints(relaySettings.url);
    endpoints = resolved ?? undefined;
    if (resolved === null) {
      return yield* setConnection({ status: "error", error: "invalid-url" });
    }
    const keys = yield* Effect.result(hostKeys);
    if (keys._tag === "Failure") {
      return yield* setConnection({ status: "error", error: "identity-unavailable" });
    }
    const { seed, hostId } = keys.success;
    let attempt = 0;
    while (true) {
      yield* setConnection({ status: "connecting", hostId });
      const exit = yield* Effect.exit(
        connectOnce(
          resolved,
          seed,
          hostId,
          relaySettings,
          Effect.sync(() => {
            attempt = 0;
          }),
        ),
      );
      const error =
        Exit.isFailure(exit) && Option.isSome(Exit.findErrorOption(exit))
          ? Option.getOrThrow(Exit.findErrorOption(exit)).error
          : "network";
      yield* setConnection({
        status: error === "network" ? "disconnected" : "error",
        error,
        ...(error === "registration-failed" || error === "unauthorized"
          ? { registered: false }
          : {}),
      });
      const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
      attempt = Math.min(attempt + 1, 16);
      yield* Effect.sleep(yield* Random.nextIntBetween(ceiling / 2, ceiling));
    }
  }, withServices);

  let running: Fiber.Fiber<void> | undefined;
  let appliedKey: string | undefined;
  const applySettings = Effect.fn("RelayConnector.applySettings")(function* (
    settings: ServerSettings,
  ) {
    const key = encodeFrame(settings.relay);
    if (key === appliedKey) return yield* publish;
    appliedKey = key;
    // Tell connected devices why before their sockets go with the connection.
    const live = [...sessions.values()];
    for (const session of live) yield* session.close("host-policy");
    if (running !== undefined) yield* Fiber.interrupt(running);
    running = undefined;
    if (!policyAllowed || !settings.relay.enabled) {
      return yield* setConnection({
        status: "disabled",
        error: policyAllowed ? null : "policy-disallowed",
      });
    }
    running = yield* Effect.forkIn(superviseConnection(settings.relay), layerScope);
  });

  // The approval policy lives with the account; the relay state shows it too.
  yield* account.changes.pipe(
    Stream.drop(1),
    Stream.runForEach(() => publish),
    Effect.forkIn(layerScope),
  );
  const settingsChanges = yield* settingsService.subscribeChanges;
  // A standby server (during an update) shares this host key; connecting would evict the
  // active server's control socket, so the relay waits for activation.
  yield* ServerActivation.forkParked(
    Effect.gen(function* () {
      yield* applySettings(yield* currentSettings);
      yield* settingsChanges.pipe(Stream.runForEach(applySettings));
    }),
  );
  yield* Scope.addFinalizer(
    layerScope,
    Effect.suspend(() => (running === undefined ? Effect.void : Fiber.interrupt(running))),
  );

  // ── Ledger operations ──────────────────────────────────────────────────────

  const revokeDevice = Effect.fn("RelayConnector.revokeDevice")(function* (deviceId: string) {
    if (!policyAllowed) return yield* relayError("policy-disallowed");
    const now = yield* Clock.currentTimeMillis;
    const device = yield* ledger
      .revoke(deviceId, now)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "DeviceLedgerError"
            ? relayError("unknown-device")
            : relayError("internal"),
        ),
      );
    const keys = yield* hostKeys.pipe(Effect.mapError(() => relayError("internal")));
    const revocation = yield* signRevocation({ hostIdentitySeed: keys.seed, deviceId, now }).pipe(
      Effect.mapError(() => relayError("internal")),
    );
    if (controlWriter !== undefined) {
      yield* controlWriter({ type: "revoke", ...revocation });
    } else if (endpoints !== undefined) {
      // The relay's copy is advisory; the host ledger already refuses the device.
      yield* http
        .execute(
          HttpClientRequest.post(`${endpoints.http}/v1/grants/revoke`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ hostId: keys.hostId, ...revocation }),
          ),
        )
        .pipe(Effect.ignore);
    }
    yield* auth.revokeRelayDevice(deviceId).pipe(Effect.mapError(() => relayError("internal")));
    // Closing a session removes it from the map, so take the list first.
    const live = [...sessions.values()].filter((session) => session.deviceId === deviceId);
    for (const session of live) yield* session.close("revoked");
    yield* publish;
    return toDevice(device, sessions.values());
  });

  const renameDevice = Effect.fn("RelayConnector.renameDevice")(function* (
    deviceId: string,
    name: string,
  ) {
    const device = yield* ledger
      .rename(deviceId, name)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "DeviceLedgerError"
            ? relayError(error.reason === "invalid-name" ? "invalid-name" : "unknown-device")
            : relayError("internal"),
        ),
      );
    yield* publish;
    return toDevice(device, sessions.values());
  });

  return RelayConnector.of({
    state: SubscriptionRef.get(output),
    changes: SubscriptionRef.changes(output),
    createPairingOffer,
    cancelPairing: cancelPairingWindow,
    approvePairing: approveDevice,
    rejectPairing: rejectPendingPairing,
    revokeDevice,
    renameDevice,
  });
});

export const layer = Layer.effect(RelayConnector, make).pipe(
  // One account service, shared with the RPC handlers that sign the host in.
  Layer.provideMerge(RelayAccount.layer),
  Layer.provide(RelayDeviceLedger.layer),
  Layer.provide(layerE2eeCrypto),
);
