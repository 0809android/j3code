import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    K3CODE_HOSTED_APP_URL: process.env.K3CODE_HOSTED_APP_URL,
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(
  variant: string | undefined,
  env: { hostedAppUrl?: string; clerkPublishableKey?: string } = {},
) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  vi.stubEnv("K3CODE_HOSTED_APP_URL", env.hostedAppUrl);
  vi.stubEnv("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY", env.clerkPublishableKey);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

const HOSTED_APP_URL = "https://hosted.example.test";
// Encodes "clerk.example.test$", as Clerk publishable keys do.
const CLERK_PUBLISHABLE_KEY = "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==";

it.each([
  [undefined, "jp.kinocode.k3code"],
  ["development", "jp.kinocode.k3code.dev"],
  ["preview", "jp.kinocode.k3code.preview"],
  ["production", "jp.kinocode.k3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("claims no web address without a configured hosted app or T3 Connect", async () => {
  const config = await loadConfig(undefined);
  expect(config.ios?.associatedDomains).toEqual([]);
  expect(config.android?.intentFilters).toEqual([]);
  expect(config.extra?.hostedAppUrl).toBeNull();
  expect(JSON.stringify(config)).not.toContain("t3.codes");
});

it.each(["", "not a url", "http://insecure.example.test"])(
  "ignores the invalid hosted app URL %j",
  async (hostedAppUrl) => {
    const config = await loadConfig(undefined, { hostedAppUrl });
    expect(config.ios?.associatedDomains).toEqual([]);
    expect(config.android?.intentFilters).toEqual([]);
    expect(config.extra?.hostedAppUrl).toBeNull();
  },
);

it("opens copied thread links only on the configured hosted app", async () => {
  const config = await loadConfig(undefined, { hostedAppUrl: HOSTED_APP_URL });
  const host = new URL(HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toEqual([`applinks:${host}`]);
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(config.extra?.hostedAppUrl).toBe(HOSTED_APP_URL);
});

it("associates the Clerk host only when the build has a publishable key", async () => {
  const config = await loadConfig(undefined, { clerkPublishableKey: CLERK_PUBLISHABLE_KEY });
  expect(config.ios?.associatedDomains).toEqual([
    "applinks:clerk.example.test",
    "webcredentials:clerk.example.test",
  ]);
  const malformed = await loadConfig(undefined, { clerkPublishableKey: "pk_test_" });
  expect(malformed.ios?.associatedDomains).toEqual([]);
});
