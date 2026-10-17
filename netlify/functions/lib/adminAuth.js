/**
 * @file netlify/functions/lib/adminAuth.js
 * Dedicated administrator authentication middleware for management endpoints.
 * Validates individual admin sessions (ghostai_admin_session) with RBAC (owner / admin)
 * OR fallback GHOSTAI_ADMIN_AUTH_TOKEN Bearer header (system owner).
 * Rejects client access tokens and legacy operator tokens on admin endpoints.
 */

"use strict";

const crypto = require("crypto");
const { ERROR_CODES } = require("./errors");

const ADMIN_COOKIE_NAME = "ghostai_admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours session limit

/**
 * Parses cookies from event headers.
 * @param {object} event
 * @returns {Record<string, string>}
 */
function parseCookies(event) {
  const cookieHeader =
    event?.headers?.cookie ||
    event?.headers?.Cookie ||
    (event?.multiValueHeaders?.cookie && event.multiValueHeaders.cookie.join("; ")) ||
    (event?.multiValueHeaders?.Cookie && event.multiValueHeaders.Cookie.join("; ")) ||
    "";

  /** @type {Record<string, string>} */
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== "string") return cookies;

  cookieHeader.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx > -1) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      if (key) cookies[key] = val;
    }
  });

  return cookies;
}

/**
 * Creates a signed admin session token with identity and role.
 *
 * @param {string} adminSecret
 * @param {object} [adminData]
 * @param {string} [adminData.id]
 * @param {string} [adminData.email]
 * @param {string} [adminData.name]
 * @param {"owner" | "admin"} [adminData.role]
 * @returns {string}
 */
function generateAdminSessionToken(adminSecret, adminData = null) {
  const now = Date.now();
  const payload = {
    role: adminData ? adminData.role : "owner",
    keyId: adminData?.keyId || null,
    sessionVersion: adminData?.session_version || 0,
    adminId: adminData?.id || "system_owner",
    email: adminData?.email || "owner@ghostai.internal",
    name: adminData?.name || "GhostAI Owner",
    iat: now,
    exp: now + SESSION_TTL_MS,
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const hmac = crypto.createHmac("sha256", adminSecret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${hmac}`;
}

/**
 * Parses and verifies an admin session token, returning the payload object or null.
 *
 * @param {string} token
 * @param {string} adminSecret
 * @returns {object | null}
 */
function parseAdminSessionToken(token, adminSecret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, providedHmac] = parts;
  const expectedHmac = crypto.createHmac("sha256", adminSecret).update(payloadB64).digest("base64url");

  const providedBuf = Buffer.from(providedHmac);
  const expectedBuf = Buffer.from(expectedHmac);

  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    if (!["owner", "admin", "operator"].includes(payload.role)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

/**
 * Verifies an admin session token (returns boolean for backward-compatibility).
 *
 * @param {string} token
 * @param {string} adminSecret
 * @returns {boolean}
 */
function verifyAdminSessionToken(token, adminSecret) {
  return parseAdminSessionToken(token, adminSecret) !== null;
}

/**
 * Builds the Set-Cookie string for a new admin session.
 *
 * @param {string} adminSecret
 * @param {object} [adminData]
 * @returns {string}
 */
function buildAdminSessionCookie(adminSecret, adminData = null) {
  const token = generateAdminSessionToken(adminSecret, adminData);
  return `${ADMIN_COOKIE_NAME}=${token}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * Builds the Set-Cookie string to expire / clear the admin session.
 *
 * @returns {string}
 */
function buildAdminLogoutCookie() {
  return `${ADMIN_COOKIE_NAME}=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/**
 * Validates admin authentication via:
 * 1. Session cookie (`ghostai_admin_session`)
 * 2. OR Authorization: Bearer <GHOSTAI_ADMIN_AUTH_TOKEN>
 *
 * @param {object} event - Netlify function event
 * @param {string} [requestId=""] - Optional request ID for error payload
 * @param {"owner" | "admin" | null} [requiredRole=null] - Minimum required role
 * @returns {{ ok: true, admin: { id: string, email: string, name: string, role: string } } | { ok: false, statusCode: number, error: { code: string, message: string }, requestId: string }}
 */
function requireAdminAuth(event, requestId = "", requiredRole = null) {
  const secret = process.env.GHOSTAI_ADMIN_AUTH_TOKEN;

  // Fail closed if server admin token is not configured
  if (!secret || typeof secret !== "string" || !secret.trim()) {
    return {
      ok: false,
      statusCode: 500,
      error: {
        code: ERROR_CODES.GATEWAY_NOT_CONFIGURED,
        message: "Admin authentication is not configured on the server.",
      },
      requestId,
    };
  }

  const trimmedSecret = secret.trim();

  // 1. Check Session Cookie first
  const cookies = parseCookies(event);
  const sessionToken = cookies[ADMIN_COOKIE_NAME];
  if (sessionToken) {
    const payload = parseAdminSessionToken(sessionToken, trimmedSecret);
    if (payload) {
      const admin = {
        id: payload.adminId || "system_owner",
        email: payload.email || "owner@ghostai.internal",
        name: payload.name || "GhostAI Owner",
        role: payload.role,
        keyId: payload.keyId || null,
        sessionVersion: payload.sessionVersion || 0,
      };

      if (requiredRole === "owner" && admin.role !== "owner") {
        return {
          ok: false,
          statusCode: 403,
          error: {
            code: "FORBIDDEN",
            message: "Acceso denegado: solo el OWNER puede realizar esta acción.",
          },
          requestId,
        };
      }

      return { ok: true, admin };
    }
  }

  // 2. Check Authorization Header as fallback (Bearer GHOSTAI_ADMIN_AUTH_TOKEN)
  const authHeader =
    event?.headers?.authorization ||
    event?.headers?.Authorization ||
    event?.headers?.AUTHORIZATION;

  if (authHeader && typeof authHeader === "string" && authHeader.trim()) {
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      const token = parts[1];
      if (token) {
        const expectedBuf = Buffer.from(trimmedSecret, "utf8");
        const actualBuf = Buffer.from(token.trim(), "utf8");

        if (
          expectedBuf.length === actualBuf.length &&
          crypto.timingSafeEqual(expectedBuf, actualBuf)
        ) {
          return {
            ok: true,
            admin: {
              id: "00000000-0000-0000-0000-000000000000",
              email: "owner@ghostai.internal",
              name: "GhostAI Owner",
              role: "owner",
            },
          };
        }
      }
    }
  }

  // If neither cookie nor bearer token is valid:
  return {
    ok: false,
    statusCode: 401,
    error: {
      code: ERROR_CODES.AUTH_INVALID,
      message: "Admin authorization required.",
    },
    requestId,
  };
}

module.exports = {
  ADMIN_COOKIE_NAME,
  requireAdminAuth,
  buildAdminSessionCookie,
  buildAdminLogoutCookie,
  verifyAdminSessionToken,
  parseAdminSessionToken,
  generateAdminSessionToken,
};
