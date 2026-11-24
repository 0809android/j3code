import {
  ProviderSetupError,
  TrimmedNonEmptyString,
  type ProviderAuthState,
  type ProviderInstanceId,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const OPENDESIGN_API_URL = "https://amr-api.open-design.ai";
export const OPENDESIGN_EXTERNAL_USAGE = {
  label: "OpenDesign Cloud",
  url: "https://open-design.ai/cloud",
} as const;

const OPENDESIGN_CLI_VERSION = "0.1.4";
const AUTH_TIMEOUT_MS = 600_000;

export const OpenDesignCredentials = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    controlKey: TrimmedNonEmptyString,
    runtimeKey: Schema.optionalKey(TrimmedNonEmptyString),
    accountId: Schema.optionalKey(TrimmedNonEmptyString),
    email: Schema.optionalKey(TrimmedNonEmptyString),
  }),
);
export type OpenDesignCredentials = typeof OpenDesignCredentials.Type;

const decodeOpenDesignCredentials = Schema.decodeUnknownEffect(OpenDesignCredentials);
const encodeOpenDesignCredentials = Schema.encodeEffect(OpenDesignCredentials);

const DeviceAuthStartResponse = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  deviceSecret: TrimmedNonEmptyString,
  activationUrl: TrimmedNonEmptyString,
  pollIntervalSeconds: Schema.optionalKey(Schema.Number),
});

const DeviceAuthTokenResponse = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  runtimeKey: Schema.optionalKey(Schema.String),
  controlKey: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.NullOr(Schema.String)),
      appUserId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      email: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

const WorkspaceCurrentResponse = Schema.Struct({
  workspaceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  activeWorkspaceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  workspace: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        workspaceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        id: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const PreflightWindow = Schema.Struct({
  durationSeconds: Schema.Number,
  usedCredits: Schema.Union([Schema.String, Schema.Number]),
  limitCredits: Schema.Union([Schema.String, Schema.Number]),
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const PreflightResponse = Schema.Struct({
  workspaceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  balanceUsd: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  codingPlan: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        eligible: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
        tier: Schema.optionalKey(Schema.NullOr(Schema.String)),
        windows: Schema.optionalKey(Schema.NullOr(Schema.Array(PreflightWindow))),
      }),
    ),
  ),
});

