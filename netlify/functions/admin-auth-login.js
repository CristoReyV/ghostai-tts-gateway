/**
 * @file netlify/functions/admin-auth-login.js
 * POST /api/admin/auth/login
 *
 * Exchanges administrator credential for a temporary HttpOnly session cookie.
 * NEVER stores the credential plaintext in browser client storage.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { buildAdminSessionCookie } = require("./lib/adminAuth");

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

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  const requestId = crypto.randomUUID();

  if (event.httpMethod !== "POST") {
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only POST is accepted.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  const serverSecret = process.env.GHOSTAI_ADMIN_AUTH_TOKEN;
  if (!serverSecret || !serverSecret.trim()) {
    const err = makeError(500, ERROR_CODES.GATEWAY_NOT_CONFIGURED, "Admin authentication is not configured on the server.", requestId);
    return jsonResponse(500, { error: err.error, requestId }, origin);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const { adminToken } = body;
  if (!adminToken || typeof adminToken !== "string" || !adminToken.trim()) {
    const err = makeError(401, ERROR_CODES.AUTH_INVALID, "Invalid admin credential.", requestId);
    return jsonResponse(401, { error: err.error, requestId }, origin);
  }

  const expectedBuf = Buffer.from(serverSecret.trim(), "utf8");
  const actualBuf = Buffer.from(adminToken.trim(), "utf8");

  if (
    expectedBuf.length !== actualBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, actualBuf)
  ) {
    const err = makeError(401, ERROR_CODES.AUTH_INVALID, "Invalid admin credential.", requestId);
    return jsonResponse(401, { error: err.error, requestId }, origin);
  }

  const sessionCookie = buildAdminSessionCookie(serverSecret.trim());
  return jsonResponse(200, { ok: true, authenticated: true }, origin, sessionCookie);
};
