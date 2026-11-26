import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  hostedAppUrlConfig,
  makeCloudCliOAuthConfig,
  makeRelayUrlConfig,
  optionalHostedAppUrlConfig,
  resolveRelayClientTracingConfig,
} from "./publicConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("rejects an insecure runtime relay URL override", () =>
  makeRelayUrlConfig("https://embedded.example.test").pipe(
    provideEnv({ K3CODE_RELAY_URL: "http://runtime.example.test" }),
    Effect.flip,
  ),
);

it.effect("rejects malformed or insecure hosted app URLs", () =>
  Effect.gen(function* () {
    for (const value of [
      "app.example.test",
      "http://app.example.test",
      "https://app.example.test/nested",
      "https://app.example.test?alias=true",
    ]) {
      const env = { K3CODE_HOSTED_APP_URL: value };
      const required = yield* hostedAppUrlConfig.pipe(provideEnv(env), Effect.result);
      const optional = yield* optionalHostedAppUrlConfig.pipe(provideEnv(env), Effect.result);
      assert.isTrue(Result.isFailure(required), value);
      assert.isTrue(Result.isFailure(optional), value);
    }
  }),
);

it.effect("has no hosted app unless one is configured", () =>
  Effect.gen(function* () {
    // Unset and empty mean none, not the former T3 hosted app or any other default.
    for (const env of [{}, { K3CODE_HOSTED_APP_URL: "" }, { K3CODE_HOSTED_APP_URL: "  " }]) {
      assert.deepEqual(yield* optionalHostedAppUrlConfig.pipe(provideEnv(env)), Option.none());
      const required = yield* hostedAppUrlConfig.pipe(provideEnv(env), Effect.result);
      assert.isTrue(Result.isFailure(required), JSON.stringify(env));
    }
  }),
);

it.effect("reads a configured hosted app as its origin", () =>
  Effect.gen(function* () {
    for (const value of ["https://app.example.test", " https://app.example.test/ "]) {
      const env = { K3CODE_HOSTED_APP_URL: value };
      assert.deepEqual(
        yield* optionalHostedAppUrlConfig.pipe(provideEnv(env)),
        Option.some("https://app.example.test"),
      );
      assert.strictEqual(
        yield* hostedAppUrlConfig.pipe(provideEnv(env)),
        "https://app.example.test",
      );
    }
    assert.deepEqual(
      yield* optionalHostedAppUrlConfig.pipe(
        provideEnv({ K3CODE_HOSTED_APP_URL: "http://localhost:5733" }),
      ),
      Option.some("http://localhost:5733"),
    );
  }),
);

it.effect("derives direct Clerk OAuth endpoints from statically injected public config", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      clerkPublishableKeyFallback: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
      clerkCliOAuthClientIdFallback: "oauth_client_embedded",
    }).pipe(provideEnv({}));

    assert.deepEqual(config, {
      tokenEndpoint: "https://clerk.example.test/oauth/token",
      deviceAuthorizationEndpoint: "https://clerk.example.test/oauth/device_authorization",
      clientId: "oauth_client_embedded",
      loopbackPort: 34338,
      redirectUri: "http://127.0.0.1:34338/callback",
      scopes: ["openid", "profile", "email", "offline_access"],
    });
  }),
);

it("product opt-out disables relay tracing with either built-in or runtime credentials", () => {
  const fallback = {
    tracesUrl: "https://embedded.example.test/v1/traces",
    tracesDataset: "embedded-dataset",
    tracesToken: "embedded-token",
  };
  const env = {
    K3CODE_TELEMETRY_ENABLED: "false",
    K3CODE_OTEL_SDK_DISABLED: "false",
  };

  assert.equal(resolveRelayClientTracingConfig(env, fallback), null);
  assert.equal(
    resolveRelayClientTracingConfig(
      {
        ...env,
        K3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://runtime.example.test/v1/traces",
        K3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        K3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    null,
  );
});
