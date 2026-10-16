/**
 * @file netlify/functions/admin-members-send-invitation.js
 * POST /api/admin/members/send-invitation
 *
 * Dispatches personalized HTML invitation emails to members.
 * Supports single and bulk sending with:
 *  - Per-member isolated processing (batch safety: no full rollback on single failure)
 *  - Real-time audit attribution (sentByAdminId)
 *  - Member email status tracking (NO ENVIADA, ENVIADA, ERROR)
 *  - Zero secret exposure
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireAdminAuth } = require("./lib/adminAuth");
const { inviteMember } = require("./lib/memberService");
const { renderGhostAIMemberInvitationEmail } = require("./lib/emailTemplates");
const { sendEmail } = require("./lib/emailService");
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
  const auth = requireAdminAuth(event, requestId);
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

  let targetIds = [];
  if (Array.isArray(body.memberIds)) {
    targetIds = body.memberIds.filter((id) => typeof id === "string" && id.trim());
  } else if (body.memberId && typeof body.memberId === "string" && body.memberId.trim()) {
    targetIds = [body.memberId.trim()];
  }

  if (targetIds.length === 0) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Se requiere 'memberId' o 'memberIds'.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const succeeded = [];
  const failed = [];

  for (const memberId of targetIds) {
    try {
      const member = await db.getMemberById(memberId);
      if (!member) {
        failed.push({
          memberId,
          error: "Miembro no encontrado.",
        });
        continue;
      }

      // Generate or refresh activation token
      const invitation = await inviteMember(memberId);

      // Render the HTML & text email
      const rendered = renderGhostAIMemberInvitationEmail({
        name: member.name,
        email: member.email,
        plan: member.access_plan,
        activationLink: invitation.activationLink,
        invitationExpiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      });

      // Dispatch email
      const sendResult = await sendEmail({
        to: member.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      const now = new Date().toISOString();

      if (sendResult.ok) {
        // Record success in member record
        await db.updateMemberEmailStatus(member.id, {
          status: "sent",
          sentAt: now,
          sentBy: auth.admin.id !== "system_owner" ? auth.admin.id : null,
          error: null,
        });

        // Audit log with admin attribution
        await db.logAdminAuditEvent({
          adminId: auth.admin.id,
          adminEmail: auth.admin.email,
          adminRole: auth.admin.role,
          action: "invite_sent",
          targetId: member.id,
          metadata: {
            memberEmail: member.email,
            plan: member.access_plan,
            messageId: sendResult.messageId,
            simulated: sendResult.simulated,
          },
        });

        succeeded.push({
          memberId: member.id,
          email: member.email,
          messageId: sendResult.messageId,
          simulated: sendResult.simulated,
        });
      } else {
        // Record failure in member record
        await db.updateMemberEmailStatus(member.id, {
          status: "failed",
          sentAt: now,
          sentBy: auth.admin.id !== "system_owner" ? auth.admin.id : null,
          error: sendResult.error,
        });

        failed.push({
          memberId: member.id,
          email: member.email,
          error: sendResult.error || "Error enviando correo.",
        });
      }
    } catch (memberErr) {
      failed.push({
        memberId,
        error: memberErr.message || "Error procesando invitación.",
      });
    }
  }

  return jsonResponse(
    200,
    {
      ok: true,
      processed: targetIds.length,
      succeededCount: succeeded.length,
      failedCount: failed.length,
      succeeded,
      failed,
    },
    origin
  );
};
