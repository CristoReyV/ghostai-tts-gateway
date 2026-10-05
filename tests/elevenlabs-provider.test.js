/**
 * @file tests/elevenlabs-provider.test.js
 * Tests the ElevenLabs adapter with a mocked global fetch.
 * No real API calls are made. No credits are consumed.
 */

"use strict";

const { generate, listVoices, listModels, _clearCache } = require("../netlify/functions/providers/elevenlabs");

const FAKE_KEY = "sk-fake-test-key";
const REQUEST_ID = "test-req-001";

beforeEach(() => {
  _clearCache();
  process.env.ELEVENLABS_API_KEY = FAKE_KEY;
});

afterEach(() => {
  delete process.env.ELEVENLABS_API_KEY;
  jest.restoreAllMocks();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockFetch(statusCode, body, isBuffer = false) {
  const response = {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    headers: { get: (h) => (h === "Content-Type" ? "audio/mpeg" : null) },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
    arrayBuffer: async () => {
      const buf = isBuffer ? body : Buffer.from(JSON.stringify(body));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
  global.fetch = jest.fn().mockResolvedValue(response);
}

function mockFetchNetworkError() {
  global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed"));
}

function mockFetchTimeout() {
  global.fetch = jest.fn().mockImplementation((url, opts) => {
    return new Promise((_, reject) => {
      // Immediately abort so the AbortSignal triggers
      if (opts?.signal) {
        opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }
      setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 50);
    });
  });
}

// ─── generate() ─────────────────────────────────────────────────────────────

describe("ElevenLabs provider — generate()", () => {
  const BASE_REQ = {
    requestId: REQUEST_ID,
    voiceId: "voice-123",
    text: "Hola mundo",
    modelId: "eleven_multilingual_v2",
    outputFormat: "mp3_44100_128",
  };

  test("returns audio buffer on 200", async () => {
    const fakeAudio = Buffer.from([0x49, 0x44, 0x33]); // fake MP3 header
    mockFetch(200, fakeAudio, true);

    const result = await generate(BASE_REQ);
    expect(result.ok).toBe(true);
    expect(result.audioBuffer).toBeInstanceOf(Buffer);
    expect(result.contentType).toBe("audio/mpeg");
  });

  test("fetch is called with xi-api-key header", async () => {
    const fakeAudio = Buffer.from([0x49, 0x44, 0x33]);
    mockFetch(200, fakeAudio, true);

    await generate(BASE_REQ);

    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers["xi-api-key"]).toBe(FAKE_KEY);
  });

  test("xi-api-key is never in the returned result object", async () => {
    const fakeAudio = Buffer.from([0x49, 0x44, 0x33]);
    mockFetch(200, fakeAudio, true);

    const result = await generate(BASE_REQ);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(FAKE_KEY);
    expect(serialised).not.toContain("xi-api-key");
  });

  test("returns ELEVENLABS_UNAUTHORIZED on 401", async () => {
    mockFetch(401, { detail: { status: "unauthorized" } });
    const result = await generate(BASE_REQ);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ELEVENLABS_UNAUTHORIZED");
    expect(result.statusCode).toBe(401);
  });

  test("returns ELEVENLABS_PAYMENT_REQUIRED on 402", async () => {
    mockFetch(402, { detail: "payment required" });
    const result = await generate(BASE_REQ);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ELEVENLABS_PAYMENT_REQUIRED");
    expect(result.statusCode).toBe(402);
    expect(result.error.message).toBe("Esta voz o función requiere un plan de ElevenLabs compatible.");
  });

  test("returns ELEVENLABS_FORBIDDEN on 403", async () => {
    mockFetch(403, { detail: "forbidden" });
    const result = await generate(BASE_REQ);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ELEVENLABS_FORBIDDEN");
  });

  test("returns ELEVENLABS_NOT_FOUND on 404", async () => {
    mockFetch(404, { detail: "not found" });
    const result = await generate(BASE_REQ);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ELEVENLABS_NOT_FOUND");
  });

  test("returns ELEVENLABS_UNPROCESSABLE on 422", async () => {
    mockFetch(422, { detail: "unprocessable" });
    const result = await generate(BASE_REQ);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ELEVENLABS_UNPROCESSABLE");
  });

  test("returns ELEVENLABS_RATE_LIMIT on 429", async () => {
    mockFetch(429, { detail: "rate limit" });
    const result = await generate(BASE_REQ);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ELEVENLABS_RATE_LIMIT");
    expect(result.statusCode).toBe(429);
  });

  test("returns ELEVENLABS_SERVER_ERROR on 500", async () => {
    mockFetch(500, { detail: "server error" });
    const result = await generate(BASE_REQ);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ELEVENLABS_SERVER_ERROR");
    expect(result.statusCode).toBe(502);
  });

  test("returns ELEVENLABS_TIMEOUT on AbortError", async () => {
    mockFetchTimeout();
    const result = await generate({ ...BASE_REQ });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ELEVENLABS_TIMEOUT");
  });

  test("returns ELEVENLABS_NETWORK_ERROR on network failure", async () => {
    mockFetchNetworkError();
    const result = await generate(BASE_REQ);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ELEVENLABS_NETWORK_ERROR");
  });

  test("returns GATEWAY_NOT_CONFIGURED when API key is absent", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const result = await generate(BASE_REQ);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("GATEWAY_NOT_CONFIGURED");
    expect(result.statusCode).toBe(503);
  });
});

// ─── listVoices() ────────────────────────────────────────────────────────────

describe("ElevenLabs provider — listVoices()", () => {
  test("returns normalised voice list on 200", async () => {
    mockFetch(200, {
      voices: [
        { voice_id: "v1", name: "Rachel", category: "premade", labels: { accent: "american" }, preview_url: null },
        { voice_id: "v2", name: "Domi", category: "premade", labels: {}, preview_url: "https://example.com/preview.mp3" },
      ],
      has_more: false,
      last_voice_id: null,
    });

    const result = await listVoices(REQUEST_ID);
    expect(result.ok).toBe(true);
    expect(result.voices).toHaveLength(2);
    expect(result.voices[0]).toMatchObject({ voiceId: "v1", name: "Rachel", category: "premade" });
    expect(result.hasMore).toBe(false);
  });

  test("returns cached result on second call", async () => {
    mockFetch(200, { voices: [], has_more: false, last_voice_id: null });
    await listVoices(REQUEST_ID);
    await listVoices(REQUEST_ID);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("returns GATEWAY_NOT_CONFIGURED when key is missing", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const result = await listVoices(REQUEST_ID);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("GATEWAY_NOT_CONFIGURED");
  });

  test("returns ELEVENLABS_UNAUTHORIZED on 401", async () => {
    mockFetch(401, { detail: "unauthorized" });
    const result = await listVoices(REQUEST_ID);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ELEVENLABS_UNAUTHORIZED");
  });
});

// ─── listModels() ────────────────────────────────────────────────────────────

describe("ElevenLabs provider — listModels()", () => {
  test("returns only TTS-compatible models on 200", async () => {
    mockFetch(200, [
      { model_id: "m1", name: "Multilingual v2", description: "Best", languages: [{ language_id: "es", name: "Spanish" }], can_do_text_to_speech: true, model_rates: {} },
      { model_id: "m2", name: "STT Only", description: "STT", languages: [], can_do_text_to_speech: false, model_rates: {} },
    ]);

    const result = await listModels(REQUEST_ID);
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(1);
    expect(result.models[0].modelId).toBe("m1");
  });

  test("returns cached result on second call", async () => {
    mockFetch(200, []);
    await listModels(REQUEST_ID);
    await listModels(REQUEST_ID);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("returns GATEWAY_NOT_CONFIGURED when key is missing", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const result = await listModels(REQUEST_ID);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("GATEWAY_NOT_CONFIGURED");
  });
});