const decodeWorkspaceCurrent = HttpClientResponse.schemaBodyJson(WorkspaceCurrentResponse);
const decodePreflight = HttpClientResponse.schemaBodyJson(PreflightResponse);

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function titleCaseTier(tier: string): string {
  const trimmed = tier.trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** 公式の OpenDesign デバイス認証 URL のみを許可する。 */
export function isOfficialOpenDesignActivationUrl(raw: string): boolean {
  const parsed = URL.parse(raw);
  if (!parsed) return false;
  return (
    parsed.protocol === "https:" &&
    parsed.hostname.toLowerCase() === "open-design.ai" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname.startsWith("/cloud/cli/activate")
  );
}

/** デバイス認証レスポンスから OpenDesign ユーザー識別情報を抽出する。 */
export function parseOpenDesignProfile(
  user:
    | {
        readonly id?: string | null | undefined;
        readonly appUserId?: string | null | undefined;
        readonly email?: string | null | undefined;
      }
    | null
    | undefined,
): { readonly accountId?: string; readonly email?: string } | null {
  if (!user) return null;
  const email = trimNonEmpty(user.email);
  const accountId = trimNonEmpty(user.id) ?? trimNonEmpty(user.appUserId);
  if (!email && !accountId) return null;
  return {
    ...(accountId === undefined ? {} : { accountId }),
    ...(email === undefined ? {} : { email }),
  };
}

/** クレジット文字列または非負整数から数値へ変換する。 */
function openDesignCreditAmount(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && Number.isInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 秒数に応じたウィンドウ種別と表示ラベルを返す。 */
function openDesignWindowPresentation(durationSeconds: number): {
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
} {
  if (durationSeconds === 18_000) return { kind: "session", label: "OpenDesign · 5-hour" };
  if (durationSeconds === 604_800) return { kind: "weekly", label: "OpenDesign · 7-day" };
  if (durationSeconds % 86_400 === 0) {
    return { kind: "other", label: `OpenDesign · ${durationSeconds / 86_400}-day` };
  }
  if (durationSeconds % 3_600 === 0) {
    return { kind: "other", label: `OpenDesign · ${durationSeconds / 3_600}-hour` };
  }
  return {
    kind: "other",
    label: `OpenDesign · ${Math.max(1, Math.round(durationSeconds / 60))}m`,
  };
}

function parseBalanceUsd(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatOpenDesignPlanLabel(tier: string | undefined, balanceUsd: number | null): string {
  const tierLabel = tier ? titleCaseTier(tier) : undefined;
  const balanceText = balanceUsd !== null ? `$${balanceUsd.toFixed(2)}` : undefined;
  const parts = ["OpenDesign", tierLabel, balanceText].filter(Boolean);
  return parts.join(" · ");
}

/** API レスポンス形式の揺れを吸収するため候補フィールドを優先順で辿る。 */
function extractOpenDesignWorkspaceId(
  data: Schema.Schema.Type<typeof WorkspaceCurrentResponse>,
): string | undefined {
  return (
    trimNonEmpty(data.workspaceId) ??
    trimNonEmpty(data.activeWorkspaceId) ??
    trimNonEmpty(data.workspace?.workspaceId) ??
    trimNonEmpty(data.workspace?.id) ??
    trimNonEmpty(data.id)
  );
}

/** `billing/preflight` レスポンスを T3 Code の使用量上限構造へ変換する。 */
export function parseOpenDesignPreflight(
  data: Schema.Schema.Type<typeof PreflightResponse>,
  expectedWorkspaceId: string,
  options: {
    readonly checkedAt: string;
    readonly credentialFingerprint?: string;
  },
): {
  readonly limits: ServerProviderUsageLimits;
  readonly planLabel: string;
  readonly balanceUsd: number | null;
} {
  const actualWorkspaceId = trimNonEmpty(data.workspaceId);
  if (actualWorkspaceId !== undefined && actualWorkspaceId !== expectedWorkspaceId) {
    throw new Error("OpenDesign preflight returned mismatched workspace.");
  }

  const balanceUsd = parseBalanceUsd(data.balanceUsd);
  const tier = trimNonEmpty(data.codingPlan?.tier);
  const planLabel = formatOpenDesignPlanLabel(tier, balanceUsd);
  const fingerprintPatch =
    options.credentialFingerprint === undefined
      ? {}
      : { credentialFingerprint: options.credentialFingerprint };

  const validWindows = (data.codingPlan?.windows ?? [])
    .flatMap((window) => {
      if (!Number.isFinite(window.durationSeconds) || window.durationSeconds <= 0) return [];
      const limit = openDesignCreditAmount(window.limitCredits);
      const used = openDesignCreditAmount(window.usedCredits);
      if (limit === null || limit <= 0 || used === null || used < 0) return [];
      const durationSeconds = Math.round(window.durationSeconds);
      const { kind, label } = openDesignWindowPresentation(durationSeconds);
      const resetParsed = trimNonEmpty(window.resetsAt)
        ? DateTime.make(window.resetsAt!.trim())
        : Option.none();
      const resetsAt = Option.isSome(resetParsed)
        ? DateTime.formatIso(resetParsed.value)
        : undefined;
      return [
        {
          durationSeconds,
          window: {
            id: `opendesign_${durationSeconds}`,
            kind,
            label,
            providerIds: ["open-design"],
            windowDurationMins: Math.max(1, Math.round(durationSeconds / 60)),
            usedPercent: clampPercent((used / limit) * 100),
            ...(resetsAt === undefined ? {} : { resetsAt }),
          } satisfies ServerProviderUsageWindow,
        },
      ];
    })
    .toSorted((left, right) => left.durationSeconds - right.durationSeconds)
    .map((entry) => entry.window);

  if (validWindows.length === 0) {
    const balanceText = balanceUsd !== null ? `$${balanceUsd.toFixed(2)}` : undefined;
    return {
      planLabel,
      balanceUsd,
      limits: {
        ...makeUnavailableUsageLimits({
          checkedAt: options.checkedAt,
          reason: "unsupported",
          message:
            balanceText !== undefined
              ? `OpenDesign wallet balance: ${balanceText}`
              : "No active OpenDesign coding plan windows.",
        }),
        ...fingerprintPatch,
        externalUsage: OPENDESIGN_EXTERNAL_USAGE,
      },
    };
  }

  return {
    planLabel,
    balanceUsd,
    limits: {
      ...makeUsageLimits({ checkedAt: options.checkedAt, windows: validWindows }),
      ...fingerprintPatch,
      externalUsage: OPENDESIGN_EXTERNAL_USAGE,
    },
  };
}

export interface OpenDesignCredentialStore {
  readonly binding: { readonly owner: "t3"; readonly key: string };
  readonly load: Effect.Effect<OpenDesignCredentials | undefined>;
  readonly save: (credentials: OpenDesignCredentials) => Effect.Effect<void, ProviderSetupError>;
  readonly clear: Effect.Effect<void, ProviderSetupError>;
}

export const makeOpenDesignCredentialStore = Effect.fn("makeOpenDesignCredentialStore")(function* (
  instanceId: ProviderInstanceId,
) {
  const credentials = yield* (yield* ProviderHost.ProviderHost).credentials(
    "opencode-opendesign",
    instanceId,
  );
  const load = credentials.get.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.undefined,
        onSome: (bytes) =>
          decodeOpenDesignCredentials(new TextDecoder().decode(bytes)).pipe(
            Effect.orElseSucceed(() => undefined),
          ),
      }),
    ),
    Effect.orElseSucceed(() => undefined),
  );
  const save = Effect.fn("OpenDesignCredentialStore.save")(function* (
    value: OpenDesignCredentials,
  ) {
    const encoded = yield* encodeOpenDesignCredentials(value).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation: "credentials",
            detail: "OpenDesign returned an unsupported credential format.",
          }),
      ),
    );
    yield* credentials.set(new TextEncoder().encode(encoded)).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId,
            operation: "credentials",
            detail: "Could not save the OpenDesign sign-in. Try again.",
            cause,
          }),
      ),
    );
  });
  const clear = credentials.remove.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderSetupError({
          instanceId,
          operation: "logout",
          detail: "Could not clear the OpenDesign sign-in. Try again.",
          cause,
        }),
    ),
  );
  return {
    binding: credentials.binding,
    load,
    save,
    clear,
  } satisfies OpenDesignCredentialStore;
});

