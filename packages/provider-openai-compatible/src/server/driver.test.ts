import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { OpenAiCompatibleSettings } from "../settings.ts";
import {
  classifyHttpFailure,
  makeOpenAiCompatibleAdapterV2,
  parseSseChunkLines,
} from "./adapter.ts";
import { resolveOpenAiCompatibleEndpoint } from "./presets.ts";
import { checkOpenAiCompatibleStatus } from "./status.ts";
import { executeCodingTool } from "./tools.ts";

const decodeSettings = Schema.decodeSync(OpenAiCompatibleSettings);

describe("OpenAI-compatible presets and endpoint resolution", () => {
  it("resolves Mistral preset baseUrl and MISTRAL_API_KEY from environment", () => {
    const endpoint = resolveOpenAiCompatibleEndpoint(
      decodeSettings({ enabled: true, preset: "mistral" }),
      { MISTRAL_API_KEY: "mistral-secret-key" },
    );
    assert.equal(endpoint.baseUrl, "https://api.mistral.ai/v1");
    assert.equal(endpoint.apiKey, "mistral-secret-key");
    assert.equal(endpoint.apiKeySource, "env");
  });

  it("resolves OpenDesign preset and prefers settings apiKey over environment", () => {
    const endpoint = resolveOpenAiCompatibleEndpoint(
      decodeSettings({ enabled: true, preset: "opendesign", apiKey: "direct-key" }),
      { OPENDESIGN_API_KEY: "env-key" },
    );
    assert.equal(endpoint.baseUrl, "https://amr-api.open-design.ai/v1");
    assert.equal(endpoint.apiKey, "direct-key");
    assert.equal(endpoint.apiKeySource, "settings");
  });

  it("normalizes custom baseUrl trailing slashes", () => {
    const endpoint = resolveOpenAiCompatibleEndpoint(
      decodeSettings({ enabled: true, preset: "custom", baseUrl: "http://localhost:8000/v1///" }),
      {},
    );
    assert.equal(endpoint.baseUrl, "http://localhost:8000/v1");
    assert.equal(endpoint.apiKeySource, "none");
  });
});

describe("OpenAI-compatible HTTP failure classification and SSE parsing", () => {
  it("classifies 429 as usage_limit with Retry-After resetAt, 500 as provider_error, 401 as permission_error", () => {
    const nowMs = Date.parse("2026-11-24T00:00:00.000Z");
    const rateLimited = classifyHttpFailure(
      429,
      '{"error":{"message":"Too many requests"}}',
      "60",
      nowMs,
    );
    assert.equal(rateLimited.class, "usage_limit");
    assert.equal(rateLimited.retryable, true);
    assert.equal(rateLimited.resetAt, "2026-11-24T00:01:00.000Z");

    const serverErr = classifyHttpFailure(503, "Service Unavailable");
    assert.equal(serverErr.class, "provider_error");
    assert.equal(serverErr.retryable, true);

    const authErr = classifyHttpFailure(401, "Invalid API key");
    assert.equal(authErr.class, "permission_error");
    assert.equal(authErr.retryable, false);

    const badReq = classifyHttpFailure(400, "Invalid model");
    assert.equal(badReq.class, "validation_error");
  });

  it("parses SSE delta content, reasoning_content, and streamed tool calls", () => {
    const raw = [
      'data: {"choices":[{"delta":{"reasoning_content":"Thinking... "}}]}',
      'data: {"choices":[{"delta":{"content":"Hello "}}]}',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]}}]}',
      "data: [DONE]",
    ].join("\n");
    const parsed = parseSseChunkLines(raw);
    assert.equal(parsed.reasoning, "Thinking... ");
    assert.equal(parsed.text, "Hello world");
    assert.deepStrictEqual(parsed.toolCalls, [
      { id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' },
    ]);
  });
});

