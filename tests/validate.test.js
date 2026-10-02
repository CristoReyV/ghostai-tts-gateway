/**
 * @file tests/validate.test.js
 */

"use strict";

const { validateGenerateRequest } = require("../netlify/functions/lib/validate");

const VALID_BODY = {
  provider: "elevenlabs",
  voiceId: "voice-abc",
  text: "Hola mundo",
  modelId: "eleven_multilingual_v2",
  outputFormat: "mp3_44100_128",
};

describe("validateGenerateRequest", () => {
  test("returns null for a valid request", () => {
    expect(validateGenerateRequest(VALID_BODY, "req-1")).toBeNull();
  });

  test("rejects missing provider", () => {
    const r = validateGenerateRequest({ ...VALID_BODY, provider: undefined }, "req-2");
    expect(r).not.toBeNull();
    expect(r.error.code).toBe("VALIDATION_MISSING_PROVIDER");
    expect(r.statusCode).toBe(400);
  });

  test("rejects unknown provider", () => {
    const r = validateGenerateRequest({ ...VALID_BODY, provider: "openai" }, "req-3");
    expect(r).not.toBeNull();
    expect(r.error.code).toBe("VALIDATION_UNKNOWN_PROVIDER");
  });

  test("rejects missing voiceId", () => {
    const r = validateGenerateRequest({ ...VALID_BODY, voiceId: "" }, "req-4");
    expect(r).not.toBeNull();
    expect(r.error.code).toBe("VALIDATION_MISSING_VOICE_ID");
  });

  test("rejects empty text", () => {
    const r = validateGenerateRequest({ ...VALID_BODY, text: "" }, "req-5");
    expect(r).not.toBeNull();
    expect(r.error.code).toBe("VALIDATION_MISSING_TEXT");
  });

  test("rejects whitespace-only text", () => {
    const r = validateGenerateRequest({ ...VALID_BODY, text: "   " }, "req-6");
    expect(r).not.toBeNull();
    expect(r.error.code).toBe("VALIDATION_MISSING_TEXT");
  });

  test("rejects text exceeding MAX_TEXT_LENGTH", () => {
    const longText = "a".repeat(6000);
    const r = validateGenerateRequest({ ...VALID_BODY, text: longText }, "req-7");
    expect(r).not.toBeNull();
    expect(r.error.code).toBe("VALIDATION_TEXT_TOO_LONG");
  });

  test("rejects invalid outputFormat", () => {
    const r = validateGenerateRequest({ ...VALID_BODY, outputFormat: "ogg_vorbis" }, "req-8");
    expect(r).not.toBeNull();
    expect(r.error.code).toBe("VALIDATION_INVALID_OUTPUT_FORMAT");
  });

  test("accepts request without modelId", () => {
    const { modelId, ...body } = VALID_BODY;
    expect(validateGenerateRequest(body, "req-9")).toBeNull();
  });

  test("accepts request without outputFormat", () => {
    const { outputFormat, ...body } = VALID_BODY;
    expect(validateGenerateRequest(body, "req-10")).toBeNull();
  });
});
