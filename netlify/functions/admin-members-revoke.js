/**
 * @file netlify/functions/admin-members-revoke.js
 * POST /api/admin/members/revoke
 *
 * Administrator endpoint to immediately revoke a member.
 * Invalidates member access, revokes their key in ghostai_access_tokens,
 * suspends the client account, and revokes pending activation tokens.
 * Other members and keys remain completely unaffected.
 *
 * Protected by GHOSTAI_ADMIN_AUTH_TOKEN / admin session.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireAdminAuth } = require("./lib/adminAuth");
const { revokeMemberAccess } = require("./lib/memberService");

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
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Solo POST es aceptado en este endpoint.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const { memberId } = body;
  if (!memberId || typeof memberId !== "string" || !memberId.trim()) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "El campo 'memberId' es requerido.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  try {
    const updated = await revokeMemberAccess(memberId.trim());
    return jsonResponse(
      200,
      {
        ok: true,
        memberId: updated.id,
        status: "revoked",
        revokedAt: updated.revoked_at,
      },
      origin
    );
  } catch (err) {
    if (err.code === "MEMBER_NOT_FOUND") {
      const errPayload = makeError(404, "MEMBER_NOT_FOUND", "Miembro no encontrado.", requestId);
      return jsonResponse(404, { error: errPayload.error, requestId }, origin);
    }
    const errPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error revocando acceso de miembro.", requestId);
    return jsonResponse(500, { error: errPayload.error, requestId }, origin);
  }
};
