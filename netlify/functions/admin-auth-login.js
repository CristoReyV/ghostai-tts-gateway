/**
 * @file netlify/functions/admin-auth-login.js
 * POST /api/admin/auth/login
 *
 * Exchanges administrator credentials for a temporary HttpOnly session cookie.
 * Supports:
 *  1. Email + Password (individual admin users: owner or admin role)
 *  2. Master adminToken (GHOSTAI_ADMIN_AUTH_TOKEN: system owner role)
 * NEVER stores the credential plaintext in browser client storage.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { buildAdminSessionCookie } = require("./lib/adminAuth");
const { loginAdminWithPassword } = require("./lib/adminUserService");
const { loginAdminWithKey } = require("./lib/adminKeyService");

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

  const { adminToken, adminKey, email, password } = body;
  if (adminKey !== undefined) {
    try {
      const admin = await loginAdminWithKey(adminKey);
      return jsonResponse(200, { ok: true, authenticated: true, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } }, origin, buildAdminSessionCookie(serverSecret.trim(), admin));
    } catch (_) {
      return jsonResponse(401, { error: { code: "AUTH_INVALID", message: "Admin key inválida o revocada." }, requestId }, origin);
    }
  }

  // ── Mode 1: Individual Admin Email + Password ───────────────────────
  if (email && typeof email === "string" && email.trim()) {
    try {
      const admin = await loginAdminWithPassword(email.trim(), password || "");
      const sessionCookie = buildAdminSessionCookie(serverSecret.trim(), admin);
      return jsonResponse(
        200,
        {
          ok: true,
          authenticated: true,
          admin: {
            id: admin.id,
            name: admin.name,
            email: admin.email,
            role: admin.role,
          },
        },
        origin,
        sessionCookie
      );
    } catch (err) {
      const statusCode = err.statusCode || 401;
      const errPayload = makeError(statusCode, err.code || ERROR_CODES.AUTH_INVALID, err.message, requestId);
      return jsonResponse(statusCode, { error: errPayload.error, requestId }, origin);
    }
  }

  // ── Mode 2: Legacy Master Admin Token ──────────────────────────────
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

  const systemOwner = {
    id: "00000000-0000-0000-0000-000000000000",
    name: "GhostAI Owner",
    email: "owner@ghostai.internal",
    role: "owner",
  };

  const sessionCookie = buildAdminSessionCookie(serverSecret.trim(), systemOwner);
  return jsonResponse(
    200,
    {
      ok: true,
      authenticated: true,
      admin: systemOwner,
    },
    origin,
    sessionCookie
  );
};
