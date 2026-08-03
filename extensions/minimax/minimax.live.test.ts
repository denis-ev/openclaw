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
const MINIMAX_M3_IMAGE_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBBsGAQr00ED3AAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA0LTI3VDA2OjAxOjEwKzAwOjAwPU3tXwAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wNC0yN1QwNjowMToxMCswMDowMEwQVeMAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDQtMjdUMDY6MDE6MTArMDA6MDAbBXQ8AAAAeElEQVRo3u3awQnDQBAEwT2Q8w/YAikIP5rF1RFMca+FO8/s7rrnqjcA1BsA6g0A9QaAesOfA77zqTf8Blj/AgAAAAAAAJsDqAOoA6gDqAOoc9TXAdQB1AHUAdQB1AHUAdQB1AHU7Qc46gEAAAAANrcecGZ2f8B/ASYSQPlKoEJ/AAAAAElFTkSuQmCC";
const describeLive =
  isLiveTestEnabled() && MINIMAX_SEARCH_KEY.length > 0 ? describe : describe.skip;
const describeTtsLive =
  isLiveTestEnabled() && MINIMAX_API_KEY.length > 0 ? describe : describe.skip;
const describeM3VisionLive =
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

describeM3VisionLive("minimax M3 image input live", () => {
  it("accepts an Anthropic-compatible base64 image message", async () => {
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
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: MINIMAX_M3_IMAGE_B64,
                },
              },
              { type: "text", text: "Reply with the dominant image color." },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    expect(response.ok).toBe(true);
    const body = (await response.json()) as { content?: Array<{ text?: string; type?: string }> };
    expect(body.content?.some((block) => block.type === "text" && block.text?.trim())).toBe(true);
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
