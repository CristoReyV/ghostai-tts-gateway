/**
 * @file netlify/functions/members-activate.js
 * POST /api/members/activate
 *
 * Public activation endpoint.
 * Validates cryptographic activationToken, marks it consumed (single use),
 * activates member, sets activatedAt = now and computes expiresAt,
 * updates underlying key in ghostai_access_tokens, decrypts the key from escrow,
 * and returns the session credentials so Studio opens authenticated.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { activateMemberAccess } = require("./lib/memberService");

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

  if (event.httpMethod !== "POST") {
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Solo POST es aceptado en este endpoint.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const { token } = body;
  if (!token || typeof token !== "string" || !token.trim()) {
    const err = makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Token de activación requerido.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  try {
    const result = await activateMemberAccess(token.trim());
    return jsonResponse(
      200,
      {
        ok: true,
        authenticated: true,
        accessKey: result.accessKey,
        clientName: result.clientName,
        accessPlan: result.accessPlan,
        activatedAt: result.activatedAt,
        expiresAt: result.expiresAt,
        memberId: result.memberId,
      },
      origin
    );
  } catch (err) {
    const statusCode = err.statusCode || (err.code === "MEMBER_NOT_FOUND" ? 404 : 400);
    const errPayload = makeError(statusCode, err.code || ERROR_CODES.INTERNAL_ERROR, err.message, requestId);
    return jsonResponse(statusCode, { error: errPayload.error, requestId }, origin);
  }
};
