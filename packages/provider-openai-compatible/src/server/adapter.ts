import {
  MessageId,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderFailureClass,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { OPENAI_COMPATIBLE_DRIVER_KIND, type OpenAiCompatibleSettings } from "../settings.ts";
import { resolveOpenAiCompatibleEndpoint } from "./presets.ts";
import { CODING_TOOL_DEFINITIONS, executeCodingTool } from "./tools.ts";

const MAX_TOOL_STEPS = 16;

interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: ReadonlyArray<{
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
}

interface ParsedCompletionTurn {
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  }>;
}

function makeNativeRef(nativeId: string): OrchestrationV2ProviderRef {
  return {
    driver: OPENAI_COMPATIBLE_DRIVER_KIND,
    nativeId,
    strength: "strong",
  };
}

const OpenAiCompatibleCapabilities: OrchestrationV2ProviderCapabilities = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsNativeResume: false,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
};

const READ_ONLY_CODING_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "grep_files",
]);
const READ_ONLY_TOOL_CONCURRENCY = 6;

const MAX_TRANSPORT_ERROR_CHARS = 300;

function sanitizeTransportError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            typeof error._tag === "string"
          ? error._tag
          : "Network request error";
  const redacted = raw.replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]").trim();
  if (!redacted) return "Network request error";
  return redacted.length > MAX_TRANSPORT_ERROR_CHARS
    ? `${redacted.slice(0, MAX_TRANSPORT_ERROR_CHARS)}...`
    : redacted;
}

export function classifyHttpFailure(
  status: number,
  bodyText: string,
  retryAfterHeader?: string | null,
  nowMs?: number,
): OrchestrationV2ProviderFailure {
  let failureClass: OrchestrationV2ProviderFailureClass = "provider_error";
  let retryable = false;
  let resetAt: string | null = null;

  if (status === 429) {
    failureClass = "usage_limit";
    retryable = true;
    if (retryAfterHeader && nowMs !== undefined) {
      const seconds = Number(retryAfterHeader);
      if (Number.isFinite(seconds) && seconds > 0) {
        resetAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs + seconds * 1000));
      } else {
        const parsed = Date.parse(retryAfterHeader);
        if (Number.isFinite(parsed) && parsed > nowMs) {
          resetAt = DateTime.formatIso(DateTime.makeUnsafe(parsed));
        }
      }
    }
  } else if (status === 401 || status === 403) {
    failureClass = "permission_error";
  } else if (status === 400 || status === 404 || status === 422) {
    failureClass = "validation_error";
  } else if (status >= 500 || status === 408) {
    failureClass = "provider_error";
    retryable = true;
  }

  let detail = bodyText.trim();
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string }; message?: string };
    detail = parsed.error?.message ?? parsed.message ?? detail;
  } catch {
    // plain text error body
  }
  const message = detail ? `HTTP ${status}: ${detail}` : `HTTP ${status} from API endpoint.`;
  return makeProviderFailure({
    class: failureClass,
    message,
    code: `http_${status}`,
    retryable,
    ...(resetAt ? { resetAt } : {}),
  });
}

interface SseDelta {
  readonly text?: string;
  readonly reasoning?: string;
}

class SseTurnAccumulator {
  text = "";
  reasoning = "";
  private readonly toolCallsByIndex = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  private lineBuffer = "";

