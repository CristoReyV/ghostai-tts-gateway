/**
 * @file netlify/functions/admin-auth-logout.js
 * POST /api/admin/auth/logout
 *
 * Expires the admin session cookie.
 */

"use strict";

const { corsHeaders, preflightResponse } = require("./lib/cors");
const { buildAdminLogoutCookie } = require("./lib/adminAuth");

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  const clearCookie = buildAdminLogoutCookie();

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": clearCookie,
    },
    body: JSON.stringify({ ok: true, authenticated: false }),
  };
};
