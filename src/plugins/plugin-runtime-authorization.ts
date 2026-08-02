// Host-owned authorization facts for plugin runtime capabilities.
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginRecord } from "./registry-types.js";
import type { PluginRuntime } from "./runtime/types.js";

type PluginRuntimeAuthorization = Readonly<{
  pluginId: string;
  origin: PluginOrigin;
}>;

const authorizationByRuntime = new WeakMap<PluginRuntime, PluginRuntimeAuthorization>();

/** Records loader-owned provenance on the exact runtime object issued to a plugin. */
export function registerPluginRuntimeAuthorization(
  runtime: PluginRuntime,
  record: Pick<PluginRecord, "id" | "origin">,
): void {
  authorizationByRuntime.set(
    runtime,
    Object.freeze({
      pluginId: record.id,
      origin: record.origin,
    }),
  );
}

/** Rejects fabricated runtimes and runtimes issued to non-bundled plugin sources. */
export function assertBundledPluginRuntime(runtime: PluginRuntime): void {
  const authorization = authorizationByRuntime.get(runtime);
  if (authorization?.origin === "bundled") {
    return;
  }
  if (!authorization) {
    throw new Error("Bundled plugin runtime required; the runtime was not issued by OpenClaw");
  }
  throw new Error(
    `Bundled plugin runtime required; plugin "${authorization.pluginId}" loaded with origin "${authorization.origin}"`,
  );
}
