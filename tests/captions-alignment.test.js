/**
 * @file tests/captions-alignment.test.js
 * Test suite for Captions 01A — ElevenLabs Timestamps & Canonical Alignment.
 *
 * All external HTTP calls are mocked. ZERO real ElevenLabs credits used.
 */

"use strict";

const { normalizeElevenLabsAlignment, isValidCanonicalAlignment } = require("../netlify/functions/lib/alignment");
const { validateGenerateRequest } = require("../netlify/functions/lib/validate");
const { sanitizeSourceManifest } = require("../netlify/functions/lib/errorCatalog");
const elevenlabsProvider = require("../netlify/functions/providers/elevenlabs");
const ttsGenerate = require("../netlify/functions/tts-generate");
const ttsRecover = require("../netlify/functions/tts-generations-recover");
const db = require("../netlify/functions/lib/db");
const { generateClientToken } = require("../netlify/functions/lib/tokenService");
const { encryptCredential } = require("../netlify/functions/lib/credentialCrypto");

describe("Captions 01A — Timestamps & Alignment Normalization", () => {
  describe("1. lib/alignment: normalizeElevenLabsAlignment & canonical validation", () => {
    // A) alignment español correcto
    test("Fixture A: normalizes standard Spanish sentence into word tokens", () => {
      const text = "El misterio comienza hoy";
      const rawAlignment = {
        characters: ["E", "l", " ", "m", "i", "s", "t", "e", "r", "i", "o", " ", "c", "o", "m", "i", "e", "n", "z", "a", " ", "h", "o", "y"],
        character_start_times_seconds: [
          0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00, 1.05, 1.10, 1.15
        ],
        character_end_times_seconds: [
          0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00, 1.05, 1.10, 1.15, 1.20
        ],
      };

      const result = normalizeElevenLabsAlignment({ text, rawAlignment });
      expect(result).not.toBeNull();
      expect(result.words).toHaveLength(4);

      expect(result.words[0]).toEqual({ text: "El", start: 0.0, end: 0.1 });
      expect(result.words[1]).toEqual({ text: "misterio", start: 0.15, end: 0.55 });
      expect(result.words[2]).toEqual({ text: "comienza", start: 0.6, end: 1.0 });
      expect(result.words[3]).toEqual({ text: "hoy", start: 1.05, end: 1.2 });
      expect(isValidCanonicalAlignment(result)).toBe(true);
    });

    // B) á é í ó ú ñ
    test("Fixture B: preserves accents and Spanish ñ exactly", () => {
      const text = "canción año árbol";
      const rawAlignment = {
        characters: ["c", "a", "n", "c", "i", "ó", "n", " ", "a", "ñ", "o", " ", "á", "r", "b", "o", "l"],
        character_start_times_seconds: [
          0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
        ],
        character_end_times_seconds: [
          0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
        ],
      };

      const result = normalizeElevenLabsAlignment({ text, rawAlignment });
      expect(result).not.toBeNull();
      expect(result.words).toHaveLength(3);
      expect(result.words[0].text).toBe("canción");
      expect(result.words[1].text).toBe("año");
      expect(result.words[2].text).toBe("árbol");
    });

    // C) ¿Pregunta?
    test("Fixture C: attaches inverted and closing question marks to surrounding tokens", () => {
      const text = "¿Cómo estás?";
      const rawAlignment = {
        characters: ["¿", "C", "ó", "m", "o", " ", "e", "s", "t", "á", "s", "?"],
        character_start_times_seconds: [0.0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
        character_end_times_seconds:   [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.05],
      };

      const result = normalizeElevenLabsAlignment({ text, rawAlignment });
      expect(result).not.toBeNull();
      expect(result.words).toHaveLength(2);
      expect(result.words[0].text).toBe("¿Cómo");
      expect(result.words[0].start).toBe(0.0);
      expect(result.words[0].end).toBe(0.4);
      expect(result.words[1].text).toBe("estás?");
      expect(result.words[1].start).toBe(0.5);
      expect(result.words[1].end).toBe(1.05);
    });

    // D) ¡Hola!
    test("Fixture D: attaches inverted and closing exclamation marks properly", () => {
      const text = "¡Hola amigos!";
      const rawAlignment = {
        characters: ["¡", "H", "o", "l", "a", "!", " ", "a", "m", "i", "g", "o", "s", "!"],
        character_start_times_seconds: [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65],
        character_end_times_seconds:   [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7],
      };

      const result = normalizeElevenLabsAlignment({ text, rawAlignment });
      expect(result).not.toBeNull();
      expect(result.words).toHaveLength(2);
      expect(result.words[0].text).toBe("¡Hola!");
      expect(result.words[1].text).toBe("amigos!");
    });

    // E) Puntuación variada
    test("Fixture E: preserves commas, dots, semicolons, quotes and dashes", () => {
      const text = "Sí, claro; \"bien\" — dijo.";
      const chars = Array.from(text);
      const starts = chars.map((_, i) => i * 0.1);
      const ends = chars.map((_, i) => (i + 1) * 0.1);

      const result = normalizeElevenLabsAlignment({
        text,
        rawAlignment: {
          characters: chars,
          character_start_times_seconds: starts,
          character_end_times_seconds: ends,
        },
      });

      expect(result).not.toBeNull();
      expect(result.words.map((w) => w.text)).toEqual(["Sí,", "claro;", "\"bien\"", "—", "dijo."]);
    });

    // F) Alignment ausente
    test("Fixture F: returns null when rawAlignment is missing or null", () => {
      expect(normalizeElevenLabsAlignment({ text: "Test", rawAlignment: null })).toBeNull();
      expect(normalizeElevenLabsAlignment({ text: "Test", rawAlignment: undefined })).toBeNull();
      expect(normalizeElevenLabsAlignment(null)).toBeNull();
    });

    // G) Alignment malformado
    test("Fixture G: returns null when alignment arrays are mismatched or have inverted timestamps", () => {
      // Mismatched length
      expect(
        normalizeElevenLabsAlignment({
          text: "Hola",
          rawAlignment: {
            characters: ["H", "o", "l", "a"],
            character_start_times_seconds: [0.1, 0.2],
            character_end_times_seconds: [0.2, 0.3],
          },
        })
      ).toBeNull();

      // Inverted end < start
      expect(
        normalizeElevenLabsAlignment({
          text: "Hola",
          rawAlignment: {
            characters: ["H", "o", "l", "a"],
            character_start_times_seconds: [0.1, 0.2, 0.5, 0.6],
            character_end_times_seconds: [0.2, 0.3, 0.4, 0.7], // 0.4 < 0.5
          },
        })
      ).toBeNull();

      // Negative timestamp
      expect(
        normalizeElevenLabsAlignment({
          text: "Hola",
          rawAlignment: {
            characters: ["H"],
            character_start_times_seconds: [-0.1],
            character_end_times_seconds: [0.1],
          },
        })
      ).toBeNull();
    });
  });

  describe("2. Validation & Security Whitelist", () => {
    test("validateGenerateRequest accepts withTimestamps boolean and rejects non-boolean", () => {
      const valid = { provider: "elevenlabs", voiceId: "v1", text: "Test", withTimestamps: true };
      expect(validateGenerateRequest(valid, "r1")).toBeNull();

      const invalid = { provider: "elevenlabs", voiceId: "v1", text: "Test", withTimestamps: "yes" };
      const err = validateGenerateRequest(invalid, "r1");
      expect(err).not.toBeNull();
      expect(err.statusCode).toBe(400);
    });

    test("sanitizeSourceManifest preserves canonical alignment on items", () => {
      const manifest = {
        format: "ghostai-tts",
        version: "1.0",
        items: [
          {
            id: "n1",
            text: "Hola",
            alignment: {
              words: [{ text: "Hola", start: 0.0, end: 0.5 }],
            },
          },
        ],
      };
      const sanitized = sanitizeSourceManifest(manifest);
      expect(sanitized.items[0].alignment).toEqual({
        words: [{ text: "Hola", start: 0.0, end: 0.5 }],
      });
    });
  });

  describe("3. ElevenLabs Provider Adapter (Mocked)", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    // H) Legacy binary request sin withTimestamps
    test("Fixture H: calls /v1/text-to-speech/:id without with-timestamps when withTimestamps is false", async () => {
      let calledUrl = "";
      let acceptHeader = "";

      global.fetch = jest.fn().mockImplementation((url, opts) => {
        calledUrl = url;
        acceptHeader = opts.headers["Accept"];
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "audio/mpeg" }),
          arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xfb, 0x90]).buffer),
        });
      });

      const res = await elevenlabsProvider.generate({
        requestId: "req-legacy",
        voiceId: "voice-123",
        text: "Audio legacy",
        apiKey: "sk_test_key_12345",
        withTimestamps: false,
      });

      expect(res.ok).toBe(true);
      expect(calledUrl).toContain("/v1/text-to-speech/voice-123?");
      expect(calledUrl).not.toContain("with-timestamps");
      expect(acceptHeader).toBe("audio/*");
      expect(res.audioBuffer).toBeDefined();
      expect(res.alignment).toBeUndefined();
    });

    // Timestamp opt-in request
    test("calls /v1/text-to-speech/:id/with-timestamps when withTimestamps is true", async () => {
      let calledUrl = "";
      let acceptHeader = "";

      const fakeAudioB64 = Buffer.from([0xff, 0xfb, 0x90]).toString("base64");
      global.fetch = jest.fn().mockImplementation((url, opts) => {
        calledUrl = url;
        acceptHeader = opts.headers["Accept"];
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          json: () =>
            Promise.resolve({
              audio_base64: fakeAudioB64,
              alignment: {
                characters: ["H", "o", "l", "a"],
                character_start_times_seconds: [0.0, 0.1, 0.2, 0.3],
                character_end_times_seconds: [0.1, 0.2, 0.3, 0.4],
              },
            }),
        });
      });

      const res = await elevenlabsProvider.generate({
        requestId: "req-ts",
        voiceId: "voice-123",
        text: "Hola",
        apiKey: "sk_test_key_12345",
        withTimestamps: true,
      });

      expect(res.ok).toBe(true);
      expect(calledUrl).toContain("/v1/text-to-speech/voice-123/with-timestamps?");
      expect(acceptHeader).toBe("application/json");
      expect(res.audioBuffer).toBeDefined();
      expect(res.alignment).toEqual({
        words: [{ text: "Hola", start: 0.0, end: 0.4 }],
      });
      // Verification: characters arrays are NOT exposed outside adapter
      expect(res.characters).toBeUndefined();
      expect(res.character_start_times_seconds).toBeUndefined();
    });

    // G) Audio succeeds even if alignment is malformed
    test("Fixture G: provider retains valid audio when alignment is malformed, setting alignment to null", async () => {
      const fakeAudioB64 = Buffer.from([0xff, 0xfb, 0x90]).toString("base64");
      global.fetch = jest.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          json: () =>
            Promise.resolve({
              audio_base64: fakeAudioB64,
              alignment: "broken_alignment",
            }),
        })
      );

      const res = await elevenlabsProvider.generate({
        requestId: "req-broken-align",
        voiceId: "voice-123",
        text: "Hola",
        apiKey: "sk_test_key_12345",
        withTimestamps: true,
      });

      expect(res.ok).toBe(true);
      expect(res.audioBuffer).toBeDefined();
      expect(res.alignment).toBeNull();
    });
  });

  describe("4. End-to-End Gateway Handler: Legacy vs Opt-in Timestamps & Recovery", () => {
    let client, tokenData, authHeaders, byokCookie;
    const originalFetch = global.fetch;

    beforeAll(() => {
      process.env.GHOSTAI_ADMIN_AUTH_TOKEN = "test_admin";
      process.env.GHOSTAI_TOKEN_HASH_PEPPER = "pepper_at_least_32_bytes_long_123456789";
      process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      db._setMemoryStoreEnabled(true);
    });

    beforeEach(async () => {
      db._resetMemoryStore();
      client = await db.createClient({ name: "Client Test" });
      tokenData = await generateClientToken({ clientId: client.id, label: "Token Test" });
      authHeaders = { authorization: `Bearer ${tokenData.token}` };
      const encKey = encryptCredential(
        JSON.stringify({ v: 2, provider: "elevenlabs", principalId: client.id, apiKey: "sk_valid_test_key_12345678901234567890" })
      );
      byokCookie = `__Host-ghostai_elevenlabs=${encKey}`;
    });

    afterAll(() => {
      global.fetch = originalFetch;
      db._setMemoryStoreEnabled(false);
    });

    // Regression: Legacy request returns binary audio/mpeg
    test("Fixture H regression: legacy request (withTimestamps omitted) returns audio/mpeg binary", async () => {
      global.fetch = jest.fn().mockImplementation((url) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "audio/mpeg" }),
          arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xfb, 0x90]).buffer),
        });
      });

      const res = await ttsGenerate.handler({
        httpMethod: "POST",
        headers: {
          ...authHeaders,
          cookie: byokCookie,
          origin: "http://localhost:5173",
        },
        body: JSON.stringify({
          provider: "elevenlabs",
          voiceId: "voice-123",
          text: "Audio test legacy",
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toBe("audio/mpeg");
      expect(res.isBase64Encoded).toBe(true);
      expect(typeof res.body).toBe("string"); // base64 encoded audio in Netlify v1 return signature
    });

    // Opt-in request returns JSON with audioBase64 and canonical alignment
    test("Opt-in withTimestamps: true returns application/json with audioBase64 and canonical alignment", async () => {
      const fakeAudioB64 = Buffer.from([0xff, 0xfb, 0x90]).toString("base64");
      global.fetch = jest.fn().mockImplementation((url) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          json: () =>
            Promise.resolve({
              audio_base64: fakeAudioB64,
              alignment: {
                characters: ["H", "o", "l", "a"],
                character_start_times_seconds: [0.0, 0.1, 0.2, 0.3],
                character_end_times_seconds: [0.1, 0.2, 0.3, 0.4],
              },
            }),
        });
      });

      const res = await ttsGenerate.handler({
        httpMethod: "POST",
        headers: {
          ...authHeaders,
          cookie: byokCookie,
          origin: "http://localhost:5173",
        },
        body: JSON.stringify({
          provider: "elevenlabs",
          voiceId: "voice-123",
          text: "Hola",
          withTimestamps: true,
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toBe("application/json");
      expect(res.isBase64Encoded).toBeUndefined();

      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.audioBase64).toBe(fakeAudioB64);
      expect(body.alignment).toEqual({
        words: [{ text: "Hola", start: 0.0, end: 0.4 }],
      });
      expect(body.sessionId).toBeDefined();
    });

    // I) Recovery con alignment
    test("Fixture I: recovers generation session with canonical alignment", async () => {
      const fakeAudioB64 = Buffer.from([0xff, 0xfb, 0x90]).toString("base64");
      global.fetch = jest.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          json: () =>
            Promise.resolve({
              audio_base64: fakeAudioB64,
              alignment: {
                characters: ["E", "l", " ", "s", "o", "l"],
                character_start_times_seconds: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5],
                character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
              },
            }),
        })
      );

      // Generate with timestamps
      const genRes = await ttsGenerate.handler({
        httpMethod: "POST",
        headers: {
          ...authHeaders,
          cookie: byokCookie,
          origin: "http://localhost:5173",
        },
        body: JSON.stringify({
          provider: "elevenlabs",
          voiceId: "voice-123",
          text: "El sol",
          narrationId: "narr-aligned",
          withTimestamps: true,
        }),
      });

      const genData = JSON.parse(genRes.body);
      const sessionId = genData.sessionId;

      // Recover session
      const recRes = await ttsRecover.handler({
        httpMethod: "POST",
        headers: {
          ...authHeaders,
          origin: "http://localhost:5173",
        },
        body: JSON.stringify({ sessionId }),
      });

      expect(recRes.statusCode).toBe(200);
      const recData = JSON.parse(recRes.body);
      expect(recData.ok).toBe(true);
      expect(recData.items).toHaveLength(1);
      expect(recData.items[0].narrationId).toBe("narr-aligned");
      expect(recData.items[0].alignment).toEqual({
        words: [
          { text: "El", start: 0.0, end: 0.2 },
          { text: "sol", start: 0.3, end: 0.6 },
        ],
      });
    });

    // J) Recovery histórico sin alignment
    test("Fixture J: historical recovery without alignment returns alignment: null without errors", async () => {
      // Create session & item directly without alignment
      const session = await db.createGenerationSession({
        clientId: client.id,
        projectId: "proj-old",
        retentionHours: 24,
      });

      await db.createOrUpdateGenerationItem({
        sessionId: session.id,
        clientId: client.id,
        narrationId: "narr-legacy-no-align",
        status: "ready",
        storagePath: "client/session/audio.mp3",
        text: "Audio viejo sin alignment",
        expiresAt: session.expires_at,
        // alignment omitted
      });

      const recRes = await ttsRecover.handler({
        httpMethod: "POST",
        headers: {
          ...authHeaders,
          origin: "http://localhost:5173",
        },
        body: JSON.stringify({ sessionId: session.id }),
      });

      expect(recRes.statusCode).toBe(200);
      const recData = JSON.parse(recRes.body);
      expect(recData.ok).toBe(true);
      expect(recData.items[0].alignment).toBeNull();
    });
  });
});
