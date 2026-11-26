import { describe, expect, it, vi } from "vite-plus/test";

import { hostedAppLinkPrefixes, resolveHostedAppUrl } from "./hostedApp";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("hosted app configuration", () => {
  it("has no hosted app unless the build config names a valid one", () => {
    for (const extra of [
      undefined,
      null,
      {},
      { hostedAppUrl: null },
      { hostedAppUrl: "" },
      { hostedAppUrl: 42 },
      { hostedAppUrl: "http://insecure.example.test" },
      { hostedAppUrl: "not a url" },
    ]) {
      expect(resolveHostedAppUrl(extra)).toBeUndefined();
    }
    expect(hostedAppLinkPrefixes(undefined)).toEqual([]);
  });

  it("uses the origin of the configured hosted app", () => {
    const hostedAppUrl = resolveHostedAppUrl({ hostedAppUrl: "https://hosted.example.test/x" });
    expect(hostedAppUrl).toBe("https://hosted.example.test");
    expect(hostedAppLinkPrefixes(hostedAppUrl)).toEqual(["https://hosted.example.test"]);
  });
});
