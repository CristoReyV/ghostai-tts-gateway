/**
 * @file adminAuth.js
 * Dedicated administrator authentication middleware for management endpoints.
 * Validates GHOSTAI_ADMIN_AUTH_TOKEN server-side.
 * Rejects client access tokens and legacy tokens on admin endpoints.
 */

"use strict";

const crypto = require("crypto");
const { ERROR_CODES } = require("./errors");

/**
 * Validates the admin bearer token from the request Authorization header.
 *
 * @param {object} event - Netlify function event
 * @param {string} [requestId=""] - Optional request ID for error payload
 * @returns {{ ok: true } | { ok: false, statusCode: number, error: { code: string, message: string }, requestId: string }}
 */
function requireAdminAuth(event, requestId = "") {
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

  const authHeader =
    event?.headers?.authorization ||
    event?.headers?.Authorization ||
    event?.headers?.AUTHORIZATION;

  if (!authHeader || typeof authHeader !== "string" || !authHeader.trim()) {
    return {
      ok: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_REQUIRED,
        message: "Authorization header is required.",
      },
      requestId,
    };
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return {
      ok: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_INVALID,
        message: "Invalid authorization scheme.",
      },
      requestId,
    };
  }

  const token = parts[1];
  if (!token) {
    return {
      ok: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_INVALID,
        message: "Authorization token cannot be empty.",
      },
      requestId,
    };
  }

  const expectedBuf = Buffer.from(secret.trim(), "utf8");
  const actualBuf = Buffer.from(token.trim(), "utf8");

  if (
    expectedBuf.length !== actualBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, actualBuf)
  ) {
    return {
      ok: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_INVALID,
        message: "Invalid admin authorization token.",
      },
      requestId,
    };
  }

  return { ok: true };
}

module.exports = { requireAdminAuth };
