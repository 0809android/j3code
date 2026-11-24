/**
 * OpenAI-compatible API client definition: settings form, label, and icon.
 * Browser- and React Native-safe.
 *
 * @module provider-openai-compatible/client
 */
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OPENAI_COMPATIBLE_DRIVER_KIND, OpenAiCompatibleSettings } from "./settings.ts";

export const openAiCompatibleClient = defineProviderClient({
  driverKind: OPENAI_COMPATIBLE_DRIVER_KIND,
  label: "Mistral / OpenAI-Compatible API",
  badgeLabel: "API",
  featured: true,
  settingsSchema: OpenAiCompatibleSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F172A", dark: "#F8FAFC" },
    paths: [
      {
        d: "M4 5h4v4H4V5zm6 0h4v4h-4V5zm6 0h4v4h-4V5zM4 11h16v2H4v-2zm0 4h4v4H4v-4zm6 0h4v4h-4v-4zm6 0h4v4h-4v-4z",
      },
    ],
  },
});
