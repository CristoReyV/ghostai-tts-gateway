/**
 * @file tests/tts-voices-models.test.js
 * Tests for tts-voices and tts-models handlers.
 */

"use strict";

jest.mock("../netlify/functions/providers", () => ({
  getProvider: jest.fn(),
}));

const { getProvider } = require("../netlify/functions/providers");
const { handler: voicesHandler } = require("../netlify/functions/tts-voices");
const { handler: modelsHandler } = require("../netlify/functions/tts-models");

function makeEvent(method, params = {}) {
  return {
    httpMethod: method,
    headers: { origin: "https://studio.ghostai.io" },
    queryStringParameters: params,
  };
}

describe("GET /api/tts/voices", () => {
  beforeEach(() => {
    getProvider.mockReturnValue({
      listVoices: jest.fn().mockResolvedValue({
        ok: true,
        voices: [{ voiceId: "v1", name: "Rachel", category: "premade", labels: {}, previewUrl: null }],
        hasMore: false,
        nextPageToken: null,
      }),
    });
  });

  test("returns 204 for OPTIONS", async () => {
    const res = await voicesHandler(makeEvent("OPTIONS"));
    expect(res.statusCode).toBe(204);
  });

  test("returns 200 with voice list for GET", async () => {
    const res = await voicesHandler(makeEvent("GET"));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.voices)).toBe(true);
    expect(body.voices[0].voiceId).toBe("v1");
    expect(body.hasMore).toBe(false);
  });

  test("returns 400 for unknown provider query param", async () => {
    getProvider.mockReturnValue(null);
    const res = await voicesHandler(makeEvent("GET", { provider: "unknown" }));
    expect(res.statusCode).toBe(400);
  });

  test("returns 405 for POST", async () => {
    const res = await voicesHandler(makeEvent("POST"));
    expect(res.statusCode).toBe(405);
  });

  test("has CORS headers", async () => {
    const res = await voicesHandler(makeEvent("GET"));
    expect(res.headers["Access-Control-Allow-Origin"]).toBeTruthy();
  });

  test("propagates provider error", async () => {
    getProvider.mockReturnValue({
      listVoices: jest.fn().mockResolvedValue({
        ok: false,
        statusCode: 401,
        error: { code: "ELEVENLABS_UNAUTHORIZED", message: "Unauthorized" },
        requestId: "r1",
      }),
    });
    const res = await voicesHandler(makeEvent("GET"));
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("ELEVENLABS_UNAUTHORIZED");
  });
});

describe("GET /api/tts/models", () => {
  beforeEach(() => {
    getProvider.mockReturnValue({
      listModels: jest.fn().mockResolvedValue({
        ok: true,
        models: [{ modelId: "eleven_multilingual_v2", name: "Multilingual v2", description: "", languages: [], supportsStyle: true, supportsSpeakerBoost: true }],
      }),
    });
  });

  test("returns 204 for OPTIONS", async () => {
    const res = await modelsHandler(makeEvent("OPTIONS"));
    expect(res.statusCode).toBe(204);
  });

  test("returns 200 with model list for GET", async () => {
    const res = await modelsHandler(makeEvent("GET"));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models[0].modelId).toBe("eleven_multilingual_v2");
  });

  test("returns 400 for unknown provider", async () => {
    getProvider.mockReturnValue(null);
    const res = await modelsHandler(makeEvent("GET", { provider: "ghost" }));
    expect(res.statusCode).toBe(400);
  });

  test("returns 405 for DELETE", async () => {
    const res = await modelsHandler(makeEvent("DELETE"));
    expect(res.statusCode).toBe(405);
  });
});
