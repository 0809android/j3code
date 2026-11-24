/**
 * OpenAI-compatible API instance settings (Mistral, OpenDesign, OpenRouter, DeepSeek, Ollama, Custom).
 * Shared by the server driver and client settings form; keep browser-safe.
 *
 * @module provider-openai-compatible/settings
 */
import {
  CustomModelSetting,
  makeProviderSettingsSchema,
  ProviderDriverKind,
  secretSetting,
  SettingsSecretValue,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const OPENAI_COMPATIBLE_DRIVER_KIND = ProviderDriverKind.make("openai-compatible");

export const OpenAiCompatiblePreset = Schema.Literals([
  "mistral",
  "opendesign",
  "openrouter",
  "deepseek",
  "ollama",
  "custom",
]);
export type OpenAiCompatiblePreset = typeof OpenAiCompatiblePreset.Type;

export const OpenAiCompatibleSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    preset: OpenAiCompatiblePreset.pipe(
      Schema.withDecodingDefault(Effect.succeed("mistral" as const)),
      Schema.annotateKey({
        title: "API preset",
        description:
          "Choose a built-in API endpoint preset (Mistral, OpenDesign, OpenRouter, DeepSeek, Ollama) or Custom.",
        providerSettingsForm: {
          control: "select",
          clearWhenEmpty: "omit",
          options: [
            { value: "mistral", label: "Mistral AI" },
            { value: "opendesign", label: "OpenDesign Cloud" },
            { value: "openrouter", label: "OpenRouter" },
            { value: "deepseek", label: "DeepSeek" },
            { value: "ollama", label: "Ollama (Local)" },
            { value: "custom", label: "Custom OpenAI-Compatible API" },
          ],
        },
      }),
    ),
    baseUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Base URL",
        description: "Leave blank to use the selected preset's default OpenAI-compatible /v1 URL.",
        providerSettingsForm: {
          placeholder: "https://api.mistral.ai/v1",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    apiKey: SettingsSecretValue.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API key",
        description:
          "Stored separately on the host. Leave blank to read the preset's environment variable (e.g. MISTRAL_API_KEY).",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional if set in environment",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    defaultModel: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Default model",
        description: "Optional model slug to prefer as default for this instance.",
        providerSettingsForm: {
          placeholder: "devstral-medium-latest",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["preset", "baseUrl", "apiKey", "defaultModel"],
  },
);
export type OpenAiCompatibleSettings = typeof OpenAiCompatibleSettings.Type;
