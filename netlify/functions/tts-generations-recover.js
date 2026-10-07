/**
 * @file netlify/functions/tts-generations-recover.js
 * POST /api/tts/generations/recover
 *
 * Rehydration endpoint for Temporary Recovery Vault.
 * Returns project and item metadata needed to restore session without ElevenLabs synthesis.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireOperatorAuth } = require("./lib/auth");
const db = require("./lib/db");

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

  if (auth.authMode !== "client_token" || !auth.clientId) {
    const err = makeError(403, "RECOVERY_CLIENT_REQUIRED", "Recuperación requiere token individual de cliente.", requestId);
    return jsonResponse(403, { error: err.error, requestId }, origin);
  }

  if (event.httpMethod !== "POST") {
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only POST is accepted.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "JSON inválido en el cuerpo de la petición.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const sessionId = body.sessionId || body.session_id;
  if (!sessionId || typeof sessionId !== "string") {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Campo 'sessionId' es requerido.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  try {
    const session = await db.getGenerationSession(sessionId.trim());
    if (!session || session.client_id !== auth.clientId || session.status === "deleted") {
      const err = makeError(404, "SESSION_NOT_FOUND", "Sesión de generación no encontrada.", requestId);
      return jsonResponse(404, { error: err.error, requestId }, origin);
    }

    if (new Date(session.expires_at) <= new Date()) {
      const err = makeError(410, "RECOVERY_EXPIRED", "La sesión ha expirado y no se puede recuperar.", requestId);
      return jsonResponse(410, { error: err.error, requestId }, origin);
    }

    const items = await db.listGenerationItems(sessionId.trim());

    // Sanitized item list for Studio rehydration
    const rehydrationItems = items.map((i) => ({
      id: i.id,
      narrationId: i.narration_id,
      sceneId: i.scene_id,
      sceneIndex: i.scene_index,
      status: i.status,
      hasAudio: Boolean(i.storage_path),
      sha256: i.sha256,
      sizeBytes: i.size_bytes,
      mimeType: i.mime_type || "audio/mpeg",
      voiceId: i.voice_id,
      modelId: i.model_id,
      outputFormat: i.output_format,
      durationSeconds: i.duration_seconds,
      text: i.text, // Preserved temporarily for 1.0 reconstruction
    }));

    return jsonResponse(
      200,
      {
        ok: true,
        session: {
          id: session.id,
          projectId: session.project_id,
          projectTitle: session.project_title,
          status: session.status,
          itemCount: session.item_count,
          readyCount: session.ready_count,
          errorCount: session.error_count,
          createdAt: session.created_at,
          expiresAt: session.expires_at,
        },
        items: rehydrationItems,
      },
      origin
    );
  } catch (err) {
    const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error procesando recuperación de sesión.", requestId);
    return jsonResponse(500, { error: errorPayload.error, requestId }, origin);
  }
};