function resolveOpenDesignApiBaseUrl(environment?: NodeJS.ProcessEnv, override?: string): string {
  const raw = trimNonEmpty(override) ?? trimNonEmpty(environment?.OPENDESIGN_API_URL);
  return (raw ?? OPENDESIGN_API_URL).replace(/\/+$/, "");
}

export interface OpenDesignUsageResult {
  readonly limits: ServerProviderUsageLimits;
  readonly planLabel: string;
  readonly workspaceId?: string;
}

/** OpenDesign ワークスペースとコーディングプラン使用量を読み取る。 */
export const readOpenDesignUsageLimits = Effect.fn("readOpenDesignUsageLimits")(function* (input: {
  readonly controlKey: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly apiBaseUrl?: string;
}): Effect.fn.Return<OpenDesignUsageResult, never, HttpClient.HttpClient | Digest.Digest> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const baseUrl = resolveOpenDesignApiBaseUrl(input.environment, input.apiBaseUrl);
  const httpClient = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;

  const getJson = Effect.fn("getJson")(function* (
    url: string,
    extraHeaders?: Record<string, string>,
  ) {
    let req = HttpClientRequest.get(url).pipe(
      HttpClientRequest.bearerToken(input.controlKey),
      HttpClientRequest.setHeader("Accept", "application/json"),
    );
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        req = HttpClientRequest.setHeader(req, key, value);
      }
    }
    const res = yield* httpClient.execute(req);
    if (res.status === 401 || res.status === 403) {
      return yield* Effect.fail({
        kind: "unauthorized" as const,
        status: res.status,
      });
    }
    return yield* HttpClientResponse.filterStatusOk(res);
  });

  return yield* Effect.gen(function* () {
    const workspaceRes = yield* getJson(`${baseUrl}/api/v1/workspaces/current`);
    const current = yield* decodeWorkspaceCurrent(workspaceRes);
    const workspaceId = extractOpenDesignWorkspaceId(current);
    if (!workspaceId) {
      return {
        planLabel: "OpenDesign",
        limits: {
          ...makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "OpenDesign returned no active workspace.",
          }),
          externalUsage: OPENDESIGN_EXTERNAL_USAGE,
        },
      } as OpenDesignUsageResult;
    }

    const preflightRes = yield* getJson(
      `${baseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/preflight`,
      { "x-vela-workspace-id": workspaceId },
    );
    const preflight = yield* decodePreflight(preflightRes);
    const rawFingerprint = yield* digest.digest(
      Digest.sha256,
      new TextEncoder().encode(`opendesign\0${workspaceId}`),
    );
    const credentialFingerprint = Hex.encode(rawFingerprint);
    const parsed = parseOpenDesignPreflight(preflight, workspaceId, {
      checkedAt,
      credentialFingerprint,
    });
    return {
      limits: parsed.limits,
      planLabel: parsed.planLabel,
      workspaceId,
    } as OpenDesignUsageResult;
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catch((error) => {
      const unauthorized =
        typeof error === "object" &&
        error !== null &&
        "kind" in error &&
        error.kind === "unauthorized";
      return Effect.succeed<OpenDesignUsageResult>({
        planLabel: "OpenDesign",
        limits: {
          ...makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: unauthorized
              ? "OpenDesign sign-in expired. Sign in again."
              : "OpenDesign usage request failed.",
          }),
          externalUsage: OPENDESIGN_EXTERNAL_USAGE,
        },
      });
    }),
  );
});

