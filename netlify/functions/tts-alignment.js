/**
 * @file netlify/functions/tts-alignment.js
 * POST /api/tts/alignment  →  canonical NarrationAlignment JSON
 *
 * Runs ElevenLabs Forced Alignment for existing audio without re-synthesizing voice.
 * Routed via netlify.toml:
 *   /api/tts/alignment → /.netlify/functions/tts-alignment
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse, isOriginAllowed } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { logRequestStart } = require("./lib/logger");
const { requireOperatorAuth } = require("./lib/auth");
const { resolveByokApiKey, byokFailureError, buildClearCookie } = require("./lib/byok");
const { getProvider } = require("./providers");
const db = require("./lib/db");

/**
 * Builds a JSON error Netlify response.
 * @param {{ statusCode: number; error: { code: string; message: string }; requestId: string }} errPayload
 * @param {string|undefined} origin
 */
function jsonErrorResponse(errPayload, origin) {
  return {
    statusCode: errPayload.statusCode,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "X-TTS-Request-ID": errPayload.requestId,
      "Cache-Control": "no-store",
    },
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
      makeError(403, ERROR_CODES.FORBIDDEN_ORIGIN, "Origin not allowed.", ""),
      origin
    );
  }

  const requestId = crypto.randomUUID();

  // ── Operator / Client Auth ─────────────────────────────────────────────────
  const authResult = await requireOperatorAuth(event, requestId);
  if (!authResult.ok) {
    return jsonErrorResponse(authResult, origin);
  }

  // ── BYOK Session Resolution ────────────────────────────────────────────────
  const byok = resolveByokApiKey(event, authResult.principalId);
  if (!byok.ok) {
    const errPayload = byokFailureError(byok, requestId);
    const clearCookie = errPayload.clearCookie ? buildClearCookie() : undefined;
    return jsonErrorResponse(errPayload, origin, clearCookie);
  }
  const apiKey = byok.apiKey;

  logRequestStart(requestId, {
    clientId: authResult.clientId || authResult.principalId,
    endpoint: "tts-alignment",
  });

  // ── Request Body Parsing ───────────────────────────────────────────────────
  let audioBuffer = null;
  let text = "";
  let generationItemId = "";

  const contentType =
    event.headers?.["content-type"] ||
    event.headers?.["Content-Type"] ||
    "";

  try {
    if (contentType.toLowerCase().includes("multipart/form-data")) {
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || "", "base64")
        : Buffer.from(event.body || "");

      const fakeResp = new Response(rawBody, {
        headers: { "content-type": contentType },
      });
      const formData = await fakeResp.formData();

      const audioField = formData.get("audio") || formData.get("file");
      if (audioField && typeof audioField === "object" && typeof audioField.arrayBuffer === "function") {
        const ab = await audioField.arrayBuffer();
        audioBuffer = Buffer.from(ab);
      } else if (typeof audioField === "string") {
        audioBuffer = Buffer.from(audioField, "base64");
      }

      const textField = formData.get("text");
      if (typeof textField === "string") {
        text = textField.trim();
      }

      const idField = formData.get("generationItemId");
      if (typeof idField === "string") {
        generationItemId = idField.trim();
      }
    } else {
      // JSON payload support
      const rawStr = event.isBase64Encoded
        ? Buffer.from(event.body || "", "base64").toString("utf8")
        : event.body || "{}";
      const parsed = JSON.parse(rawStr);

      const audioRaw = parsed.audio || parsed.audioBase64 || parsed.file;
      if (typeof audioRaw === "string" && audioRaw.trim()) {
        audioBuffer = Buffer.from(audioRaw, "base64");
      }

      if (typeof parsed.text === "string") {
        text = parsed.text.trim();
      }

      if (typeof parsed.generationItemId === "string") {
        generationItemId = parsed.generationItemId.trim();
      }
    }
  } catch (parseErr) {
    return jsonErrorResponse(
      makeError(
        400,
        ERROR_CODES.VALIDATION_INVALID_VALUE,
        `Error parsing alignment request body: ${parseErr.message}`,
        requestId
      ),
      origin
    );
  }

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!audioBuffer || audioBuffer.byteLength === 0) {
    return jsonErrorResponse(
      makeError(
        400,
        ERROR_CODES.VALIDATION_INVALID_VALUE,
        "Field 'audio' is required as audio file binary or base64.",
        requestId
      ),
      origin
    );
  }

  if (!text) {
    return jsonErrorResponse(
      makeError(
        400,
        ERROR_CODES.VALIDATION_MISSING_TEXT,
        "Field 'text' is required and must not be empty.",
        requestId
      ),
      origin
    );
  }

  // ── Call Forced Alignment via Provider ─────────────────────────────────────
  const provider = getProvider("elevenlabs");
  if (!provider || typeof provider.alignAudio !== "function") {
    return jsonErrorResponse(
      makeError(500, ERROR_CODES.INTERNAL_ERROR, "Alignment provider not available.", requestId),
      origin
    );
  }

  const alignResult = await provider.alignAudio({
    apiKey,
    requestId,
    audioBuffer,
    text,
  });

  if (!alignResult.ok) {
    return jsonErrorResponse(alignResult, origin);
  }

  // ── Update Generation Item in DB if generationItemId provided ──────────────
  if (generationItemId) {
    try {
      await db.updateGenerationItemAlignment(generationItemId, alignResult.alignment);
    } catch (dbErr) {
      console.warn("[tts-alignment] Warning: failed to update generation item alignment:", dbErr.message);
    }
  }

  // ── Return Canonical Alignment Response ────────────────────────────────────
  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "X-TTS-Request-ID": requestId,
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({
      ok: true,
      alignment: alignResult.alignment,
      requestId,
      ...(generationItemId ? { generationItemId } : {}),
    }),
  };
};
