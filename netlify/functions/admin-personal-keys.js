"use strict";
const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { authorizeAdmin } = require("./lib/adminAuthorization");
const service = require("./lib/personalKeyService");
exports.handler = async event => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);
  const requestId = crypto.randomUUID();
  const response = (statusCode, body) => ({ statusCode, headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store, private", Pragma: "no-cache" }, body: JSON.stringify(body) });
  const auth = await authorizeAdmin(event, requestId, event.httpMethod === "PUT" ? "owner" : "personal_keys.read");
  if (!auth.ok) return response(auth.statusCode, { error: auth.error, requestId });
  if (!["GET", "POST", "PUT"].includes(event.httpMethod)) return response(405, { error: { message: "Método no permitido." }, requestId });
  try {
    if (event.httpMethod === "GET") return response(200, { keys: await service.list(auth.admin.id) });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (_) { return response(400, { error: { message: "Solicitud inválida." }, requestId }); }
    if (event.httpMethod === "PUT") return response(200, { key: await service.grant({ adminId: body.adminId, token: body.accessKey, actor: auth.admin }) });
    return response(200, { accessKey: await service.reveal(auth.admin, body.keyId) });
  } catch (error) {
    return response(error.statusCode || 503, { error: { message: "No se pudo acceder a la key personal. Intenta de nuevo o consulta al OWNER." }, requestId });
  }
};
