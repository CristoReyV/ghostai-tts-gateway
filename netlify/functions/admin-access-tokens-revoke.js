/**
 * @file netlify/functions/admin-access-tokens-revoke.js
 * POST /api/admin/access-tokens/revoke
 *
 * Administrator endpoint to immediately revoke an access token.
 * Protected by GHOSTAI_ADMIN_AUTH_TOKEN.
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

  if (event.httpMethod !== "POST") {
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only POST is accepted on this endpoint.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const { tokenId } = body;
  if (!tokenId || typeof tokenId !== "string" || !tokenId.trim()) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Field 'tokenId' is required.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  try {
    const result = await db.revokeToken(tokenId.trim());
    if (!result) {
      const err = makeError(404, "TOKEN_NOT_FOUND", "Access token not found.", requestId);
      return jsonResponse(404, { error: err.error, requestId }, origin);
    }

    return jsonResponse(
      200,
      {
        ok: true,
        tokenId: result.id,
        status: "revoked",
        revokedAt: result.revoked_at,
      },
      origin
    );
  } catch (err) {
    const errPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error revoking access token.", requestId);
    return jsonResponse(500, { error: errPayload.error, requestId }, origin);
  }
};
