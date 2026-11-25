import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import type { K3RelayAccountPendingSignIn } from "./account.ts";
import { K3RelayAccountOnboarding, layer } from "./accountOnboarding.ts";
import { DeviceKeyStore, layerMemory } from "./deviceKeyStore.ts";
import { layerWebSocketGlobal } from "./k3relay.testkit.ts";

let requests = 0;
const layerNoNetwork = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch, (async () => {
      requests += 1;
      throw new Error("no request should be made");
    }) as unknown as typeof fetch),
  ),
);

const layerTest = layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerMemory(),
      layerNoNetwork,
      layerWebSocketGlobal,
      // Signing in never touches saved environments; only connecting to a host does.
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        {} as EnvironmentRegistry.EnvironmentRegistry["Service"],
      ),
      Layer.succeed(ClientCapabilities.ClientPresentation, {
        metadata: { label: "Test phone", deviceType: "mobile" },
      }),
    ),
  ),
);

const pendingSignIn = Effect.gen(function* () {
  const keys = yield* DeviceKeyStore;
  const keyId = "k3relay-account:test";
  const signer = yield* keys.create(keyId);
  return {
    offer: {
      relayUrl: "https://relay.example",
      providers: ["github"],
      issuer: "https://relay.example",
      accountKey: new Uint8Array(32),
    },
    provider: "github",
    verifier: "verifier",
    appState: "state-1",
    redirect: "k3relay://account/callback",
    keyId,
    signer,
  } satisfies K3RelayAccountPendingSignIn;
});

describe("the device's account service", () => {
  it.effect("drops a sign-in's key when its callback is for another sign-in", () =>
    Effect.gen(function* () {
      requests = 0;
      const accounts = yield* K3RelayAccountOnboarding;
      const keys = yield* DeviceKeyStore;
      const pending = yield* pendingSignIn;
      const exit = yield* Effect.exit(
        accounts.completeSignIn(pending, "k3relay://account/callback?code=c&state=state-2"),
      );
      assert(Exit.isFailure(exit));
      expect(JSON.stringify(exit.cause)).toContain('"reason":"sign-in-failed"');
      expect(Option.isNone(yield* keys.load(pending.keyId))).toBe(true);
      expect(requests).toBe(0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("ends a sign-in the user cancelled at the provider, without a request", () =>
    Effect.gen(function* () {
      requests = 0;
      const accounts = yield* K3RelayAccountOnboarding;
      const keys = yield* DeviceKeyStore;
      const pending = yield* pendingSignIn;
      const exit = yield* Effect.exit(
        accounts.completeSignIn(
          pending,
          "k3relay://account/callback?error=access_denied&state=state-1",
        ),
      );
      assert(Exit.isFailure(exit));
      expect(JSON.stringify(exit.cause)).toContain('"reason":"sign-in-cancelled"');
      expect(Option.isNone(yield* keys.load(pending.keyId))).toBe(true);
      expect(requests).toBe(0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("forgets a session's key when the device signs out", () =>
    Effect.gen(function* () {
      const accounts = yield* K3RelayAccountOnboarding;
      const keys = yield* DeviceKeyStore;
      const pending = yield* pendingSignIn;
      yield* accounts.forget(pending.keyId);
      expect(Option.isNone(yield* keys.load(pending.keyId))).toBe(true);
      // Forgetting twice is harmless: signing out never fails.
      yield* accounts.forget(pending.keyId);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports a relay without accounts as such, not as a failed sign-in", () =>
    Effect.gen(function* () {
      const accounts = yield* K3RelayAccountOnboarding;
      const exit = yield* Effect.exit(accounts.offer("not a relay"));
      assert(Exit.isFailure(exit));
      expect(JSON.stringify(exit.cause)).toContain('"reason":"relay-unreachable"');
    }).pipe(Effect.provide(layerTest)),
  );
});
