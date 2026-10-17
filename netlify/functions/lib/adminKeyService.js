"use strict";
const crypto = require("crypto");
const db = require("./db");
const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const identity = user => ({ id: user.id, name: user.name, email: user.email, role: user.role });
const digest = secret => crypto.createHash("sha256").update(secret).digest("hex");

async function manageAdminKey({ action, adminId, name, requestingAdmin }) {
  if (requestingAdmin?.role !== "owner") throw failure(403, "Solo OWNER puede gestionar admin keys.");
  if (!["create", "rotate", "revoke"].includes(action)) throw failure(400, "Acción inválida.");
  let user;
  if (action === "create") {
    if (typeof name !== "string" || !name.trim()) throw failure(400, "Nombre requerido.");
    if ((await db.listAdminUsers()).some(u => u.name === name.trim() && u.role === "operator")) throw failure(409, "El operador ya existe. Rota su key desde su cuenta.");
    user = await db.createAdminUserRecord({ name: name.trim(), email: null, role: "operator", status: "active" });
  } else {
    user = await db.getAdminUserById(adminId);
    if (!user || user.role !== "operator") throw failure(400, "Selecciona un OPERATOR válido.");
    if (action === "rotate" && user.status !== "active") throw failure(400, "Activa el operador antes de rotar su key.");
    await db.revokeAdminKeys(user.id);
  }
  let rawKey;
  if (action !== "revoke") {
    const publicId = crypto.randomBytes(12).toString("hex");
    const secret = crypto.randomBytes(32).toString("hex");
    await db.createAdminKey({ public_id: publicId, secret_hash: digest(secret), admin_user_id: user.id, role: "operator", status: "active", created_at: new Date().toISOString(), last_used_at: null });
    rawKey = `gai_admin_${publicId}.${secret}`;
  }
  await db.logAdminAuditEvent({ adminId: requestingAdmin.id, adminEmail: requestingAdmin.email, adminRole: requestingAdmin.role, action: `admin_key_${action}`, targetId: user.id });
  return { admin: identity(user), ...(rawKey ? { key: rawKey } : {}) };
}

async function loginAdminWithKey(rawKey) {
  const match = typeof rawKey === "string" && /^gai_admin_([a-f0-9]{24})\.([a-f0-9]{64})$/.exec(rawKey.trim());
  const invalid = () => failure(401, "Admin key inválida o revocada.");
  if (!match) throw invalid();
  const key = await db.getAdminKey(match[1]);
  if (!key || key.status !== "active" || key.role !== "operator") throw invalid();
  const expected = Buffer.from(key.secret_hash, "hex");
  const actual = Buffer.from(digest(match[2]), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw invalid();
  const user = await db.getAdminUserById(key.admin_user_id);
  if (!user || user.status !== "active" || user.role !== "operator") throw invalid();
  const now = new Date().toISOString();
  await db.updateAdminKey(key.public_id, { last_used_at: now });
  await db.updateAdminUser(user.id, { last_login_at: now });
  await db.logAdminAuditEvent({ adminId: user.id, adminEmail: user.email, adminRole: user.role, action: "admin_key_login", targetId: user.id });
  return { ...identity(user), keyId: key.public_id, session_version: user.session_version || 0 };
}

module.exports = { manageAdminKey, loginAdminWithKey };
