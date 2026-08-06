/* oxlint-disable max-lines -- transport accounting needs one cross-path provider matrix. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiModelTransportEvent,
} from "../host.js";
import { responsesPromptObserver } from "../internal/openai.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
} from "../providers/openai-chatgpt-responses.js";
import type { Context, Model } from "../types.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";

const initialHost = getAiTransportHost();

const openAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

const azureModel = {
  ...openAIModel,
  api: "azure-openai-responses",
  provider: "azure-openai-responses",
  baseUrl: "https://resource.openai.azure.com/openai/v1",
} satisfies Model<"azure-openai-responses">;

const chatGptModel = {
  ...openAIModel,
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.test/backend-api",
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  systemPrompt: "private prompt that must never enter transport accounting",
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
} satisfies Context;

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

function completedSseEvent(responseId: string) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

function completedSseResponse(responseId = "resp_transport_accounting"): Response {
  return new Response(`data: ${JSON.stringify(completedSseEvent(responseId))}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function truncatedSseResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      item_id: "msg_truncated",
      output_index: 0,
      content_index: 0,
      delta: "partial",
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function stalledSseResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>(), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function abortErroredSseResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("upstream reset", "AbortError"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function waitForRequestAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("expected request signal"));
      return;
    }
    const rejectAbort = () => reject(new DOMException("request aborted", "AbortError"));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function configureTransportObserver(
  events: AiModelTransportEvent[],
  buildNetworkFetch?: () => typeof fetch,
): void {
  configureAiTransportHost({
    ...initialHost,
    ...(buildNetworkFetch
      ? {
          buildModelFetch: (
            _model: Model,
            _timeoutMs?: number,
            options?: { onFetchEgress?: () => void },
          ) => {
            const networkFetch = buildNetworkFetch();
            return async (input: RequestInfo | URL, init?: RequestInit) => {
              const responsePromise = networkFetch(input, init);
              options?.onFetchEgress?.();
              return await responsePromise;
            };
          },
        }
      : {}),
    observeModelTransportEvent: (event: AiModelTransportEvent) => events.push(event),
  });
}

function attemptEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "attempt" }> =>
      event.type === "attempt",
  );
}

function connectionEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "connection" }> =>
      event.type === "connection",
  );
}

function fallbackEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "fallback" }> =>
      event.type === "fallback",
  );
}

function submissionEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "submission" }> =>
      event.type === "submission",
  );
}

afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost(initialHost);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenAI provider transport accounting", () => {
  it("records SDK retries from physical fetches, not retry headers", async () => {
    const events: AiModelTransportEvent[] = [];
    const guardedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after-ms": "0" },
        }),
      )
      .mockResolvedValueOnce(completedSseResponse());
    configureTransportObserver(events, () => guardedFetch);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(
        { ...openAIModel, headers: { "X-Stainless-Retry-Count": "99" } },
        context,
        { apiKey: "test-key", maxRetries: 1, requestId: "call-sdk-retry" },
      ),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed", statusCode: 503 },
      { ordinal: 2, reason: "retry", outcome: "completed", statusCode: 200 },
    ]);
  });

  it("emits one zero-submission fact after terminal SDK preflight failure", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => async () => {
        throw new Error("blocked before provider egress");
      },
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-preflight",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      {
        callId: "call-sdk-preflight",
        transport: "responses-sdk",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
    ]);
  });

  it("does not count a synchronous SDK fetch throw as a submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch invocation failed");
      }),
    );

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-sync-fetch-throw",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "responses-sdk", outcome: "failed", total: 0 },
    ]);
  });

  it("keeps the first real SDK egress initial after a preflight-only retry", async () => {
    const events: AiModelTransportEvent[] = [];
    let guardedFetchCalls = 0;
    configureTransportObserver(events);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch:
        (_model: Model, _timeoutMs?: number, options?: { onFetchEgress?: () => void }) =>
        async () => {
          guardedFetchCalls += 1;
          if (guardedFetchCalls === 1) {
            throw new TypeError("blocked before provider egress");
          }
          options?.onFetchEgress?.();
          return completedSseResponse();
        },
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 1,
        requestId: "call-sdk-preflight-retry",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(guardedFetchCalls).toBe(2);
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "completed", statusCode: 200 },
    ]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("records encrypted-content recovery as a distinct submission reason", async () => {
    const events: AiModelTransportEvent[] = [];
    const guardedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "invalid encrypted content",
              type: "invalid_request_error",
              code: "invalid_encrypted_content",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(completedSseResponse());
    configureTransportObserver(events, () => guardedFetch);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-recovery",
        onPayload: (payload: unknown) => {
          const request = payload as Record<string, unknown>;
          return {
            ...request,
            input: [
              ...((request.input as unknown[]) ?? []),
              { type: "reasoning", encrypted_content: "secret-ciphertext", summary: [] },
            ],
          };
        },
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(
      attemptEvents(events).map(({ reason, outcome, statusCode }) => ({
        reason,
        outcome,
        statusCode,
      })),
    ).toEqual([
      { reason: "initial", outcome: "failed", statusCode: 400 },
      { reason: "payload_recovery", outcome: "completed", statusCode: 200 },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-ciphertext");
  });

  it("emits zero submission when payload-recovery prompt observation fails", async () => {
    const events: AiModelTransportEvent[] = [];
    const guardedFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "invalid encrypted content",
            type: "invalid_request_error",
            code: "invalid_encrypted_content",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    configureTransportObserver(events, () => guardedFetch);
    const options = {
      apiKey: "test-key",
      maxRetries: 0,
      requestId: "call-sdk-recovery-observer",
      onPayload: (payload: unknown) => {
        const request = payload as Record<string, unknown>;
        return {
          ...request,
          input: [
            ...((request.input as unknown[]) ?? []),
            { type: "reasoning", encrypted_content: "ciphertext", summary: [] },
          ],
        };
      },
    };
    responsesPromptObserver.set(options, (observation) => {
      if (observation.payloadVariant === "encrypted-content-retry") {
        throw new Error("prompt observer failed");
      }
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, options),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(guardedFetch).toHaveBeenCalledOnce();
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed", statusCode: 400 },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "responses-sdk", outcome: "failed", total: 0 },
    ]);
  });

  it("keeps successful SDK headers pending until truncated stream failure", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => truncatedSseResponse()));

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-truncated",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toMatchObject([
      { reason: "initial", outcome: "failed", statusCode: 200 },
    ]);
  });

  it("distinguishes SDK caller abort from internal request timeout", async () => {
    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(abortEvents, () =>
      vi.fn((_input, init) => {
        queueMicrotask(() => controller.abort());
        return waitForRequestAbort(init);
      }),
    );
    const aborted = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-abort",
        signal: controller.signal,
      }),
    );

    expect((await aborted.result()).stopReason).toBe("aborted");
    expect(attemptEvents(abortEvents)).toMatchObject([{ outcome: "aborted" }]);

    const timeoutEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(timeoutEvents, () =>
      vi.fn((_input, init) => waitForRequestAbort(init)),
    );
    const timedOut = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-timeout",
        timeoutMs: 1,
      }),
    );

    expect((await timedOut.result()).stopReason).toBe("error");
    expect(attemptEvents(timeoutEvents)).toMatchObject([{ outcome: "failed" }]);
  });

  it("settles SDK post-header abort and first-event timeout at stream terminal", async () => {
    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(abortEvents, () => vi.fn(async () => completedSseResponse()));
    const aborted = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-post-header-abort",
        signal: controller.signal,
        onResponse: () => controller.abort(),
      }),
    );

    expect((await aborted.result()).stopReason).toBe("aborted");
    expect(attemptEvents(abortEvents)).toMatchObject([{ outcome: "aborted", statusCode: 200 }]);

    const timeoutEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(timeoutEvents, () => vi.fn(async () => stalledSseResponse()));
    const streamFn = createOpenAIResponsesTransportStreamFn();
    const timedOut = await Promise.resolve(
      streamFn(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-first-event-timeout",
        firstEventTimeoutMs: 1,
      } as Parameters<typeof streamFn>[2] & { firstEventTimeoutMs: number }),
    );

    expect((await timedOut.result()).stopReason).toBe("error");
    expect(attemptEvents(timeoutEvents)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);
  });

  it("treats post-header AbortError without caller cancellation as failed", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => abortErroredSseResponse()));

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-upstream-abort-error",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);
  });

  it("uses the shared SDK accounting path for Azure Responses", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => completedSseResponse()));

    const stream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(azureModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-azure-sdk",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      {
        callId: "call-azure-sdk",
        provider: "azure-openai-responses",
        api: "azure-openai-responses",
        reason: "initial",
        outcome: "completed",
      },
    ]);
  });

  it("uses the shared SDK accounting path for traditional AzureOpenAI URLs", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => completedSseResponse()));
    const traditionalAzure = {
      ...azureModel,
      baseUrl: "https://resource.openai.azure.com",
    } satisfies Model<"azure-openai-responses">;

    const stream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(traditionalAzure, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-azure-traditional",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      { callId: "call-azure-traditional", reason: "initial", outcome: "completed" },
    ]);
  });

  it("emits Azure zero submission when client fetch setup throws", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => {
        throw new Error("azure client fetch setup failed");
      },
    });

    const stream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(azureModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-azure-setup-failure",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      {
        callId: "call-azure-setup-failure",
        transport: "responses-sdk",
        outcome: "failed",
      },
    ]);
  });

  it("records each native SSE retry and completes only after stream termination", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("overloaded", {
            status: 503,
            headers: { "retry-after-ms": "0" },
          }),
        )
        .mockResolvedValueOnce(completedSseResponse()),
    );
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const result = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      requestId: "call-native-sse-retry",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
        statusCode: 503,
      },
      {
        transport: "native-codex-sse",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
        statusCode: 200,
      },
    ]);
  });

  it("settles native SSE truncation, caller abort, and watchdog timeout correctly", async () => {
    const truncatedEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(truncatedEvents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => truncatedSseResponse()),
    );
    const truncated = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-truncated",
    }).result();
    expect(truncated.stopReason).toBe("error");
    expect(attemptEvents(truncatedEvents)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);

    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(abortEvents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );
    const aborted = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-abort",
      signal: controller.signal,
      onResponse: () => controller.abort(),
    }).result();
    expect(aborted.stopReason).toBe("aborted");
    expect(attemptEvents(abortEvents)).toMatchObject([{ outcome: "aborted", statusCode: 200 }]);

    const timeoutEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(timeoutEvents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stalledSseResponse()),
    );
    const timedOut = await streamSimpleOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-first-event-timeout",
      firstEventTimeoutMs: 1,
    } as Parameters<typeof streamSimpleOpenAICodexResponses>[2] & {
      firstEventTimeoutMs: number;
    }).result();
    expect(timedOut.stopReason).toBe("error");
    expect(attemptEvents(timeoutEvents)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);
  });

  it("records explicit WebSocket handshake failure as connection plus zero submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class FailingWebSocket {
      constructor() {
        throw new Error("private websocket connect failure");
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-handshake",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(connectionEvents(events)).toMatchObject([{ reason: "initial", outcome: "failed" }]);
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "native-codex-websocket", total: 0, outcome: "failed" },
    ]);
  });

  it("distinguishes WebSocket handshake timeout from caller abort", async () => {
    const timeoutEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(timeoutEvents);
    class HangingWebSocket extends EventTarget {
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal("WebSocket", HangingWebSocket);
    const timedOut = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-handshake-timeout",
      timeoutMs: 1,
    }).result();
    expect(timedOut.stopReason).toBe("error");
    expect(connectionEvents(timeoutEvents)).toMatchObject([{ outcome: "failed" }]);
    expect(submissionEvents(timeoutEvents)).toMatchObject([{ outcome: "failed" }]);

    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(abortEvents);
    class AbortedHandshakeWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => controller.abort());
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal("WebSocket", AbortedHandshakeWebSocket);
    const aborted = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-handshake-abort",
      signal: controller.signal,
    }).result();
    expect(aborted.stopReason).toBe("aborted");
    expect(connectionEvents(abortEvents)).toMatchObject([{ outcome: "aborted" }]);
    expect(submissionEvents(abortEvents)).toMatchObject([{ outcome: "aborted" }]);
  });

  it("records a fresh WebSocket success as one connection and one attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class SuccessfulWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completedSseEvent("resp_ws_success")),
            }),
          ),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SuccessfulWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-success",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(connectionEvents(events)).toMatchObject([{ outcome: "completed" }]);
    expect(attemptEvents(events)).toMatchObject([{ outcome: "completed", reason: "initial" }]);
  });

  it("classifies synchronous WebSocket send rejection as submission failure", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class SendRejectingWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        throw new Error("private synchronous send failure");
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SendRejectingWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      requestId: "call-sync-send-fallback",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(connectionEvents(events)).toMatchObject([{ outcome: "completed" }]);
    expect(fallbackEvents(events)).toMatchObject([{ reason: "submission_failure" }]);
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        ordinal: 1,
        reason: "transport_fallback",
        outcome: "completed",
      },
    ]);
  });

  it("records post-send fallback as failed WS plus transport-fallback SSE", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class SendThenFailWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("error"), { message: "private post-send failure" }),
          ),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SendThenFailWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      requestId: "call-post-send-fallback",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-websocket",
        reason: "initial",
        outcome: "failed",
      },
      {
        transport: "native-codex-sse",
        reason: "transport_fallback",
        outcome: "completed",
      },
    ]);
    expect(fallbackEvents(events)).toMatchObject([{ reason: "stream_failure" }]);
  });

  it("records submitted WebSocket caller abort as an aborted attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(events);
    class AbortedWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() => controller.abort());
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", AbortedWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-submitted-abort",
      signal: controller.signal,
    }).result();

    expect(result.stopReason).toBe("aborted");
    expect(attemptEvents(events)).toMatchObject([{ outcome: "aborted", reason: "initial" }]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("counts cached WebSocket reuse as a new attempt without a new connection", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    let connections = 0;
    let submissions = 0;
    class CachedWebSocket extends EventTarget {
      readyState = 1;
      constructor() {
        super();
        connections += 1;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        submissions += 1;
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completedSseEvent(`resp_cached_${submissions}`)),
            }),
          );
        });
      }
      close(): void {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", CachedWebSocket);
    const baseOptions = {
      apiKey: createJwt(),
      sessionId: "cached-transport-accounting",
      transport: "websocket-cached" as const,
    };

    await streamOpenAICodexResponses(chatGptModel, context, {
      ...baseOptions,
      requestId: "call-cached-one",
    }).result();
    await streamOpenAICodexResponses(
      chatGptModel,
      {
        ...context,
        messages: [...context.messages, { role: "user", content: "follow-up", timestamp: 2 }],
      },
      { ...baseOptions, requestId: "call-cached-two" },
    ).result();

    expect(connections).toBe(1);
    expect(submissions).toBe(2);
    expect(connectionEvents(events)).toHaveLength(1);
    expect(attemptEvents(events)).toMatchObject([
      { callId: "call-cached-one", outcome: "completed" },
      { callId: "call-cached-two", outcome: "completed" },
    ]);
  });

  it("records connection-limit recovery as retry plus reconnect, not fallback", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class ConnectionLimitWebSocket extends EventTarget {
      private static connectionCount = 0;
      private readonly connection = ++ConnectionLimitWebSocket.connectionCount;
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        const event =
          this.connection === 1
            ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
            : completedSseEvent("resp_connection_retry");
        queueMicrotask(() =>
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) })),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", ConnectionLimitWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-connection-limit",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed" },
      { ordinal: 2, reason: "retry", outcome: "completed" },
    ]);
    expect(connectionEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "completed" },
      { ordinal: 2, reason: "reconnect", outcome: "completed" },
    ]);
    expect(fallbackEvents(events)).toEqual([]);
  });

  it("records sticky-session policy fallback before the target SSE attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class FailingWebSocket {
      constructor() {
        throw new Error("connect failed");
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );
    const sessionId = "sticky-policy-accounting";

    await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      sessionId,
      requestId: "call-policy-prime",
    }).result();
    await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      sessionId,
      requestId: "call-policy-sticky",
    }).result();

    expect(
      fallbackEvents(events).filter((event) => event.callId === "call-policy-sticky"),
    ).toMatchObject([{ reason: "policy" }]);
    expect(
      attemptEvents(events).filter((event) => event.callId === "call-policy-sticky"),
    ).toMatchObject([{ reason: "transport_fallback", outcome: "completed" }]);
  });

  it("isolates throwing transport observers from provider success", async () => {
    configureTransportObserver([], () => vi.fn(async () => completedSseResponse()));
    configureAiTransportHost({
      ...getAiTransportHost(),
      observeModelTransportEvent: () => {
        throw new Error("observer failure");
      },
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-throwing-observer",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
  });

  it("keeps event identities route-scoped when request IDs repeat", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => completedSseResponse()));

    const openAIStream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "reused-call-id",
      }),
    );
    const azureStream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(azureModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "reused-call-id",
      }),
    );
    await Promise.all([openAIStream.result(), azureStream.result()]);

    const ids = attemptEvents(events).map((event) => event.eventId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("emits no uncorrelated transport events when requestId is absent", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => completedSseResponse()));

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(events).toEqual([]);
  });

  it("counts SDK egress when the embedding host supplies no guarded fetch", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => undefined,
      observeModelTransportEvent: (event) => events.push(event),
    });
    const networkFetch = vi.fn(async () => completedSseResponse());
    vi.stubGlobal("fetch", networkFetch);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-default-host-fetch",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(networkFetch).toHaveBeenCalledOnce();
    expect(attemptEvents(events)).toMatchObject([
      { reason: "initial", outcome: "completed", statusCode: 200 },
    ]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("emits zero submission when SDK retry backoff ends in caller abort", async () => {
    const events: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setTimeout(() => controller.abort(), 0);
        return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after-ms": "20" },
        });
      }),
    );

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        requestId: "call-sdk-retry-abort",
        signal: controller.signal,
      }),
    );

    expect((await stream.result()).stopReason).toBe("aborted");
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed", statusCode: 503 },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "responses-sdk", outcome: "aborted", total: 0 },
    ]);
  });

  it("emits zero submission when native SSE retry backoff is caller-aborted", async () => {
    const events: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("overloaded", { status: 503 })),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 1,
      requestId: "call-native-retry-abort",
      signal: controller.signal,
      onResponse: () => controller.abort(),
    }).result();

    expect(result.stopReason).toBe("aborted");
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed", statusCode: 503 },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "native-codex-sse", outcome: "aborted", total: 0 },
    ]);
  });

  it("emits zero submission when a WebSocket reconnect fails before resend", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class ReconnectFailingWebSocket extends EventTarget {
      private static connectionCount = 0;
      private readonly connection = ++ReconnectFailingWebSocket.connectionCount;
      constructor() {
        super();
        if (this.connection === 2) {
          throw new Error("reconnect failed");
        }
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify({
                type: "error",
                error: { code: "websocket_connection_limit_reached" },
              }),
            }),
          ),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", ReconnectFailingWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-reconnect-failure",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed" },
    ]);
    expect(connectionEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "completed" },
      { ordinal: 2, reason: "reconnect", outcome: "failed" },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "native-codex-websocket", outcome: "failed", total: 0 },
    ]);
  });

  it("does not count a synchronous native SSE fetch throw as a submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch invocation failed");
      }),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-sync-fetch-throw",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "native-codex-sse", outcome: "failed", total: 0 },
    ]);
  });

  it("counts an asynchronously rejected native SSE fetch as a failed submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network request rejected"))),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-async-fetch-reject",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(attemptEvents(events)).toMatchObject([
      { transport: "native-codex-sse", outcome: "failed", reason: "initial" },
    ]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("does not emit zero submission after unsupported fallback target succeeds", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      requestId: "call-unsupported-fallback",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(fallbackEvents(events)).toMatchObject([{ reason: "unsupported" }]);
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        reason: "transport_fallback",
        outcome: "completed",
      },
    ]);
    expect(submissionEvents(events)).toEqual([]);
  });
});
