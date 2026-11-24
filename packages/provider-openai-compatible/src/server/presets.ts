import type { OpenAiCompatiblePreset, OpenAiCompatibleSettings } from "../settings.ts";

export interface OpenAiCompatiblePresetDefinition {
  readonly id: OpenAiCompatiblePreset;
  readonly displayName: string;
  readonly defaultBaseUrl: string;
  readonly envApiKeyNames: ReadonlyArray<string>;
  readonly requiresApiKey: boolean;
  readonly defaultModels: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly contextWindow?: number;
  }>;
}

const OPENAI_COMPATIBLE_PRESETS: Readonly<
  Record<OpenAiCompatiblePreset, OpenAiCompatiblePresetDefinition>
> = {
  mistral: {
    id: "mistral",
    displayName: "Mistral AI",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    envApiKeyNames: ["MISTRAL_API_KEY"],
    requiresApiKey: true,
    defaultModels: [
      { slug: "devstral-medium-latest", name: "Devstral Medium", contextWindow: 128_000 },
      { slug: "devstral-small-latest", name: "Devstral Small", contextWindow: 128_000 },
      { slug: "codestral-latest", name: "Codestral", contextWindow: 256_000 },
      { slug: "mistral-large-latest", name: "Mistral Large", contextWindow: 128_000 },
      { slug: "mistral-medium-latest", name: "Mistral Medium", contextWindow: 128_000 },
    ],
  },
  opendesign: {
    id: "opendesign",
    displayName: "OpenDesign Cloud",
    defaultBaseUrl: "https://amr-api.open-design.ai/v1",
    envApiKeyNames: ["OPENDESIGN_API_KEY", "OPENDESIGN_RUNTIME_KEY", "OPENDESIGN_CONTROL_KEY"],
    requiresApiKey: true,
    defaultModels: [
      {
        slug: "opendesign/claude-sonnet-4-6",
        name: "OpenDesign Claude Sonnet 4.6",
        contextWindow: 200_000,
      },
      { slug: "opendesign/gpt-5.4", name: "OpenDesign GPT-5.4", contextWindow: 200_000 },
      {
        slug: "opendesign/gemini-2.5-pro",
        name: "OpenDesign Gemini 2.5 Pro",
        contextWindow: 1_000_000,
      },
    ],
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    envApiKeyNames: ["OPENROUTER_API_KEY"],
    requiresApiKey: true,
    defaultModels: [
      {
        slug: "mistralai/devstral-medium",
        name: "Devstral Medium (OpenRouter)",
        contextWindow: 128_000,
      },
      {
        slug: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4 (OpenRouter)",
        contextWindow: 200_000,
      },
      {
        slug: "deepseek/deepseek-chat-v3-0324",
        name: "DeepSeek V3 (OpenRouter)",
        contextWindow: 128_000,
      },
      { slug: "qwen/qwen3-coder", name: "Qwen3 Coder (OpenRouter)", contextWindow: 256_000 },
    ],
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    envApiKeyNames: ["DEEPSEEK_API_KEY"],
    requiresApiKey: true,
    defaultModels: [
      { slug: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 128_000 },
      { slug: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128_000 },
    ],
  },
  ollama: {
    id: "ollama",
    displayName: "Ollama (Local)",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    envApiKeyNames: ["OLLAMA_API_KEY"],
    requiresApiKey: false,
    defaultModels: [
      { slug: "devstral:latest", name: "Devstral (Ollama)", contextWindow: 128_000 },
      { slug: "qwen2.5-coder:32b", name: "Qwen 2.5 Coder 32B", contextWindow: 32_768 },
    ],
  },
  custom: {
    id: "custom",
    displayName: "Custom OpenAI-Compatible API",
    defaultBaseUrl: "",
    envApiKeyNames: ["OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
    requiresApiKey: false,
    defaultModels: [],
  },
};

export interface ResolvedOpenAiCompatibleEndpoint {
  readonly preset: OpenAiCompatiblePresetDefinition;
  readonly baseUrl: string;
  readonly invalidBaseUrl: boolean;
  readonly apiKey: string | undefined;
  readonly apiKeySource: "settings" | "env" | "none";
}

function normalizeHttpBaseUrl(raw: string): {
  readonly baseUrl: string;
  readonly invalidBaseUrl: boolean;
} {
  const trimmed = raw.trim().replace(/\/+$/u, "");
  if (trimmed.length === 0) {
    return { baseUrl: "", invalidBaseUrl: false };
  }
  const parsed = URL.parse(trimmed);
  if (
    !parsed ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0
  ) {
    return { baseUrl: "", invalidBaseUrl: true };
  }
  return { baseUrl: trimmed, invalidBaseUrl: false };
}

export function resolveOpenAiCompatibleEndpoint(
  settings: OpenAiCompatibleSettings,
  environment: NodeJS.ProcessEnv,
): ResolvedOpenAiCompatibleEndpoint {
  const preset = OPENAI_COMPATIBLE_PRESETS[settings.preset];
  const { baseUrl, invalidBaseUrl } = normalizeHttpBaseUrl(
    settings.baseUrl || preset.defaultBaseUrl,
  );
  const directKey = typeof settings.apiKey === "string" ? settings.apiKey.trim() : "";
  if (directKey.length > 0) {
    return { preset, baseUrl, invalidBaseUrl, apiKey: directKey, apiKeySource: "settings" };
  }
  for (const envName of preset.envApiKeyNames) {
    const candidate = environment[envName]?.trim();
    if (candidate && candidate.length > 0) {
      return { preset, baseUrl, invalidBaseUrl, apiKey: candidate, apiKeySource: "env" };
    }
  }
  return { preset, baseUrl, invalidBaseUrl, apiKey: undefined, apiKeySource: "none" };
}
