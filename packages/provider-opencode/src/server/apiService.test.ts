import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vite-plus/test";

import {
  apiServiceConfigContent,
  apiServiceModel,
  apiServiceStartEnvironment,
  isAllowedApiServiceUrl,
  parseApiServiceModels,
  withinEnvironmentLimit,
} from "./apiService.ts";

describe("parseApiServiceModels", () => {
  it("サービスごとに違う上限と対応機能の項目を読む", () => {
    const models = parseApiServiceModels({
      data: [
        {
          id: "od",
          context_limit: 1_000_000,
          output_budget: 32_000,
          architecture: { input_modalities: ["text", "image"] },
        },
        { id: "mistral", max_context_length: 256_000, capabilities: { vision: true } },
        {
          id: "router",
          context_length: 64_000,
          top_provider: { max_completion_tokens: 4_000 },
          supported_parameters: ["temperature"],
        },
        { id: "plain" },
      ],
    });
    expect(models).toEqual([
      apiServiceModel("od", { context: 1_000_000, output: 32_000, vision: true }),
      apiServiceModel("mistral", { context: 256_000, vision: true }),
      apiServiceModel("router", { context: 64_000, output: 4_000, tools: false }),
      apiServiceModel("plain"),
    ]);
  });

  it("会話に使えないモデルと壊れた行は除く", () => {
    expect(
      parseApiServiceModels([
        { id: "text-embedding-3" },
        { id: "ocr", capabilities: { completion_chat: false } },
        { id: "painter", architecture: { output_modalities: ["image"] } },
        { name: "no-id" },
        null,
      ]),
    ).toEqual([]);
    expect(parseApiServiceModels({ error: "unauthorized" })).toEqual([]);
  });
});

describe("apiServiceConfigContent", () => {
  it("キーは環境変数の参照にして、このサービスだけを使わせる", () => {
    const config = JSON.parse(
      apiServiceConfigContent({
        name: "Example",
        baseUrl: "https://api.example.com/v1/",
        models: [apiServiceModel("m1")],
      }),
    );
    expect(config.providers["k3-api"].settings).toEqual({
      baseURL: "https://api.example.com/v1",
      apiKey: "{env:K3_API_SERVICE_KEY}",
    });
    expect(Object.keys(config.providers["k3-api"].models)).toEqual(["m1"]);
    expect(config.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "k3-api", effect: "allow" },
    ]);
  });
});

describe("isAllowedApiServiceUrl", () => {
  it("https と手元の http だけを許す", () => {
    expect(isAllowedApiServiceUrl("https://api.example.com/v1")).toBe(true);
    expect(isAllowedApiServiceUrl("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isAllowedApiServiceUrl("http://api.example.com/v1")).toBe(false);
    expect(isAllowedApiServiceUrl("not a url")).toBe(false);
  });
});

describe("apiServiceStartEnvironment", () => {
  const start = (input: {
    readonly status: number;
    readonly customModels?: ReadonlyArray<string>;
    readonly baseUrl?: string;
    readonly requests?: string[];
  }) =>
    apiServiceStartEnvironment({
      service: { name: "Example", baseUrl: input.baseUrl ?? "https://api.example.com/v1" },
      customModels: input.customModels ?? [],
      environment: { K3_API_SERVICE_KEY: "secret" },
    }).pipe(
      Effect.map((environment) =>
        Object.keys(JSON.parse(environment.OPENCODE_CONFIG_CONTENT!).providers["k3-api"].models),
      ),
      Effect.mapError((error) => error.detail),
      Effect.result,
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          input.requests?.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ data: [{ id: "listed" }] }), { status: input.status }),
            ),
          );
        }),
      ),
    );

  effectIt.effect("認証に失敗したら起動せず、理由を返す。手で足したモデルがあっても同じ", () =>
    Effect.gen(function* () {
      expect(yield* start({ status: 401, customModels: ["mine"] })).toMatchObject({
        failure: "Example: API キーが認証されませんでした（HTTP 401）。",
      });
    }),
  );

  effectIt.effect("一覧がないサービスは、手で足したモデルだけで動かす", () =>
    Effect.gen(function* () {
      expect(yield* start({ status: 404, customModels: ["mine", "k3-api/other"] })).toMatchObject({
        success: ["mine", "other"],
      });
    }),
  );

  effectIt.effect("一覧も手で足したモデルもなければ起動しない", () =>
    Effect.gen(function* () {
      expect(yield* start({ status: 404 })).toMatchObject({
        failure: "Example: 使えるモデルがありません。モデル名を手で追加してください。",
      });
    }),
  );

  effectIt.effect("許可しない URL にはキーを送らない", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      expect(
        yield* start({ status: 200, baseUrl: "http://api.example.com/v1", requests }),
      ).toHaveProperty("failure");
      expect(requests).toEqual([]);
    }),
  );
});

describe("withinEnvironmentLimit", () => {
  it("モデルが多いサービスでも、設定が環境変数の上限を超えない", () => {
    const models = Array.from({ length: 2_000 }, (_, index) =>
      apiServiceModel(`vendor/very-long-model-name-${index}`),
    );
    const kept = withinEnvironmentLimit(models);
    expect(kept.length).toBeGreaterThan(300);
    expect(
      apiServiceConfigContent({ name: "A", baseUrl: "https://a.example/v1", models: kept }).length,
    ).toBeLessThan(128 * 1024);
  });
});
