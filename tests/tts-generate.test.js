/**
 * @file tests/tts-generate.test.js
 * Integration-style tests for the tts-generate Netlify function handler.
 * All ElevenLabs calls are mocked. No credits consumed.
 */

"use strict";

const crypto = require("crypto");

// ─── Mock provider before requiring handler ──────────────────────────────────
jest.mock("../netlify/functions/providers", () => ({
  getProvider: jest.fn(),
}));

const { getProvider } = require("../netlify/functions/providers");
const { handler } = require("../netlify/functions/tts-generate");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_OPERATOR_TOKEN = "test-operator-token";

function makeEvent(
  method,
  body,
  origin = "https://studio.ghostai.io",
  auth = `Bearer ${TEST_OPERATOR_TOKEN}`
) {
  const headers = { origin };
  if (auth !== null && auth !== undefined) {
    headers.authorization = auth;
  }
  return {
    httpMethod: method,
    headers,
    body: body ? JSON.stringify(body) : null,
    queryStringParameters: {},
  };
}

const VALID_BODY = {
  provider: "elevenlabs",
  voiceId: "voice-abc",
  text: "Hola mundo",
  modelId: "eleven_multilingual_v2",
  outputFormat: "mp3_44100_128",
};

const FAKE_AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x04]);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/tts/generate — handler", () => {
  let mockGenerate;

  beforeEach(() => {
    process.env.GHOSTAI_STUDIO_AUTH_TOKEN = TEST_OPERATOR_TOKEN;
    mockGenerate = jest.fn().mockResolvedValue({
      ok: true,
      audioBuffer: FAKE_AUDIO,
      contentType: "audio/mpeg",
      durationMs: 120,
      responseBytes: FAKE_AUDIO.byteLength,
    });
    getProvider.mockReturnValue({
      generate: mockGenerate,
    });
  });

  afterEach(() => {
    delete process.env.GHOSTAI_STUDIO_AUTH_TOKEN;
  });

  test("returns 204 for OPTIONS preflight without auth", async () => {
    const res = await handler(makeEvent("OPTIONS", null, "https://studio.ghostai.io", null));
    expect(res.statusCode).toBe(204);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeTruthy();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test("rejects POST without auth with 401 AUTH_REQUIRED and provider not called", async () => {
    const res = await handler(makeEvent("POST", VALID_BODY, "https://studio.ghostai.io", null));
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("AUTH_REQUIRED");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test("rejects POST with incorrect bearer token with 401 AUTH_INVALID and provider not called", async () => {
    const res = await handler(makeEvent("POST", VALID_BODY, "https://studio.ghostai.io", "Bearer wrong-token"));
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("AUTH_INVALID");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test("rejects POST with non-bearer scheme with 401 AUTH_INVALID and provider not called", async () => {
    const res = await handler(makeEvent("POST", VALID_BODY, "https://studio.ghostai.io", "Basic dXNlcjpwYXNz"));
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("AUTH_INVALID");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test("rejects POST with 500 when server GHOSTAI_STUDIO_AUTH_TOKEN is missing (fail closed)", async () => {
    delete process.env.GHOSTAI_STUDIO_AUTH_TOKEN;
    const res = await handler(makeEvent("POST", VALID_BODY));
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("GATEWAY_NOT_CONFIGURED");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test("returns 405 for GET", async () => {
    const res = await handler(makeEvent("GET", null));
    expect(res.statusCode).toBe(405);
  });

  test("returns 200 with base64 audio on valid request", async () => {
    const res = await handler(makeEvent("POST", VALID_BODY));
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("audio/mpeg");
    expect(res.isBase64Encoded).toBe(true);
    expect(res.headers["X-TTS-Provider"]).toBe("elevenlabs");
    expect(res.headers["X-TTS-Request-ID"]).toBeTruthy();
  });

  test("CORS headers present on 200 response", async () => {
    const res = await handler(makeEvent("POST", VALID_BODY));
    expect(res.headers["Access-Control-Allow-Origin"]).toBeTruthy();
    expect(res.headers["Access-Control-Expose-Headers"]).toContain("X-TTS-Provider");
  });

  test("returns 400 for missing provider", async () => {
    const res = await handler(makeEvent("POST", { ...VALID_BODY, provider: undefined }));
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    expect(body.error.code).toBe("VALIDATION_MISSING_PROVIDER");
  });

  test("returns 400 for unknown provider", async () => {
    getProvider.mockReturnValue(null);
    const res = await handler(makeEvent("POST", { ...VALID_BODY, provider: "unknown-provider" }));
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    // validate layer catches it first
    expect(body.error.code).toBe("VALIDATION_UNKNOWN_PROVIDER");
  });

  test("returns 400 for empty text", async () => {
    const res = await handler(makeEvent("POST", { ...VALID_BODY, text: "" }));
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    expect(body.error.code).toBe("VALIDATION_MISSING_TEXT");
  });

  test("returns 400 for text too long", async () => {
    const res = await handler(makeEvent("POST", { ...VALID_BODY, text: "a".repeat(6000) }));
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    expect(body.error.code).toBe("VALIDATION_TEXT_TOO_LONG");
  });

  test("returns 400 for missing voiceId", async () => {
    const res = await handler(makeEvent("POST", { ...VALID_BODY, voiceId: "" }));
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(400);
    expect(body.error.code).toBe("VALIDATION_MISSING_VOICE_ID");
  });

  test("propagates 401 from provider", async () => {
    getProvider.mockReturnValue({
      generate: jest.fn().mockResolvedValue({
        ok: false,
        statusCode: 401,
        error: { code: "ELEVENLABS_UNAUTHORIZED", message: "Unauthorized" },
        requestId: "r1",
      }),
    });
    const res = await handler(makeEvent("POST", VALID_BODY));
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(401);
    expect(body.error.code).toBe("ELEVENLABS_UNAUTHORIZED");
  });

  test("propagates 402 payment required from provider", async () => {
    getProvider.mockReturnValue({
      generate: jest.fn().mockResolvedValue({
        ok: false,
        statusCode: 402,
        error: { code: "ELEVENLABS_PAYMENT_REQUIRED", message: "Esta voz o función requiere un plan de ElevenLabs compatible." },
        requestId: "r-pay",
      }),
    });
    const res = await handler(makeEvent("POST", VALID_BODY));
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(402);
    expect(body.error.code).toBe("ELEVENLABS_PAYMENT_REQUIRED");
    expect(body.error.message).toBe("Esta voz o función requiere un plan de ElevenLabs compatible.");
  });

  test("propagates 429 from provider", async () => {
    getProvider.mockReturnValue({
      generate: jest.fn().mockResolvedValue({
        ok: false,
        statusCode: 429,
        error: { code: "ELEVENLABS_RATE_LIMIT", message: "Rate limit" },
        requestId: "r2",
      }),
    });
    const res = await handler(makeEvent("POST", VALID_BODY));
    expect(res.statusCode).toBe(429);
  });

  test("propagates 504 timeout from provider", async () => {
    getProvider.mockReturnValue({
      generate: jest.fn().mockResolvedValue({
        ok: false,
        statusCode: 504,
        error: { code: "ELEVENLABS_TIMEOUT", message: "Timeout" },
        requestId: "r3",
      }),
    });
    const res = await handler(makeEvent("POST", VALID_BODY));
    expect(res.statusCode).toBe(504);
  });

  test("response body never contains API key", async () => {
    process.env.ELEVENLABS_API_KEY = "sk-super-secret-key";
    const res = await handler(makeEvent("POST", VALID_BODY));
    expect(res.body).not.toContain("sk-super-secret-key");
    expect(JSON.stringify(res.headers)).not.toContain("sk-super-secret-key");
    delete process.env.ELEVENLABS_API_KEY;
  });

  test("returns 400 for invalid JSON body when authenticated", async () => {
    const event = {
      httpMethod: "POST",
      headers: {
        origin: "https://studio.ghostai.io",
        authorization: `Bearer ${TEST_OPERATOR_TOKEN}`,
      },
      body: "not-json-{",
      queryStringParameters: {},
    };
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
  });
});
