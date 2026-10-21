"use strict";
const db = require("./db");
const store = require("./personalKeyStore");
const { encryptCredential, decryptCredential } = require("./credentialCrypto");
const { parseToken, verifySecret } = require("./tokenService");
const fail = (statusCode = 404) => Object.assign(new Error("Acceso personal no disponible."), { statusCode });
const PURPOSE = "ghostai-personal-key:v1";
async function validate(token, expected = null, requireActive = true) {
  const parsed = parseToken(token);
  const record = parsed.valid ? await db.getTokenByPublicId(parsed.publicId) : null;
  if (!record || !verifySecret(parsed.secret, record.secret_hash)) throw fail();
  const client = await db.getClientById(record.client_id);
  if (!client || client.email || await db.getMemberByClientId(client.id) || record.expires_at !== null) throw fail();
  if (expected && (expected.keyId !== record.id || expected.clientId !== client.id)) throw fail();
  if (requireActive && (client.status !== "active" || record.status !== "active")) throw fail(409);
  return { record, client };
}
async function load(adminId, keyId, requireActive) {
  if (!store.UUID.test(adminId) || !store.UUID.test(keyId)) throw fail();
  const ciphertext = await store.get(adminId, keyId);
  const plaintext = ciphertext ? decryptCredential(ciphertext) : null;
  let payload;
  try { payload = JSON.parse(plaintext); } catch (_) { throw fail(); }
  if (!payload || payload.purpose !== PURPOSE || payload.adminId !== adminId || payload.keyId !== keyId) throw fail();
  const validated = await validate(payload.token, payload, requireActive);
  return { ...validated, token: payload.token };
}
async function grant({ adminId, token, actor }) {
  if (actor.role !== "owner") throw fail(403);
  if (!store.UUID.test(adminId)) throw fail(400);
  const user = await db.getAdminUserById(adminId);
  if (!user || user.role !== "operator" || user.status !== "active") throw fail(400);
  const { record, client } = await validate(token);
  const ciphertext = encryptCredential(JSON.stringify({ purpose: PURPOSE, adminId, keyId: record.id, clientId: client.id, token }));
  await store.put(adminId, record.id, ciphertext);
  await audit(actor, "personal_key_assigned", record.id, { assignedAdminId: adminId, clientId: client.id });
  return { id: record.id, label: record.label, clientName: client.name };
}
async function audit(actor, action, keyId, metadata = {}) {
  await db.logAdminAuditEvent({ adminId: store.UUID.test(actor.id) && actor.id !== "00000000-0000-0000-0000-000000000000" ? actor.id : null,
    adminEmail: actor.email || "owner@ghostai.internal", adminRole: actor.role, action, targetId: keyId, metadata });
}
async function list(adminId) {
  const ids = await store.list(adminId);
  const keys = await Promise.all(ids.map(async id => {
    const { record, client } = await load(adminId, id, false);
    return { id, label: record.label, clientName: client.name, status: record.status, expiresAt: record.expires_at,
      canReveal: client.status === "active" && record.status === "active" };
  }));
  return keys.sort((a, b) => (a.label || "").localeCompare(b.label || ""));
}
async function reveal(actor, keyId) {
  const { token } = await load(actor.id, keyId, true);
  await audit(actor, "personal_key_revealed", keyId);
  return token;
}
module.exports = { grant, list, reveal };
