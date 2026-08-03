import { resolveFfmpegBin } from "openclaw/plugin-sdk/media-runtime";
// Minimax tests cover minimax plugin behavior.
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { buildMinimaxSpeechProvider } from "./speech-provider.js";
import { createMiniMaxWebSearchProvider } from "./src/minimax-web-search-provider.js";

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY?.trim() ?? "";
const MINIMAX_SEARCH_KEY =
  process.env.MINIMAX_CODE_PLAN_KEY?.trim() ||
  process.env.MINIMAX_CODING_API_KEY?.trim() ||
  process.env.MINIMAX_OAUTH_TOKEN?.trim() ||
  MINIMAX_API_KEY ||
  "";
const MINIMAX_TTS_TOKEN_PLAN_KEY =
  process.env.MINIMAX_OAUTH_TOKEN?.trim() ||
  process.env.MINIMAX_CODE_PLAN_KEY?.trim() ||
  process.env.MINIMAX_CODING_API_KEY?.trim() ||
  "";
const MINIMAX_ANTHROPIC_MESSAGES_URL = "https://api.minimax.io/anthropic/v1/messages";
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J7z8AAAAASUVORK5CYII=";
const describeLive =
  isLiveTestEnabled() && MINIMAX_SEARCH_KEY.length > 0 ? describe : describe.skip;
const describeM3Live = isLiveTestEnabled() && MINIMAX_API_KEY.length > 0 ? describe : describe.skip;
const describeTtsLive =
  isLiveTestEnabled() && MINIMAX_API_KEY.length > 0 ? describe : describe.skip;
const describeTokenPlanTtsLive =
  isLiveTestEnabled() && MINIMAX_TTS_TOKEN_PLAN_KEY.length > 0 ? describe : describe.skip;

const registerMinimaxPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "minimax",
    name: "MiniMax Provider",
  });

function hasTrustedFfmpegForLiveVoiceNote(): boolean {
  try {
    resolveFfmpegBin();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ffmpeg not found in trusted system directories")) {
      console.warn("[minimax:live] skip voice-note transcode: ffmpeg unavailable");
      return false;
    }
    throw error;
  }
}

describeLive("minimax plugin live", () => {
  it("runs MiniMax web search through the provider tool", async () => {
    const provider = createMiniMaxWebSearchProvider();
    const tool = provider.createTool?.({
      config: {},
      searchConfig: { apiKey: MINIMAX_SEARCH_KEY, cacheTtlMinutes: 0 },
    } as never);

    const result = await tool?.execute({ query: "OpenClaw GitHub", count: 1 });

    expect(result?.provider).toBe("minimax");
    expect(result?.count).toBeGreaterThan(0);
    expect(Array.isArray(result?.results)).toBe(true);
  }, 120_000);
});

describeM3Live("minimax M3 live", () => {
  it("returns text through the Anthropic-compatible route", async () => {
    const response = await fetch(MINIMAX_ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": MINIMAX_API_KEY,
      },
      body: JSON.stringify({
        model: "MiniMax-M3",
        max_tokens: 16,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    expect(response.ok).toBe(true);
    const body = (await response.json()) as { content?: Array<{ text?: string; type?: string }> };
    const text = body.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text?.trim() ?? "")
      .join(" ");
    expect(text).toMatch(/\bok\b/i);
  }, 120_000);

  it("rejects image input through the Anthropic-compatible route", async () => {
    const response = await fetch(MINIMAX_ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": MINIMAX_API_KEY,
      },
      body: JSON.stringify({
        model: "MiniMax-M3",
        max_tokens: 16,
        thinking: { type: "adaptive" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: ONE_PIXEL_PNG_BASE64,
                },
              },
              { type: "text", text: "Reply with exactly: ok" },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    expect(response.ok).toBe(false);
  }, 120_000);
});

describeTtsLive("minimax tts live", () => {
  it("synthesizes TTS through the registered speech provider", async () => {
    const { speechProviders } = await registerMinimaxPlugin();
    const provider = requireRegisteredProvider(speechProviders, "minimax");

    const audioFile = await provider.synthesize({
      text: "OpenClaw MiniMax text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: MINIMAX_API_KEY },
      target: "audio-file",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 120_000);

  it("synthesizes MiniMax TTS as an Opus voice note", async () => {
    if (!hasTrustedFfmpegForLiveVoiceNote()) {
      return;
    }

    const provider = buildMinimaxSpeechProvider();

    const voiceNote = await provider.synthesize({
      text: "OpenClaw MiniMax voice note test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: MINIMAX_API_KEY },
      target: "voice-note",
      timeoutMs: 90_000,
    });

    expect(voiceNote.outputFormat).toBe("opus");
    expect(voiceNote.fileExtension).toBe(".opus");
    expect(voiceNote.voiceCompatible).toBe(true);
    expect(voiceNote.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 120_000);
});

describeTokenPlanTtsLive("minimax token plan tts live", () => {
  it("synthesizes TTS with Token Plan auth without MINIMAX_API_KEY", async () => {
    const savedApiKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    try {
      const provider = buildMinimaxSpeechProvider();

      const audioFile = await provider.synthesize({
        text: "OpenClaw MiniMax Token Plan text to speech integration test OK.",
        cfg: { plugins: { enabled: true } } as never,
        providerConfig: {},
        target: "audio-file",
        timeoutMs: 90_000,
      });

      expect(audioFile.outputFormat).toBe("mp3");
      expect(audioFile.fileExtension).toBe(".mp3");
      expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
    } finally {
      if (savedApiKey === undefined) {
        delete process.env.MINIMAX_API_KEY;
      } else {
        process.env.MINIMAX_API_KEY = savedApiKey;
      }
    }
  }, 120_000);
});
