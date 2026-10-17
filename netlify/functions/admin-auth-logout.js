/**
 * @file netlify/functions/admin-auth-logout.js
 * POST /api/admin/auth/logout
 *
 * Expires the admin session cookie.
 */

"use strict";

const { corsHeaders, preflightResponse } = require("./lib/cors");
const { buildAdminLogoutCookie } = require("./lib/adminAuth");
const { authorizeAdmin } = require("./lib/adminAuthorization");
const db = require("./lib/db");

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  if (event.httpMethod !== "POST") return { statusCode: 405, headers: corsHeaders(origin), body: "" };
  const auth = await authorizeAdmin(event, "", "session");
  if (auth.ok && !["system_owner", "00000000-0000-0000-0000-000000000000"].includes(auth.admin.id)) {
    try {
      const user = await db.getAdminUserById(auth.admin.id);
      await db.updateAdminUser(user.id, { session_version: (user.session_version || 0) + 1 });
    } catch (_) { return { statusCode: 503, headers: corsHeaders(origin), body: JSON.stringify({ error: { message: "No se pudo cerrar la sesión. Intenta de nuevo." } }) }; }
  }

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
