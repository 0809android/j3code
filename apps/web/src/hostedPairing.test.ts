import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedChannelSelectionUrl,
  buildHostedPairingUrl,
  configuredHostedAppUrl,
  hasHostedPairingRequest,
  isHostedStaticApp,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://hosted.example.test/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.example.test");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
      })!,
    );

    expect(url.origin).toBe("https://preview.example.test");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });

  it("has no hosted app unless the build names one", () => {
    for (const value of ["", "   ", "not a url", "http://insecure.example.test"]) {
      vi.stubEnv("VITE_HOSTED_APP_URL", value);
      expect(configuredHostedAppUrl()).toBeUndefined();
      expect(
        buildHostedPairingUrl({ host: "https://backend.example.com:3773", token: "pairing-token" }),
      ).toBeNull();
      expect(buildHostedChannelSelectionUrl({ channel: "nightly" })).toBeNull();
      expect(isHostedStaticApp(new URL("https://app.t3.codes/"))).toBe(false);
    }
  });

  it("uses only the origin of the configured hosted app", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.example.test/ignored?x=1");
    expect(configuredHostedAppUrl()).toBe("https://preview.example.test");
    expect(buildHostedChannelSelectionUrl({ channel: "nightly" })).toBe(
      "https://preview.example.test/__t3code/channel?channel=nightly",
    );
    expect(isHostedStaticApp(new URL("https://preview.example.test/pair"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://app.t3.codes/pair"))).toBe(false);
  });
});
