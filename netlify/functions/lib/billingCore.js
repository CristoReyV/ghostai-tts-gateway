"use strict";
const crypto = require("crypto");
const normalize = value => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const emailKey = value => String(value ?? "").trim().toLowerCase();
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const monthKey = date => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit" }).format(date).slice(0, 7);
const validMonth = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "");
function validDate(value) { const date = new Date(value + "T12:00:00Z"); return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }
function amountMinor(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  let s = String(value).trim().replace(/(?:USD|MXN|US\$|\$|\s)/gi, "");
  if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+([.,]\d{1,2})?$/.test(s)) s = s.replace(",", ".");
  else return null;
  const parts = s.split(".");
  const result = Number(parts[0]) * 100 + Number((parts[1] || "").padEnd(2, "0"));
  return Number.isSafeInteger(result) && result >= 0 && result <= 100000000000 ? result : null;
}
function parseCsv(text) {
  const rows = []; let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === "," || c === "\n")) { row.push(cell.replace(/\r$/, "")); cell = ""; if (c === "\n") { rows.push(row); row = []; } }
    else cell += c;
  }
  if (quoted) throw new Error("CSV_INVALID");
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows;
}
function sourceDate(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  if (validDate(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  const result = m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
  return validDate(result) ? result : null;
}
function reconcileSheet(rows, members, sourceId) {
  const headerIndex = rows.findIndex(r => r.some(c => /correo|email|e-mail/.test(normalize(c))) && r.some(c => /nombre|name/.test(normalize(c))));
  if (headerIndex < 0) throw new Error("SHEET_HEADERS_NOT_FOUND");
  const headers = rows[headerIndex];
  const find = regex => headers.findIndex(c => regex.test(normalize(c)));
  const cols = { name: find(/^(nombre|name)$/), email: find(/correo|email|e-mail/), plan: find(/tipo de acceso|plan|membresia/), amount: find(/valor|monto|precio|amount|charged|price/), currency: find(/moneda|currency/), status: find(/estado.*pago|payment.*status|^pagado$|^status$|^estado$/), date: find(/fecha.*pago|payment.*date|paid.?at/), period: find(/periodo|period|mes de/)};
  if (cols.amount < 0 || cols.plan < 0) throw new Error("SHEET_FINANCIAL_HEADERS_NOT_FOUND");
  const currencyHint = String(headers[cols.amount]).match(/\b(USD|MXN)\b/i)?.[1]?.toUpperCase() || null;
  const candidates = rows.slice(headerIndex + 1).map((r, i) => ({ r, row: headerIndex + i + 2 })).filter(({ r }) => r.some(c => String(c ?? "").trim()));
  const counts = new Map(); for (const { r } of candidates) { const email = emailKey(r[cols.email]); if (email) counts.set(email, (counts.get(email) || 0) + 1); }
  const records = [], issues = []; let summaryRows = 0;
  for (const { r, row } of candidates) {
    const email = emailKey(r[cols.email]); const name = String(r[cols.name] || "").trim();
    if (!name && !email) { summaryRows++; continue; }
    const matches = members.filter(m => emailKey(m.email) === email);
    const plan = /^(mensual|monthly)$/.test(normalize(r[cols.plan])) ? "monthly" : /^(anual|annual)$/.test(normalize(r[cols.plan])) ? "annual" : null;
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || counts.get(email) > 1 || matches.length !== 1 || !plan || matches[0].access_plan !== plan) {
      issues.push({ row, reason: counts.get(email) > 1 ? "DUPLICATE_EMAIL" : matches.length !== 1 ? "MEMBER_MATCH_REVIEW" : "INVALID_OR_PLAN_MISMATCH" }); continue;
    }
    const amount = amountMinor(r[cols.amount]);
    const currencyText = String(cols.currency < 0 ? currencyHint || "" : r[cols.currency] || "").trim().toUpperCase();
    const currency = /^(USD|MXN)$/.test(currencyText) ? currencyText : null;
    const statusText = normalize(r[cols.status]);
    const status = /^(paid|pagado|cobrado|completado)$/.test(statusText) ? "paid" : /^(pending|pendiente|por cobrar|no pagado)$/.test(statusText) ? "pending" : "unknown";
    const paidAt = sourceDate(r[cols.date]);
    const rawPeriod = String(r[cols.period] || "").trim();
    const period = validMonth(rawPeriod) ? rawPeriod : paidAt?.slice(0, 7) || null;
    const record = { member_id: matches[0].id, access_plan: plan, amount_minor: amount, currency, status, paid_at: status === "paid" ? paidAt : null, billing_period: period, source: "GOOGLE_SHEET", source_key: `SHEET:${sourceId}:${digest(email)}` };
    record.source_hash = digest(record);
    records.push(record);
    if (amount === null || !currency || (r[cols.date] && !paidAt)) issues.push({ row, reason: "FINANCIAL_DATA_REVIEW" });
  }
  return { records, metadata: { sourceId, detectedColumns: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, i < 0 ? null : headers[i]])), rows: candidates.length - summaryRows, matched: records.length, summaryRows, issues, unknownAmounts: records.filter(r => r.amount_minor === null).length, currencies: [...new Set(records.map(r => r.currency).filter(Boolean))] } };
}
function latestTransactions(transactions) {
  const entries = new Map(); for (const t of transactions) if (!entries.has(t.entry_key) || entries.get(t.entry_key).revision < t.revision) entries.set(t.entry_key, t);
  return [...entries.values()];
}
function dashboard(state, members, options = {}, now = new Date()) {
  const month = options.month || monthKey(now); if (!validMonth(month)) throw new Error("INVALID_MONTH");
  const transactions = latestTransactions(state.transactions);
  const currencies = [...new Set([...state.profiles, ...transactions, ...state.goals].map(r => r.currency).filter(Boolean))].sort();
  const currency = options.currency || currencies[0] || "USD";
  if (!/^(USD|MXN)$/.test(currency)) throw new Error("INVALID_CURRENCY");
  const validMoney = r => Number.isSafeInteger(Number(r.amount_minor)) && r.amount_minor !== null && r.currency === currency;
  const amount = r => Number(r.amount_minor);
  const sum = list => list.filter(validMoney).reduce((a, r) => a + amount(r), 0);
  const collected = m => transactions.filter(t => t.status === "paid" && t.paid_at?.slice(0, 7) === m && validMoney(t));
  const registered = m => transactions.filter(t => t.status === "unknown" && t.billing_period === m && validMoney(t));
  const previous = new Date(month + "-01T12:00:00Z"); previous.setUTCMonth(previous.getUTCMonth() - 1);
  const previousMonth = previous.toISOString().slice(0, 7);
  const paid = collected(month), revenue = sum(paid), prevRevenue = sum(collected(previousMonth));
  const profiles = members.map(m => {
    const profile = state.profiles.find(p => p.member_id === m.id);
    const chronology = t => `${t.billing_period || t.paid_at?.slice(0, 7) || ""}|${t.paid_at || ""}`;
    const history = transactions.filter(t => t.member_id === m.id).sort((a, b) => chronology(b).localeCompare(chronology(a)) || b.created_at.localeCompare(a.created_at) || b.revision - a.revision);
    const entry = history[0] || null;
    return { memberId: m.id, name: m.name, email: m.email, plan: m.access_plan, memberStatus: m.status, expiresAt: m.expires_at, amountMinor: profile?.amount_minor ?? null, currency: profile?.currency || null, revision: profile?.revision || 0, paymentStatus: entry?.status || "unknown", paidAt: entry?.paid_at || null, period: entry?.billing_period || null, entry, source: profile?.source || null };
  });
  const confirmed = profiles.filter(p => p.memberStatus === "active" && transactions.some(t => t.member_id === p.memberId && t.status === "paid" && validMoney(t)));
  const recurring = confirmed.filter(p => p.plan === "monthly" && p.currency === currency && p.amountMinor !== null);
  const goal = state.goals.find(g => g.month === month && g.currency === currency) || null;
  const target = goal ? Number(goal.target_minor) : null;
  const trend = Array.from({ length: 6 }, (_, i) => { const date = new Date(month + "-01T12:00:00Z"); date.setUTCMonth(date.getUTCMonth() - 5 + i); const key = date.toISOString().slice(0, 7); return { month: key, collected: sum(collected(key)), registered: sum(registered(key)) }; });
  const renewals = profiles.filter(p => p.memberStatus === "active" && p.expiresAt && Date.parse(p.expiresAt) > now.getTime() && Date.parse(p.expiresAt) <= now.getTime() + 30 * 86400000).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)).map(p => ({ ...p, days: Math.ceil((Date.parse(p.expiresAt) - now.getTime()) / 86400000) }));
  const firstPaid = new Map(); for (const t of transactions.filter(t => t.status === "paid" && t.paid_at && validMoney(t))) if (!firstPaid.has(t.member_id) || t.paid_at < firstPaid.get(t.member_id)) firstPaid.set(t.member_id, t.paid_at);
  return { month, previousMonth, currency, currencies, members: profiles, transactions, sync: state.sync,
    summary: { collected: revenue, registered: sum(registered(month)), previousCollected: prevRevenue, differencePercent: prevRevenue ? (revenue - prevRevenue) / prevRevenue * 100 : null, pending: sum(transactions.filter(t => t.status === "pending")), averageTicket: paid.length ? Math.round(revenue / paid.length) : null, annualCollected: sum(paid.filter(t => t.access_plan === "annual")), monthlyCollected: sum(paid.filter(t => t.access_plan === "monthly")), mrr: recurring.length ? recurring.reduce((a, p) => a + Number(p.amountMinor), 0) : null, activePayingMembers: confirmed.length, newPayingMembers: [...firstPaid.values()].filter(d => d.slice(0, 7) === month).length, undated: sum(transactions.filter(t => !t.billing_period && !t.paid_at)), undatedCount: transactions.filter(t => validMoney(t) && !t.billing_period && !t.paid_at).length, needsReview: profiles.filter(p => p.amountMinor === null || !p.currency).length },
    goal: { target, revision: goal?.revision || 0, progress: target ? revenue / target * 100 : null, remaining: target === null ? null : Math.max(0, target - revenue) }, trend, renewals,
    breakdown: ["monthly", "annual"].map(plan => ({ plan, members: profiles.filter(p => p.plan === plan && p.currency === currency && p.amountMinor !== null).length, collected: sum(paid.filter(t => t.access_plan === plan)), registered: sum(registered(month).filter(t => t.access_plan === plan)), undated: sum(transactions.filter(t => t.access_plan === plan && !t.paid_at && !t.billing_period)) })),
    recent: transactions.filter(validMoney).sort((a, b) => (b.paid_at || b.billing_period || "").localeCompare(a.paid_at || a.billing_period || "") || b.created_at.localeCompare(a.created_at)).slice(0, 8).map(t => ({ ...t, name: members.find(m => m.id === t.member_id)?.name || "Miembro" })) };
}
module.exports = { amountMinor, parseCsv, reconcileSheet, dashboard, latestTransactions, validMonth, validDate, monthKey, digest };
