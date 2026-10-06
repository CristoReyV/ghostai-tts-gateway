/**
 * @file netlify/functions/admin-clients.js
 * POST /api/admin/clients
 *
 * Administrator endpoint to create a new client.
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

  // Handle GET /api/admin/clients (listing)
  if (event.httpMethod === "GET") {
    try {
      const clients = await db.listClients();
      return jsonResponse(200, { ok: true, clients }, origin);
    } catch (err) {
      const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error listing clients.", requestId);
      return jsonResponse(500, { error: errorPayload.error, requestId }, origin);
    }
  }

  // Handle POST /api/admin/clients (creation)
  if (event.httpMethod !== "POST") {
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only POST and GET are accepted on this endpoint.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const { name, email } = body;
  if (!name || typeof name !== "string" || !name.trim()) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Field 'name' is required.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  if (name.trim().length > 255) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_PARAM, "Field 'name' must not exceed 255 characters.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  try {
    const record = await db.createClient({
      name: name.trim(),
      email: typeof email === "string" && email.trim() ? email.trim() : null,
    });

    return jsonResponse(
      201,
      {
        id: record.id,
        name: record.name,
        email: record.email,
        status: record.status,
        createdAt: record.created_at,
      },
      origin
    );
  } catch (err) {
    const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error creating client.", requestId);
    return jsonResponse(500, { error: errorPayload.error, requestId }, origin);
  }
};
