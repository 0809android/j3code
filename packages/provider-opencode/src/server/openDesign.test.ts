import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import {
  isOfficialOpenDesignActivationUrl,
  makeOpenDesignAuth,
  makeOpenDesignCredentialStore,
  OPENDESIGN_EXTERNAL_USAGE,
  parseOpenDesignPreflight,
  parseOpenDesignProfile,
  readOpenDesignUsageLimits,
} from "./openDesign.ts";

const jsonResponse = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  status: number,
  body: unknown,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

it("validates official OpenDesign activation URLs", () => {
  assert.isTrue(
    isOfficialOpenDesignActivationUrl("https://open-design.ai/cloud/cli/activate?code=ABCD-1234"),
  );
  assert.isFalse(
    isOfficialOpenDesignActivationUrl("http://open-design.ai/cloud/cli/activate?code=ABCD-1234"),
  );
  assert.isFalse(
    isOfficialOpenDesignActivationUrl(
      "https://evil.open-design.ai/cloud/cli/activate?code=ABCD-1234",
    ),
  );
  assert.isFalse(
    isOfficialOpenDesignActivationUrl("https://open-design.ai:8443/cloud/cli/activate"),
  );
  assert.isFalse(
    isOfficialOpenDesignActivationUrl("https://user@open-design.ai/cloud/cli/activate"),
  );
  assert.isFalse(isOfficialOpenDesignActivationUrl("https://open-design.ai/other"));
});

it("extracts profile from OpenDesign user payload", () => {
  assert.deepStrictEqual(
    parseOpenDesignProfile({ id: "u_1", appUserId: "app_1", email: "user@example.com" }),
    { accountId: "u_1", email: "user@example.com" },
  );
  assert.deepStrictEqual(parseOpenDesignProfile({ appUserId: "app_1" }), {
    accountId: "app_1",
  });
  assert.isNull(parseOpenDesignProfile({ id: "  ", email: "" }));
});

it("parses OpenDesign codingPlan windows sorted ascending and wallet fallback", () => {
  const parsed = parseOpenDesignPreflight(
    {
      workspaceId: "ws_1",
      balanceUsd: "12.5",
      codingPlan: {
        eligible: true,
        tier: "pro",
        windows: [
          {
            durationSeconds: 604_800,
            usedCredits: "250",
            limitCredits: "1000",
            resetsAt: "2026-11-30T00:00:00Z",
          },
          {
            durationSeconds: 18_000,
            usedCredits: "45",
            limitCredits: "100",
            resetsAt: "2026-11-23T15:00:00Z",
          },
        ],
      },
    },
    "ws_1",
    { checkedAt: "2026-11-23T12:00:00.000Z", credentialFingerprint: "fp_1" },
  );

  assert.strictEqual(parsed.planLabel, "OpenDesign · Pro · $12.50");
  assert.strictEqual(parsed.limits.unavailable, undefined);
  assert.strictEqual(parsed.limits.credentialFingerprint, "fp_1");
  assert.deepStrictEqual(parsed.limits.externalUsage, OPENDESIGN_EXTERNAL_USAGE);
  assert.deepStrictEqual(
    parsed.limits.windows.map((window) => ({
      id: window.id,
      kind: window.kind,
      label: window.label,
      usedPercent: window.usedPercent,
      providerIds: window.providerIds,
    })),
    [
      {
        id: "opendesign_18000",
        kind: "session",
        label: "OpenDesign · 5-hour",
        usedPercent: 45,
        providerIds: ["open-design"],
      },
      {
        id: "opendesign_604800",
        kind: "weekly",
        label: "OpenDesign · 7-day",
        usedPercent: 25,
        providerIds: ["open-design"],
      },
    ],
  );

  const walletOnly = parseOpenDesignPreflight(
    {
      workspaceId: "ws_1",
      balanceUsd: "10",
      codingPlan: { eligible: false, windows: [] },
    },
    "ws_1",
    { checkedAt: "2026-11-23T12:00:00.000Z" },
  );
  assert.strictEqual(walletOnly.limits.unavailable?.reason, "unsupported");
  assert.include(walletOnly.limits.unavailable?.message ?? "", "$10.00");
});

