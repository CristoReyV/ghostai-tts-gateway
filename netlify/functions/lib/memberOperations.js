"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRES_SOON_DAYS = 7;
const ACTIVATION_FOLLOWUP_DAYS = 7;
const time = value => value ? Date.parse(value) : NaN;

function isReissued(member) {
  return /\(Regenerated\)$/.test(member.key?.label || "");
}

function emailCoversCurrentAccess(member) {
  if (member.last_email_status !== "sent" || !Number.isFinite(time(member.last_email_sent_at))) return false;
  if (member.last_email_key_id && member.last_email_key_id !== member.key_id) return false;
  // Older delivery evidence remains usable only if it predates neither the key nor renewal.
  const sentAt = time(member.last_email_sent_at);
  if (time(member.key?.created_at) > sentAt || time(member.last_renewed_at) > sentAt) return false;
  return true;
}

function getMemberEmailType(member) {
  if (isReissued(member) && !emailCoversCurrentAccess(member)) return "ACCESS_REPLACEMENT";
  if (member.last_renewed_at && !emailCoversCurrentAccess(member)) return "RENEWAL";
  if (member.last_email_status === "sent" && member.last_email_sent_at) return "RESEND";
  return member.status === "pending" || member.status === "invited" ? "NEW_ACCESS" : "RESEND";
}

// Single source for operational decisions; never writes the membership state machine.
function getMemberOperationalState(member, now = Date.now()) {
  const result = (status, label, recommendedAction, severity, needsAction) => ({ status, label, recommendedAction, severity, needsAction, emailType: getMemberEmailType(member) });
  if (member.status === "revoked" || member.revoked_at) return result("REVOKED", "REVOCADO", "Sin acción pendiente", "muted", false);
  if (member.status === "expired" || time(member.expires_at) <= now) return result("EXPIRED", "VENCIDO", "Revisar renovación con OWNER", "danger", true);
  if (!member.key_id || (member.key && (member.key.status !== "active" || time(member.key.expires_at) <= now)) || member.client?.status === "suspended" || !["pending", "invited", "active"].includes(member.status)) return result("NEEDS_REVIEW", "REVISAR", "Revisar acceso con OWNER", "danger", true);
  if (isReissued(member) && !emailCoversCurrentAccess(member)) return result("ACCESS_REISSUED_NEEDS_RESEND", "ACCESO REEMITIDO · FALTA REENVIAR", "ENVIAR ACCESO DE REEMPLAZO", "attention", true);
  if (member.last_email_status === "failed") return result("NEEDS_REVIEW", "REVISAR", "Revisar el último intento de correo", "danger", true);
  if (["pending", "invited"].includes(member.status)) {
    if (emailCoversCurrentAccess(member)) {
      const followup = now - time(member.last_email_sent_at) >= ACTIVATION_FOLLOWUP_DAYS * DAY_MS;
      return result("SENT_PENDING_ACTIVATION", "ENVIADO · PENDIENTE DE ACTIVACIÓN", followup ? "Contactar al miembro: lleva 7 días sin activar" : "Esperar activación del miembro", followup ? "attention" : "info", followup);
    }
    return result("READY_TO_SEND", "LISTO PARA ENVIAR", "ENVIAR ACCESO NUEVO", "attention", true);
  }
  if (time(member.expires_at) - now <= EXPIRES_SOON_DAYS * DAY_MS) return result("EXPIRES_SOON", "VENCE PRONTO", "Revisar vencimiento con OWNER", "attention", true);
  if (member.last_renewed_at && !emailCoversCurrentAccess(member)) return result("READY_TO_SEND", "LISTO PARA ENVIAR", "ENVIAR CONFIRMACIÓN DE RENOVACIÓN", "attention", true);
  return result("ACTIVE", "ACTIVO", "Sin acción pendiente", "success", false);
}

module.exports = { getMemberOperationalState, getMemberEmailType, emailCoversCurrentAccess, EXPIRES_SOON_DAYS, ACTIVATION_FOLLOWUP_DAYS };