describe("OpenAI-compatible status probe and adapter execution", () => {
  it.effect("discovers models from /models and reports ready status", () =>
    Effect.gen(function* () {
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: [{ id: "devstral-2-custom" }, { id: "codestral-latest" }],
            }),
          ),
        ),
      );
      const snapshot = yield* checkOpenAiCompatibleStatus(
        decodeSettings({ enabled: true, preset: "mistral", apiKey: "test-key" }),
        {},
      ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.isTrue(snapshot.models.some((model) => model.slug === "devstral-2-custom"));
      assert.isTrue(snapshot.models.some((model) => model.slug === "devstral-medium-latest"));
    }),
  );

  it.effect("streams assistant response and supports injectHistory handoff", () =>
    Effect.gen(function* () {
      const seenBodies: Array<Record<string, unknown>> = [];
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.body._tag === "Uint8Array") {
            seenBodies.push(
              JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>,
            );
          }
          const sse = [
            'data: {"choices":[{"delta":{"content":"Continued on Mistral!"}}]}',
            "data: [DONE]",
          ].join("\n");
          return HttpClientResponse.fromWeb(
            request,
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          );
        }),
      );

      const instanceId = ProviderInstanceId.make("mistral");
      const adapter = makeOpenAiCompatibleAdapterV2({
        instanceId,
        settings: decodeSettings({ enabled: true, preset: "mistral", apiKey: "test-key" }),
        environment: {},
        httpClient,
      });

      const session = yield* adapter.openSession({
        threadId: ThreadId.make("thread:1"),
        providerSessionId: ProviderSessionId.make("session:1"),
        modelSelection: { instanceId, model: "devstral-medium-latest" },
        runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
      });

      const providerThread = yield* session.ensureThread({
        threadId: ThreadId.make("thread:1"),
        modelSelection: { instanceId, model: "devstral-medium-latest" },
        runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
      });

      const injected = yield* session.injectHistory!({
        providerThread,
        context: "",
        messages: [
          {
            role: "user",
            text: "Original task from primary provider",
            threadId: ThreadId.make("thread:1"),
            runId: null,
            itemId: "item:1" as never,
            providerThreadId: null,
            status: "completed",
            kind: "user_message",
          },
        ],
      });
      assert.isTrue(injected);

      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: { id: ThreadId.make("thread:1") } as never,
        threadId: ThreadId.make("thread:1"),
        runId: RunId.make("run:2"),
        runOrdinal: 2,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt:1"),
        rootNodeId: NodeId.make("node:1"),
        providerThread,
        message: {
          messageId: MessageId.make("msg:2"),
          text: "Continue from where it stopped",
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
        },
        modelSelection: { instanceId, model: "devstral-medium-latest" },
        runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
      });

      const collected = yield* session.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        ),
        Stream.runCollect,
      );
      const events = [...collected];
      const assistantItem = events.find(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
      );
      assert.isDefined(assistantItem);
      if (
        assistantItem?.type === "turn_item.updated" &&
        assistantItem.turnItem.type === "assistant_message"
      ) {
        assert.equal(assistantItem.turnItem.text, "Continued on Mistral!");
      }
      assert.equal(seenBodies.length, 1);
      const sentMessages = seenBodies[0]?.messages as Array<{ role: string; content: string }>;
      assert.isTrue(
        sentMessages.some((msg) => msg.content === "Original task from primary provider"),
      );
      const assistantItems = events.filter(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
      );
      assert.isTrue(
        assistantItems.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.streaming === true,
        ),
      );
      void now;
    }).pipe(Effect.scoped),
  );

  it.effect("reports warning on unreachable or 5xx /models probe, and ready on 404 /models", () =>
    Effect.gen(function* () {
      const serverErrorClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("Internal error", { status: 500 })),
        ),
      );
      const warningSnapshot = yield* checkOpenAiCompatibleStatus(
        decodeSettings({ enabled: true, preset: "ollama" }),
        {},
      ).pipe(Effect.provideService(HttpClient.HttpClient, serverErrorClient));
      assert.equal(warningSnapshot.status, "warning");
      assert.isTrue(Boolean(warningSnapshot.message?.includes("500")));

      const notFoundClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })),
        ),
      );
      const readySnapshot = yield* checkOpenAiCompatibleStatus(
        decodeSettings({ enabled: true, preset: "ollama" }),
        {},
      ).pipe(Effect.provideService(HttpClient.HttpClient, notFoundClient));
      assert.equal(readySnapshot.status, "ready");
    }),
  );

  it.effect("rolls back pending user message from history when HTTP request fails", () =>
    Effect.gen(function* () {
      let attempt = 0;
      const seenBodies: Array<Record<string, unknown>> = [];
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          attempt += 1;
          if (request.body._tag === "Uint8Array") {
            seenBodies.push(
              JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>,
            );
          }
          if (attempt === 1) {
            return HttpClientResponse.fromWeb(
              request,
              new Response('{"error":{"message":"Temporary failure"}}', { status: 503 }),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ choices: [{ message: { content: "Recovered!" } }] }),
          );
        }),
      );

      const instanceId = ProviderInstanceId.make("mistral");
      const adapter = makeOpenAiCompatibleAdapterV2({
        instanceId,
        settings: decodeSettings({ enabled: true, preset: "mistral", apiKey: "test-key" }),
        environment: {},
        httpClient,
      });
      const session = yield* adapter.openSession({
        threadId: ThreadId.make("thread:retry"),
        providerSessionId: ProviderSessionId.make("session:retry"),
        modelSelection: { instanceId, model: "devstral-medium-latest" },
        runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
      });
      const providerThread = yield* session.ensureThread({
        threadId: ThreadId.make("thread:retry"),
        modelSelection: { instanceId, model: "devstral-medium-latest" },
        runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
      });

      yield* session.startTurn({
        appThread: { id: ThreadId.make("thread:retry") } as never,
        threadId: ThreadId.make("thread:retry"),
        runId: RunId.make("run:1"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt:1"),
        rootNodeId: NodeId.make("node:1"),
        providerThread,
        message: {
          messageId: MessageId.make("msg:1"),
          text: "First attempt",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId, model: "devstral-medium-latest" },
        runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
      });
      yield* session.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "failed",
        ),
        Stream.runDrain,
      );

      yield* session.startTurn({
        appThread: { id: ThreadId.make("thread:retry") } as never,
        threadId: ThreadId.make("thread:retry"),
        runId: RunId.make("run:2"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("attempt:2"),
        rootNodeId: NodeId.make("node:2"),
        providerThread,
        message: {
          messageId: MessageId.make("msg:2"),
          text: "Retry attempt",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId, model: "devstral-medium-latest" },
        runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
      });
      yield* session.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        ),
        Stream.runDrain,
      );

      assert.equal(seenBodies.length, 2);
      const retryMessages = seenBodies[1]?.messages as Array<{ role: string; content: string }>;
      assert.equal(retryMessages.filter((msg) => msg.role === "user").length, 1);
      assert.equal(retryMessages.find((msg) => msg.role === "user")?.content, "Retry attempt");
    }).pipe(Effect.scoped),
  );

  it("blocks workspace-escaping paths in non-full-access runtime modes", async () => {
    const result = await executeCodingTool({
      name: "read_file",
      rawArguments: JSON.stringify({ path: "../../outside.txt" }),
      cwd: process.cwd(),
      runtimeMode: "auto",
    });
    assert.isFalse(result.ok);
    assert.isTrue(result.output.includes("outside the workspace root"));
  });

  it("allows workspace files whose names start with double dots and rejects empty edit_file old_string", async () => {
    const readMissingDotDot = await executeCodingTool({
      name: "read_file",
      rawArguments: JSON.stringify({ path: "..nonexistent-config" }),
      cwd: process.cwd(),
      runtimeMode: "auto",
    });
    assert.isFalse(readMissingDotDot.ok);
    assert.isFalse(readMissingDotDot.output.includes("outside the workspace root"));

    const emptyEdit = await executeCodingTool({
      name: "edit_file",
      rawArguments: JSON.stringify({ path: "package.json", old_string: "", new_string: "x" }),
      cwd: process.cwd(),
      runtimeMode: "auto",
    });
    assert.isFalse(emptyEdit.ok);
    assert.include(emptyEdit.output, "non-empty old_string");
  });

  it("supports search_files tool in workspace", async () => {
    const result = await executeCodingTool({
      name: "search_files",
      rawArguments: JSON.stringify({ query: "package.json", limit: 10 }),
      cwd: process.cwd(),
      runtimeMode: "auto",
    });
    assert.isTrue(result.ok);
    assert.include(result.output, "package.json");
  });

  it("supports grep_files tool in workspace via persistent worker", async () => {
    const result = await executeCodingTool({
      name: "grep_files",
      rawArguments: JSON.stringify({ query: "provider-openai-compatible", limit: 5 }),
      cwd: process.cwd(),
      runtimeMode: "auto",
    });
    assert.isTrue(result.ok);
    assert.include(result.output, "provider-openai-compatible");
  });

  it.effect("rejects non-http(s) baseUrl schemes without issuing network requests", () =>
    Effect.gen(function* () {
      const endpoint = resolveOpenAiCompatibleEndpoint(
        decodeSettings({ enabled: true, preset: "custom", baseUrl: "file:///etc/passwd" }),
        {},
      );
      assert.equal(endpoint.baseUrl, "");
      assert.isTrue(endpoint.invalidBaseUrl);

      let called = false;
      const httpClient = HttpClient.make(() =>
        Effect.sync(() => {
          called = true;
          throw new Error("should not be called");
        }),
      );
      const snapshot = yield* checkOpenAiCompatibleStatus(
        decodeSettings({ enabled: true, preset: "custom", baseUrl: "file:///etc/passwd" }),
        {},
      ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

      assert.isFalse(called);
      assert.equal(snapshot.status, "error");
      assert.isTrue(snapshot.message?.includes("http:// or https://") ?? false);
    }),
  );

  it.effect("redacts Bearer tokens from transport error messages", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("mistral-redact");
      const httpClient = HttpClient.make(() =>
        Effect.fail(
          new Error("connect failed with Authorization: Bearer super-secret-token-123") as never,
        ),
      );
      const adapter = makeOpenAiCompatibleAdapterV2({
        instanceId,
        settings: decodeSettings({
          enabled: true,
          preset: "mistral",
          apiKey: "super-secret-token-123",
        }),
        environment: {},
        httpClient,
      });
      const session = yield* adapter.openSession({
        threadId: ThreadId.make("thread:redact"),
        providerSessionId: ProviderSessionId.make("session:redact"),
        modelSelection: { instanceId, model: "devstral-medium-latest" },
        runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
      });
      const providerThread = yield* session.ensureThread({
        threadId: ThreadId.make("thread:redact"),
        modelSelection: { instanceId, model: "devstral-medium-latest" },
        runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
      });

      yield* session.startTurn({
        appThread: { id: ThreadId.make("thread:redact") } as never,
        threadId: ThreadId.make("thread:redact"),
        runId: RunId.make("run:redact"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt:redact"),
        rootNodeId: NodeId.make("node:redact"),
        providerThread,
        message: {
          messageId: MessageId.make("msg:redact"),
          text: "Hello",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId, model: "devstral-medium-latest" },
        runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
      });

      const events = yield* session.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "failed",
        ),
        Stream.runCollect,
      );
      const errorEvent = [...events].find(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isDefined(errorEvent);
      if (errorEvent?.type === "turn_item.updated" && errorEvent.turnItem.type === "error") {
        assert.notInclude(errorEvent.turnItem.failure.message, "super-secret-token-123");
        assert.include(errorEvent.turnItem.failure.message, "[REDACTED]");
      }
    }).pipe(Effect.scoped),
  );
});
