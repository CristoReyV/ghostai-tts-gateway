"use strict";

const { requireAdminAuth } = require("./adminAuth");
const db = require("./db");
const OPERATOR_CAPABILITIES = new Set([
  "session", "member.read", "member.invitation.preview", "member.invitation.send", "member.invitation.link",
]);
const OWNER_ONLY = new Set(["owner", "member.create_key", "admin.keys"]);

async function authorizeAdmin(event, requestId = "", capability = "admin") {
  const auth = requireAdminAuth(event, requestId);
  if (!auth.ok) return auth;
  const deny = (statusCode = 403) => ({ ok: false, statusCode, error: { code: statusCode === 403 ? "FORBIDDEN" : "AUTH_INVALID", message: "Acceso administrativo no autorizado." }, requestId });
  const admin = auth.admin;
  // Legacy system owner keeps its existing session and master-token compatibility.
  if (!["system_owner", "00000000-0000-0000-0000-000000000000"].includes(admin.id)) {
    try {
      const user = await db.getAdminUserById(admin.id);
      if (!user || user.status !== "active" || user.role !== admin.role || (user.session_version || 0) !== admin.sessionVersion) return deny(401);
      if (admin.keyId) {
        const key = await db.getAdminKey(admin.keyId);
        if (!key || key.status !== "active" || key.admin_user_id !== admin.id || key.role !== admin.role) return deny(401);
      }
    } catch (_) { return deny(401); }
  } else if (admin.role !== "owner") { return deny(401); }
  if (admin.role === "owner") return auth;
  if (OWNER_ONLY.has(capability)) return deny();
  if (admin.role === "operator" && !OPERATOR_CAPABILITIES.has(capability)) return deny();
  return auth;
}

module.exports = { authorizeAdmin };
