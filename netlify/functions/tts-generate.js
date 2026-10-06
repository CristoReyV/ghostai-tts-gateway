/**
 * @file netlify/functions/tts-generate.js
 * POST /api/tts/generate  →  audio/mpeg binary
 *
 * Routed via netlify.toml:
 *   /api/tts/generate → /.netlify/functions/tts-generate
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse, isOriginAllowed } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { logRequestStart } = require("./lib/logger");
const { validateGenerateRequest } = require("./lib/validate");
const { requireOperatorAuth } = require("./lib/auth");
const { resolveByokApiKey, byokFailureError, buildClearCookie, KEY_REJECTED_MESSAGE } = require("./lib/byok");
const { getProvider } = require("./providers");

/**
 * Builds a JSON error Netlify response.
 * @param {{ statusCode: number; error: { code: string; message: string }; requestId: string }} errPayload
 * @param {string|undefined} origin
 * @param {string|undefined} [setCookie]
 */
function jsonErrorResponse(errPayload, origin, setCookie) {
  const headers = {
    ...corsHeaders(origin),
    "Content-Type": "application/json",
    "X-TTS-Request-ID": errPayload.requestId,
    "Cache-Control": "no-store",
  };
  if (setCookie) {
    headers["Set-Cookie"] = setCookie;
  }
  return {
    statusCode: errPayload.statusCode,
    headers,
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

  // ── Origin allowlist guard ──────────────────────────────────────────────────
  if (!isOriginAllowed(origin)) {
    return jsonErrorResponse(
      makeError(403, ERROR_CODES.ORIGIN_NOT_ALLOWED, "Origin not allowed.", ""),
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

  // ── BYOK Credential Resolution ──────────────────────────────────────────────
  // Resolves user's ElevenLabs key exclusively from HttpOnly session cookie.
  // CRITICAL: ZERO fallback to process.env.ELEVENLABS_API_KEY or GhostAI key.
  const byok = resolveByokApiKey(event);
  if (!byok.ok) {
    const errPayload = byokFailureError(byok, requestId);
    const clearCookie = errPayload.clearCookie ? buildClearCookie() : undefined;
    return jsonErrorResponse(errPayload, origin, clearCookie);
  }

  const userApiKey = byok.apiKey;

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
  if (!provider) {
    return jsonErrorResponse(
      makeError(400, ERROR_CODES.VALIDATION_UNKNOWN_PROVIDER, `Provider '${providerName}' not found.`, requestId),
      origin
    );
  }

  let result;
  try {
    result = await provider.generate({
      requestId,
      voiceId,
      text,
      modelId,
      voiceSettings,
      outputFormat,
      languageCode,
      apiKey: userApiKey,
    });
  } finally {
    // Explicitly scope out user key reference immediately after call
    // (Never persist, never log, garbage collected)
  }

  if (!result.ok) {
    let clearCookieHeader;
    // If ElevenLabs returned 401, the user's key was rejected or revoked
    if (result.statusCode === 401) {
      clearCookieHeader = buildClearCookie();
      result.error.message = KEY_REJECTED_MESSAGE;
    }
    return jsonErrorResponse(result, origin, clearCookieHeader);
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
