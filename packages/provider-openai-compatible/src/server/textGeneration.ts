import { TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import {
  decodeJsonReply,
  fromRunner,
  withoutInvestigation,
} from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type { OpenAiCompatibleSettings } from "../settings.ts";
import { resolveOpenAiCompatibleEndpoint } from "./presets.ts";

interface ChatCompletionPayload {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string | null };
  }>;
}

export function makeOpenAiCompatibleTextGeneration(input: {
  readonly settings: OpenAiCompatibleSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly httpClient: HttpClient.HttpClient;
}): ProviderTextGeneration {
  const endpoint = resolveOpenAiCompatibleEndpoint(input.settings, input.environment);

  return fromRunner(
    "OpenAiCompatibleTextGeneration",
    withoutInvestigation(endpoint.preset.displayName, (request) =>
      Effect.gen(function* () {
        if (endpoint.invalidBaseUrl) {
          return yield* new TextGenerationError({
            operation: request.operation,
            detail: `${endpoint.preset.displayName} Base URL must use http:// or https://.`,
          });
        }
        if (!endpoint.baseUrl) {
          return yield* new TextGenerationError({
            operation: request.operation,
            detail: `${endpoint.preset.displayName} Base URL is not configured.`,
          });
        }
        const model =
          request.modelSelection.model.trim() ||
          input.settings.defaultModel.trim() ||
          endpoint.preset.defaultModels[0]?.slug ||
          "";
        if (!model) {
          return yield* new TextGenerationError({
            operation: request.operation,
            detail: "No model is configured for text generation.",
          });
        }
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json",
        };
        if (endpoint.apiKey) {
          headers.Authorization = `Bearer ${endpoint.apiKey}`;
        }
        const response = yield* input.httpClient
          .execute(
            HttpClientRequest.post(`${endpoint.baseUrl}/chat/completions`).pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.bodyJsonUnsafe({
                model,
                temperature: 0.2,
                messages: [
                  {
                    role: "system",
                    content:
                      "Respond ONLY with a valid JSON object matching the user's requested schema.",
                  },
                  { role: "user", content: request.prompt },
                ],
              }),
            ),
          )
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: request.operation,
                  detail: `${endpoint.preset.displayName} text generation request failed.`,
                  cause,
                }),
            ),
          );
        if (response.status < 200 || response.status >= 300) {
          const bodyText = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* new TextGenerationError({
            operation: request.operation,
            detail: `${endpoint.preset.displayName} returned HTTP ${response.status}: ${bodyText.slice(0, 300)}`,
          });
        }
        const payload = (yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: request.operation,
                detail: `${endpoint.preset.displayName} returned unreadable JSON.`,
                cause,
              }),
          ),
        )) as ChatCompletionPayload;
        const text = payload.choices?.[0]?.message?.content ?? "";
        return yield* decodeJsonReply(request, endpoint.preset.displayName, text);
      }),
    ),
  );
}
