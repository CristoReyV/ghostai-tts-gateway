/**
 * @file netlify/functions/admin-auth-status.js
 * GET /api/admin/auth/status
 *
 * Checks if the current admin session is valid. Never returns credential.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { requireAdminAuth } = require("./lib/adminAuth");

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  const requestId = crypto.randomUUID();
  const auth = requireAdminAuth(event, requestId);

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({ ok: true, authenticated: auth.ok === true }),
  };
};
