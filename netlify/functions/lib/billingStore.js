"use strict";
const crypto = require("crypto");
const db = require("./db");
let memory = { profiles: [], transactions: [], goals: [], sync: null };
let queue = Promise.resolve();
const copy = x => JSON.parse(JSON.stringify(x));
function reset() { memory = { profiles: [], transactions: [], goals: [], sync: null }; queue = Promise.resolve(); }
async function all(table) {
  const result = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const { data, error } = await db.getSupabaseClient().from(table).select("*").order(table === "ghostai_revenue_goals" ? "month" : table === "ghostai_member_billing" ? "member_id" : "id").range(offset, offset + 999);
    if (error) throw new Error("BILLING_STORAGE_UNAVAILABLE");
    result.push(...data); if (data.length < 1000) return result;
  }
  throw new Error("BILLING_DATA_LIMIT_REACHED");
}
async function read() {
  if (db.isMemoryMode()) return copy(memory);
  const [profiles, transactions, goals, syncRows] = await Promise.all([all("ghostai_member_billing"), all("ghostai_billing_transactions"), all("ghostai_revenue_goals"), all("ghostai_billing_sync")]);
  return { profiles, transactions, goals, sync: syncRows.sort((a, b) => b.synced_at.localeCompare(a.synced_at))[0] || null };
}
async function memoryWrite(action, p, actor) {
  const now = new Date().toISOString();
  const audit = (name, target, metadata = {}) => db.logAdminAuditEvent({ adminId: actor.id, adminEmail: actor.email, adminRole: actor.role, action: name, targetId: target, metadata });
  const conflict = () => { throw Object.assign(new Error("BILLING_CONFLICT"), { statusCode: 409 }); };
  const entry = r => ({ id: crypto.randomUUID(), ...r, created_at: now, created_by: actor.id });
  if (action === "sync") {
    let created = 0, updated = 0;
    for (const row of p.records) {
      let profile = memory.profiles.find(r => r.member_id === row.member_id);
      if (!profile) { profile = { member_id: row.member_id, revision: 0 }; memory.profiles.push(profile); }
      if (profile.source_hash !== row.source_hash) {
        if (profile.revision) await audit("billing_amount_corrected", row.member_id, { source: "GOOGLE_SHEET", previousAmount: profile.amount_minor, amount: row.amount_minor });
        Object.assign(profile, { amount_minor: row.amount_minor, currency: row.currency, source: "GOOGLE_SHEET", source_hash: row.source_hash, revision: profile.revision + 1, updated_at: now }); updated++;
      }
      if (!memory.transactions.some(t => t.entry_key === row.source_key)) { memory.transactions.push(entry({ ...row, entry_key: row.source_key, revision: 1, type: "NEW_ACCESS", reason: "Importación de hoja actual" })); created++; }
    }
    memory.sync = { id: p.metadata.sourceId, synced_at: now, metadata: p.metadata };
    await audit("billing_sheet_synced", null, { created, updated, matched: p.records.length });
    return { created, updated };
  }
  if (action === "goal") {
    let goal = memory.goals.find(g => g.month === p.month && g.currency === p.currency);
    if ((goal?.revision || 0) !== p.expectedRevision) conflict();
    const existing = !!goal;
    if (!goal) { goal = { month: p.month, currency: p.currency, revision: 0 }; memory.goals.push(goal); }
    Object.assign(goal, { target_minor: p.targetMinor, revision: goal.revision + 1, updated_at: now });
    await audit(existing ? "revenue_goal_updated" : "revenue_goal_created", null, { month: p.month, currency: p.currency, amount: p.targetMinor });
    return { changed: true };
  }
  if (action === "price") {
    let profile = memory.profiles.find(r => r.member_id === p.memberId);
    if ((profile?.revision || 0) !== p.expectedRevision) conflict();
    if (!profile) { profile = { member_id: p.memberId, revision: 0 }; memory.profiles.push(profile); }
    Object.assign(profile, { amount_minor: p.amountMinor, currency: p.currency, source: "OWNER", revision: profile.revision + 1, updated_at: now });
    await audit("billing_amount_corrected", p.memberId, { amount: p.amountMinor, currency: p.currency, reason: p.reason });
    return { changed: true };
  }
  if (action === "payment") {
    const key = p.entryId ? memory.transactions.find(t => t.id === p.entryId)?.entry_key : `OWNER:${p.memberId}:${p.period}:${p.type}`;
    const latest = memory.transactions.filter(t => t.entry_key === key).sort((a, b) => b.revision - a.revision)[0];
    if (p.entryId && latest?.id !== p.entryId) conflict();
    if (!p.entryId && latest) return { changed: false };
    memory.transactions.push(entry({ member_id: p.memberId, access_plan: p.plan, entry_key: key, revision: (latest?.revision || 0) + 1, type: latest ? "ADJUSTMENT" : p.type, amount_minor: p.amountMinor, currency: p.currency, status: p.status, paid_at: p.paidAt, billing_period: p.period, source: "OWNER", reason: p.reason }));
    if (latest && (latest.amount_minor !== p.amountMinor || latest.currency !== p.currency)) await audit("billing_amount_corrected", p.memberId, { entryId: p.entryId, reason: p.reason });
    await audit("payment_status_changed", p.memberId, { status: p.status, reason: p.reason });
    return { changed: true };
  }
  throw new Error("INVALID_BILLING_ACTION");
}
async function write(action, payload, admin) {
  const actor = { ...admin, id: ["system_owner", "00000000-0000-0000-0000-000000000000"].includes(admin.id) ? null : admin.id };
  if (actor.role !== "owner") throw Object.assign(new Error("FORBIDDEN"), { statusCode: 403 });
  if (db.isMemoryMode()) { const result = queue.then(() => memoryWrite(action, payload, actor)); queue = result.catch(() => {}); return result; }
  const { data, error } = await db.getSupabaseClient().rpc("ghostai_billing_write", { p_action: action, p_payload: payload, p_actor: actor });
  if (error) throw Object.assign(new Error(error.message.includes("BILLING_CONFLICT") ? "BILLING_CONFLICT" : "BILLING_WRITE_FAILED"), { statusCode: error.message.includes("BILLING_CONFLICT") ? 409 : 500 });
  return data;
}
module.exports = { read, write, _reset: reset };
