/**
 * @file cors.js
 * Shared CORS header builder for Netlify Functions.
 * Reutilises the pattern already present in health.js / tts.js.
 */

"use strict";

/**
 * Returns the CORS origin header value for a given request origin.
 * Reads GHOSTAI_ALLOWED_ORIGINS at call-time (not module load)
 * so that tests can override process.env per-test.
 *
 * @param {string|undefined} requestOrigin
 * @returns {string}
 */
function resolveOrigin(requestOrigin) {
  const allowedEnv = process.env.GHOSTAI_ALLOWED_ORIGINS || "";
  if (!allowedEnv) return "*";
  const allowed = allowedEnv.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return "*";
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return null;
}

/**
 * Builds the base CORS + GhostAI-Gateway headers.
 *
 * @param {string|undefined} requestOrigin
 * @returns {Record<string, string>}
 */
function corsHeaders(requestOrigin) {
  const resolved = resolveOrigin(requestOrigin);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers":
      "X-TTS-Provider, X-TTS-Request-ID, X-TTS-Output-Format, X-GhostAI-Gateway",
    "X-GhostAI-Gateway": "true",
  };

  if (resolved !== null) {
    headers["Access-Control-Allow-Origin"] = resolved;
  }

  return headers;
}

/**
 * Returns a 204 OPTIONS preflight response.
 *
 * @param {string|undefined} requestOrigin
 * @returns {{ statusCode: number, headers: Record<string, string>, body: string }}
 */
function preflightResponse(requestOrigin) {
  return {
    statusCode: 204,
    headers: corsHeaders(requestOrigin),
    body: "",
  };
}

module.exports = { corsHeaders, preflightResponse, resolveOrigin };
