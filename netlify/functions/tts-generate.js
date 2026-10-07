/**
 * @file netlify/functions/tts-generate.js
 * POST /api/tts/generate  →  audio/mpeg binary
 *
 * Routed via netlify.toml:
 *   /api/tts/generate → /.netlify/functions/tts-generate
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse, isOriginAllowed } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { logRequestStart } = require("./lib/logger");
const { validateGenerateRequest } = require("./lib/validate");
const { requireOperatorAuth } = require("./lib/auth");
const { resolveByokApiKey, byokFailureError, buildClearCookie, KEY_REJECTED_MESSAGE } = require("./lib/byok");
const { getProvider } = require("./providers");
const db = require("./lib/db");
const storage = require("./lib/storageService");
const { TtsErrorCode, TtsOperationStage, sanitizeOperationalError } = require("./lib/errorCatalog");

/**
 * Builds a JSON error Netlify response.
 * @param {{ statusCode: number; error: { code: string; message: string }; requestId: string }} errPayload
 * @param {string|undefined} origin
 * @param {string|undefined} [setCookie]
 */
function jsonErrorResponse(errPayload, origin, setCookie) {
  const headers = {
    ...corsHeaders(origin),
    "Content-Type": "application/json",
    "X-TTS-Request-ID": errPayload.requestId,
    "Cache-Control": "no-store",
  };
  if (setCookie) {
    headers["Set-Cookie"] = setCookie;
  }
  return {
    statusCode: errPayload.statusCode,
    headers,
    body: JSON.stringify({ error: errPayload.error, requestId: errPayload.requestId }),
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  // ── CORS Preflight ──────────────────────────────────────────────────────────
  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  // ── Method guard ────────────────────────────────────────────────────────────
  if (event.httpMethod !== "POST") {
    return jsonErrorResponse(
      makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only POST is accepted on this endpoint.", ""),
      origin
    );
  }

  // ── Origin allowlist guard ──────────────────────────────────────────────────
  if (!isOriginAllowed(origin)) {
    return jsonErrorResponse(
      makeError(403, ERROR_CODES.ORIGIN_NOT_ALLOWED, "Origin not allowed.", ""),
      origin
    );
  }

  const requestId = crypto.randomUUID();

  // ── Operator Auth guard ─────────────────────────────────────────────────────
  const authResult = await requireOperatorAuth(event, requestId);
  if (!authResult.ok) {
    return jsonErrorResponse(authResult, origin);
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_) {
    return jsonErrorResponse(
      makeError(400, "INVALID_JSON", "Request body is not valid JSON.", requestId),
      origin
    );
  }

  // ── Validate ────────────────────────────────────────────────────────────────
  const validationError = validateGenerateRequest(body, requestId);
  if (validationError) return jsonErrorResponse(validationError, origin);

  // ── BYOK Credential Resolution ──────────────────────────────────────────────
  // Resolves user's ElevenLabs key exclusively from HttpOnly session cookie.
  // CRITICAL: ZERO fallback to process.env.ELEVENLABS_API_KEY or GhostAI key.
  const byok = resolveByokApiKey(event, authResult.principalId);
  if (!byok.ok) {
    const errPayload = byokFailureError(byok, requestId);
    const clearCookie = errPayload.clearCookie ? buildClearCookie() : undefined;
    return jsonErrorResponse(errPayload, origin, clearCookie);
  }

  const userApiKey = byok.apiKey;

  const {
    provider: providerName,
    voiceId,
    text,
    modelId,
    voiceSettings,
    outputFormat,
    languageCode,
    sessionId: reqSessionId,
    projectId,
    projectTitle,
    narrationId: reqNarrationId,
    sceneId,
    sceneIndex,
  } = body;

  logRequestStart(requestId, {
    clientId: authResult.clientId || undefined,
    provider: providerName,
    voiceId,
    modelId: modelId || "(default)",
    textLength: text.length,
  });

  // ── Dispatch to provider ────────────────────────────────────────────────────
  const provider = getProvider(providerName);
  if (!provider) {
    return jsonErrorResponse(
      makeError(400, ERROR_CODES.VALIDATION_UNKNOWN_PROVIDER, `Provider '${providerName}' not found.`, requestId),
      origin
    );
  }

  let result;
  try {
    result = await provider.generate({
      requestId,
      voiceId,
      text,
      modelId,
      voiceSettings,
      outputFormat,
      languageCode,
      apiKey: userApiKey,
    });
  } finally {
    // Explicitly scope out user key reference immediately after call
    // (Never persist, never log, garbage collected)
  }

  if (!result.ok) {
    let clearCookieHeader;
    // If ElevenLabs returned 401, the user's key was rejected or revoked
    if (result.statusCode === 401) {
      clearCookieHeader = buildClearCookie();
      result.error.message = KEY_REJECTED_MESSAGE;
    }
    return jsonErrorResponse(result, origin, clearCookieHeader);
  }

  // ── Calculate MP3 Checksum ──────────────────────────────────────────────────
  const sha256 = crypto.createHash("sha256").update(result.audioBuffer).digest("hex");
  let activeSessionId = reqSessionId || null;
  let recoveryWarning = null;

  // ── Temporary Recovery Vault (Client Tokens Only) ───────────────────────────
  if (authResult.authMode === "client_token" && authResult.clientId) {
    const narrationId = reqNarrationId || `narration_${Date.now()}`;
    const retentionHours = Number(process.env.TTS_TEMP_RETENTION_HOURS) || 24;

    try {
      // Find or create session
      let session = null;
      if (activeSessionId) {
        session = await db.getGenerationSession(activeSessionId);
        // Enforce ownership and validity: if session belongs to another client, or is expired/deleted, do not reuse
        const isExpired = session && new Date(session.expires_at) <= new Date();
        const isInvalidStatus = session && (session.status === "deleted" || session.status === "expired");
        if (!session || session.client_id !== authResult.clientId || isExpired || isInvalidStatus) {
          session = null;
          activeSessionId = null;
        }
      }

      if (!session) {
        session = await db.createGenerationSession({
          clientId: authResult.clientId,
          projectId: projectId || null,
          projectTitle: projectTitle || null,
          retentionHours,
        });
        activeSessionId = session.id;
      }

      // Attempt upload to Supabase Storage
      let uploadResult;
      try {
        uploadResult = await storage.uploadAudio({
          clientId: authResult.clientId,
          sessionId: activeSessionId,
          narrationId,
          audioBuffer: result.audioBuffer,
          mimeType: result.contentType || "audio/mpeg",
        });
      } catch (uploadErr) {
        uploadResult = { ok: false, error: uploadErr.message };
      }

      if (!uploadResult.ok) {
        // Storage failed: GRACEFUL DEGRADATION. Audio still returned to user!
        recoveryWarning = TtsErrorCode.RECOVERY_STORAGE_FAILED;
        await db.logOperationEvent({
          clientId: authResult.clientId,
          sessionId: activeSessionId,
          narrationId,
          requestId,
          stage: TtsOperationStage.STORAGE,
          eventType: "STORAGE_UPLOAD_FAILED",
          errorCode: TtsErrorCode.RECOVERY_STORAGE_FAILED,
          messageSanitized: sanitizeOperationalError(uploadResult.error || "Storage upload failed"),
        });

        await db.createOrUpdateGenerationItem({
          sessionId: activeSessionId,
          clientId: authResult.clientId,
          narrationId,
          sceneId: sceneId || null,
          sceneIndex: typeof sceneIndex === "number" ? sceneIndex : null,
          status: "error", // Marked error in vault since storage is not available for recovery
          storagePath: null,
          mimeType: result.contentType || "audio/mpeg",
          sizeBytes: result.audioBuffer.byteLength,
          sha256,
          providerRequestId: requestId,
          voiceId,
          modelId: modelId || "eleven_multilingual_v2",
          outputFormat: outputFormat || "mp3_44100_128",
          text: text || null,
          errorCode: TtsErrorCode.RECOVERY_STORAGE_FAILED,
          errorStage: TtsOperationStage.STORAGE,
          expiresAt: session.expires_at,
        });
      } else {
        // Storage succeeded
        await db.createOrUpdateGenerationItem({
          sessionId: activeSessionId,
          clientId: authResult.clientId,
          narrationId,
          sceneId: sceneId || null,
          sceneIndex: typeof sceneIndex === "number" ? sceneIndex : null,
          status: "ready",
          storagePath: uploadResult.storagePath,
          mimeType: result.contentType || "audio/mpeg",
          sizeBytes: result.audioBuffer.byteLength,
          sha256,
          providerRequestId: requestId,
          voiceId,
          modelId: modelId || "eleven_multilingual_v2",
          outputFormat: outputFormat || "mp3_44100_128",
          text: text || null,
          expiresAt: session.expires_at,
        });
      }

      // Update session counts
      const items = await db.listGenerationItems(activeSessionId);
      const readyCount = items.filter((i) => i.status === "ready").length;
      const errorCount = items.filter((i) => i.status === "error").length;
      await db.updateGenerationSession(activeSessionId, {
        item_count: items.length,
        ready_count: readyCount,
        error_count: errorCount,
        status: readyCount === items.length ? "ready" : "partial",
      });
    } catch (sessionErr) {
      // Non-fatal: recovery tracking failed, but audio delivery succeeds
      recoveryWarning = TtsErrorCode.RECOVERY_SESSION_CREATE_FAILED;
    }
  }

  // ── Return binary audio ─────────────────────────────────────────────────────
  const responseHeaders = {
    ...corsHeaders(origin),
    "Content-Type": result.contentType || "audio/mpeg",
    "Content-Length": String(result.audioBuffer.byteLength),
    "X-TTS-Provider": providerName,
    "X-TTS-Request-ID": requestId,
    "X-TTS-Output-Format": body.outputFormat || process.env.ELEVENLABS_DEFAULT_OUTPUT_FORMAT || "mp3_44100_128",
    "X-TTS-Audio-SHA256": sha256,
    "Cache-Control": "no-store",
  };

  if (activeSessionId) {
    responseHeaders["X-TTS-Session-ID"] = activeSessionId;
  }
  if (recoveryWarning) {
    responseHeaders["X-TTS-Recovery-Warning"] = recoveryWarning;
  }

  return {
    statusCode: 200,
    headers: responseHeaders,
    // Netlify Functions v1 returns binary via isBase64Encoded
    isBase64Encoded: true,
    body: result.audioBuffer.toString("base64"),
  };
};