  pushLine(line: string): SseDelta | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return null;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return null;
    let parsed: {
      choices?: ReadonlyArray<{
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: ReadonlyArray<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      return null;
    }
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return null;
    let deltaReasoning: string | undefined;
    let deltaText: string | undefined;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      this.reasoning += delta.reasoning_content;
      deltaReasoning = delta.reasoning_content;
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      this.text += delta.content;
      deltaText = delta.content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0;
        const current = this.toolCallsByIndex.get(index) ?? {
          id: tc.id ?? `call_${index}`,
          name: "",
          arguments: "",
        };
        if (tc.id) current.id = tc.id;
        if (tc.function?.name) current.name += tc.function.name;
        if (tc.function?.arguments) current.arguments += tc.function.arguments;
        this.toolCallsByIndex.set(index, current);
      }
    }
    if (deltaText === undefined && deltaReasoning === undefined) return null;
    return {
      ...(deltaText === undefined ? {} : { text: deltaText }),
      ...(deltaReasoning === undefined ? {} : { reasoning: deltaReasoning }),
    };
  }

  pushChunk(chunk: string): ReadonlyArray<SseDelta> {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split(/\r?\n/u);
    this.lineBuffer = lines.pop() ?? "";
    const deltas: Array<SseDelta> = [];
    for (const line of lines) {
      const delta = this.pushLine(line);
      if (delta) deltas.push(delta);
    }
    return deltas;
  }

  flush(): ReadonlyArray<SseDelta> {
    if (!this.lineBuffer) return [];
    const remaining = this.lineBuffer;
    this.lineBuffer = "";
    const delta = this.pushLine(remaining);
    return delta ? [delta] : [];
  }

  result(): ParsedCompletionTurn {
    return {
      text: this.text,
      reasoning: this.reasoning,
      toolCalls: [...this.toolCallsByIndex.entries()]
        .toSorted((a, b) => a[0] - b[0])
        .map(([, call]) => call)
        .filter((call) => call.name.length > 0),
    };
  }
}

export function parseSseChunkLines(
  rawText: string,
  onDelta?: (delta: SseDelta) => void,
): ParsedCompletionTurn {
  const acc = new SseTurnAccumulator();
  for (const delta of acc.pushChunk(rawText)) {
    onDelta?.(delta);
  }
  for (const delta of acc.flush()) {
    onDelta?.(delta);
  }
  return acc.result();
}

