/**
 * @file netlify/functions/tts-generations-audio.js
 * GET /api/tts/generations/audio?sessionId=...&narrationId=...
 *
 * Authenticated binary streaming of recovered audio from the Recovery Vault.
 * Enforces server-side client ownership. Zero long-lived public signed URLs.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireOperatorAuth } = require("./lib/auth");
const db = require("./lib/db");
const storage = require("./lib/storageService");

function jsonErrorResponse(statusCode, errPayload, origin) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({ error: errPayload.error, requestId: errPayload.requestId }),
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  const requestId = crypto.randomUUID();

  // Operator Auth Guard
  const auth = await requireOperatorAuth(event, requestId);
  if (!auth.ok) {
    return jsonErrorResponse(auth.statusCode, auth, origin);
  }

  if (auth.authMode !== "client_token" || !auth.clientId) {
    const err = makeError(403, "RECOVERY_CLIENT_REQUIRED", "Recuperación de audio requiere token individual de cliente.", requestId);
    return jsonErrorResponse(403, err, origin);
  }

  if (event.httpMethod !== "GET") {
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only GET is accepted.", requestId);
    return jsonErrorResponse(405, err, origin);
  }

  const sessionId = event.queryStringParameters?.sessionId || event.queryStringParameters?.session_id;
  const narrationId = event.queryStringParameters?.narrationId || event.queryStringParameters?.narration_id;

  if (!sessionId || !narrationId) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Campos 'sessionId' y 'narrationId' son requeridos.", requestId);
    return jsonErrorResponse(400, err, origin);
  }

  try {
    const session = await db.getGenerationSession(sessionId.trim());
    if (!session || session.client_id !== auth.clientId || session.status === "deleted") {
      const err = makeError(404, "SESSION_NOT_FOUND", "Sesión de generación no encontrada.", requestId);
      return jsonErrorResponse(404, err, origin);
    }

    const items = await db.listGenerationItems(sessionId.trim());
    const item = items.find((i) => i.narration_id === narrationId.trim());

    if (!item || !item.storage_path) {
      const err = makeError(404, "AUDIO_NOT_FOUND", "Audio no encontrado en el recovery vault.", requestId);
      return jsonErrorResponse(404, err, origin);
    }

    const downloadResult = await storage.downloadAudio(item.storage_path);
    if (!downloadResult.ok || !downloadResult.buffer) {
      const err = makeError(500, "RECOVERY_FETCH_FAILED", "No se pudo descargar el audio del vault de recuperación.", requestId);
      return jsonErrorResponse(500, err, origin);
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": item.mime_type || "audio/mpeg",
        "Content-Length": String(downloadResult.buffer.byteLength),
        "X-TTS-Session-ID": sessionId,
        "X-TTS-Narration-ID": narrationId,
        "X-TTS-Audio-SHA256": item.sha256 || "",
        "Cache-Control": "no-store",
      },
      isBase64Encoded: true,
      body: downloadResult.buffer.toString("base64"),
    };
  } catch (err) {
    const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error descargando audio de recuperación.", requestId);
    return jsonErrorResponse(500, errorPayload, origin);
  }
};
