/**
 * @file netlify/functions/admin-access-tokens.js
 * POST /api/admin/access-tokens  → create access token (returns plaintext token ONCE)
 * GET  /api/admin/access-tokens  → list tokens (never returns secret or full token)
 *
 * Protected by GHOSTAI_ADMIN_AUTH_TOKEN.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireAdminAuth } = require("./lib/adminAuth");
const { generateClientToken } = require("./lib/tokenService");
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

  // ── GET: List tokens ──────────────────────────────────────────────
  if (event.httpMethod === "GET") {
    try {
      const clientId =
        event.queryStringParameters?.clientId ||
        event.queryStringParameters?.client_id ||
        null;

      const tokens = await db.listTokens(clientId);
      return jsonResponse(200, { ok: true, tokens }, origin);
    } catch (err) {
      const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error listing access tokens.", requestId);
      return jsonResponse(500, { error: errorPayload.error, requestId }, origin);
    }
  }

  // ── POST: Create token ────────────────────────────────────────────
  if (event.httpMethod !== "POST") {
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only GET and POST are accepted on this endpoint.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const { clientId, label, expiresAt } = body;
  if (!clientId || typeof clientId !== "string" || !clientId.trim()) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Field 'clientId' is required.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  // Validate expiresAt format if provided
  if (expiresAt !== null && expiresAt !== undefined) {
    const parsedDate = new Date(expiresAt);
    if (isNaN(parsedDate.getTime())) {
      const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_PARAM, "Field 'expiresAt' must be a valid ISO date or null.", requestId);
      return jsonResponse(400, { error: err.error, requestId }, origin);
    }
  }

  try {
    const result = await generateClientToken({
      clientId: clientId.trim(),
      label: typeof label === "string" && label.trim() ? label.trim() : null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    });

    // Plaintext token returned ONLY in this response
    return jsonResponse(
      201,
      {
        token: result.token,
        tokenId: result.tokenId,
        clientId: result.clientId,
        label: result.label,
        createdAt: result.createdAt,
        expiresAt: result.expiresAt,
      },
      origin
    );
  } catch (err) {
    if (err.code === "CLIENT_NOT_FOUND") {
      const errPayload = makeError(404, "CLIENT_NOT_FOUND", "Client does not exist.", requestId);
      return jsonResponse(404, { error: errPayload.error, requestId }, origin);
    }
    if (err.code === "CLIENT_NOT_ACTIVE") {
      const errPayload = makeError(400, "CLIENT_NOT_ACTIVE", "Client is suspended or inactive.", requestId);
      return jsonResponse(400, { error: errPayload.error, requestId }, origin);
    }
    const errPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error generating access token.", requestId);
    return jsonResponse(500, { error: errPayload.error, requestId }, origin);
  }
};
