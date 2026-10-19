"use strict";
const crypto = require("crypto");
const { authorizeAdmin } = require("./lib/adminAuthorization");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const db = require("./lib/db");
const store = require("./lib/billingStore");
const core = require("./lib/billingCore");
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const money = v => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= 100000000000);
exports.handler = async event => {
  const origin = event.headers?.origin || event.headers?.Origin;
  const respond = (statusCode, body) => ({ statusCode, headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);
  if (!["GET", "POST"].includes(event.httpMethod)) return respond(405, { error: { message: "Método no permitido." } });
  const auth = await authorizeAdmin(event, crypto.randomUUID(), event.httpMethod === "GET" ? "billing.read" : "billing.write");
  if (!auth.ok) return respond(auth.statusCode, { error: auth.error });
  if (!["owner", "operator"].includes(auth.admin.role)) return respond(403, { error: { message: "Acceso no autorizado." } });
  try {
    const members = await db.listMembers();
    if (event.httpMethod === "GET") return respond(200, { ok: true, dashboard: core.dashboard(await store.read(), members, event.queryStringParameters || {}) });
    let body; try { body = JSON.parse(event.body || "{}"); } catch { fail("JSON inválido."); }
    const { action } = body; let payload;
    if (action === "sync") {
      const sheetId = process.env.GHOSTAI_BILLING_SHEET_ID;
      if (!sheetId || !/^[\w-]+$/.test(sheetId)) throw Object.assign(new Error("Configura la fuente Google Sheet en el servidor."), { statusCode: 503 });
      const response = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok || !response.headers.get("content-type")?.includes("csv")) throw new Error("SHEET_UNAVAILABLE");
      const csv = await response.text(); if (csv.length > 500000) fail("La hoja excede el límite de sincronización.");
      const reconciled = core.reconcileSheet(core.parseCsv(csv), members, sheetId);
      if (!reconciled.records.length) fail("No hay miembros conciliados; no se modificó facturación.");
      payload = reconciled;
    } else if (action === "goal") {
      if (!core.validMonth(body.month) || !/^(USD|MXN)$/.test(body.currency) || !money(body.targetMinor) || !body.targetMinor || !Number.isInteger(body.expectedRevision)) fail("Meta, mes, moneda o revisión inválidos.");
      payload = { month: body.month, currency: body.currency, targetMinor: body.targetMinor, expectedRevision: body.expectedRevision };
    } else if (["price", "payment"].includes(action)) {
      const member = members.find(m => m.id === body.memberId); if (!member) fail("Miembro inválido.");
      if (!money(body.amountMinor) || !/^(USD|MXN)$/.test(body.currency) || typeof body.reason !== "string" || body.reason.trim().length < 3 || body.reason.length > 300) fail("Monto, moneda o motivo inválidos.");
      if (action === "price") {
        if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) fail("Revisión inválida.");
        payload = { memberId: member.id, amountMinor: body.amountMinor, currency: body.currency, reason: body.reason.trim(), expectedRevision: body.expectedRevision };
      } else {
        if (!["paid", "pending", "unknown"].includes(body.status) || !core.validMonth(body.period) || !["NEW_ACCESS", "RENEWAL"].includes(body.type)) fail("Periodo, tipo o estado de pago inválidos.");
        if (body.status === "paid" && (!core.validDate(body.paidAt) || body.amountMinor === null)) fail("Un pago confirmado requiere monto y fecha real.");
        const original = body.entryId ? (await store.read()).transactions.find(t => t.id === body.entryId && t.member_id === member.id) : null;
        if (body.entryId && !original) fail("Movimiento inválido.");
        payload = { memberId: member.id, plan: original?.access_plan || member.access_plan, amountMinor: body.amountMinor, currency: body.currency, reason: body.reason.trim(), entryId: body.entryId || null, status: body.status, period: body.period, type: body.type, paidAt: body.status === "paid" ? body.paidAt : null };
      }
    } else fail("Acción inválida.");
    const result = await store.write(action, payload, auth.admin);
    return respond(200, { ok: true, ...result, ...(action === "sync" ? { reconciliation: payload.metadata } : {}) });
  } catch (error) {
    return respond(error.statusCode || (/INVALID_MONTH|INVALID_CURRENCY/.test(error.message) ? 400 : 500), { error: { message: error.statusCode === 400 || error.statusCode === 503 ? error.message : error.statusCode === 409 ? "Los datos cambiaron. Actualiza antes de guardar." : "No se pudo completar facturación. Actualiza o revisa la fuente." } });
  }
};