it.effect("reads OpenDesign workspace and preflight limits via Bearer controlKey", () =>
  Effect.gen(function* () {
    const requests: Array<{
      url: string;
      auth: string | undefined;
      workspaceHeader: string | undefined;
    }> = [];
    const client = HttpClient.make((request) => {
      requests.push({
        url: request.url,
        auth: request.headers.authorization,
        workspaceHeader: request.headers["x-vela-workspace-id"],
      });
      if (request.url.endsWith("/api/v1/workspaces/current")) {
        return Effect.succeed(jsonResponse(request, 200, { workspace: { id: "ws_live" } }));
      }
      return Effect.succeed(
        jsonResponse(request, 200, {
          workspaceId: "ws_live",
          balanceUsd: "3.25",
          codingPlan: {
            tier: "plus",
            windows: [{ durationSeconds: 18_000, usedCredits: "50", limitCredits: "200" }],
          },
        }),
      );
    });

    const result = yield* readOpenDesignUsageLimits({
      controlKey: "vela_ctrl_secret",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));

    assert.strictEqual(result.workspaceId, "ws_live");
    assert.strictEqual(result.planLabel, "OpenDesign · Plus · $3.25");
    assert.strictEqual(result.limits.windows[0]?.usedPercent, 25);
    assert.isString(result.limits.credentialFingerprint);
    assert.deepStrictEqual(requests, [
      {
        url: "https://amr-api.open-design.ai/api/v1/workspaces/current",
        auth: "Bearer vela_ctrl_secret",
        workspaceHeader: undefined,
      },
      {
        url: "https://amr-api.open-design.ai/api/v1/workspaces/ws_live/billing/preflight",
        auth: "Bearer vela_ctrl_secret",
        workspaceHeader: "ws_live",
      },
    ]);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("completes OpenDesign device auth flow, stores credentials, and supports logout", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("opencode-open-design-test");
    const store = yield* makeOpenDesignCredentialStore(instanceId);
    let polls = 0;
    const changed: boolean[] = [];
    const client = HttpClient.make((request) => {
      if (request.url.endsWith("/api/v1/cli/device-authorizations")) {
        return Effect.succeed(
          jsonResponse(request, 200, {
            deviceId: "dev_1",
            deviceSecret: "sec_1",
            activationUrl: "https://open-design.ai/cloud/cli/activate?code=XYZ",
            pollIntervalSeconds: 2,
          }),
        );
      }
      if (request.url.endsWith("/api/v1/cli/device-authorizations/dev_1/token")) {
        polls += 1;
        if (polls === 1) {
          return Effect.succeed(jsonResponse(request, 200, { status: "pending" }));
        }
        return Effect.succeed(
          jsonResponse(request, 200, {
            status: "approved",
            runtimeKey: "sk-amr-test-runtime",
            controlKey: "vela_ctrl_test-control",
            user: { id: "usr_1", email: "alice@example.com" },
          }),
        );
      }
      return Effect.die(`Unexpected URL: ${request.url}`);
    });

    const auth = yield* makeOpenDesignAuth({
      instanceId,
      enabled: true,
      store,
      onChanged: (signedIn) =>
        Effect.sync(() => {
          changed.push(signedIn);
        }),
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));

    const statesFiber = yield* auth.controller.subscribe("session-1").pipe(
      Stream.filter((state) => state.phase === "waiting" || state.phase === "succeeded"),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );

    const started = yield* auth.controller.start("session-1");
    assert.strictEqual(started.phase, "starting");
    yield* Effect.yieldNow;
    yield* TestClock.adjust("2 seconds");
    yield* Effect.yieldNow;
    yield* TestClock.adjust("2 seconds");

    const states = Array.from(yield* Fiber.join(statesFiber));
    assert.strictEqual(states[0]?.phase, "waiting");
    assert.strictEqual(states[0]?.interaction?.type, "browser");
    assert.strictEqual(states[1]?.phase, "succeeded");

    const resolved = yield* auth.resolveControlKey;
    assert.strictEqual(resolved.source, "oauth");
    assert.strictEqual(resolved.controlKey, "vela_ctrl_test-control");
    assert.strictEqual(resolved.email, "alice@example.com");
    assert.deepStrictEqual(changed, [true]);

    const loggedOut = yield* auth.controller.logout(Effect.void);
    assert.strictEqual(loggedOut.phase, "idle");
    const afterLogout = yield* auth.resolveControlKey;
    assert.strictEqual(afterLogout.source, "none");
    assert.isUndefined(afterLogout.controlKey);
    assert.deepStrictEqual(changed, [true, false]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        NodeCrypto.layer,
        TestClock.layer(),
      ),
    ),
  ),
);
