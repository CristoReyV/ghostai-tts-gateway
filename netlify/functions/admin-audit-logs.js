/**
 * @file netlify/functions/admin-audit-logs.js
 * GET /api/admin/audit-logs
 *
 * Lists administrator audit trail events. OWNER only.
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

  // Guard: OWNER ONLY
  const auth = requireAdminAuth(event, requestId, "owner");
  if (!auth.ok) {
    return jsonResponse(auth.statusCode, { error: auth.error, requestId }, origin);
  }

  if (event.httpMethod !== "GET") {
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Solo GET es aceptado.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  const limit = Math.min(parseInt(event.queryStringParameters?.limit || "100", 10), 200);
  const offset = Math.max(parseInt(event.queryStringParameters?.offset || "0", 10), 0);

  try {
    const logs = await db.listAdminAuditLogs(limit, offset);
    return jsonResponse(200, { ok: true, logs }, origin);
  } catch (err) {
    const errPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error listando registros de auditoría.", requestId);
    return jsonResponse(500, { error: errPayload.error, requestId }, origin);
  }
};
