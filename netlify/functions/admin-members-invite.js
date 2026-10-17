/**
 * @file netlify/functions/admin-members-invite.js
 * POST /api/admin/members/invite
 *
 * Administrator endpoint to create or re-send invitations.
 * Generates a fresh activation token (7-day TTL), updates invited_at,
 * and produces ready-to-send email payloads.
 * Zero real emails sent.
 *
 * Protected by GHOSTAI_ADMIN_AUTH_TOKEN / admin session.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { authorizeAdmin: requireAdminAuth } = require("./lib/adminAuthorization");
const { inviteMember } = require("./lib/memberService");
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
  const adminAuth = await requireAdminAuth(event, requestId, "member.invitation.link");
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

  const { memberId, memberIds } = body;
  const targetIds = Array.isArray(memberIds)
    ? memberIds.filter((id) => typeof id === "string" && id.trim())
    : memberId && typeof memberId === "string" && memberId.trim()
    ? [memberId.trim()]
    : [];

  if (targetIds.length === 0) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Provide 'memberId' or a list of 'memberIds'.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  try {
    const invitations = [];
    const errors = [];

    for (const id of targetIds) {
      try {
        const result = await inviteMember(id);
        await db.logAdminAuditEvent({ adminId: adminAuth.admin.id, adminEmail: adminAuth.admin.email, adminRole: adminAuth.admin.role, action: "invite_link_created", targetId: id });
        invitations.push({
          memberId: id,
          activationToken: result.activationToken,
          activationLink: result.activationLink,
          emailPayload: result.emailPayload,
        });
      } catch (itemErr) {
        errors.push({
          memberId: id,
          error: itemErr.message,
        });
      }
    }

    return jsonResponse(
      200,
      {
        ok: true,
        sentCount: invitations.length,
        errorCount: errors.length,
        invitations,
        errors,
        zeroRealEmailsSent: true,
      },
      origin
    );
  } catch (err) {
    const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error generando invitaciones.", requestId);
    return jsonResponse(500, { error: errorPayload.error, requestId }, origin);
  }
};
