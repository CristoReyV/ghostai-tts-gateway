/**
 * @file netlify/functions/admin-members-email-preview.js
 * POST /api/admin/members/email-preview
 *
 * Previews the personalized invitation email HTML and text for a member
 * without sending anything. Zero real emails sent.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { authorizeAdmin: requireAdminAuth } = require("./lib/adminAuthorization");
const { renderGhostAIMemberInvitationEmail } = require("./lib/emailTemplates");
const { getStudioBaseUrl } = require("./lib/memberService");
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

  // Guard: OWNER or ADMIN
  const auth = await requireAdminAuth(event, requestId, "member.invitation.preview");
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

  const { memberId } = body;
  if (!memberId || typeof memberId !== "string" || !memberId.trim()) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "El campo 'memberId' es requerido.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  try {
    const member = await db.getMemberById(memberId.trim());
    if (!member) {
      const err = makeError(404, "MEMBER_NOT_FOUND", "Miembro no encontrado.", requestId);
      return jsonResponse(404, { error: err.error, requestId }, origin);
    }

    // Determine activation link preview
    const studioBase = getStudioBaseUrl();
    const latestToken = await db.getLatestActivationTokenForMember(member.id);
    const previewToken = latestToken?.token_public_id
      ? `gai_act_${latestToken.token_public_id}.preview_token`
      : "gai_act_sample001.preview_token";

    const activationLink = `${studioBase}/?activate=${previewToken}`;
    const invitationExpiresAt = latestToken?.expires_at || new Date(Date.now() + 7 * 86400000).toISOString();

    const rendered = renderGhostAIMemberInvitationEmail({
      name: member.name,
      email: member.email,
      plan: member.access_plan,
      activationLink,
      invitationExpiresAt,
    });

    await db.logAdminAuditEvent({ adminId: auth.admin.id, adminEmail: auth.admin.email, adminRole: auth.admin.role, action: "invite_preview", targetId: member.id });

    return jsonResponse(
      200,
      {
        ok: true,
        preview: {
          to: member.email,
          name: member.name,
          plan: member.access_plan,
          subject: rendered.subject,
          preheader: rendered.preheader,
          html: rendered.html,
          text: rendered.text,
          activationLink,
          invitationExpiresAt,
        },
      },
      origin
    );
  } catch (err) {
    const errPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error generando previsualización de correo.", requestId);
    return jsonResponse(500, { error: errPayload.error, requestId }, origin);
  }
};
