/**
 * @file netlify/functions/tts-provider-elevenlabs-connect.js
 * POST /api/tts/provider/elevenlabs/connect
 *
 * Connects the user's personal ElevenLabs API key for this browser session.
 *
 * Security:
 *  - Requires Operator Bearer authentication (GhostAI operator token).
 *  - Origin must be allowed (CORS + CSRF protection).
 *  - Strict payload validation (max body 4KB, trims apiKey, rejects empty).
 *  - Validates key against ElevenLabs via GET /v1/user/subscription (NO synthesis, NO credits).
 *  - Never logs the API key or request body.
 *  - Encrypts key with AES-256-GCM using GHOSTAI_CREDENTIAL_ENCRYPTION_KEY.
 *  - Returns Set-Cookie with `__Host-ghostai_elevenlabs` (HttpOnly, Secure, SameSite=Strict, Path=/).
 *  - Response body contains ONLY non-sensitive metadata (connected: true, tier).
 *    Never returns the API key, partial key, or ciphertext.
 *  - Cache-Control: no-store.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse, isOriginAllowed } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { requireOperatorAuth } = require("./lib/auth");
const { logByokEvent } = require("./lib/logger");
const { isEncryptionConfigured } = require("./lib/credentialCrypto");
const { issueByokCookie, isPlausibleApiKey } = require("./lib/byok");
const { getProvider } = require("./providers");

const MAX_BODY_BYTES = 4096;

function jsonResponse(statusCode, body, origin, setCookie) {
  const headers = {
    ...corsHeaders(origin),
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (setCookie) {
    headers["Set-Cookie"] = setCookie;
  }
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  // ── CORS Preflight ──────────────────────────────────────────────────────────
  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  // ── Method guard ────────────────────────────────────────────────────────────
  if (event.httpMethod !== "POST") {
    const requestId = crypto.randomUUID();
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only POST is accepted on this endpoint.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  // ── Origin guard ────────────────────────────────────────────────────────────
  if (!isOriginAllowed(origin)) {
    const requestId = crypto.randomUUID();
    const err = makeError(403, ERROR_CODES.ORIGIN_NOT_ALLOWED, "Origin not allowed.", requestId);
    return jsonResponse(403, { error: err.error, requestId }, origin);
  }

  const requestId = crypto.randomUUID();

  // ── Operator Auth guard (BEFORE touching any provider) ──────────────────────
  const authResult = await requireOperatorAuth(event, requestId);
  if (!authResult.ok) {
    return jsonResponse(authResult.statusCode, { error: authResult.error, requestId }, origin);
  }

  // ── Master Encryption Key check ─────────────────────────────────────────────
  if (!isEncryptionConfigured()) {
    const err = makeError(500, ERROR_CODES.GATEWAY_NOT_CONFIGURED, "BYOK credential encryption is not configured on the server.", requestId);
    return jsonResponse(500, { error: err.error, requestId }, origin);
  }

  // ── Body length guard ───────────────────────────────────────────────────────
  const rawBody = event.body || "";
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    const err = makeError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, "Request body exceeds maximum allowed size.", requestId);
    return jsonResponse(413, { error: err.error, requestId }, origin);
  }

  // ── Body parsing (never log raw body) ───────────────────────────────────────
  let parsed;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch (_) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const candidateKey = typeof parsed?.apiKey === "string" ? parsed.apiKey.trim() : "";
  if (!candidateKey) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Field 'apiKey' is required.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  if (!isPlausibleApiKey(candidateKey)) {
    const err = makeError(
      400,
      ERROR_CODES.ELEVENLABS_INVALID_API_KEY,
      "El formato de la API key no es válido. Debe ser una clave válida de ElevenLabs.",
      requestId
    );
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  // ── Validate key against ElevenLabs (read-only subscription probe) ───────────
  const provider = getProvider("elevenlabs");
  if (!provider || typeof provider.verifyApiKey !== "function") {
    const err = makeError(500, ERROR_CODES.GATEWAY_NOT_CONFIGURED, "ElevenLabs provider not configured.", requestId);
    return jsonResponse(500, { error: err.error, requestId }, origin);
  }

  let verifyResult;
  try {
    verifyResult = await provider.verifyApiKey(candidateKey, requestId);
  } catch (err) {
    verifyResult = {
      ok: false,
      statusCode: 502,
      error: { code: ERROR_CODES.ELEVENLABS_NETWORK_ERROR, message: "Error al verificar la API key con ElevenLabs." },
      requestId,
    };
  }

  if (!verifyResult.ok) {
    logByokEvent(requestId, { action: "connect", outcome: "rejected" });
    // Controlled error response: NEVER expose raw upstream headers or secret
    return jsonResponse(
      verifyResult.statusCode || 401,
      {
        error: {
          code: ERROR_CODES.ELEVENLABS_INVALID_API_KEY,
          message: "API key de ElevenLabs inválida o sin permisos.",
        },
        requestId,
      },
      origin
    );
  }

  // ── Key is valid: encrypt server-side and issue session cookie ──────────────
  let cookieHeader;
  try {
    cookieHeader = issueByokCookie(candidateKey, authResult.principalId, verifyResult.tier);
  } catch (err) {
    logByokEvent(requestId, { action: "connect", outcome: "encryption_failed" });
    const errPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error al cifrar credencial de sesión.", requestId);
    return jsonResponse(500, { error: errPayload.error, requestId }, origin);
  }

  logByokEvent(requestId, { action: "connect", outcome: "success" });

  // ── Respond ONLY with non-sensitive metadata ────────────────────────────────
  // NEVER return candidateKey, partial key, or ciphertext in the response body!
  return jsonResponse(
    200,
    {
      ok: true,
      connected: true,
      provider: "elevenlabs",
      tier: verifyResult.tier || "user",
      status: verifyResult.status || "active",
      message: "API key conectada correctamente para esta sesión.",
    },
    origin,
    cookieHeader
  );
};
