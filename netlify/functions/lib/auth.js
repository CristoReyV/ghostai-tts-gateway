/**
 * @file auth.js
 * Operator Bearer token authentication helper for sensitive endpoints.
 * Validates GHOSTAI_STUDIO_AUTH_TOKEN server-side.
 */

"use strict";

const crypto = require("crypto");
const { ERROR_CODES } = require("./errors");

/**
 * Validates operator Bearer token from the request Authorization header.
 *
 * @param {object} event - Netlify function event
 * @param {string} [requestId=""] - Optional request ID for error payload
 * @returns {{ ok: true } | { ok: false, statusCode: number, error: { code: string, message: string }, requestId: string }}
 */
function requireOperatorAuth(event, requestId = "") {
  const secret = process.env.GHOSTAI_STUDIO_AUTH_TOKEN;

  // Fail closed if the server is not configured with an operator auth token
  if (!secret || typeof secret !== "string" || !secret.trim()) {
    return {
      ok: false,
      statusCode: 500,
      error: {
        code: ERROR_CODES.GATEWAY_NOT_CONFIGURED,
        message: "Gateway operator auth is not configured on the server.",
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

  // Safe timing comparison: compare lengths first, then timingSafeEqual
  const expectedBuf = Buffer.from(secret, "utf8");
  const actualBuf = Buffer.from(token, "utf8");

  if (
    expectedBuf.length !== actualBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, actualBuf)
  ) {
    return {
      ok: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_INVALID,
        message: "Invalid authorization token.",
      },
      requestId,
    };
  }

  return { ok: true };
}

module.exports = { requireOperatorAuth };
