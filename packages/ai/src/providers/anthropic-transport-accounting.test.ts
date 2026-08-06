import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiModelTransportEvent,
} from "../host.js";
import type { Model } from "../types.js";
import { createAnthropicTransportAccounting } from "./anthropic-transport-accounting.js";

const coreTransportHost = getAiTransportHost();

const model: Model<"anthropic-messages"> = {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

function captureEvents(): AiModelTransportEvent[] {
  const events: AiModelTransportEvent[] = [];
  configureAiTransportHost({
    ...coreTransportHost,
    observeModelTransportEvent: (event) => events.push(event),
  });
  return events;
}

function terminalUsage(modelId?: string, declinedModels: string[] = []): Record<string, unknown> {
  return {
    iterations: modelId
      ? [
          ...declinedModels.map((declinedModel) => ({
            type: "message",
            model: declinedModel,
          })),
          { type: "fallback_message", model: modelId },
        ]
      : [{ type: "message", model: model.id }],
  };
}

afterEach(() => {
  configureAiTransportHost(coreTransportHost);
});

describe("Anthropic transport accounting", () => {
  it("records zero submission only when guarded preflight prevents egress", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-preflight" },
      serverFallbackEnabled: false,
    });
    const error = new Error("blocked before fetch");
    await expect(
      accounting.wrapFetch(async () => {
        throw error;
      })("https://example.test"),
    ).rejects.toBe(error);
    accounting.fail(error);

    expect(events).toEqual([
      expect.objectContaining({
        type: "submission",
        callId: "call-preflight",
        total: 0,
        outcome: "failed",
      }),
    ]);
  });

  it("isolates observer failures from successful completion", async () => {
    configureAiTransportHost({
      ...coreTransportHost,
      observeModelTransportEvent: () => {
        throw new Error("observer failed");
      },
    });
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-observer" },
      serverFallbackEnabled: false,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchEgress();
      return new Response("", { status: 200 });
    })("https://example.test");

    expect(() => accounting.completeSuccess()).not.toThrow();
  });

  it("counts SDK retries as distinct submitted attempts", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-retry" },
      serverFallbackEnabled: false,
    });
    const networkFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const fetch = accounting.wrapFetch(async (input, init) => {
      const response = networkFetch(input, init);
      accounting.onFetchEgress();
      return await response;
    });

    await fetch("https://example.test");
    await fetch("https://example.test");
    accounting.completeSuccess();

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
        statusCode: 500,
      }),
      expect.objectContaining({
        type: "attempt",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
        statusCode: 200,
      }),
    ]);
  });

  it("classifies SDK-internal timeout aborts as failed attempts", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-timeout" },
      serverFallbackEnabled: false,
    });
    const timeoutError = Object.assign(new Error("timed out"), { name: "AbortError" });

    await expect(
      accounting.wrapFetch(async () => {
        accounting.onFetchEgress();
        throw timeoutError;
      })("https://example.test"),
    ).rejects.toBe(timeoutError);
    accounting.fail(timeoutError);

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        callId: "call-timeout",
        outcome: "failed",
      }),
    ]);
  });

  it("classifies only an authoritative caller signal as aborted", async () => {
    const events = captureEvents();
    const controller = new AbortController();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-caller-abort", signal: controller.signal },
      serverFallbackEnabled: false,
    });
    const abortError = Object.assign(new Error("cancelled"), { name: "AbortError" });

    await expect(
      accounting.wrapFetch(async () => {
        accounting.onFetchEgress();
        controller.abort(abortError);
        throw abortError;
      })("https://example.test"),
    ).rejects.toBe(abortError);
    accounting.fail(abortError);

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        callId: "call-caller-abort",
        outcome: "aborted",
      }),
    ]);
  });

  it("does not infer a terminal outcome from consumer close", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-consumer-close" },
      serverFallbackEnabled: false,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchEgress();
      return new Response("", { status: 200 });
    })("https://example.test");

    expect(events).toEqual([]);
  });

  it("reconciles a no-boundary provider fallback from terminal usage", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-no-boundary" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchEgress();
      return new Response("", { status: 200 });
    })("https://example.test");
    accounting.observeTerminalUsage(terminalUsage("claude-opus-5"));
    const resolution = accounting.completeSuccess();

    expect(resolution).toMatchObject({
      traceValid: true,
      servingModel: "claude-opus-5",
      transitions: [{ fromModel: "claude-fable-5", toModel: "claude-opus-5" }],
    });
    expect(events.map((event) => event.type)).toEqual(["provider_fallback", "attempt"]);
  });

  it("reconciles and deduplicates a contiguous two-hop fallback chain", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-two-hop" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchEgress();
      return new Response("", { status: 200 });
    })("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-sonnet-5",
    });
    accounting.observeFallbackBoundary({
      fromModel: "claude-sonnet-5",
      toModel: "claude-opus-5",
    });
    accounting.observeTerminalUsage(
      terminalUsage("claude-opus-5", ["claude-fable-5", "claude-sonnet-5"]),
    );
    accounting.completeSuccess();

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider_fallback",
        fromModel: "claude-fable-5",
        toModel: "claude-sonnet-5",
      }),
      expect.objectContaining({
        type: "provider_fallback",
        fromModel: "claude-sonnet-5",
        toModel: "claude-opus-5",
      }),
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
    ]);
  });

  it("collapses repeated sampling iterations from the same fallback hop", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-tool-loop" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchEgress();
      return new Response("", { status: 200 });
    })("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });
    accounting.observeTerminalUsage(
      terminalUsage("claude-opus-5", ["claude-fable-5", "claude-fable-5"]),
    );
    const resolution = accounting.completeSuccess();

    expect(resolution.traceValid).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        type: "provider_fallback",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      }),
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
    ]);
  });

  it.each([
    { label: "missing usage", usage: undefined },
    { label: "null iterations", usage: { iterations: null } },
    { label: "malformed iterations", usage: { iterations: [{}] } },
    {
      label: "unknown iteration type",
      usage: { iterations: [{ type: "future_iteration", model: "claude-fable-5" }] },
    },
    {
      label: "contradictory boundary",
      usage: terminalUsage("claude-opus-5", ["claude-fable-5"]),
      boundaries: [{ fromModel: "claude-fable-5", toModel: "claude-sonnet-5" }],
    },
    {
      label: "contradictory intermediate hop",
      usage: terminalUsage("claude-opus-5", ["claude-fable-5", "claude-haiku-5"]),
      boundaries: [
        { fromModel: "claude-fable-5", toModel: "claude-sonnet-5" },
        { fromModel: "claude-sonnet-5", toModel: "claude-opus-5" },
      ],
    },
  ])("degrades $label to no transport facts", async ({ usage, boundaries }) => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-invalid-fallback" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchEgress();
      return new Response("", { status: 200 });
    })("https://example.test");
    for (const boundary of boundaries ?? []) {
      accounting.observeFallbackBoundary(boundary);
    }
    accounting.observeTerminalUsage(usage);
    const resolution = accounting.completeSuccess();

    expect(resolution.traceValid).toBe(false);
    expect(events).toEqual([]);
  });

  it("records an authoritative abort before egress as zero submission", () => {
    const events = captureEvents();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-abort", signal: controller.signal },
      serverFallbackEnabled: false,
    });

    accounting.fail(controller.signal.reason);

    expect(events).toEqual([
      expect.objectContaining({
        type: "submission",
        outcome: "aborted",
      }),
    ]);
  });
});
