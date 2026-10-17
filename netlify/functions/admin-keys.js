"use strict";
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { authorizeAdmin } = require("./lib/adminAuthorization");
const { manageAdminKey } = require("./lib/adminKeyService");
exports.handler = async event => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);
  const reply = (statusCode, body) => ({ statusCode, headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  const auth = await authorizeAdmin(event, "", "admin.keys");
  if (!auth.ok) return reply(auth.statusCode, { error: auth.error });
  if (event.httpMethod !== "POST") return reply(405, { error: { message: "Solo POST." } });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (_) { return reply(400, { error: { message: "JSON inválido." } }); }
  try { return reply(200, { ok: true, ...await manageAdminKey({ action: body.action, adminId: body.adminId, name: body.name, requestingAdmin: auth.admin }) }); }
  catch (err) { return reply(err.statusCode || 500, { error: { message: err.statusCode ? err.message : "Error gestionando admin key." } }); }
};
