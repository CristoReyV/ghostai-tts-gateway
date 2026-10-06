/**
 * @file netlify/functions/tts-provider-elevenlabs-status.js
 * GET /api/tts/provider/elevenlabs/status
 *
 * Checks if the current session has a valid, decrypted BYOK connection.
 * Does NOT invoke ElevenLabs — pure server-side decryption probe.
 *
 * Security:
 *  - Requires Operator Bearer auth.
 *  - Origin must be allowed.
 *  - Cache-Control: no-store.
 *  - Never reveals ciphertext or cryptographic errors to the client.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse, isOriginAllowed } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireOperatorAuth } = require("./lib/auth");
const { logByokEvent } = require("./lib/logger");
const { resolveByokApiKey, buildClearCookie } = require("./lib/byok");

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

  if (event.httpMethod !== "GET") {
    const requestId = crypto.randomUUID();
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only GET is accepted on this endpoint.", requestId);
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

  // ── Inspect and decrypt session cookie (NO ElevenLabs call) ─────────────────
  const byok = resolveByokApiKey(event);

  if (byok.ok) {
    logByokEvent(requestId, { action: "status", outcome: "connected" });
    return jsonResponse(
      200,
      {
        ok: true,
        connected: true,
        provider: "elevenlabs",
      },
      origin
    );
  }

  // If cookie was present but tampered or un-decryptable, expire it
  const clearCookieHeader = byok.reason === "invalid" ? buildClearCookie() : undefined;
  logByokEvent(requestId, { action: "status", outcome: byok.reason });

  return jsonResponse(
    200,
    {
      ok: true,
      connected: false,
      provider: "elevenlabs",
    },
    origin,
    clearCookieHeader
  );
};
