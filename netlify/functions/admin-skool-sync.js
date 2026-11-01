"use strict";
const crypto = require("crypto");
const { authorizeAdmin } = require("./lib/adminAuthorization");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const service = require("./lib/skoolSync");
exports.handler = async event => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);
  const respond = (statusCode, body) => ({ statusCode, headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  const auth = await authorizeAdmin(event, crypto.randomUUID(), event.httpMethod === "GET" ? "member.read" : "owner");
  if (!auth.ok) return respond(auth.statusCode, { error: auth.error });
  try {
    if (event.httpMethod === "GET") {
      if (!process.env.GHOSTAI_SKOOL_SHEET_ID) return respond(200, { configured: false, sync: null });
      return respond(200, await service.status());
    }
    if (event.httpMethod !== "POST") return respond(405, { error: { message: "Método no permitido." } });
    let body; try { body = JSON.parse(event.body || "{}"); } catch (_) { return respond(400, { error: { message: "Solicitud inválida." } }); }
    if (body.action === "preview") return respond(200, { preview: await service.preview(auth.admin) });
    if (body.action === "apply") return respond(200, await service.apply(auth.admin, body.previewToken));
    return respond(400, { error: { message: "Acción SKOOL inválida." } });
  } catch (error) { return respond(error.statusCode || 500, { error: { message: error.statusCode ? error.message : "No se pudo completar SKOOL. Actualiza la vista previa antes de reintentar." } }); }
};
