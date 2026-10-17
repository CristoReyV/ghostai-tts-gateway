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
const { authorizeAdmin: requireAdminAuth } = require("./lib/adminAuthorization");
const { renderMemberDeliveryForSend } = require("./lib/memberDelivery");
const { sanitizeOperationalError } = require("./lib/errorCatalog");
const { renderGhostAIMemberInvitationEmail } = require("./lib/emailTemplates");
const { sendEmail, getEmailConfigStatus } = require("./lib/emailService");
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
  const auth = await requireAdminAuth(event, requestId, "member.invitation.send");
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

  targetIds = [...new Set(targetIds.map(id => id.trim()))];
  if (targetIds.length > 100) return jsonResponse(400, { error: { message: "Máximo 100 miembros por envío." } }, origin);
  if (body.previewOnly === true) {
    await db.logAdminAuditEvent({ adminId: auth.admin.id, adminEmail: auth.admin.email, adminRole: auth.admin.role, action: "invite_bulk_preview", metadata: { memberIds: targetIds, count: targetIds.length } });
    return jsonResponse(200, { ok: true, processed: targetIds.length, zeroRealEmailsSent: true }, origin);
  }
  if (!getEmailConfigStatus().isLive && !(process.env.NODE_ENV === "test" && process.env.GHOSTAI_EMAIL_MODE === "provider")) return jsonResponse(409, { error: { code: "MANUAL_EMAIL_MODE", message: "La entrega de la key requiere un proveedor de correo configurado por OWNER." } }, origin);

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

      const rendered = await renderMemberDeliveryForSend(memberId);

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
          error: sanitizeOperationalError(sendResult.error),
        });

        failed.push({
          memberId: member.id,
          email: member.email,
          error: "No se pudo enviar el correo. Contacta al OWNER.",
        });
      }
    } catch (memberErr) {
      failed.push({
        memberId,
        error: "No se pudo preparar la entrega segura. Contacta al OWNER.",
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
