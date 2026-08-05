// OpenAI tests cover the shipped GPT-Live model compatibility migration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

describe("OpenAI doctor contract", () => {
  it("detects and migrates retired GPT-Live Talk model values", () => {
    const cfg = {
      talk: {
        realtime: {
          provider: "openai",
          model: " GPT-Live-1-Codex ",
          providers: {
            openai: {
              model: "gpt-live-1-codex",
              speakerVoice: "marin",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(legacyConfigRules.every((rule) => rule.message.includes("openclaw doctor --fix"))).toBe(
      true,
    );
    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toHaveLength(2);
    expect(result.config.talk?.realtime).toEqual({
      provider: "openai",
      model: "gpt-live-1-boulder-alpha",
      providers: {
        openai: {
          model: "gpt-live-1-boulder-alpha",
          speakerVoice: "marin",
        },
      },
    });
    expect(cfg.talk?.realtime?.model).toBe(" GPT-Live-1-Codex ");
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("leaves supported and unrelated realtime models unchanged", () => {
    const cfg = {
      talk: {
        realtime: {
          provider: "openai",
          model: "gpt-live-1-boulder-alpha",
          providers: { openai: { model: "gpt-realtime-2.1" } },
        },
      },
    } as OpenClawConfig;

    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  });
});
