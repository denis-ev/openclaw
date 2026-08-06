import type { AiModelTransportEvent, AiModelTransportOutcome } from "@openclaw/ai";
import type {
  ProviderTransportAccountingCoverage,
  ProviderTransportAccountingCoverageReason,
  ProviderTransportAccountingSnapshot,
  ProviderTransportAccountingTotalKind,
  ProviderTransportLogicalCall,
} from "./provider-transport-accounting.types.js";

export type ProviderTransportAggregateLowerBoundKey =
  | "attempts"
  | "connections"
  | "fallbacks"
  | "providerFallbacks"
  | "zeroSubmissions";

export function providerTransportAggregateKeyForEventType(
  type: AiModelTransportEvent["type"],
): ProviderTransportAggregateLowerBoundKey {
  switch (type) {
    case "attempt":
      return "attempts";
    case "connection":
      return "connections";
    case "fallback":
      return "fallbacks";
    case "provider_fallback":
      return "providerFallbacks";
    case "submission":
      return "zeroSubmissions";
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

export type ProviderTransportProjectionCall = {
  callId: string;
  provider: string;
  model: string;
  api: string;
  currentTransport?: string;
  currentServingModel?: string;
  nextConnectionOrdinal: number;
  fallbackCause?: {
    transport: string;
    reason: "connection_failure" | "stream_failure";
  };
  lastAttempt?: {
    ordinal: number;
    transport: string;
    servingModel: string;
    outcome: AiModelTransportOutcome;
  };
  phase?: {
    transport: string;
    servingModel: string;
    submissionEvidence: boolean;
    expectedAttemptReason: "initial" | "same_route" | "transport_fallback";
  };
  pendingTransportTarget?: string;
  zeroSubmissionOutcome?: "failed" | "aborted";
  pendingSettlementOutcome?: AiModelTransportOutcome;
  settledOutcome?: AiModelTransportOutcome;
  acceptedCallEventCount: number;
};

export type ProviderTransportProjectionState = {
  logicalCalls: Map<string, ProviderTransportProjectionCall>;
  eventFingerprints: Map<string, { fingerprint: string; type: AiModelTransportEvent["type"] }>;
  aggregate: {
    attempts: Omit<ProviderTransportAccountingSnapshot["attempts"], "totalKind">;
    connections: Omit<ProviderTransportAccountingSnapshot["connections"], "totalKind">;
    fallbacks: Omit<ProviderTransportAccountingSnapshot["fallbacks"], "totalKind">;
    providerFallbacks: Omit<ProviderTransportAccountingSnapshot["providerFallbacks"], "totalKind">;
    zeroSubmissions: Omit<ProviderTransportAccountingSnapshot["zeroSubmissions"], "totalKind">;
  };
  events: AiModelTransportEvent[];
  acceptedEvents: number;
  nextPrewarmConnectionOrdinal: number;
  callTotalsLowerBound: boolean;
  outcomeTotalsLowerBound: boolean;
  aggregateLowerBounds: {
    attempts: boolean;
    connections: boolean;
    fallbacks: boolean;
    providerFallbacks: boolean;
    zeroSubmissions: boolean;
    events: boolean;
  };
  activeEventType?: AiModelTransportEvent["type"];
  callDetailsTruncated: boolean;
  eventDetailsTruncated: boolean;
  issues: Set<ProviderTransportAccountingCoverageReason>;
};

export function lowerMissingTransportFallbackCause(
  event: Extract<AiModelTransportEvent, { type: "fallback" }>,
  state: ProviderTransportProjectionState,
): void {
  const aggregate =
    event.reason === "connection_failure"
      ? "connections"
      : event.reason === "stream_failure"
        ? "attempts"
        : undefined;
  if (aggregate) {
    state.aggregateLowerBounds[aggregate] = true;
    state.issues.add("transport_totals_lower_bound");
  }
}

export function countProviderTransportFallback(
  event: Extract<AiModelTransportEvent, { type: "fallback" }>,
  state: ProviderTransportProjectionState,
): void {
  state.aggregate.fallbacks.total += 1;
  const key =
    event.reason === "connection_failure"
      ? "connectionFailures"
      : event.reason === "submission_failure"
        ? "submissionFailures"
        : event.reason === "stream_failure"
          ? "streamFailures"
          : event.reason;
  state.aggregate.fallbacks[key] += 1;
}

export function retainProviderTransportEventDetail(
  event: AiModelTransportEvent,
  state: ProviderTransportProjectionState,
  maxEvents: number,
): void {
  if (state.events.length >= maxEvents) {
    state.eventDetailsTruncated = true;
    state.issues.add("transport_details_truncated");
    return;
  }
  state.events.push(event);
}

function unavailableCoverage(
  reasons: Iterable<ProviderTransportAccountingCoverageReason>,
): ProviderTransportAccountingCoverage {
  return { state: "unavailable", reasons: [...new Set(reasons)] };
}

function totalsKind(lowerBound: boolean): ProviderTransportAccountingTotalKind {
  return lowerBound ? "lower_bound" : "exact";
}

function projectLogicalCall(call: ProviderTransportProjectionCall): ProviderTransportLogicalCall {
  return {
    callId: call.callId,
    provider: call.provider,
    model: call.model,
    api: call.api,
    ...(call.currentTransport ? { transport: call.currentTransport } : {}),
    ...(call.phase?.servingModel || call.currentServingModel
      ? { servingModel: call.phase?.servingModel ?? call.currentServingModel }
      : {}),
    ...(call.settledOutcome ? { outcome: call.settledOutcome } : {}),
  };
}

function callHasMissingAttemptEventEvidence(call: ProviderTransportProjectionCall): boolean {
  if (call.zeroSubmissionOutcome) {
    return false;
  }
  const hasServerSubmissionWithoutTerminalAttempt = call.phase?.submissionEvidence === true;
  const hasUnresolvedSettlementAfterSubmission =
    call.pendingSettlementOutcome !== undefined &&
    (call.lastAttempt !== undefined || hasServerSubmissionWithoutTerminalAttempt);
  return hasServerSubmissionWithoutTerminalAttempt || hasUnresolvedSettlementAfterSubmission;
}

export function projectProviderTransportAccounting(state: ProviderTransportProjectionState) {
  const issues = new Set(state.issues);
  const calls = [...state.logicalCalls.values()];
  const hasCallWithoutAcceptedTransportEvent = calls.some(
    (call) => call.acceptedCallEventCount === 0,
  );
  const missingAttemptEventEvidence = calls.some(callHasMissingAttemptEventEvidence);
  for (const call of calls) {
    if (!call.settledOutcome) {
      issues.add("transport_logical_call_incomplete");
    }
    if (call.acceptedCallEventCount === 0) {
      issues.add("not_instrumented");
    }
    if (call.phase?.submissionEvidence) {
      issues.add("not_instrumented");
    }
  }
  const hasSnapshot =
    calls.length > 0 ||
    state.eventFingerprints.size > 0 ||
    state.callTotalsLowerBound ||
    state.outcomeTotalsLowerBound ||
    Object.values(state.aggregateLowerBounds).some(Boolean);
  if (!hasSnapshot) {
    return {
      coverage: unavailableCoverage(issues.size > 0 ? issues : ["not_observed"]),
    };
  }
  const attemptsLowerBound =
    state.aggregateLowerBounds.attempts ||
    hasCallWithoutAcceptedTransportEvent ||
    missingAttemptEventEvidence ||
    calls.some(
      (call) => !call.zeroSubmissionOutcome && (!call.lastAttempt || call.pendingTransportTarget),
    );
  const outcomeLowerBound =
    state.callTotalsLowerBound ||
    state.outcomeTotalsLowerBound ||
    calls.some((call) => !call.settledOutcome);
  const snapshot: ProviderTransportAccountingSnapshot = {
    logicalCalls: {
      total: calls.length,
      totalKind: totalsKind(state.callTotalsLowerBound),
      outcomeKind: totalsKind(outcomeLowerBound),
      completed: calls.filter((call) => call.settledOutcome === "completed").length,
      failed: calls.filter((call) => call.settledOutcome === "failed").length,
      aborted: calls.filter((call) => call.settledOutcome === "aborted").length,
      entries: calls.map(projectLogicalCall),
      entriesTruncated: state.callDetailsTruncated,
    },
    attempts: { ...state.aggregate.attempts, totalKind: totalsKind(attemptsLowerBound) },
    connections: {
      ...state.aggregate.connections,
      totalKind: totalsKind(
        state.aggregateLowerBounds.connections || hasCallWithoutAcceptedTransportEvent,
      ),
    },
    fallbacks: {
      ...state.aggregate.fallbacks,
      totalKind: totalsKind(
        state.aggregateLowerBounds.fallbacks || hasCallWithoutAcceptedTransportEvent,
      ),
    },
    providerFallbacks: {
      ...state.aggregate.providerFallbacks,
      totalKind: totalsKind(
        state.aggregateLowerBounds.providerFallbacks || hasCallWithoutAcceptedTransportEvent,
      ),
    },
    zeroSubmissions: {
      ...state.aggregate.zeroSubmissions,
      totalKind: totalsKind(
        state.aggregateLowerBounds.zeroSubmissions || hasCallWithoutAcceptedTransportEvent,
      ),
    },
    events: {
      total: state.acceptedEvents,
      totalKind: totalsKind(
        state.aggregateLowerBounds.events ||
          hasCallWithoutAcceptedTransportEvent ||
          missingAttemptEventEvidence,
      ),
      entries: state.events.map((event) => ({ ...event })),
      entriesTruncated: state.eventDetailsTruncated,
    },
  };
  if (state.eventFingerprints.size === 0) {
    return {
      snapshot,
      coverage: unavailableCoverage(issues.size > 0 ? issues : ["not_instrumented"]),
    };
  }
  const reasons = [...issues];
  return {
    snapshot,
    coverage:
      reasons.length === 0
        ? ({ state: "complete" } as const)
        : ({ state: "partial", reasons } as const),
  };
}
