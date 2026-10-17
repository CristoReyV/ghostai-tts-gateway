"use strict";
const db = require("./db");
const { safeDecryptKey, issueActivationToken, buildActivationLink, getStudioBaseUrl } = require("./memberService");
const { parseToken, verifySecret } = require("./tokenService");
const { renderGhostAIMemberInvitationEmail } = require("./emailTemplates");
const failure = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 });

// Build delivery metadata using encrypted escrow. No plaintext is persisted.
async function prepareDeliveryContext(memberId) {
  const member = await db.getMemberById(memberId);
  if (!member) throw Object.assign(new Error("Miembro no encontrado."), { statusCode: 404 });
  if (!["pending", "invited", "active"].includes(member.status)) throw failure("MEMBER_NOT_DELIVERABLE", "Este acceso no permite preparar un correo.");
  let escrow = await db.getLatestActivationTokenForMember(member.id);
  if (!escrow?.encrypted_key) throw failure("DELIVERY_KEY_UNAVAILABLE", "La key no está disponible para entrega segura. Solicita recuperación al OWNER.");
  const deliveryType = member.status === "active" ? "ACCESS_REPLACEMENT" : "INVITATION";
  let activationLink = getStudioBaseUrl();
  if (deliveryType === "INVITATION") {
    const token = escrow.status === "active" && Date.parse(escrow.expires_at) > Date.now() && escrow.encrypted_invitation_token ? safeDecryptKey(escrow.encrypted_invitation_token) : null;
    if (token) activationLink = buildActivationLink(token);
    else {
      const invitation = await issueActivationToken(member.id);
      activationLink = invitation.activationLink;
      escrow = await db.getLatestActivationTokenForMember(member.id);
    }
  }
  const rendered = renderGhostAIMemberInvitationEmail({ name: member.name, email: member.email, plan: member.access_plan, activationLink, invitationExpiresAt: escrow.expires_at, deliveryType });
  return { ...rendered, to: member.email, name: member.name, plan: member.access_plan, activationLink, invitationExpiresAt: escrow.expires_at, deliveryType, keyRedacted: true, deliveryReady: true, requiresServerDelivery: true };
}

// Render only for server delivery or authenticated preview explicitly authorized by OWNER.
async function renderMemberDeliveryForSend(memberId) {
  const preview = await prepareDeliveryContext(memberId);
  const member = await db.getMemberById(memberId);
  const escrow = await db.getLatestActivationTokenForMember(memberId);
  const key = escrow?.encrypted_key ? safeDecryptKey(escrow.encrypted_key) : null;
  const parsed = key ? parseToken(key) : { valid: false };
  const record = parsed.valid ? await db.getTokenByPublicId(parsed.publicId) : null;
  if (!record || record.id !== member.key_id || record.status !== "active" || !verifySecret(parsed.secret, record.secret_hash)) throw failure("DELIVERY_KEY_UNAVAILABLE", "La key no está disponible para entrega segura. Solicita recuperación al OWNER.");
  return { to: member.email, ...renderGhostAIMemberInvitationEmail({ name: member.name, email: member.email, plan: member.access_plan, activationLink: preview.activationLink, invitationExpiresAt: preview.invitationExpiresAt, deliveryType: preview.deliveryType, accessKey: key }) };
}
async function prepareMemberDelivery(memberId) {
 const preview = await prepareDeliveryContext(memberId);
 const rendered = await renderMemberDeliveryForSend(memberId);
 return { ...preview, ...rendered, keyRedacted: false, requiresServerDelivery: false };
}
module.exports = { prepareMemberDelivery, renderMemberDeliveryForSend };
