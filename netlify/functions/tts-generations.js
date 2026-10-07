/**
 * @file netlify/functions/tts-generations.js
 * GET    /api/tts/generations             → list sessions for authenticated client
 * GET    /api/tts/generations?sessionId=  → get session details & items
 * DELETE /api/tts/generations?sessionId=  → early deletion of session & recovery files
 *
 * Enforces strict server-side client ownership.
 * Only available for authMode = client_token.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireOperatorAuth } = require("./lib/auth");
const db = require("./lib/db");
const storage = require("./lib/storageService");

function jsonResponse(statusCode, body, origin) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  const requestId = crypto.randomUUID();

  // Operator Auth Guard
  const auth = await requireOperatorAuth(event, requestId);
  if (!auth.ok) {
    return jsonResponse(auth.statusCode, { error: auth.error, requestId }, origin);
  }

  // Recovery Vault is strictly scoped to client_token authentication
  if (auth.authMode !== "client_token" || !auth.clientId) {
    const err = makeError(
      403,
      "RECOVERY_CLIENT_REQUIRED",
      "La recuperación temporal requiere autenticación mediante token individual de cliente.",
      requestId
    );
    return jsonResponse(403, { error: err.error, requestId }, origin);
  }

  const clientId = auth.clientId;
  const sessionId =
    event.queryStringParameters?.sessionId ||
    event.queryStringParameters?.session_id ||
    null;

  // ── GET: Single Session OR List Sessions ────────────────────────────
  if (event.httpMethod === "GET") {
    try {
      if (sessionId) {
        // Fetch specific session
        const session = await db.getGenerationSession(sessionId);
        if (!session || session.client_id !== clientId || session.status === "deleted") {
          const err = makeError(404, "SESSION_NOT_FOUND", "Sesión de generación no encontrada.", requestId);
          return jsonResponse(404, { error: err.error, requestId }, origin);
        }

        const items = await db.listGenerationItems(sessionId);
        return jsonResponse(200, { ok: true, session, items }, origin);
      }

      // List all sessions for this client
      const sessions = await db.listGenerationSessions(clientId);
      return jsonResponse(200, { ok: true, sessions }, origin);
    } catch (err) {
      const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error consultando sesiones de recuperación.", requestId);
      return jsonResponse(500, { error: errorPayload.error, requestId }, origin);
    }
  }

  // ── DELETE: Delete Session ──────────────────────────────────────────
  if (event.httpMethod === "DELETE") {
    if (!sessionId) {
      const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Parámetro 'sessionId' es requerido.", requestId);
      return jsonResponse(400, { error: err.error, requestId }, origin);
    }

    try {
      const session = await db.getGenerationSession(sessionId);
      if (!session || session.client_id !== clientId) {
        const err = makeError(404, "SESSION_NOT_FOUND", "Sesión de generación no encontrada.", requestId);
        return jsonResponse(404, { error: err.error, requestId }, origin);
      }

      // Remove storage files
      const items = await db.listGenerationItems(sessionId);
      const pathsToDelete = items
        .map((i) => i.storage_path)
        .filter((p) => p && typeof p === "string");

      if (pathsToDelete.length > 0) {
        const delRes = await storage.deleteAudioFiles(pathsToDelete);
        if (!delRes.ok) {
          const err = makeError(500, "STORAGE_DELETE_FAILED", "No se pudieron eliminar los archivos de audio del almacenamiento.", requestId);
          return jsonResponse(500, { error: err.error, requestId }, origin);
        }
      }

      // Delete database session and items
      await db.deleteGenerationSession(sessionId);

      return jsonResponse(200, { ok: true, deleted: true, sessionId }, origin);
    } catch (err) {
      const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error eliminando sesión de recuperación.", requestId);
      return jsonResponse(500, { error: errorPayload.error, requestId }, origin);
    }
  }

  const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Método no permitido.", requestId);
  return jsonResponse(405, { error: err.error, requestId }, origin);
};
