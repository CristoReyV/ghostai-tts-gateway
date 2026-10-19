"use strict";
const db = require("./lib/db");
const { authorizeAdmin } = require("./lib/adminAuthorization");
const { getMemberEmailType } = require("./lib/memberOperations");
const { corsHeaders, preflightResponse } = require("./lib/cors");

exports.handler = async event => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);
  const reply = (statusCode, body) => ({ statusCode, headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  const auth = await authorizeAdmin(event, "", "member.email.track");
  if (!auth.ok) return reply(auth.statusCode, { error: auth.error });
  if (event.httpMethod !== "POST") return reply(405, { error: { message: "Solo POST." } });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (_) { return reply(400, { error: { message: "JSON inválido." } }); }
  if (typeof body.memberId !== "string" || typeof body.keyId !== "string" || !["sent", "not_sent"].includes(body.status) || !(body.expectedSentAt === null || (typeof body.expectedSentAt === "string" && Number.isFinite(Date.parse(body.expectedSentAt))))) return reply(400, { error: { message: "Miembro, key actual, estado y versión de envío requeridos." } });
  try {
    const member = await db.getMemberById(body.memberId);
    if (!member) return reply(404, { error: { message: "Miembro no encontrado." } });
    if (body.status === "sent" && !["pending", "invited", "active"].includes(member.status)) return reply(409, { error: { message: "Este acceso requiere revisión antes de registrar correo." } });
    const result = await db.markMemberEmail({ memberId: member.id, keyId: body.keyId, sent: body.status === "sent", expectedSentAt: body.expectedSentAt, emailType: body.status === "not_sent" ? member.last_email_type || getMemberEmailType(member) : getMemberEmailType(member), admin: auth.admin });
    if (result.conflict) return reply(409, { error: { code: result.conflict, message: "El acceso o su envío cambió. Actualiza y prepara el correo de nuevo." } });
    return reply(200, { ok: true, changed: result.changed, member: await db.getMemberById(member.id), zeroRealEmailsSent: true });
  } catch (_) { return reply(500, { error: { message: "No se pudo registrar el estado del correo." } }); }
};
