/**
 * @file netlify/functions/tts-generations-verify.js
 * POST /api/tts/generations/verify
 *
 * Records ZIP verification outcome metadata from Studio.
 * Does NOT upload the full ZIP package.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireOperatorAuth } = require("./lib/auth");
const db = require("./lib/db");
const { TtsOperationStage } = require("./lib/errorCatalog");

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
    const err = makeError(403, "RECOVERY_CLIENT_REQUIRED", "Verificación requiere token de cliente.", requestId);
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
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "JSON inválido.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const { sessionId, verified, packageSha256, itemCount } = body;
  if (!sessionId) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Campo 'sessionId' requerido.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  // Validate packageSha256 format if provided or if verified is true
  if (verified) {
    if (!packageSha256 || typeof packageSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(packageSha256.trim())) {
      const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_VALUE, "El campo 'packageSha256' debe ser un hash SHA-256 válido de 64 caracteres hexadecimales.", requestId);
      return jsonResponse(400, { error: err.error, requestId }, origin);
    }
  }

  try {
    const session = await db.getGenerationSession(sessionId.trim());
    if (!session || session.client_id !== auth.clientId || session.status === "deleted") {
      const err = makeError(404, "SESSION_NOT_FOUND", "Sesión no encontrada.", requestId);
      return jsonResponse(404, { error: err.error, requestId }, origin);
    }

    // Validate expected itemCount if supplied
    if (typeof itemCount === "number") {
      if (itemCount !== session.ready_count && itemCount !== session.item_count) {
        const err = makeError(400, "ITEM_COUNT_MISMATCH", `El conteo de items verificado (${itemCount}) no coincide con los audios de la sesión (${session.ready_count}).`, requestId);
        return jsonResponse(400, { error: err.error, requestId }, origin);
      }
    }

    const zipStatus = verified ? "verified" : "failed";
    const zipVerifiedAt = verified ? new Date().toISOString() : null;
    const cleanSha = packageSha256 ? packageSha256.trim().toLowerCase() : null;

    await db.updateGenerationSession(sessionId.trim(), {
      zip_status: zipStatus,
      zip_verified_at: zipVerifiedAt,
      package_sha256: cleanSha,
    });

    await db.logOperationEvent({
      clientId: auth.clientId,
      sessionId: sessionId.trim(),
      stage: TtsOperationStage.VERIFICATION,
      eventType: verified ? "ZIP_CLIENT_VERIFIED_SUCCESS" : "ZIP_CLIENT_VERIFIED_FAILED",
      metadata: {
        packageSha256: cleanSha,
        verified: Boolean(verified),
        itemCount: typeof itemCount === "number" ? itemCount : session.ready_count,
        readyCount: session.ready_count,
      },
    });

    return jsonResponse(
      200,
      {
        ok: true,
        sessionId: session.id,
        zipStatus,
        zipVerifiedAt,
      },
      origin
    );
  } catch (err) {
    const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error actualizando estado de verificación.", requestId);
    return jsonResponse(500, { error: errorPayload.error, requestId }, origin);
  }
};
