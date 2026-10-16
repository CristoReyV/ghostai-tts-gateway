/**
 * @file netlify/functions/admin-members.js
 * GET  /api/admin/members  → list all registered members
 * POST /api/admin/members  → create a single member with key & activation token
 *
 * Administrator endpoint protected by GHOSTAI_ADMIN_AUTH_TOKEN / admin session.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireAdminAuth } = require("./lib/adminAuth");
const { createMemberWithAccess } = require("./lib/memberService");
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

  // ── GET: List members ─────────────────────────────────────────────
  if (event.httpMethod === "GET") {
    try {
      const members = await db.listMembers();
      return jsonResponse(200, { ok: true, members }, origin);
    } catch (err) {
      const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error listando miembros.", requestId);
      return jsonResponse(500, { error: errorPayload.error, requestId }, origin);
    }
  }

  // ── POST: Create single member ────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
      return jsonResponse(400, { error: err.error, requestId }, origin);
    }

    const { name, email, accessPlan } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "El campo 'name' es requerido.", requestId);
      return jsonResponse(400, { error: err.error, requestId }, origin);
    }

    if (!email || typeof email !== "string" || !email.trim()) {
      const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "El campo 'email' es requerido.", requestId);
      return jsonResponse(400, { error: err.error, requestId }, origin);
    }

    try {
      const result = await createMemberWithAccess({
        name: name.trim(),
        email: email.trim(),
        accessPlan: accessPlan || "monthly",
      });

      return jsonResponse(
        201,
        {
          ok: true,
          member: result.member,
          activationToken: result.activationToken,
          activationLink: result.activationLink,
          emailPayload: result.emailPayload,
        },
        origin
      );
    } catch (err) {
      if (err.code === "MEMBER_ALREADY_EXISTS") {
        const errPayload = makeError(409, "MEMBER_ALREADY_EXISTS", err.message, requestId);
        return jsonResponse(409, { error: errPayload.error, existingMember: err.existingMember, requestId }, origin);
      }
      if (err.code?.startsWith("VALIDATION_")) {
        const errPayload = makeError(400, ERROR_CODES.VALIDATION_INVALID_PARAM, err.message, requestId);
        return jsonResponse(400, { error: errPayload.error, requestId }, origin);
      }
      const errPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error creando miembro.", requestId);
      return jsonResponse(500, { error: errPayload.error, requestId }, origin);
    }
  }

  const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Solo GET y POST son aceptados en este endpoint.", requestId);
  return jsonResponse(405, { error: err.error, requestId }, origin);
};
