/**
 * @file logger.js
 * Structured logger for TTS Gateway.
 * Outputs JSON lines to stdout.  Never logs secrets.
 */

"use strict";

/**
 * Field names that must never be serialised (case-insensitive substring match).
 * Covers API keys, cookies, Set-Cookie, Authorization, secrets, tokens,
 * ciphertext, passwords and raw request bodies/headers.
 */
const REDACTED_FIELD_RE = /key|cookie|authorization|secret|token|cipher|password|passwd|credential|body|headers/i;

/**
 * Value patterns that look like secrets even when placed under an innocent field name.
 *  - ElevenLabs secret keys (sk_...)
 *  - BYOK ciphertext (v1.<iv>.<ct>.<tag>)
 *  - Bearer tokens
 */
const SECRET_VALUE_RES = [
  /sk_[A-Za-z0-9]{8,}/g,
  /v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[^\s"']+/gi,
];

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function redactValue(value) {
  if (typeof value !== "string") return value;
  return SECRET_VALUE_RES.reduce((acc, re) => acc.replace(re, "[REDACTED]"), value);
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} data
 */
function log(event, data) {
  // Redact any accidental key / cookie / credential leakage
  const safe = Object.fromEntries(
    Object.entries(data || {})
      .filter(([k]) => !REDACTED_FIELD_RE.test(k))
      .map(([k, v]) => [k, redactValue(v)])
  );
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...safe }) + "\n");
}

/**
 * Logs the start of a TTS request.
 * @param {string} requestId
 * @param {{ provider: string; voiceId: string; modelId: string; textLength: number }} info
 */
function logRequestStart(requestId, info) {
  log("TTS_REQUEST_START", { requestId, ...info });
}

/**
 * Logs that the provider call is starting.
 * @param {string} requestId
 */
function logProviderRequest(requestId) {
  log("TTS_PROVIDER_REQUEST", { requestId });
}

/**
 * Logs a successful provider response.
 * @param {string} requestId
 * @param {{ durationMs: number; responseBytes: number }} info
 */
function logProviderSuccess(requestId, info) {
  log("TTS_PROVIDER_SUCCESS", { requestId, ...info });
}

/**
 * Logs a provider error.
 * @param {string} requestId
 * @param {{ status?: number; durationMs: number; error?: string }} info
 */
function logProviderError(requestId, info) {
  log("TTS_PROVIDER_ERROR", { requestId, ...info });
}

/**
 * Logs a BYOK connection lifecycle event. Only non-sensitive metadata.
 * NEVER pass the API key, request body, cookie, Set-Cookie or ciphertext here.
 * @param {string} requestId
 * @param {{ action: "connect" | "disconnect" | "status"; outcome: string }} info
 */
function logByokEvent(requestId, info) {
  log("TTS_BYOK_EVENT", { requestId, action: info.action, outcome: info.outcome });
}

module.exports = {
  logRequestStart,
  logProviderRequest,
  logProviderSuccess,
  logProviderError,
  logByokEvent,
  _log: log,
};
