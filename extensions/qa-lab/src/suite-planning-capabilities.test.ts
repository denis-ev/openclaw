// Qa Lab tests cover implementation-capability-aware suite selection.
import { describe, expect, it } from "vitest";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

describe("qa suite planning implementation capabilities", () => {
  it("applies implementation requirements to implicit and explicit selection", () => {
    const scenarios = [
      makeQaSuiteTestScenario("portable", { channel: "matrix" }),
      makeQaSuiteTestScenario("prepared-context", {
        channel: "matrix",
        requiredImplementationCapabilities: ["adapter-prepared-flow-context"],
      }),
    ];
    const lane = {
      scenarios,
      providerMode: "mock-openai" as const,
      primaryModel: "mock-openai/gpt-5.6-luna",
      channelDriver: "live" as const,
      channel: "matrix",
    };

    expect(selectQaFlowSuiteScenarios(lane).map((scenario) => scenario.id)).toEqual(["portable"]);
    expect(
      selectQaFlowSuiteScenarios({
        ...lane,
        resolveImplementationCapabilities: () => ["adapter-prepared-flow-context"],
      }).map((scenario) => scenario.id),
    ).toEqual(["portable", "prepared-context"]);
    expect(() =>
      selectQaFlowSuiteScenarios({ ...lane, scenarioIds: ["prepared-context"] }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: prepared-context (implementationCapability=adapter-prepared-flow-context unsupported by implementation=live:matrix)",
    );
  });
});
