/**
 * @file netlify/functions/admin-users.js
 * GET  /api/admin/users  → List all administrators (OWNER only)
 * POST /api/admin/users  → Invite a new administrator (OWNER only)
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireAdminAuth } = require("./lib/adminAuth");
const { inviteAdminUser } = require("./lib/adminUserService");
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

  // ── GET: List Admins ───────────────────────────────────────────────
  if (event.httpMethod === "GET") {
    try {
      const users = await db.listAdminUsers();
      return jsonResponse(200, { ok: true, users }, origin);
    } catch (err) {
      const errPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error listando administradores.", requestId);
      return jsonResponse(500, { error: errPayload.error, requestId }, origin);
    }
  }

  // ── POST: Invite Admin ─────────────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
      return jsonResponse(400, { error: err.error, requestId }, origin);
    }

    const { name, email, role } = body;
    if (!name || typeof name !== "string" || !name.trim()) {
      const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "El campo 'name' es requerido.", requestId);
      return jsonResponse(400, { error: err.error, requestId }, origin);
    }

    if (!email || typeof email !== "string" || !email.trim()) {
      const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "El campo 'email' es requerido.", requestId);
      return jsonResponse(400, { error: err.error, requestId }, origin);
    }

    try {
      const result = await inviteAdminUser({
        name: name.trim(),
        email: email.trim(),
        role: role === "owner" ? "owner" : "admin",
        requestingAdmin: auth.admin,
      });

      return jsonResponse(
        201,
        {
          ok: true,
          adminUser: result.adminUser,
          activationToken: result.activationToken,
          activationLink: result.activationLink,
        },
        origin
      );
    } catch (err) {
      const statusCode = err.statusCode || 400;
      const errPayload = makeError(statusCode, err.code || ERROR_CODES.INTERNAL_ERROR, err.message, requestId);
      return jsonResponse(statusCode, { error: errPayload.error, requestId }, origin);
    }
  }

  const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Solo GET y POST son aceptados.", requestId);
  return jsonResponse(405, { error: err.error, requestId }, origin);
};
