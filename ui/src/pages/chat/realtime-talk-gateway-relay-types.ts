import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import type { RealtimeTalkEvent } from "./realtime-talk-shared.ts";

export const MAX_PENDING_ACTIVATION_EVENT_BYTES = 256 * 1024;

export function parseGatewayRelayOutputGeneration(value: unknown): number | null | undefined {
  return value === undefined ? undefined : (asPositiveSafeInteger(value) ?? null);
}

export type GatewayRelayEvent = {
  relaySessionId?: string;
  talkEvent?: RealtimeTalkEvent;
} & (
  | { type?: "ready" }
  | { type?: "audioStarted"; outputGeneration?: number }
  | { type?: "audio"; audioBase64?: string; outputGeneration?: number }
  | { type?: "clear"; outputGeneration?: number; reason?: "barge-in" }
  | { type?: "mark"; markName?: string }
  | {
      type?: "transcript";
      role?: "user" | "assistant";
      text?: string;
      final?: boolean;
    }
  | {
      type?: "toolCall";
      callId?: string;
      name?: string;
      args?: unknown;
      forced?: boolean;
    }
  | { type?: "toolCallCancelled"; callId?: string }
  | { type?: "toolResult"; callId?: string }
  | { type?: "error"; message?: string }
  | { type?: "close"; reason?: string }
);

export function estimateGatewayRelayEventBytes(event: GatewayRelayEvent): number {
  try {
    const serialized = JSON.stringify(event);
    // Browser strings may use two bytes per code unit; use the upper bound without
    // allocating a second encoded copy on this realtime event path.
    return (serialized?.length ?? 0) * 2;
  } catch {
    return MAX_PENDING_ACTIVATION_EVENT_BYTES + 1;
  }
}

export type DelayedToolResult = {
  callId: string;
  result: unknown;
  options?: { suppressResponse?: boolean; willContinue?: boolean };
  timer?: number;
};
