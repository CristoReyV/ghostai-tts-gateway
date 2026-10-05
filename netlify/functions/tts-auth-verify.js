/**
 * @file netlify/functions/tts-auth-verify.js
 * GET /api/tts/auth/verify
 *
 * Cheap verification endpoint for operator token.
 * Validates the Authorization: Bearer <token> header server-side.
 * Does NOT invoke ElevenLabs.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { requireOperatorAuth } = require("./lib/auth");
const { makeError, ERROR_CODES } = require("./lib/errors");

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return preflightResponse(origin);
  }

  // Only GET allowed
  if (event.httpMethod !== "GET") {
    const requestId = crypto.randomUUID();
    const err = makeError(
      405,
      ERROR_CODES.METHOD_NOT_ALLOWED,
      "Only GET is accepted on this endpoint.",
      requestId
    );
    return {
      statusCode: 405,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-TTS-Request-ID": requestId,
      },
      body: JSON.stringify({ error: err.error, requestId }),
    };
  }

  const requestId = crypto.randomUUID();
  const authResult = requireOperatorAuth(event, requestId);

  if (!authResult.ok) {
    return {
      statusCode: authResult.statusCode,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-TTS-Request-ID": requestId,
      },
      body: JSON.stringify({
        error: authResult.error,
        requestId,
      }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-TTS-Request-ID": requestId,
    },
    body: JSON.stringify({
      ok: true,
      authenticated: true,
    }),
  };
};