interface AuthFlow {
  readonly id: string;
  readonly owner: string;
  fiber?: Fiber.Fiber<void>;
}

export interface OpenDesignAuth {
  readonly controller: ProviderAuthController;
  readonly usesControlKeyEnv: boolean;
  readonly resolveControlKey: Effect.Effect<{
    readonly controlKey: string | undefined;
    readonly email: string | undefined;
    readonly source: "env" | "oauth" | "none";
  }>;
}

export interface OpenDesignAuthOptions {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly apiBaseUrl?: string;
  readonly store: OpenDesignCredentialStore;
  readonly onChanged: (signedIn: boolean) => Effect.Effect<void, ProviderSetupError>;
}

function clampPollSeconds(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 2;
  return Math.min(10, Math.max(1, Math.round(raw)));
}

/** OpenDesign デバイス認可フローを管理する `ProviderAuthController` を生成する。 */
export const makeOpenDesignAuth = Effect.fn("makeOpenDesignAuth")(function* (
  options: OpenDesignAuthOptions,
) {
  const scope = yield* Effect.scope;
  const random = yield* SecureRandom.SecureRandom;
  const httpClient = yield* HttpClient.HttpClient;
  const lock = yield* Semaphore.make(1);
  const configuredControlKey = trimNonEmpty(options.environment?.OPENDESIGN_CONTROL_KEY);
  const baseUrl = resolveOpenDesignApiBaseUrl(options.environment, options.apiBaseUrl);

  const emptyState: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
  };
  const snapshot = yield* SubscriptionRef.make({ owner: null as string | null, state: emptyState });
  let active: AuthFlow | undefined;
  let operation: "idle" | "login" | "stopping" | "closed" = "idle";

  const publish = (flow: AuthFlow, patch: Partial<ProviderAuthState>) =>
    SubscriptionRef.update(snapshot, (current) => ({
      owner: flow.owner,
      state: { ...current.state, ...patch },
    }));

  const failStart = (detail: string, cause?: unknown) =>
    new ProviderSetupError({
      instanceId: options.instanceId,
      operation: "start",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const postJson = Effect.fn("postJson")(function* <A, I>(
    url: string,
    body: unknown,
    schema: Schema.Decoder<A, I>,
    onNotFoundDetail?: string,
  ) {
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    const response = yield* httpClient
      .execute(request)
      .pipe(Effect.mapError((cause) => failStart("Could not reach OpenDesign. Try again.", cause)));
    if (response.status === 404 && onNotFoundDetail !== undefined) {
      return yield* failStart(onNotFoundDetail);
    }
    const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.mapError((cause) => failStart(`OpenDesign returned HTTP ${response.status}.`, cause)),
    );
    return yield* HttpClientResponse.schemaBodyJson(schema)(ok).pipe(
      Effect.mapError((cause) => failStart("OpenDesign returned an unexpected response.", cause)),
    );
  });

  const runLogin = Effect.fn("OpenDesignAuth.runLogin")(
    function* (flow: AuthFlow, stopSessions: Effect.Effect<void, ProviderSetupError>) {
      yield* stopSessions;
      const start = yield* postJson(
        `${baseUrl}/api/v1/cli/device-authorizations`,
        {
          cliVersion: OPENDESIGN_CLI_VERSION,
          host: "T3CODE",
          profile: "prod",
        },
        DeviceAuthStartResponse,
      );
      if (!isOfficialOpenDesignActivationUrl(start.activationUrl)) {
        return yield* failStart("OpenDesign returned an unexpected activation URL.");
      }

      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (active !== flow) return;
          yield* publish(flow, {
            phase: "waiting",
            authorizationUrl: start.activationUrl,
            message:
              "Open the OpenDesign sign-in page and approve this device. This page updates automatically.",
          });
        }),
      );

      const pollIntervalSec = clampPollSeconds(start.pollIntervalSeconds);
      const deadlineMs = (yield* Clock.currentTimeMillis) + AUTH_TIMEOUT_MS;
      let credentials: OpenDesignCredentials | undefined;

      while (!credentials) {
        if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
          return yield* failStart("OpenDesign sign-in expired. Start sign-in again.");
        }
        yield* Effect.sleep(`${pollIntervalSec} seconds`);
        if (active !== flow) return;

        const token = yield* postJson(
          `${baseUrl}/api/v1/cli/device-authorizations/${encodeURIComponent(start.deviceId)}/token`,
          { deviceSecret: start.deviceSecret },
          DeviceAuthTokenResponse,
          "OpenDesign sign-in expired. Start sign-in again.",
        );
        const status = token.status?.trim().toLowerCase();
        if (status === "pending") continue;
        if (status === "expired") {
          return yield* failStart("OpenDesign sign-in expired. Start sign-in again.");
        }
        if (
          status === "canceled" ||
          status === "cancelled" ||
          status === "denied" ||
          status === "rejected"
        ) {
          return yield* failStart("OpenDesign sign-in was cancelled.");
        }

        const controlKey = trimNonEmpty(token.controlKey);
        const runtimeKey = trimNonEmpty(token.runtimeKey);
        const profile = parseOpenDesignProfile(token.user);
        if (
          !controlKey ||
          !controlKey.startsWith("vela_ctrl_") ||
          !runtimeKey ||
          !runtimeKey.startsWith("sk-amr") ||
          !profile
        ) {
          return yield* failStart("OpenDesign sign-in did not return valid credentials.");
        }
        credentials = {
          version: 1,
          controlKey,
          runtimeKey,
          ...(profile.accountId === undefined ? {} : { accountId: profile.accountId }),
          ...(profile.email === undefined ? {} : { email: profile.email }),
        };
      }

      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (active !== flow) return;
          yield* publish(flow, {
            phase: "verifying",
            authorizationUrl: null,
            message: "Checking OpenDesign sign-in.",
          });
          yield* options.store.save(credentials);
          const verified = yield* options.onChanged(true).pipe(Effect.exit);
          if (Exit.isFailure(verified)) {
            yield* options.store.clear.pipe(Effect.ignore);
            return yield* Effect.failCause(verified.cause);
          }
          active = undefined;
          operation = "idle";
          yield* publish(flow, {
            phase: "succeeded",
            authorizationUrl: null,
            expiresAt: null,
            message: "Signed in with OpenDesign.",
          });
        }).pipe(Effect.uninterruptible),
      );
    },
    (effect, flow) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: AUTH_TIMEOUT_MS,
          orElse: () => Effect.fail(failStart("OpenDesign sign-in expired. Start sign-in again.")),
        }),
        Effect.tapCause((cause) => Effect.logWarning("OpenDesign sign-in failed", cause)),
        Effect.exit,
        Effect.flatMap((result) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              if (active !== flow) return;
              active = undefined;
              operation = "idle";
              yield* publish(flow, {
                phase: Exit.isSuccess(result) ? "succeeded" : "failed",
                authorizationUrl: null,
                expiresAt: null,
                message: Exit.isSuccess(result)
                  ? "Signed in with OpenDesign."
                  : Option.match(Cause.findErrorOption(result.cause), {
                      onNone: () => "OpenDesign sign-in failed or expired. Start sign-in again.",
                      onSome: (error) => error.detail,
                    }),
              });
            }),
          ),
        ),
      ),
  );

  const requireFlow = Effect.fn("OpenDesignAuth.requireFlow")(function* (
    owner: string,
    id: string,
    name: string,
  ) {
    if (!active || active.owner !== owner || active.id !== id) {
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: name,
        detail: "This sign-in is no longer active in this client.",
      });
    }
    return active;
  });

  const controller: ProviderAuthController = {
    credentialBinding: options.store.binding,
    isChangingCredentials: Effect.sync(() => operation !== "idle"),
    start: (owner, stopSessions = Effect.void) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (!options.enabled) {
              return yield* failStart("Enable this OpenCode provider before signing in.");
            }
            if (configuredControlKey) {
              return yield* failStart(
                "Remove OPENDESIGN_CONTROL_KEY from this provider's environment before using browser sign-in.",
              );
            }
            if (active?.owner === owner && operation === "login") return snapshot.value.state;
            if (operation !== "idle") {
              return yield* failStart("OpenDesign setup is already in progress.");
            }
            const id = yield* random
              .uuidV4()
              .pipe(
                Effect.mapError((cause) => failStart("Could not start OpenDesign sign-in.", cause)),
              );
            const expiresAt = DateTime.formatIso(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + AUTH_TIMEOUT_MS),
            );
            const flow: AuthFlow = { id, owner };
            active = flow;
            operation = "login";
            const state: ProviderAuthState = {
              ...emptyState,
              phase: "starting",
              flowId: id,
              expiresAt,
              message: "Starting OpenDesign sign-in.",
            };
            yield* SubscriptionRef.set(snapshot, { owner, state });
            flow.fiber = yield* runLogin(flow, stopSessions).pipe(
              Effect.interruptible,
              Effect.forkIn(scope),
            );
            return state;
          }),
        ),
      ),
    complete: () =>
      Effect.fail(
        new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "complete",
          detail: "Finish signing in on OpenDesign. No redirect URL is needed.",
        }),
      ),
    cancel: (owner, id) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const flow = yield* requireFlow(owner, id, "cancel");
              active = undefined;
              operation = "stopping";
              yield* publish(flow, {
                phase: "cancelled",
                authorizationUrl: null,
                expiresAt: null,
                message: "OpenDesign sign-in was cancelled.",
              });
              return flow;
            }),
          );
          if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
          operation = "idle";
          return snapshot.value.state;
        }),
      ),
    logout: (stopSessions) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (configuredControlKey) {
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "logout",
                  detail:
                    "Remove OPENDESIGN_CONTROL_KEY from this provider's environment to disconnect it.",
                });
              }
              if (operation !== "idle" && operation !== "login") {
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "logout",
                  detail: "OpenDesign setup is already stopping.",
                });
              }
              operation = "stopping";
              const flow = active;
              active = undefined;
              return flow;
            }),
          );
          const result = yield* Effect.gen(function* () {
            if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
            yield* stopSessions;
            yield* options.store.clear;
            yield* options.onChanged(false);
          }).pipe(Effect.exit);
          operation = "idle";
          const state: ProviderAuthState = {
            ...emptyState,
            phase: Exit.isSuccess(result) ? "idle" : "failed",
            message: Exit.isSuccess(result)
              ? "Signed out of OpenDesign."
              : "OpenDesign sign-out failed. Try again.",
          };
          yield* SubscriptionRef.set(snapshot, { owner: null, state });
          if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
          return state;
        }),
      ),
    subscribe: (owner) =>
      SubscriptionRef.changes(snapshot).pipe(
        Stream.map((current) => {
          const state = {
            ...current.state,
            credentialOwner: "t3" as const,
            methods: [
              {
                id: "opendesign",
                name: "Sign in with OpenDesign",
                description: null,
                type: "agent" as const,
              },
            ],
            interaction:
              current.state.phase === "waiting" &&
              current.state.authorizationUrl &&
              current.state.flowId
                ? {
                    type: "browser" as const,
                    id: current.state.flowId,
                    url: current.state.authorizationUrl,
                    requiresConsent: false,
                    acceptsCallback: false,
                  }
                : null,
          };
          if (current.owner === null || current.owner === owner) return state;
          return {
            ...state,
            interaction: null,
            flowId: null,
            authorizationUrl: null,
            expiresAt: null,
            message: active ? "Sign-in is in progress in another client." : current.state.message,
          };
        }),
      ),
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      operation = "closed";
      const flow = active;
      active = undefined;
      if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
    }),
  );

  const resolveControlKey = Effect.gen(function* () {
    if (configuredControlKey) {
      return { controlKey: configuredControlKey, email: undefined, source: "env" as const };
    }
    const stored = yield* options.store.load;
    if (!stored) {
      return { controlKey: undefined, email: undefined, source: "none" as const };
    }
    return {
      controlKey: stored.controlKey,
      email: stored.email,
      source: "oauth" as const,
    };
  });

  return {
    controller,
    usesControlKeyEnv: configuredControlKey !== undefined,
    resolveControlKey,
  } satisfies OpenDesignAuth;
});
