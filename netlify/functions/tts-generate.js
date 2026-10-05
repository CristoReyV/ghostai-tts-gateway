/**
 * @file netlify/functions/tts-generate.js
 * POST /api/tts/generate  →  audio/mpeg binary
 *
 * Routed via netlify.toml:
 *   /api/tts/generate → /.netlify/functions/tts-generate
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { logRequestStart } = require("./lib/logger");
const { validateGenerateRequest } = require("./lib/validate");
const { requireOperatorAuth } = require("./lib/auth");
const { getProvider } = require("./providers");

/**
 * Builds a JSON error Netlify response.
 * @param {{ statusCode: number; error: { code: string; message: string }; requestId: string }} errPayload
 * @param {string|undefined} origin
 */
function jsonErrorResponse(errPayload, origin) {
  return {
    statusCode: errPayload.statusCode,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "X-TTS-Request-ID": errPayload.requestId,
    },
    body: JSON.stringify({ error: errPayload.error, requestId: errPayload.requestId }),
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  // ── CORS Preflight ──────────────────────────────────────────────────────────
  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  // ── Method guard ────────────────────────────────────────────────────────────
  if (event.httpMethod !== "POST") {
    return jsonErrorResponse(
      makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only POST is accepted on this endpoint.", ""),
      origin
    );
  }

  const requestId = crypto.randomUUID();

  // ── Operator Auth guard ─────────────────────────────────────────────────────
  const authResult = requireOperatorAuth(event, requestId);
  if (!authResult.ok) {
    return jsonErrorResponse(authResult, origin);
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_) {
    return jsonErrorResponse(
      makeError(400, "INVALID_JSON", "Request body is not valid JSON.", requestId),
      origin
    );
  }

  // ── Validate ────────────────────────────────────────────────────────────────
  const validationError = validateGenerateRequest(body, requestId);
  if (validationError) return jsonErrorResponse(validationError, origin);

  const {
    provider: providerName,
    voiceId,
    text,
    modelId,
    voiceSettings,
    outputFormat,
    languageCode,
  } = body;

  logRequestStart(requestId, {
    provider: providerName,
    voiceId,
    modelId: modelId || "(default)",
    textLength: text.length,
  });

  // ── Dispatch to provider ────────────────────────────────────────────────────
  const provider = getProvider(providerName);
  // getProvider already validated above via ALLOWED_PROVIDERS, but belt-and-braces:
  if (!provider) {
    return jsonErrorResponse(
      makeError(400, ERROR_CODES.VALIDATION_UNKNOWN_PROVIDER, `Provider '${providerName}' not found.`, requestId),
      origin
    );
  }

  const result = await provider.generate({
    requestId,
    voiceId,
    text,
    modelId,
    voiceSettings,
    outputFormat,
    languageCode,
  });

  if (!result.ok) {
    return jsonErrorResponse(result, origin);
  }

  // ── Return binary audio ─────────────────────────────────────────────────────
  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": result.contentType || "audio/mpeg",
      "Content-Length": String(result.audioBuffer.byteLength),
      "X-TTS-Provider": providerName,
      "X-TTS-Request-ID": requestId,
      "X-TTS-Output-Format": body.outputFormat || process.env.ELEVENLABS_DEFAULT_OUTPUT_FORMAT || "mp3_44100_128",
      "Cache-Control": "no-store",
    },
    // Netlify Functions v1 returns binary via isBase64Encoded
    isBase64Encoded: true,
    body: result.audioBuffer.toString("base64"),
  };
};
