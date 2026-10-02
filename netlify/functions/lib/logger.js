/**
 * @file logger.js
 * Structured logger for TTS Gateway.
 * Outputs JSON lines to stdout.  Never logs secrets.
 */

"use strict";

/**
 * @param {string} event
 * @param {Record<string, unknown>} data
 */
function log(event, data) {
  // Redact any accidental key leakage
  const safe = Object.fromEntries(
    Object.entries(data).filter(([k]) => !k.toLowerCase().includes("key"))
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

module.exports = { logRequestStart, logProviderRequest, logProviderSuccess, logProviderError };
