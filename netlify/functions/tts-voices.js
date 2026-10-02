/**
 * @file netlify/functions/tts-voices.js
 * GET /api/tts/voices
 *
 * Returns normalised list of available voices for the configured provider.
 * Implements a short in-memory cache inside the provider adapter.
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
      "Cache-Control": "public, max-age=60",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  if (event.httpMethod !== "GET") {
    const requestId = crypto.randomUUID();
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only GET is accepted on this endpoint.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }

  const requestId = crypto.randomUUID();

  // Default to elevenlabs if no query param
  const providerName = event.queryStringParameters?.provider || "elevenlabs";
  const provider = getProvider(providerName);

  if (!provider) {
    const err = makeError(400, ERROR_CODES.VALIDATION_UNKNOWN_PROVIDER, `Unknown provider '${providerName}'.`, requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }

  const result = await provider.listVoices(requestId);

  if (!result.ok) {
    return jsonResponse(result.statusCode, { error: result.error, requestId }, { "X-TTS-Request-ID": requestId }, origin);
  }

  return jsonResponse(
    200,
    { voices: result.voices, hasMore: result.hasMore, nextPageToken: result.nextPageToken },
    { "X-TTS-Request-ID": requestId, "X-TTS-Provider": providerName },
    origin
  );
};
