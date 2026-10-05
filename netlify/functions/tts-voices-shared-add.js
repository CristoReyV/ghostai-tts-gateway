/**
 * @file netlify/functions/tts-voices-shared-add.js
 * POST /api/tts/voices/shared/add
 *
 * Adds a public shared voice into the user's ElevenLabs account collection.
 * Rejects GET, strictly validates body parameters, builds upstream URL server-side,
 * keeps xi-api-key strictly server-side, never calls TTS generate.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { getProvider } = require("./providers");

function jsonResponse(statusCode, body, extraHeaders, origin) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  if (event.httpMethod !== "POST") {
    const requestId = crypto.randomUUID();
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only POST is accepted on this endpoint.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }

  const requestId = crypto.randomUUID();
  const provider = getProvider("elevenlabs");

  if (!provider || typeof provider.addSharedVoice !== "function") {
    const err = makeError(500, ERROR_CODES.GATEWAY_NOT_CONFIGURED, "Add shared voice is not supported by this provider.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }

  const { voiceId, publicOwnerId, name } = body;

  if (!voiceId || typeof voiceId !== "string" || !voiceId.trim()) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Field 'voiceId' is required and must be a non-empty string.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }

  if (!publicOwnerId || typeof publicOwnerId !== "string" || !publicOwnerId.trim()) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Field 'publicOwnerId' is required and must be a non-empty string.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }

  if (!name || typeof name !== "string" || !name.trim()) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Field 'name' is required and must be a non-empty string.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }

  // Validate format of identifiers to reject arbitrary URLs or path traversal
  const safeIdRegex = /^[a-zA-Z0-9_-]{1,128}$/;
  if (!safeIdRegex.test(voiceId.trim()) || !safeIdRegex.test(publicOwnerId.trim())) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_PARAM, "Identifiers 'voiceId' and 'publicOwnerId' contain invalid characters.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }

  const result = await provider.addSharedVoice(
    {
      voiceId: voiceId.trim(),
      publicOwnerId: publicOwnerId.trim(),
      name: name.trim().slice(0, 100),
    },
    requestId
  );

  if (!result.ok) {
    return jsonResponse(result.statusCode, { error: result.error, requestId }, { "X-TTS-Request-ID": requestId }, origin);
  }

  return jsonResponse(
    200,
    {
      ok: true,
      voiceId: result.voiceId,
      name: result.name,
      message: result.message,
    },
    { "X-TTS-Request-ID": requestId },
    origin
  );
};
