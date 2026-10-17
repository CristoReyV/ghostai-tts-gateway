"use strict";
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { authorizeAdmin } = require("./lib/adminAuthorization");
const { issueActivationToken, safeDecryptKey, buildActivationLink } = require("./lib/memberService");
const { renderGhostAIMemberInvitationEmail } = require("./lib/emailTemplates");
const db = require("./lib/db");
exports.handler = async event => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);
  const reply = (statusCode, body) => ({ statusCode, headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  const auth = await authorizeAdmin(event, "", "member.invitation.preview");
  if (!auth.ok) return reply(auth.statusCode, { error: auth.error });
  if (event.httpMethod !== "POST") return reply(405, { error: { message: "Solo POST." } });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (_) { return reply(400, { error: { message: "JSON inválido." } }); }
  if (typeof body.memberId !== "string") return reply(400, { error: { message: "Miembro requerido." } });
  try {
    const member = await db.getMemberById(body.memberId);
    if (!member) return reply(404, { error: { message: "Miembro no encontrado." } });
    if (!["pending", "invited"].includes(member.status)) return reply(409, { error: { message: "Solo se preparan invitaciones para accesos pendientes de activación." } });
    const latest = await db.getLatestActivationTokenForMember(member.id);
    const saved = latest?.status === "active" && Date.parse(latest.expires_at) > Date.now() && latest.encrypted_invitation_token ? safeDecryptKey(latest.encrypted_invitation_token) : null;
    const invitation = saved ? { activationLink: buildActivationLink(saved), expiresAt: latest.expires_at } : await issueActivationToken(member.id);
    const rendered = renderGhostAIMemberInvitationEmail({ name: member.name, email: member.email, plan: member.access_plan, activationLink: invitation.activationLink, invitationExpiresAt: invitation.expiresAt });
    await db.logAdminAuditEvent({ adminId: auth.admin.id, adminEmail: auth.admin.email, adminRole: auth.admin.role, action: "invite_manual_prepared", targetId: member.id });
    return reply(200, { ok: true, zeroRealEmailsSent: true, preview: { ...rendered, to: member.email, name: member.name, plan: member.access_plan, activationLink: invitation.activationLink, invitationExpiresAt: invitation.expiresAt } });
  } catch (_) { return reply(500, { error: { message: "No se pudo preparar la invitación." } }); }
};
