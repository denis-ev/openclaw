import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";

vi.mock("../../plugins/provider-runtime.runtime.js", () => {
  throw new Error("provider runtime must not load for a usable OAuth access token");
});

describe("OAuth access-token projection", () => {
  it("resolves a usable credential without loading provider formatting", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 10 * 60_000,
        },
      },
    };
    const { resolveOAuthCredentialForProfile } = await import("./oauth.js");

    await expect(
      resolveOAuthCredentialForProfile({
        cfg: {},
        store,
        profileId: "openai:default",
      }),
    ).resolves.toEqual(store.profiles["openai:default"]);
  });

  it("preserves OAuth SecretRef policy validation", async () => {
    const profileId = "openai:secret-ref";
    const store = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openai",
          access: { source: "env", provider: "default", id: "OPENAI_ACCESS_TOKEN" },
          refresh: "oauth-refresh",
          expires: Date.now() + 10 * 60_000,
        },
      },
    } as unknown as AuthProfileStore;
    const { resolveOAuthCredentialForProfile } = await import("./oauth.js");

    await expect(
      resolveOAuthCredentialForProfile({
        cfg: {},
        store,
        profileId,
      }),
    ).rejects.toThrow(/OAuth \+ SecretRef is not supported/);
  });
});
