// MiniMax config migrations belong to the plugin so doctor repairs stale M3
// media metadata before image-tool routing reads the configured model entry.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-onboard";

const MINIMAX_PROVIDER_IDS = new Set(["minimax", "minimax-portal"]);

/** Repairs the previous M3 vision declaration without changing user overrides. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const providers = cfg.models?.providers;
  if (!providers) {
    return { config: cfg, changes: [] };
  }

  let changed = false;
  const nextProviders = Object.fromEntries(
    Object.entries(providers).map(([providerId, provider]) => {
      if (!MINIMAX_PROVIDER_IDS.has(providerId) || !provider.models) {
        return [providerId, provider];
      }
      const models = provider.models.map((model) => {
        if (model.id !== "MiniMax-M3" || !model.input.includes("image")) {
          return model;
        }
        changed = true;
        return { ...model, input: ["text"] as ModelDefinitionConfig["input"] };
      });
      return [providerId, changed ? { ...provider, models } : provider];
    }),
  );

  if (!changed) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      models: { ...cfg.models, providers: nextProviders },
    },
    changes: ["Updated MiniMax-M3 model metadata to text-only so image tools use MiniMax-VL-01."],
  };
}
