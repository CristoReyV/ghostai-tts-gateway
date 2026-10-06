/**
 * @file validate.js
 * Request validation for POST /api/tts/generate.
 */

"use strict";

const { ERROR_CODES, makeError } = require("./errors");

const ALLOWED_PROVIDERS = ["elevenlabs"];

const ALLOWED_OUTPUT_FORMATS = [
  "mp3_44100_128",
  "mp3_44100_192",
  "mp3_22050_32",
  "pcm_16000",
  "pcm_22050",
  "pcm_24000",
  "pcm_44100",
  "ulaw_8000",
];

const MAX_TEXT_LENGTH = Number(process.env.TTS_MAX_TEXT_LENGTH) || 5000;

/**
 * Payload field names that could smuggle a provider credential into /generate.
 * Compared after lower-casing and stripping non-alphanumerics, so
 * `apiKey`, `api_key`, `xi-api-key`, `elevenlabsKey`, `providerKey`… all match.
 * The provider key MUST come exclusively from the BYOK session cookie.
 */
const FORBIDDEN_CREDENTIAL_FIELDS = new Set([
  "apikey",
  "xiapikey",
  "elevenlabskey",
  "elevenlabsapikey",
  "providerkey",
  "providerapikey",
  "secretkey",
]);

/**
 * @param {Record<string, unknown>} body
 * @returns {string | null} offending field name, or null
 */
function findForbiddenCredentialField(body) {
  if (!body || typeof body !== "object") return null;
  for (const name of Object.keys(body)) {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_CREDENTIAL_FIELDS.has(normalized)) return name;
  }
  return null;
}

/**
 * Validates the parsed request body for /api/tts/generate.
 * Returns an error object on failure, null on success.
 *
 * @param {Record<string, unknown>} body
 * @param {string} requestId
 * @returns {{ statusCode: number; error: { code: string; message: string }; requestId: string } | null}
 */
function validateGenerateRequest(body, requestId) {
  const forbidden = findForbiddenCredentialField(body);
  if (forbidden) {
    return makeError(
      400,
      ERROR_CODES.VALIDATION_FORBIDDEN_FIELD,
      "Provider credentials are not accepted in the request body. Connect ElevenLabs via the BYOK connect endpoint.",
      requestId
    );
  }
  if (!body.provider || typeof body.provider !== "string") {
    return makeError(400, ERROR_CODES.VALIDATION_MISSING_PROVIDER, "Field 'provider' is required.", requestId);
  }
  if (!ALLOWED_PROVIDERS.includes(body.provider)) {
    return makeError(
      400,
      ERROR_CODES.VALIDATION_UNKNOWN_PROVIDER,
      `Provider '${body.provider}' is not supported. Allowed: ${ALLOWED_PROVIDERS.join(", ")}.`,
      requestId
    );
  }
  if (!body.voiceId || typeof body.voiceId !== "string" || !body.voiceId.trim()) {
    return makeError(400, ERROR_CODES.VALIDATION_MISSING_VOICE_ID, "Field 'voiceId' is required.", requestId);
  }
  if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
    return makeError(400, ERROR_CODES.VALIDATION_MISSING_TEXT, "Field 'text' is required and must not be empty.", requestId);
  }
  if (body.text.length > MAX_TEXT_LENGTH) {
    return makeError(
      400,
      ERROR_CODES.VALIDATION_TEXT_TOO_LONG,
      `Field 'text' exceeds the maximum allowed length of ${MAX_TEXT_LENGTH} characters.`,
      requestId
    );
  }
  if (body.modelId !== undefined && (typeof body.modelId !== "string" || !body.modelId.trim())) {
    return makeError(400, ERROR_CODES.VALIDATION_MISSING_MODEL_ID, "Field 'modelId' must be a non-empty string when provided.", requestId);
  }
  if (body.outputFormat !== undefined && !ALLOWED_OUTPUT_FORMATS.includes(body.outputFormat)) {
    return makeError(
      400,
      ERROR_CODES.VALIDATION_INVALID_OUTPUT_FORMAT,
      `Field 'outputFormat' must be one of: ${ALLOWED_OUTPUT_FORMATS.join(", ")}.`,
      requestId
    );
  }
  return null;
}

module.exports = { validateGenerateRequest, ALLOWED_PROVIDERS, ALLOWED_OUTPUT_FORMATS, MAX_TEXT_LENGTH };
