"use strict";
const db = require("./db");
const { parseCsv, digest } = require("./billingCore");
const { acquireLease } = require("./sheetSyncLease");
const { createMemberWithAccess, revokeMemberAccess } = require("./memberService");
const store = require("./skoolStore");
const normalize = value => String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
const email = value => String(value || "").trim().toLowerCase();
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const BATCH_SIZE = 8;
function config() {
  const sourceId = process.env.GHOSTAI_SKOOL_SHEET_ID, gid = process.env.GHOSTAI_SKOOL_SHEET_GID || "0";
  if (!sourceId || !/^[\w-]+$/.test(sourceId) || !/^\d+$/.test(gid)) throw fail("Configura la hoja SKOOL en el servidor.", 503);
  return { sourceId, gid };
}
async function source() {
  const settings = config();
  try {
    const response = await fetch(`https://docs.google.com/spreadsheets/d/${settings.sourceId}/export?format=csv&gid=${settings.gid}`, { signal: AbortSignal.timeout(12000), headers: { "Cache-Control": "no-cache" } });
    if (!response.ok || !response.headers.get("content-type")?.includes("csv")) throw new Error();
    const csv = await response.text();
    if (csv.length > 500000) throw new Error();
    return { ...settings, rows: parseCsv(csv) };
  } catch (_) { throw fail("No se pudo leer la hoja SKOOL. No se aplicaron altas ni bajas.", 503); }
}
function expiry(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) { const local = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (local) match = [text, local[3], local[2].padStart(2, "0"), local[1].padStart(2, "0")]; }
  if (match) {
    const day = `${match[1]}-${match[2]}-${match[3]}`;
    if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw fail("Fecha de vencimiento inválida.");
    return new Date(`${day}T23:59:59.999-06:00`).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) throw fail("Fecha de vencimiento inválida.");
  if (new Date(`${text.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== text.slice(0, 10)) throw fail("Fecha de vencimiento inválida.");
  return new Date(text).toISOString();
}
function plan(input, members) {
  const headers = (input.rows[0] || []).map(normalize);
  const nameCol = headers.findIndex(h => /^(nombre|nombre completo|name|full name)$/.test(h));
  const emailCol = headers.findIndex(h => /^(correo|correo electronico|email|e-mail)$/.test(h));
  const expiryCol = headers.findIndex(h => /^(vence|vencimiento|fecha de vencimiento|expira|expires|expiresat|expires_at|expiration date)$/.test(h));
  const statusCol = headers.findIndex(h => /^(estado|status|estado de membresia)$/.test(h));
  if (nameCol < 0 || emailCol < 0) throw fail("La hoja SKOOL necesita columnas de nombre y correo.");
  const rows = input.rows.slice(1).map((r, i) => ({ row: i + 2, sourceName: String(r[nameCol] || "").trim(), email: email(r[emailCol]), rawExpiry: expiryCol < 0 ? "" : r[expiryCol], rawStatus: statusCol < 0 ? "" : normalize(r[statusCol]) })).filter(r => r.sourceName || r.email);
  const emails = new Map(); for (const row of rows) emails.set(row.email, (emails.get(row.email) || 0) + 1);
  const names = new Set(members.map(m => normalize(m.name)));
  const details = [], operations = [];
  const counts = { newMembers: 0, existing: 0, removed: 0, rejoined: 0, expiryChanges: 0, invalid: 0, inactiveRows: 0 };
  const listed = new Set();
  for (const row of rows) {
    const matches = members.filter(m => email(m.email) === row.email);
    let reason = !row.sourceName ? "Nombre ausente" : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) ? "Correo inválido" : emails.get(row.email) > 1 ? "Correo duplicado en la hoja" : matches.length > 1 ? "Correo duplicado en producción" : null;
    let expiresAt = null;
    try { expiresAt = expiry(row.rawExpiry); } catch (_) { reason = "Fecha de vencimiento inválida"; }
    const activeStatus = !row.rawStatus || /^(active|activo|vigente|paid|pagado)$/.test(row.rawStatus);
    const inactiveStatus = /^(removed|baja|cancelado|cancelada|expired|vencido|vencida|inactive|inactivo)$/.test(row.rawStatus);
    if (!activeStatus && !inactiveStatus) reason = "Estado SKOOL no reconocido";
    const member = matches[0] || null;
    if (reason) { counts.invalid++; details.push({ row: row.row, name: row.sourceName, classification: "INVALID", reason }); continue; }
    const current = activeStatus && (!expiresAt || Date.parse(expiresAt) > Date.now());
    if (!current) {
      counts.inactiveRows++;
      const expired = !!expiresAt && Date.parse(expiresAt) <= Date.now() || /^(expired|vencido|vencida)$/.test(row.rawStatus);
      details.push({ row: row.row, name: row.sourceName, classification: "INACTIVE_ROW", reason: expired ? "Vencido en la hoja" : "Baja indicada en la hoja" });
      if (expired) listed.add(row.email);
      if (member && member.access_plan !== "skool" && !member.revoked_at && member.status !== "revoked") operations.push({ type: "remove", member, expiresAt });
      if (member?.access_plan === "skool" && member.skool_source_id === input.sourceId && !member.revoked_at) {
        if (expired) {
          const effectiveExpiry = expiresAt || member.skool_expires_at || new Date().toISOString();
          if (member.skool_removed_at || member.skool_expires_at !== effectiveExpiry) { operations.push({ type: "update", member, expiresAt: effectiveExpiry }); counts.expiryChanges++; }
        } else if (!member.skool_removed_at) operations.push({ type: "remove", member, expiresAt });
      }
      continue;
    }
    listed.add(row.email);
    if (!member) {
      let name = row.sourceName, suffix = 2; while (names.has(normalize(name))) name = `${row.sourceName} - ${suffix++}`;
      names.add(normalize(name)); counts.newMembers++;
      operations.push({ type: "create", row: row.row, name, email: row.email, expiresAt });
      details.push({ row: row.row, name, classification: "NEW", reason: name !== row.sourceName ? "Cuenta separada con otro correo; se conserva la anterior" : null });
    } else {
      counts.existing++;
      if (member.revoked_at) { details.push({ row: row.row, name: member.name, classification: "NEEDS_OWNER_REVIEW", reason: "Cuenta revocada: requiere revisión OWNER antes de volver a dar acceso" }); continue; }
      if (member.access_plan !== "skool" || member.skool_source_id !== input.sourceId) continue;
      if (member.skool_removed_at) { counts.rejoined++; details.push({ row: row.row, name: member.name, classification: "REJOINED" }); }
      if ((member.skool_expires_at || null) !== expiresAt) { counts.expiryChanges++; details.push({ row: row.row, name: member.name, classification: "EXPIRY_CHANGED" }); }
      if (member.skool_removed_at || (member.skool_expires_at || null) !== expiresAt) operations.push({ type: "update", member, expiresAt });
    }
  }
  for (const member of members.filter(m => !m.revoked_at && m.status !== "revoked" && !listed.has(email(m.email)))) {
    if (!operations.some(o => o.type === "remove" && o.member.id === member.id)) operations.push({ type: "remove", member, expiresAt: member.skool_expires_at || null });
  }
  for (const operation of operations.filter(o => o.type === "remove")) { counts.removed++; details.push({ row: null, name: operation.member.name, classification: "REMOVED", reason: "Fuera de la lista vigente: se revocan su acceso, key y enlaces, sin importar el plan" }); }
  const sourceFingerprint = digest({ sourceId: input.sourceId, gid: input.gid, rows: input.rows });
  const previewToken = digest({ sourceFingerprint, members: members.map(m => [m.id, email(m.email), m.name, m.access_plan, m.status, m.key_id, m.activated_at, m.expires_at, m.revoked_at, m.skool_removed_at, m.skool_expires_at, m.skool_source_id]).sort((a, b) => a[0].localeCompare(b[0])) });
  return { operations, preview: { sourceId: input.sourceId, rows: rows.length, counts, details, sourceFingerprint, previewToken, canApply: rows.length > 0 && rows.length <= 1000 && counts.invalid === 0 } };
}
async function audit(admin, action, metadata, targetId = null) {
  return db.logAdminAuditEvent({ adminId: admin.id === "system_owner" || admin.id === "00000000-0000-0000-0000-000000000000" ? null : admin.id, adminEmail: admin.email || "owner@ghostai.internal", adminRole: admin.role, action, targetId, metadata });
}
async function preview(admin) {
  if (admin.role !== "owner") throw fail("Acceso no autorizado.", 403);
  const [input, members] = await Promise.all([source(), db.listMembers()]);
  const result = plan(input, members).preview;
  await audit(admin, "skool_sync_previewed", { sourceId: input.sourceId, sourceFingerprint: result.sourceFingerprint, rows: result.rows, ...result.counts });
  return result;
}
async function apply(admin, previewToken) {
  if (admin.role !== "owner") throw fail("Acceso no autorizado.", 403);
  if (typeof previewToken !== "string" || !/^[a-f0-9]{64}$/.test(previewToken)) throw fail("Abre la vista previa SKOOL antes de aplicar.");
  const input = await source();
  const lease = await acquireLease(`skool:${input.sourceId}`);
  try {
    const planned = plan(input, await db.listMembers());
    if (planned.preview.previewToken !== previewToken) throw fail("La hoja o los accesos cambiaron. Abre una nueva vista previa.", 409);
    if (!planned.preview.canApply) throw fail("La hoja contiene errores o está vacía. No se aplicaron altas ni bajas.");
    const creates = planned.operations.filter(o => o.type === "create");
    let created = 0, removed = 0, updated = 0;
    for (const row of creates.slice(0, BATCH_SIZE)) {
      await lease.renew();
      const result = await createMemberWithAccess({ name: row.name, email: row.email, accessPlan: "skool", skoolSourceId: input.sourceId, skoolExpiresAt: row.expiresAt });
      created++;
      await audit(admin, "skool_member_created", { sourceId: input.sourceId, row: row.row, plan: "skool" }, result.member.id);
    }
    if (creates.length > BATCH_SIZE) return { ok: true, created, removed: 0, updated: 0, needsContinuation: true, remaining: creates.length - created, sourceFingerprint: planned.preview.sourceFingerprint };
    const changes = planned.operations.filter(o => o.type !== "create");
    for (const operation of changes.slice(0, BATCH_SIZE - created)) {
      await lease.renew();
      const member = operation.member, now = new Date().toISOString();
      if (operation.type === "remove") {
        await revokeMemberAccess(member.id);
        await db.updateMember(member.id, { skool_removed_at: now, skool_synced_at: now, skool_expires_at: operation.expiresAt });
        removed++;
      } else {
        const expiresAt = member.activated_at ? operation.expiresAt : null;
        await db.updateMember(member.id, { skool_removed_at: null, skool_expires_at: operation.expiresAt, skool_synced_at: now, expires_at: expiresAt });
        if (member.key_id) await db.updateTokenExpiresAt(member.key_id, expiresAt);
        updated++;
      }
      await audit(admin, operation.type === "remove" ? "skool_member_removed" : "skool_membership_updated", { sourceId: input.sourceId, sourceExpiry: operation.expiresAt }, member.id);
    }
    if (changes.length > removed + updated) return { ok: true, created, removed, updated, needsContinuation: true, remaining: changes.length - removed - updated, sourceFingerprint: planned.preview.sourceFingerprint };
    const sync = await store.write(input.sourceId, { sourceId: input.sourceId, gid: input.gid, rows: planned.preview.rows, sourceFingerprint: planned.preview.sourceFingerprint, adminRole: "owner", createdThisBatch: created, removed, updated });
    await audit(admin, "skool_sync_applied", { sourceId: input.sourceId, sourceFingerprint: planned.preview.sourceFingerprint, created, removed, updated });
    return { ok: true, created, removed, updated, needsContinuation: false, sourceFingerprint: planned.preview.sourceFingerprint, sync };
  } finally { await lease.release(); }
}
async function status() { const settings = config(); return { configured: true, sourceId: settings.sourceId, sync: await store.read(settings.sourceId) }; }
module.exports = { source, plan, preview, apply, status, expiry, BATCH_SIZE };
