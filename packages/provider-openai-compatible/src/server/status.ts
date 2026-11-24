import type { RuntimeMode, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type { OpenAiCompatibleSettings } from "../settings.ts";
import { resolveOpenAiCompatibleEndpoint } from "./presets.ts";

const OPENAI_COMPATIBLE_SUPPORTED_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

const OPENAI_COMPATIBLE_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [],
});

const ModelsListResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const decodeModelsList = Schema.decodeUnknownEffect(ModelsListResponse);

function buildModels(
  settings: OpenAiCompatibleSettings,
  environment: NodeJS.ProcessEnv,
  discovered: ReadonlyArray<{ readonly slug: string; readonly name: string }> = [],
): ReadonlyArray<ServerProviderModel> {
  const endpoint = resolveOpenAiCompatibleEndpoint(settings, environment);
  const bySlug = new Map<string, ServerProviderModel>();
  const preferredDefault = settings.defaultModel.trim();

  if (preferredDefault.length > 0) {
    bySlug.set(preferredDefault, {
      slug: preferredDefault,
      name: preferredDefault,
      isCustom: false,
      isDefault: true,
      capabilities: OPENAI_COMPATIBLE_MODEL_CAPABILITIES,
    });
  }

  for (const model of endpoint.preset.defaultModels) {
    if (bySlug.has(model.slug)) continue;
    bySlug.set(model.slug, {
      slug: model.slug,
      name: model.name,
      isCustom: false,
      isDefault: bySlug.size === 0,
      capabilities: OPENAI_COMPATIBLE_MODEL_CAPABILITIES,
    });
  }

  for (const model of discovered) {
    const slug = model.slug.trim();
    if (!slug || bySlug.has(slug)) continue;
    bySlug.set(slug, {
      slug,
      name: model.name.trim() || slug,
      isCustom: false,
      isDefault: bySlug.size === 0,
      capabilities: OPENAI_COMPATIBLE_MODEL_CAPABILITIES,
    });
  }

  return providerModelsFromSettings(
    [...bySlug.values()],
    settings.customModels,
    OPENAI_COMPATIBLE_MODEL_CAPABILITIES,
  );
}

function makeSnapshot(
  settings: OpenAiCompatibleSettings,
  environment: NodeJS.ProcessEnv,
  checkedAt: string,
  probe: ProviderProbeResult,
  discovered: ReadonlyArray<{ readonly slug: string; readonly name: string }> = [],
): ServerProviderDraft {
  const endpoint = resolveOpenAiCompatibleEndpoint(settings, environment);
  return buildServerProvider({
    enabled: settings.enabled,
    checkedAt,
    models: buildModels(settings, environment, discovered),
    probe,
    presentation: {
      displayName: endpoint.preset.displayName,
      badgeLabel: "API",
      showInteractionModeToggle: false,
      supportedRuntimeModes: OPENAI_COMPATIBLE_SUPPORTED_RUNTIME_MODES,
      supportsConversationRollback: true,
    },
  });
}

export const buildInitialOpenAiCompatibleSnapshot = (
  settings: OpenAiCompatibleSettings,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) => {
    const endpoint = resolveOpenAiCompatibleEndpoint(settings, environment);
    const ready =
      endpoint.baseUrl.length > 0 &&
      (!endpoint.preset.requiresApiKey || endpoint.apiKey !== undefined);
    return makeSnapshot(settings, environment, DateTime.formatIso(now), {
      installed: true,
      version: null,
      status: ready ? "ready" : "warning",
      auth: {
        status: endpoint.apiKey
          ? "authenticated"
          : endpoint.preset.requiresApiKey
            ? "unauthenticated"
            : "unknown",
        type: endpoint.apiKey ? "apiKey" : "none",
        label: endpoint.preset.displayName,
      },
      ...(!ready
        ? {
            message: endpoint.invalidBaseUrl
              ? "Base URL must be a valid http:// or https:// URL."
              : endpoint.baseUrl.length === 0
                ? "Configure a Base URL in provider settings."
                : `Configure an API key or set ${endpoint.preset.envApiKeyNames[0] ?? "API key"} in the environment.`,
          }
        : {}),
    });
  });

