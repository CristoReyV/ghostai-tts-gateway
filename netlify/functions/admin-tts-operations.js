/**
 * @file netlify/functions/admin-tts-operations.js
 * GET /api/admin/tts/operations
 *
 * Administrator audit view for TTS operations.
 * Returns metadata ONLY (session ID, client, counts, status, expiry).
 * Strictly forbids audio streaming, signed URLs, and narration text.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireAdminAuth } = require("./lib/adminAuth");
const db = require("./lib/db");

function jsonResponse(statusCode, body, origin) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  const requestId = crypto.randomUUID();

  // Admin auth guard
  const adminAuth = requireAdminAuth(event, requestId);
  if (!adminAuth.ok) {
    return jsonResponse(adminAuth.statusCode, { error: adminAuth.error, requestId }, origin);
  }

  if (event.httpMethod !== "GET") {
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only GET is accepted.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  try {
    const sessions = await db.listAdminTtsSessions();
    return jsonResponse(200, { ok: true, sessions }, origin);
  } catch (err) {
    const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error listing TTS operation sessions.", requestId);
    return jsonResponse(500, { error: errorPayload.error, requestId }, origin);
  }
};
