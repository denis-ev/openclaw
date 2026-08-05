// OpenAI doctor contract migrates shipped GPT-Live Talk model configuration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor";
import { OPENAI_GPT_LIVE_MODEL } from "./realtime-quicksilver.js";

const RETIRED_GPT_LIVE_MODEL = "gpt-live-1-codex";
const MODEL_PATHS = [
  ["talk", "realtime", "model"],
  ["talk", "realtime", "providers", "openai", "model"],
] as const;

function readPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    current = asObjectRecord(current)?.[segment];
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function isRetiredGptLiveModel(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === RETIRED_GPT_LIVE_MODEL;
}

export const legacyConfigRules = MODEL_PATHS.map((path) => ({
  path: [...path],
  message: `${path.join(".")} uses retired model ${RETIRED_GPT_LIVE_MODEL}; run "openclaw doctor --fix" to use ${OPENAI_GPT_LIVE_MODEL}.`,
  match: isRetiredGptLiveModel,
}));

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  let next = cfg;
  const changes: string[] = [];

  for (const path of MODEL_PATHS) {
    const current = readPath(next, path);
    if (!isRetiredGptLiveModel(current)) {
      continue;
    }
    if (next === cfg) {
      next = structuredClone(cfg);
    }
    const parent = asObjectRecord(readPath(next, path.slice(0, -1)));
    if (!parent) {
      continue;
    }
    parent.model = OPENAI_GPT_LIVE_MODEL;
    changes.push(
      `Updated ${path.join(".")} from ${RETIRED_GPT_LIVE_MODEL} to ${OPENAI_GPT_LIVE_MODEL}.`,
    );
  }

  return { config: next, changes };
}
