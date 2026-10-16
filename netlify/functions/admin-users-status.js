/**
 * @file netlify/functions/admin-users-status.js
 * POST /api/admin/users/status
 *
 * Changes an administrator's status (active | disabled). OWNER only.
 * Protects against deactivating the last active OWNER.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireAdminAuth } = require("./lib/adminAuth");
const { updateAdminStatus } = require("./lib/adminUserService");

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

  if (event.httpMethod !== "POST") {
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Solo POST es aceptado.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const { adminId, status } = body;
  if (!adminId || typeof adminId !== "string" || !adminId.trim()) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "El campo 'adminId' es requerido.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  if (status !== "active" && status !== "disabled") {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_PARAM, "El estado debe ser 'active' o 'disabled'.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  try {
    const updated = await updateAdminStatus({
      adminId: adminId.trim(),
      status,
      requestingAdmin: auth.admin,
    });

    return jsonResponse(
      200,
      {
        ok: true,
        adminUser: updated,
      },
      origin
    );
  } catch (err) {
    const statusCode = err.statusCode || 400;
    const errPayload = makeError(statusCode, err.code || ERROR_CODES.INTERNAL_ERROR, err.message, requestId);
    return jsonResponse(statusCode, { error: errPayload.error, requestId }, origin);
  }
};
