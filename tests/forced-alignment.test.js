/**
 * @file tests/forced-alignment.test.js
 * Comprehensive unit tests for ElevenLabs Forced Alignment & POST /api/tts/alignment endpoint.
 * Zero real ElevenLabs API calls — 100% mocked.
 */

"use strict";

const { normalizeElevenLabsForcedAlignment } = require("../netlify/functions/lib/alignment");
const { alignAudio } = require("../netlify/functions/providers/elevenlabs");
const { handler: ttsAlignmentHandler } = require("../netlify/functions/tts-alignment");
const db = require("../netlify/functions/lib/db");
const { issueByokCookie } = require("../netlify/functions/lib/byok");

describe("CAPTIONS 02 — Forced Alignment & Alignment Endpoint", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    db._setMemoryStoreEnabled(true);
    db._resetMemoryStore();
    process.env.GHOSTAI_STUDIO_AUTH_TOKEN = "test-operator-token-123";
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.GHOSTAI_ALLOWED_ORIGINS = "https://ghostai-tts-studio.smartbrain.lat,http://localhost:5173";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    db._resetMemoryStore();
    db._setMemoryStoreEnabled(false);
  });

  describe("1. Canonical Alignment Normalization (normalizeElevenLabsForcedAlignment)", () => {
    test("normalizes standard words structure and strips provider loss metadata", () => {
      const raw = {
        words: [
          { text: "Hola", start: 0.05, end: 0.42, loss: 0.012 },
          { text: "mundo,", start: 0.45, end: 0.98, loss: 0.035 },
          { text: "bienvenido", start: 1.05, end: 1.82, loss: 0.008 },
        ],
        loss: 0.018,
      };

      const result = normalizeElevenLabsForcedAlignment(raw);
      expect(result).not.toBeNull();
      expect(result.words).toHaveLength(3);
      expect(result.words[0]).toEqual({ text: "Hola", start: 0.05, end: 0.42 });
      expect(result.words[1]).toEqual({ text: "mundo,", start: 0.45, end: 0.98 });
      expect(result.words[2]).toEqual({ text: "bienvenido", start: 1.05, end: 1.82 });
      // Provider loss is stripped
      expect(result.words[0].loss).toBeUndefined();
    });

    test("rejects non-monotonic word timestamps", () => {
      const raw = {
        words: [
          { text: "Primer", start: 0.5, end: 1.0 },
          { text: "Segundo", start: 0.3, end: 0.8 }, // backwards
        ],
      };
      expect(normalizeElevenLabsForcedAlignment(raw)).toBeNull();
    });

    test("rejects negative or inverted timestamps", () => {
      expect(
        normalizeElevenLabsForcedAlignment({
          words: [{ text: "Error", start: -0.1, end: 0.5 }],
        })
      ).toBeNull();

      expect(
        normalizeElevenLabsForcedAlignment({
          words: [{ text: "Error", start: 0.8, end: 0.3 }],
        })
      ).toBeNull();
    });

    test("normalizes character-level fallback structure by grouping whitespace", () => {
      const raw = {
        characters: [
          { text: "H", start: 0.0, end: 0.1 },
          { text: "i", start: 0.1, end: 0.2 },
          { text: " ", start: 0.2, end: 0.3 },
          { text: "!", start: 0.3, end: 0.4 },
        ],
      };
      const result = normalizeElevenLabsForcedAlignment(raw);
      expect(result).not.toBeNull();
      expect(result.words).toHaveLength(2);
      expect(result.words[0]).toEqual({ text: "Hi", start: 0, end: 0.2 });
      expect(result.words[1]).toEqual({ text: "!", start: 0.3, end: 0.4 });
    });

    test("returns null for empty or invalid input", () => {
      expect(normalizeElevenLabsForcedAlignment(null)).toBeNull();
      expect(normalizeElevenLabsForcedAlignment({})).toBeNull();
      expect(normalizeElevenLabsForcedAlignment({ words: [] })).toBeNull();
    });
  });

  describe("2. ElevenLabs Provider alignAudio()", () => {
    test("rejects when apiKey is missing without calling network", async () => {
      const result = await alignAudio({
        apiKey: "",
        requestId: "req-1",
        audioBuffer: Buffer.from("audio"),
        text: "test",
      });
      expect(result.ok).toBe(false);
      expect(result.statusCode).toBe(428);
      expect(result.error.code).toBe("ELEVENLABS_NOT_CONNECTED");
    });

    test("rejects when audioBuffer is empty", async () => {
      const result = await alignAudio({
        apiKey: "xi-key-test",
        requestId: "req-2",
        audioBuffer: Buffer.alloc(0),
        text: "test",
      });
      expect(result.ok).toBe(false);
      expect(result.statusCode).toBe(400);
    });

    test("rejects when text is missing", async () => {
      const result = await alignAudio({
        apiKey: "xi-key-test",
        requestId: "req-3",
        audioBuffer: Buffer.from("audio-bytes"),
        text: "   ",
      });
      expect(result.ok).toBe(false);
      expect(result.statusCode).toBe(400);
    });

    test("calls ElevenLabs forced-alignment and returns canonical alignment on 200", async () => {
      let calledUrl = "";
      let calledHeaders = {};
      let calledBody = null;

      global.fetch = jest.fn().mockImplementation(async (url, init) => {
        calledUrl = url;
        calledHeaders = init.headers;
        calledBody = init.body;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            words: [
              { text: "Audio", start: 0.0, end: 0.5 },
              { text: "existente", start: 0.52, end: 1.1 },
            ],
            loss: 0.01,
          }),
        };
      });

      const audioBuffer = Buffer.from("mock-existing-mp3-bytes");
      const result = await alignAudio({
        apiKey: "sk-test-key",
        requestId: "req-success",
        audioBuffer,
        text: "Audio existente",
      });

      expect(result.ok).toBe(true);
      expect(calledUrl).toBe("https://api.elevenlabs.io/v1/forced-alignment");
      expect(calledHeaders["xi-api-key"]).toBe("sk-test-key");
      expect(result.alignment).toEqual({
        words: [
          { text: "Audio", start: 0, end: 0.5 },
          { text: "existente", start: 0.52, end: 1.1 },
        ],
      });
    });

    test("handles ElevenLabs 401 unauthorized", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const result = await alignAudio({
        apiKey: "bad-key",
        requestId: "req-401",
        audioBuffer: Buffer.from("dummy"),
        text: "test",
      });

      expect(result.ok).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.error.code).toBe("ELEVENLABS_UNAUTHORIZED");
    });
  });

  describe("3. POST /api/tts/alignment Endpoint Handler", () => {
    const authHeaders = {
      Authorization: "Bearer test-operator-token-123",
      Origin: "https://ghostai-tts-studio.smartbrain.lat",
    };

    test("handles CORS preflight OPTIONS with 204", async () => {
      const res = await ttsAlignmentHandler({
        httpMethod: "OPTIONS",
        headers: { Origin: "https://ghostai-tts-studio.smartbrain.lat" },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://ghostai-tts-studio.smartbrain.lat");
    });

    test("rejects non-POST methods with 405", async () => {
      const res = await ttsAlignmentHandler({
        httpMethod: "GET",
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(405);
    });

    test("rejects unauthenticated requests with 401", async () => {
      const res = await ttsAlignmentHandler({
        httpMethod: "POST",
        headers: { Origin: "https://ghostai-tts-studio.smartbrain.lat" },
        body: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(401);
    });

    test("rejects when BYOK session is not connected with 428", async () => {
      const res = await ttsAlignmentHandler({
        httpMethod: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          audio: Buffer.from("abc").toString("base64"),
          text: "hello",
        }),
      });
      expect(res.statusCode).toBe(428);
      const parsed = JSON.parse(res.body);
      expect(parsed.error.code).toBe("ELEVENLABS_NOT_CONNECTED");
    });

    test("successfully processes JSON alignment request and returns canonical alignment", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          words: [
            { text: "Prueba", start: 0.1, end: 0.6 },
            { text: "exitosa", start: 0.62, end: 1.2 },
          ],
        }),
      });

      const sessionCookie = issueByokCookie("sk-eleven-valid-key-123456789012");
      const res = await ttsAlignmentHandler({
        httpMethod: "POST",
        headers: {
          ...authHeaders,
          cookie: sessionCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          audioBase64: Buffer.from("existing-audio-content").toString("base64"),
          text: "Prueba exitosa",
        }),
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.alignment).toEqual({
        words: [
          { text: "Prueba", start: 0.1, end: 0.6 },
          { text: "exitosa", start: 0.62, end: 1.2 },
        ],
      });
    });

    test("processes multipart/form-data alignment request", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          words: [{ text: "Multipart", start: 0.0, end: 0.5 }],
        }),
      });

      const sessionCookie = issueByokCookie("sk-eleven-valid-key-123456789012");

      const form = new FormData();
      form.append("audio", new Blob([Buffer.from("mock-binary-audio")], { type: "audio/mpeg" }), "narration.mp3");
      form.append("text", "Multipart");

      const fakeReq = new Request("http://localhost", { method: "POST", body: form });
      const bodyBuffer = Buffer.from(await fakeReq.arrayBuffer());
      const contentType = fakeReq.headers.get("content-type");

      const res = await ttsAlignmentHandler({
        httpMethod: "POST",
        headers: {
          ...authHeaders,
          cookie: sessionCookie,
          "content-type": contentType,
        },
        body: bodyBuffer.toString("base64"),
        isBase64Encoded: true,
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.alignment.words).toHaveLength(1);
      expect(data.alignment.words[0].text).toBe("Multipart");
    });

    test("updates DB generation item alignment when generationItemId is provided", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          words: [{ text: "Item", start: 0.0, end: 0.4 }],
        }),
      });

      // Insert item into memory store
      const testItem = await db.createOrUpdateGenerationItem({
        sessionId: "00000000-0000-0000-0000-000000000001",
        clientId: "00000000-0000-0000-0000-000000000002",
        narrationId: "narr-001",
        status: "ready",
        alignment: null, // previously without alignment!
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });

      const sessionCookie = issueByokCookie("sk-eleven-valid-key-123456789012");
      const res = await ttsAlignmentHandler({
        httpMethod: "POST",
        headers: {
          ...authHeaders,
          cookie: sessionCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          audioBase64: Buffer.from("existing-audio").toString("base64"),
          text: "Item",
          generationItemId: testItem.id,
        }),
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.generationItemId).toBe(testItem.id);

      // Verify DB was updated
      const updatedItem = await db.getGenerationItemById(testItem.id);
      expect(updatedItem.alignment).toEqual({
        words: [{ text: "Item", start: 0, end: 0.4 }],
      });
    });
  });
});