export const checkOpenAiCompatibleStatus = Effect.fn("checkOpenAiCompatibleStatus")(function* (
  settings: OpenAiCompatibleSettings,
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const endpoint = resolveOpenAiCompatibleEndpoint(settings, environment);

  if (!settings.enabled) {
    return makeSnapshot(settings, environment, checkedAt, {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown", type: "none", label: endpoint.preset.displayName },
    });
  }

  if (endpoint.invalidBaseUrl) {
    return makeSnapshot(settings, environment, checkedAt, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unauthenticated", type: "none", label: endpoint.preset.displayName },
      message: "Base URL must be a valid http:// or https:// URL.",
    });
  }

  if (endpoint.baseUrl.length === 0) {
    return makeSnapshot(settings, environment, checkedAt, {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unauthenticated", type: "none", label: endpoint.preset.displayName },
      message: "Base URL is required for custom OpenAI-compatible endpoints.",
    });
  }

  if (endpoint.preset.requiresApiKey && !endpoint.apiKey) {
    return makeSnapshot(settings, environment, checkedAt, {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unauthenticated", type: "none", label: endpoint.preset.displayName },
      message: `Missing API key. Add it in settings or set ${endpoint.preset.envApiKeyNames.join(" / ")}.`,
    });
  }

  const httpClient = yield* HttpClient.HttpClient;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (endpoint.apiKey) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`;
  }

  type ProbeOutcome = {
    readonly reachable: boolean;
    readonly authError: boolean;
    readonly warningMessage?: string;
    readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  };

  const probeResult: ProbeOutcome = yield* httpClient
    .execute(
      HttpClientRequest.get(`${endpoint.baseUrl}/models`).pipe(
        HttpClientRequest.setHeaders(headers),
      ),
    )
    .pipe(
      Effect.flatMap((response): Effect.Effect<ProbeOutcome> => {
        if (response.status === 401 || response.status === 403) {
          return Effect.succeed({ reachable: true, authError: true, models: [] });
        }
        // Some OpenAI-compatible servers do not expose GET /models; treat 404/405 as reachable.
        if (response.status === 404 || response.status === 405) {
          return Effect.succeed({ reachable: true, authError: false, models: [] });
        }
        if (response.status < 200 || response.status >= 300) {
          return Effect.succeed({
            reachable: false,
            authError: false,
            warningMessage: `${endpoint.preset.displayName} returned HTTP ${response.status} from /models.`,
            models: [],
          });
        }
        return response.json.pipe(
          Effect.flatMap(decodeModelsList),
          Effect.map((payload): ProbeOutcome => ({
            reachable: true,
            authError: false,
            models: (payload.data ?? [])
              .slice(0, 60)
              .map((entry) => ({ slug: entry.id, name: entry.name ?? entry.id })),
          })),
          Effect.orElseSucceed((): ProbeOutcome => ({
            reachable: true,
            authError: false,
            models: [],
          })),
        );
      }),
      Effect.timeout("8 seconds"),
      Effect.orElseSucceed((): ProbeOutcome => ({
        reachable: false,
        authError: false,
        warningMessage: `Could not reach ${endpoint.preset.displayName} at ${endpoint.baseUrl}.`,
        models: [],
      })),
    );

  if (probeResult.authError) {
    return makeSnapshot(settings, environment, checkedAt, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unauthenticated", type: "apiKey", label: endpoint.preset.displayName },
      message: `${endpoint.preset.displayName} rejected the configured API key (401/403).`,
    });
  }

  if (!probeResult.reachable) {
    return makeSnapshot(settings, environment, checkedAt, {
      installed: true,
      version: null,
      status: "warning",
      auth: {
        status: endpoint.apiKey ? "authenticated" : "unknown",
        type: endpoint.apiKey ? "apiKey" : "none",
        label: endpoint.preset.displayName,
      },
      ...(probeResult.warningMessage ? { message: probeResult.warningMessage } : {}),
    });
  }

  return makeSnapshot(
    settings,
    environment,
    checkedAt,
    {
      installed: true,
      version: null,
      status: "ready",
      auth: {
        status: endpoint.apiKey ? "authenticated" : "unknown",
        type: endpoint.apiKey ? "apiKey" : "none",
        label: endpoint.preset.displayName,
      },
    },
    probeResult.models,
  );
});