function parseNonStreamingCompletion(payload: unknown): ParsedCompletionTurn {
  const data = payload as {
    choices?: ReadonlyArray<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: ReadonlyArray<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const message = data.choices?.[0]?.message;
  return {
    text: message?.content ?? "",
    reasoning: message?.reasoning_content ?? "",
    toolCalls: (message?.tool_calls ?? [])
      .filter((tc) => typeof tc.function?.name === "string" && tc.function.name.length > 0)
      .map((tc, index) => ({
        id: tc.id ?? `call_${index}`,
        name: tc.function!.name!,
        arguments: tc.function?.arguments ?? "{}",
      })),
  };
}

interface ThreadMemory {
  providerThread: OrchestrationV2ProviderThread;
  history: Array<ChatMessage>;
  messages: Array<OrchestrationV2ConversationMessage>;
  itemOrdinal: number;
}

export function makeOpenAiCompatibleAdapterV2(input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OpenAiCompatibleSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly httpClient: HttpClient.HttpClient;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const endpoint = resolveOpenAiCompatibleEndpoint(input.settings, input.environment);

  return {
    instanceId: input.instanceId,
    driver: OPENAI_COMPATIBLE_DRIVER_KIND,
    getCapabilities: () => Effect.succeed(OpenAiCompatibleCapabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("OpenAiCompatibleAdapterV2.openSession")(function* (openInput) {
      const now = yield* DateTime.now;
      const eventsQueue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const threads = new Map<ProviderThreadId, ThreadMemory>();
      interface ActiveTurnEntry {
        readonly fiber: Fiber.Fiber<void, never>;
        readonly threadId: ProviderAdapter.ProviderAdapterV2TurnInput["threadId"];
        readonly providerThreadId: ProviderThreadId;
        readonly nodeId: ProviderAdapter.ProviderAdapterV2TurnInput["rootNodeId"];
        readonly runAttemptId: ProviderAdapter.ProviderAdapterV2TurnInput["attemptId"];
        readonly ordinal: number;
        readonly startedAt: DateTime.Utc;
        readonly model: string;
      }
      const activeTurns = new Map<ProviderTurnId, ActiveTurnEntry>();

      const sessionCwd = openInput.runtimePolicy.cwd?.trim() || ".";
      const sessionModel = openInput.modelSelection.model.trim() || null;
      const providerSession: OrchestrationV2ProviderSession = {
        id: openInput.providerSessionId,
        driver: OPENAI_COMPATIBLE_DRIVER_KIND,
        providerInstanceId: input.instanceId,
        status: "ready",
        cwd: sessionCwd,
        model: sessionModel,
        capabilities: OpenAiCompatibleCapabilities,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* Queue.offer(eventsQueue, {
        type: "provider_session.updated",
        driver: OPENAI_COMPATIBLE_DRIVER_KIND,
        providerSession,
      });

      const getOrCreateThread = (providerThread: OrchestrationV2ProviderThread): ThreadMemory => {
        const existing = threads.get(providerThread.id);
        if (existing) {
          existing.providerThread = providerThread;
          return existing;
        }
        const created: ThreadMemory = {
          providerThread,
          history: [],
          messages: [],
          itemOrdinal: 0,
        };
        threads.set(providerThread.id, created);
        return created;
      };

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event): Effect.Effect<void> =>
        Queue.offer(eventsQueue, event).pipe(Effect.asVoid);

      const nextOrdinal = (memory: ThreadMemory) => {
        memory.itemOrdinal += 1;
        return memory.itemOrdinal;
      };

      const runTurnEffect = Effect.fn("OpenAiCompatibleAdapterV2.runTurn")(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        providerTurnId: ProviderTurnId,
        memory: ThreadMemory,
        startedAt: DateTime.Utc,
        model: string,
      ) {
        const baseTurn = (
          status: OrchestrationV2ProviderTurn["status"],
          completedAt: DateTime.Utc | null,
        ): OrchestrationV2ProviderTurn => ({
          id: providerTurnId,
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: makeNativeRef(providerTurnId),
          ordinal: turnInput.providerTurnOrdinal,
          status,
          startedAt,
          completedAt,
          ...(model ? { model } : {}),
        });

        yield* emit({
          type: "provider_turn.updated",
          driver: OPENAI_COMPATIBLE_DRIVER_KIND,
          threadId: turnInput.threadId,
          providerTurn: baseTurn("running", null),
        });

        const historyLenBeforeTurn = memory.history.length;
        const messagesLenBeforeTurn = memory.messages.length;
        let hasCommittedStep = false;

        const failTurn = Effect.fn("OpenAiCompatibleAdapterV2.failTurn")(function* (
          failure: OrchestrationV2ProviderFailure,
        ) {
          // Roll back the pending user message if no step completed, preventing duplicate
          // consecutive user messages when the turn is retried on strict APIs (e.g. Mistral).
          if (!hasCommittedStep) {
            memory.history.length = historyLenBeforeTurn;
            memory.messages.length = messagesLenBeforeTurn;
          }
          const failedAt = yield* DateTime.now;
          const errorItem = makeProviderFailureTurnItem({
            driver: OPENAI_COMPATIBLE_DRIVER_KIND,
            threadId: turnInput.threadId,
            runId: turnInput.runId,
            nodeId: turnInput.rootNodeId,
            providerThreadId: turnInput.providerThread.id,
            providerTurnId,
            itemOrdinal: nextOrdinal(memory),
            failure,
            occurredAt: failedAt,
          });
          yield* emit({
            type: "turn_item.updated",
            driver: OPENAI_COMPATIBLE_DRIVER_KIND,
            turnItem: errorItem,
          });
          yield* emit({
            type: "provider_turn.updated",
            driver: OPENAI_COMPATIBLE_DRIVER_KIND,
            threadId: turnInput.threadId,
            providerTurn: baseTurn("failed", failedAt),
          });
        });

        if (endpoint.invalidBaseUrl) {
          yield* failTurn(
            makeProviderFailure({
              class: "validation_error",
              message: `${endpoint.preset.displayName} Base URL must use http:// or https://.`,
              code: "invalid_base_url",
              retryable: false,
            }),
          );
          return;
        }
        if (!endpoint.baseUrl) {
          yield* failTurn(
            makeProviderFailure({
              class: "validation_error",
              message: `${endpoint.preset.displayName} Base URL is not configured.`,
              code: "missing_base_url",
              retryable: false,
            }),
          );
          return;
        }
        if (endpoint.preset.requiresApiKey && !endpoint.apiKey) {
          yield* failTurn(
            makeProviderFailure({
              class: "permission_error",
              message: `Missing API key for ${endpoint.preset.displayName}.`,
              code: "missing_api_key",
              retryable: false,
            }),
          );
          return;
        }
        if (!model) {
          yield* failTurn(
            makeProviderFailure({
              class: "validation_error",
              message: "No model selected for this turn.",
              code: "missing_model",
              retryable: false,
            }),
          );
          return;
        }

        const cwd = turnInput.runtimePolicy.cwd;
        const systemPrompt = [
          "You are a concise, thorough AI coding assistant running inside J3 Code.",
          cwd ? `Current workspace directory: ${cwd}` : "",
          `Current permission mode: ${turnInput.runtimePolicy.runtimeMode}.`,
          ...(turnInput.appContext ?? []).map((note) => note.text),
        ]
          .filter((part) => part.length > 0)
          .join("\n");

        if (memory.history.length === 0) {
          memory.history.push({ role: "system", content: systemPrompt });
        } else if (memory.history[0]?.role === "system") {
          memory.history[0] = { role: "system", content: systemPrompt };
        }

        memory.history.push({ role: "user", content: turnInput.message.text });
        memory.messages.push({
          id: turnInput.message.messageId,
          threadId: turnInput.threadId,
          runId: turnInput.runId,
          nodeId: turnInput.rootNodeId,
          role: "user",
          text: turnInput.message.text,
          attachments: [...turnInput.message.attachments],
          streaming: false,
          createdBy: turnInput.message.createdBy,
          creationSource: turnInput.message.creationSource,
          createdAt: startedAt,
          updatedAt: startedAt,
        });

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
        };
        if (endpoint.apiKey) {
          headers.Authorization = `Bearer ${endpoint.apiKey}`;
        }

        for (let step = 0; step < MAX_TOOL_STEPS; step++) {
          const requestBody: Record<string, unknown> = {
            model,
            messages: memory.history,
            stream: true,
            ...(cwd ? { tools: CODING_TOOL_DEFINITIONS, tool_choice: "auto" } : {}),
          };

          const httpResult = yield* input.httpClient
            .execute(
              HttpClientRequest.post(`${endpoint.baseUrl}/chat/completions`).pipe(
                HttpClientRequest.setHeaders(headers),
                HttpClientRequest.bodyJsonUnsafe(requestBody),
              ),
            )
            .pipe(Effect.timeout("120 seconds"), Effect.result);

          if (Result.isFailure(httpResult)) {
            yield* failTurn(
              makeProviderFailure({
                class: "transport_error",
                message: `${endpoint.preset.displayName} request failed: ${sanitizeTransportError(httpResult.failure)}`,
                code: "network_error",
                retryable: true,
              }),
            );
            return;
          }

          const response = httpResult.success;
          if (response.status < 200 || response.status >= 300) {
            const errText = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
            const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
            yield* failTurn(
              classifyHttpFailure(
                response.status,
                errText,
                response.headers["retry-after"] ?? null,
                nowMs,
              ),
            );
            return;
          }

          const contentType = response.headers["content-type"] ?? "";
          const stepStartedAt = yield* DateTime.now;
          const reasoningItemId = IdAllocator.derive.turnItemFromProviderItem({
            driver: OPENAI_COMPATIBLE_DRIVER_KIND,
            nativeItemId: `${providerTurnId}:reasoning:${step}`,
          });
          const assistantMessageId = MessageId.make(`${providerTurnId}:msg:${step}`);
          const assistantItemId = IdAllocator.derive.turnItemFromProviderItem({
            driver: OPENAI_COMPATIBLE_DRIVER_KIND,
            nativeItemId: `${providerTurnId}:assistant:${step}`,
          });
          let reasoningOrdinal: number | null = null;
          let assistantOrdinal: number | null = null;

          const emitReasoning = (
            reasoningText: string,
            streaming: boolean,
            at: DateTime.Utc,
          ): Effect.Effect<void> => {
            if (reasoningOrdinal === null) {
              reasoningOrdinal = nextOrdinal(memory);
            }
            const reasoningItem: OrchestrationV2TurnItem = {
              id: reasoningItemId,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId: turnInput.rootNodeId,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: reasoningOrdinal,
              status: streaming ? "running" : "completed",
              title: "Reasoning",
              startedAt: stepStartedAt,
              completedAt: streaming ? null : at,
              updatedAt: at,
              type: "reasoning",
              text: reasoningText,
              streaming,
            };
            return emit({
              type: "turn_item.updated",
              driver: OPENAI_COMPATIBLE_DRIVER_KIND,
              turnItem: reasoningItem,
            });
          };

          const emitAssistant = (
            assistantText: string,
            streaming: boolean,
            phase: "commentary" | "final_answer",
            at: DateTime.Utc,
          ): Effect.Effect<void> => {
            if (assistantOrdinal === null) {
              assistantOrdinal = nextOrdinal(memory);
            }
            const assistantItem: OrchestrationV2TurnItem = {
              id: assistantItemId,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId: turnInput.rootNodeId,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: assistantOrdinal,
              status: streaming ? "running" : "completed",
              title: null,
              startedAt: stepStartedAt,
              completedAt: streaming ? null : at,
              updatedAt: at,
              type: "assistant_message",
              phase,
              messageId: assistantMessageId,
              text: assistantText,
              streaming,
            };
            return emit({
              type: "turn_item.updated",
              driver: OPENAI_COMPATIBLE_DRIVER_KIND,
              turnItem: assistantItem,
            });
          };

          let parsedTurn: ParsedCompletionTurn;
          if (contentType.includes("text/event-stream")) {
            const accumulator = new SseTurnAccumulator();
            const decoder = new TextDecoder();
            const streamResult = yield* response.stream.pipe(
              Stream.runForEach((bytes) =>
                Effect.gen(function* () {
                  const textChunk = decoder.decode(bytes, { stream: true });
                  const deltas = accumulator.pushChunk(textChunk);
                  if (deltas.length === 0) return;
                  const deltaAt = yield* DateTime.now;
                  if (deltas.some((delta) => delta.reasoning !== undefined)) {
                    yield* emitReasoning(accumulator.reasoning, true, deltaAt);
                  }
                  if (deltas.some((delta) => delta.text !== undefined)) {
                    yield* emitAssistant(accumulator.text, true, "final_answer", deltaAt);
                  }
                }),
              ),
              Effect.timeout("120 seconds"),
              Effect.result,
            );
            const trailing = decoder.decode();
            if (trailing) {
              accumulator.pushChunk(trailing);
            }
            accumulator.flush();
            if (Result.isFailure(streamResult)) {
              yield* failTurn(
                makeProviderFailure({
                  class: "transport_error",
                  message: `${endpoint.preset.displayName} stream failed: ${sanitizeTransportError(streamResult.failure)}`,
                  code: "stream_error",
                  retryable: true,
                }),
              );
              return;
            }
            parsedTurn = accumulator.result();
          } else {
            const jsonBody = yield* response.json.pipe(Effect.orElseSucceed(() => ({})));
            parsedTurn = parseNonStreamingCompletion(jsonBody);
          }

          const stepAt = yield* DateTime.now;
          hasCommittedStep = true;

          if (parsedTurn.reasoning.trim().length > 0 || reasoningOrdinal !== null) {
            yield* emitReasoning(parsedTurn.reasoning, false, stepAt);
          }

          if (parsedTurn.text.length > 0 || assistantOrdinal !== null) {
            yield* emitAssistant(
              parsedTurn.text,
              false,
              parsedTurn.toolCalls.length > 0 ? "commentary" : "final_answer",
              stepAt,
            );
            if (parsedTurn.text.length > 0) {
              memory.messages.push({
                id: assistantMessageId,
                threadId: turnInput.threadId,
                runId: turnInput.runId,
                nodeId: turnInput.rootNodeId,
                role: "assistant",
                text: parsedTurn.text,
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: stepAt,
                updatedAt: stepAt,
              });
            }
          }

          if (parsedTurn.toolCalls.length === 0 || !cwd) {
            memory.history.push({ role: "assistant", content: parsedTurn.text });
            break;
          }

          memory.history.push({
            role: "assistant",
            content: parsedTurn.text || null,
            tool_calls: parsedTurn.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          });

          // Run consecutive read-only tool calls in parallel while keeping mutating tools sequential
          // and preserving original call order in emitted items and conversation history.
          type ToolBatch = {
            readonly parallel: boolean;
            readonly calls: Array<(typeof parsedTurn.toolCalls)[number]>;
          };
          const toolBatches: Array<ToolBatch> = [];
          for (const call of parsedTurn.toolCalls) {
            const isReadOnly = READ_ONLY_CODING_TOOLS.has(call.name);
            const last = toolBatches.at(-1);
            if (isReadOnly && last?.parallel) {
              last.calls.push(call);
            } else {
              toolBatches.push({ parallel: isReadOnly, calls: [call] });
            }
          }

          for (const batch of toolBatches) {
            const executed = yield* Effect.forEach(
              batch.calls,
              (call) =>
                Effect.gen(function* () {
                  const toolStartedAt = yield* DateTime.now;
                  const result = yield* Effect.promise((signal) =>
                    executeCodingTool({
                      name: call.name,
                      rawArguments: call.arguments,
                      cwd,
                      runtimeMode: turnInput.runtimePolicy.runtimeMode,
                      environment: input.environment,
                      ...(input.platform ? { platform: input.platform } : {}),
                      signal,
                    }),
                  );
                  const toolCompletedAt = yield* DateTime.now;
                  return { call, result, toolStartedAt, toolCompletedAt };
                }),
              { concurrency: batch.parallel ? READ_ONLY_TOOL_CONCURRENCY : 1 },
            );

            for (const { call, result, toolStartedAt, toolCompletedAt } of executed) {
              const toolItemId = IdAllocator.derive.turnItemFromProviderItem({
                driver: OPENAI_COMPATIBLE_DRIVER_KIND,
                nativeItemId: `${providerTurnId}:tool:${step}:${call.id}`,
              });
              if (result.kind === "file_change" && result.fileName) {
                yield* emit({
                  type: "turn_item.updated",
                  driver: OPENAI_COMPATIBLE_DRIVER_KIND,
                  turnItem: {
                    id: toolItemId,
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: nextOrdinal(memory),
                    status: result.ok ? "completed" : "failed",
                    title: `${call.name}: ${result.fileName}`,
                    startedAt: toolStartedAt,
                    completedAt: toolCompletedAt,
                    updatedAt: toolCompletedAt,
                    type: "file_change",
                    fileName: result.fileName,
                  },
                });
              } else {
                yield* emit({
                  type: "turn_item.updated",
                  driver: OPENAI_COMPATIBLE_DRIVER_KIND,
                  turnItem: {
                    id: toolItemId,
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: nextOrdinal(memory),
                    status: result.ok ? "completed" : "failed",
                    title: call.name,
                    startedAt: toolStartedAt,
                    completedAt: toolCompletedAt,
                    updatedAt: toolCompletedAt,
                    type: "command_execution",
                    input: result.command ?? `${call.name}(${call.arguments})`,
                    output: result.output,
                    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
                    outputIndicatesFailure: !result.ok,
                  },
                });
              }
              memory.history.push({
                role: "tool",
                tool_call_id: call.id,
                content: result.output,
              });
            }
          }
        }

        const completedAt = yield* DateTime.now;
        yield* emit({
          type: "provider_turn.updated",
          driver: OPENAI_COMPATIBLE_DRIVER_KIND,
          threadId: turnInput.threadId,
          providerTurn: baseTurn("completed", completedAt),
        });
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: input.instanceId,
        driver: OPENAI_COMPATIBLE_DRIVER_KIND,
        providerSessionId: openInput.providerSessionId,
        providerSession,
        canResumeAfterRestart: false,
        events: Stream.fromQueue(eventsQueue),
        ensureThread: Effect.fn("OpenAiCompatibleAdapterV2.ensureThread")(function* (ensureInput) {
          const ts = yield* DateTime.now;
          const existing = ensureInput.existingProviderThread;
          const id =
            existing && !ensureInput.forceNewNativeThread
              ? existing.id
              : ProviderThreadId.make(
                  `openai-compat:${input.instanceId}:${ensureInput.threadId}:${DateTime.toEpochMillis(ts)}`,
                );
          const providerThread: OrchestrationV2ProviderThread = {
            id,
            driver: OPENAI_COMPATIBLE_DRIVER_KIND,
            providerInstanceId: input.instanceId,
            providerSessionId: openInput.providerSessionId,
            appThreadId: ensureInput.threadId,
            ownerNodeId: null,
            nativeThreadRef: makeNativeRef(id),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: existing?.firstRunOrdinal ?? null,
            lastRunOrdinal: existing?.lastRunOrdinal ?? null,
            handoffIds: existing?.handoffIds ?? [],
            forkedFrom: existing?.forkedFrom ?? null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt: existing?.createdAt ?? ts,
            updatedAt: ts,
          };
          getOrCreateThread(providerThread);
          yield* emit({
            type: "provider_thread.updated",
            driver: OPENAI_COMPATIBLE_DRIVER_KIND,
            providerThread,
          });
          return providerThread;
        }),
        resumeThread: Effect.fn("OpenAiCompatibleAdapterV2.resumeThread")(function* (resumeInput) {
          const ts = yield* DateTime.now;
          const providerThread: OrchestrationV2ProviderThread = {
            ...resumeInput.providerThread,
            providerSessionId: openInput.providerSessionId,
            status: "idle",
            updatedAt: ts,
          };
          getOrCreateThread(providerThread);
          return providerThread;
        }),
        injectHistory: (historyInput) =>
          Effect.sync(() => {
            const memory = getOrCreateThread(historyInput.providerThread);
            for (const item of historyInput.messages) {
              memory.history.push({ role: item.role, content: item.text });
            }
            if (historyInput.context.trim().length > 0 && historyInput.messages.length === 0) {
              memory.history.push({ role: "user", content: historyInput.context });
            }
            return true;
          }),
        startTurn: Effect.fn("OpenAiCompatibleAdapterV2.startTurn")(function* (turnInput) {
          const memory = getOrCreateThread(turnInput.providerThread);
          const startedAt = yield* DateTime.now;
          const model =
            turnInput.modelSelection.model.trim() ||
            input.settings.defaultModel.trim() ||
            endpoint.preset.defaultModels[0]?.slug ||
            "";
          const providerTurnId = ProviderTurnId.make(
            `openai-compat-turn:${turnInput.runId}:${turnInput.providerTurnOrdinal}`,
          );
          const fiber = yield* Effect.forkDetach(
            runTurnEffect(turnInput, providerTurnId, memory, startedAt, model).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  activeTurns.delete(providerTurnId);
                }),
              ),
            ),
          );
          activeTurns.set(providerTurnId, {
            fiber,
            threadId: turnInput.threadId,
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            ordinal: turnInput.providerTurnOrdinal,
            startedAt,
            model,
          });
        }),
        steerTurn: (steerInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver: OPENAI_COMPATIBLE_DRIVER_KIND,
              providerThreadId: steerInput.providerThread.id,
            }),
          ),
        interruptTurn: Effect.fn("OpenAiCompatibleAdapterV2.interruptTurn")(
          function* (interruptInput) {
            const active = activeTurns.get(interruptInput.providerTurnId);
            if (active) {
              yield* Fiber.interrupt(active.fiber);
              activeTurns.delete(interruptInput.providerTurnId);
            }
            const ts = yield* DateTime.now;
            const resolvedThreadId =
              active?.threadId ?? interruptInput.providerThread.appThreadId ?? undefined;
            yield* emit({
              type: "provider_turn.updated",
              driver: OPENAI_COMPATIBLE_DRIVER_KIND,
              ...(resolvedThreadId ? { threadId: resolvedThreadId } : {}),
              providerTurn: {
                id: interruptInput.providerTurnId,
                providerThreadId: active?.providerThreadId ?? interruptInput.providerThread.id,
                nodeId:
                  active?.nodeId ?? interruptInput.providerThread.ownerNodeId ?? ("root" as never),
                runAttemptId: active?.runAttemptId ?? null,
                nativeTurnRef: makeNativeRef(interruptInput.providerTurnId),
                ordinal: active?.ordinal ?? 1,
                status: "interrupted",
                startedAt: active?.startedAt ?? ts,
                completedAt: ts,
                ...(active?.model ? { model: active.model } : {}),
              },
            });
          },
        ),
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: (readInput) =>
          Effect.sync(() => {
            const memory = getOrCreateThread(readInput.providerThread);
            return {
              providerThread: memory.providerThread,
              messages: [...memory.messages],
              runtimeRequests: [],
            };
          }),
        rollbackThread: (rollbackInput) =>
          Effect.sync(() => {
            const memory = getOrCreateThread(rollbackInput.providerThread);
            if (rollbackInput.target.type === "thread_start") {
              memory.history = memory.history.filter((msg) => msg.role === "system");
              memory.messages = [];
            }
            return {
              providerThread: memory.providerThread,
              messages: [...memory.messages],
              runtimeRequests: [],
            };
          }),
        forkThread: Effect.fn("OpenAiCompatibleAdapterV2.forkThread")(function* (forkInput) {
          const ts = yield* DateTime.now;
          const source = threads.get(forkInput.sourceProviderThread.id);
          const forkedId = ProviderThreadId.make(
            `openai-compat:${input.instanceId}:${forkInput.targetThreadId}:${DateTime.toEpochMillis(ts)}`,
          );
          const forkedThread: OrchestrationV2ProviderThread = {
            ...forkInput.sourceProviderThread,
            id: forkedId,
            appThreadId: forkInput.targetThreadId,
            ownerNodeId: forkInput.ownerNodeId ?? null,
            nativeThreadRef: makeNativeRef(forkedId),
            forkedFrom: {
              providerThreadId: forkInput.sourceProviderThread.id,
              ...(forkInput.providerTurnId ? { providerTurnId: forkInput.providerTurnId } : {}),
            },
            createdAt: ts,
            updatedAt: ts,
          };
          threads.set(forkedId, {
            providerThread: forkedThread,
            history: source ? [...source.history] : [],
            messages: source ? [...source.messages] : [],
            itemOrdinal: source?.itemOrdinal ?? 0,
          });
          return forkedThread;
        }),
      };

      return runtime;
    }),
  };
}
