// MiniMax doctor contract tests cover persisted model metadata repair.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { buildMinimaxApiModelDefinition } from "./model-definitions.js";

describe("minimax doctor contract", () => {
  it("repairs stale M3 image metadata for API and OAuth providers", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            models: [
              { ...buildMinimaxApiModelDefinition("MiniMax-M3"), input: ["text", "image"] },
              { ...buildMinimaxApiModelDefinition("custom"), input: ["text", "image"] },
            ],
          },
          "minimax-portal": {
            baseUrl: "https://api.minimax.io/anthropic",
            models: [{ ...buildMinimaxApiModelDefinition("MiniMax-M3"), input: ["text", "image"] }],
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toEqual([
      "Updated MiniMax-M3 model metadata to text-only so image tools use MiniMax-VL-01.",
    ]);
    expect(
      result.config.models?.providers?.minimax?.models.map(({ id, input }) => ({ id, input })),
    ).toEqual([
      { id: "MiniMax-M3", input: ["text"] },
      { id: "custom", input: ["text", "image"] },
    ]);
    expect(
      result.config.models?.providers?.["minimax-portal"]?.models.map(({ id, input }) => ({
        id,
        input,
      })),
    ).toEqual([{ id: "MiniMax-M3", input: ["text"] }]);
  });
});
