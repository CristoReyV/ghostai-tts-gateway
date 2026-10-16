/**
 * @file netlify/functions/admin-auth-activate.js
 * POST /api/admin/auth/activate
 *
 * Public endpoint for newly invited administrators to activate their account,
 * establish a secure password, and automatically receive an HttpOnly session cookie.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { buildAdminSessionCookie } = require("./lib/adminAuth");
const { activateAdminUser } = require("./lib/adminUserService");

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
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Solo POST es aceptado.", requestId);
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

  const { token, password } = body;
  if (!token || typeof token !== "string" || !token.trim()) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Token de activación requerido.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  if (!password || typeof password !== "string" || password.length < 8) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_PARAM, "La contraseña debe tener al menos 8 caracteres.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  try {
    const result = await activateAdminUser({ token: token.trim(), password });
    const sessionCookie = buildAdminSessionCookie(serverSecret.trim(), result.admin);

    return jsonResponse(
      200,
      {
        ok: true,
        authenticated: true,
        admin: result.admin,
      },
      origin,
      sessionCookie
    );
  } catch (err) {
    const statusCode = err.statusCode || 400;
    const errPayload = makeError(statusCode, err.code || ERROR_CODES.AUTH_INVALID, err.message, requestId);
    return jsonResponse(statusCode, { error: errPayload.error, requestId }, origin);
  }
};
