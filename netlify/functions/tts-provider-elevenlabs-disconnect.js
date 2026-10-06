/**
 * @file netlify/functions/tts-provider-elevenlabs-disconnect.js
 * POST /api/tts/provider/elevenlabs/disconnect
 *
 * Disconnects the user's ElevenLabs BYOK session by expiring the HttpOnly cookie.
 * Does NOT call ElevenLabs.
 *
 * Security:
 *  - Requires Operator Bearer auth.
 *  - Origin must be allowed.
 *  - Cache-Control: no-store.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse, isOriginAllowed } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireOperatorAuth } = require("./lib/auth");
const { logByokEvent } = require("./lib/logger");
const { buildClearCookie } = require("./lib/byok");

function jsonResponse(statusCode, body, origin, clearCookie) {
  const headers = {
    ...corsHeaders(origin),
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (clearCookie) {
    headers["Set-Cookie"] = clearCookie;
  }
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  if (event.httpMethod !== "POST") {
    const requestId = crypto.randomUUID();
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only POST is accepted on this endpoint.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  if (!isOriginAllowed(origin)) {
    const requestId = crypto.randomUUID();
    const err = makeError(403, ERROR_CODES.ORIGIN_NOT_ALLOWED, "Origin not allowed.", requestId);
    return jsonResponse(403, { error: err.error, requestId }, origin);
  }

  const requestId = crypto.randomUUID();

  // ── Operator Auth guard ─────────────────────────────────────────────────────
  const authResult = requireOperatorAuth(event, requestId);
  if (!authResult.ok) {
    return jsonResponse(authResult.statusCode, { error: authResult.error, requestId }, origin);
  }

  logByokEvent(requestId, { action: "disconnect", outcome: "success" });

  return jsonResponse(
    200,
    {
      ok: true,
      connected: false,
      provider: "elevenlabs",
      message: "Cuenta de ElevenLabs desconectada correctamente.",
    },
    origin,
    buildClearCookie()
  );
};
