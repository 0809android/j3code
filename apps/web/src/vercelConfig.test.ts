import { describe, expect, it } from "vite-plus/test";

import { makeConfig } from "../vercel";

const hostRoutes = (env: Record<string, string>) =>
  (makeConfig(env).routes ?? []).filter((route) => "dest" in route);

describe("vercel config", () => {
  it("routes by host only when a hosted app names its host and both channel origins", () => {
    expect(hostRoutes({})).toEqual([]);
    expect(JSON.stringify(makeConfig({}))).not.toContain("t3.codes");
    for (const missing of [
      "K3CODE_HOSTED_APP_HOST",
      "K3CODE_HOSTED_APP_LATEST_ORIGIN",
      "K3CODE_HOSTED_APP_NIGHTLY_ORIGIN",
    ]) {
      const env: Record<string, string> = {
        K3CODE_HOSTED_APP_HOST: "app.example.test",
        K3CODE_HOSTED_APP_LATEST_ORIGIN: "https://latest.app.example.test",
        K3CODE_HOSTED_APP_NIGHTLY_ORIGIN: "https://nightly.app.example.test",
      };
      delete env[missing];
      expect(hostRoutes(env), missing).toEqual([]);
    }
  });

  it("sends the router host to the channel the cookie selects", () => {
    const routes = hostRoutes({
      K3CODE_HOSTED_APP_HOST: "app.example.test",
      K3CODE_HOSTED_APP_LATEST_ORIGIN: "https://latest.app.example.test",
      K3CODE_HOSTED_APP_NIGHTLY_ORIGIN: "https://nightly.app.example.test",
    });
    expect(routes.map((route) => ("dest" in route ? route.dest : null))).toEqual([
      "https://nightly.app.example.test/$1",
      "https://latest.app.example.test/$1",
    ]);
  });
});
