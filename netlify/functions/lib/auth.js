/**
 * @file auth.js
 * GhostAI authentication middleware.
 * Supports:
 *  - Individual client access tokens (gai_live_<publicId>.<secret>) validated against DB with HMAC-SHA256
 *  - Backward-compatible legacy operator token (GHOSTAI_STUDIO_AUTH_TOKEN)
 *
 * Resolves a principal object:
 *   {
 *     authenticated: true,
 *     ok: true,
 *     authMode: "client_token" | "legacy",
 *     principalId: string,
 *     clientId: string | null,
 *     tokenId: string | null,
 *     clientName: string
 *   }
 */

"use strict";

const crypto = require("crypto");
const { ERROR_CODES } = require("./errors");
const db = require("./db");
const { TOKEN_PREFIX, parseToken, verifySecret, getPepper } = require("./tokenService");

/**
 * Validates a legacy operator token against GHOSTAI_STUDIO_AUTH_TOKEN.
 * Synchronous.
 *
 * @param {string} token
 * @param {string} requestId
 * @returns {object}
 */
function verifyLegacyToken(token, requestId) {
  const secret = process.env.GHOSTAI_STUDIO_AUTH_TOKEN;

  if (!secret || typeof secret !== "string" || !secret.trim()) {
    return {
      ok: false,
      authenticated: false,
      statusCode: 500,
      error: {
        code: ERROR_CODES.GATEWAY_NOT_CONFIGURED,
        message: "Gateway operator auth is not configured on the server.",
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
      authenticated: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_INVALID,
        message: "Invalid authorization token.",
      },
      requestId,
    };
  }

  return {
    ok: true,
    authenticated: true,
    authMode: "legacy",
    principalId: "legacy_operator",
    clientId: null,
    tokenId: null,
    clientName: "Legacy Operator",
  };
}

/**
 * Validates a client access token (gai_live_...) against the database.
 * Asynchronous.
 *
 * @param {string} token
 * @param {string} requestId
 * @returns {Promise<object>}
 */
async function verifyClientToken(token, requestId) {
  let pepper;
  try {
    pepper = getPepper();
  } catch (_) {
    return {
      ok: false,
      authenticated: false,
      statusCode: 500,
      error: {
        code: ERROR_CODES.GATEWAY_NOT_CONFIGURED,
        message: "Token hash pepper is not configured on the server.",
      },
      requestId,
    };
  }

  const parsed = parseToken(token);
  if (!parsed.valid) {
    return {
      ok: false,
      authenticated: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_INVALID,
        message: "Invalid authorization token.",
      },
      requestId,
    };
  }

  let tokenRecord;
  try {
    tokenRecord = await db.getTokenByPublicId(parsed.publicId);
  } catch (err) {
    return {
      ok: false,
      authenticated: false,
      statusCode: 500,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: "Database error validating token.",
      },
      requestId,
    };
  }

  if (!tokenRecord) {
    return {
      ok: false,
      authenticated: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_INVALID,
        message: "Invalid authorization token.",
      },
      requestId,
    };
  }

  // Verify HMAC-SHA256 of the secret using timingSafeEqual
  const matches = verifySecret(parsed.secret, tokenRecord.secret_hash, pepper);
  if (!matches) {
    return {
      ok: false,
      authenticated: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_INVALID,
        message: "Invalid authorization token.",
      },
      requestId,
    };
  }

  // Verify token is active
  if (tokenRecord.status === "revoked") {
    return {
      ok: false,
      authenticated: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_INVALID,
        message: "Token has been revoked.",
      },
      requestId,
    };
  }

  // Verify expiration
  if (tokenRecord.expires_at) {
    const expiresTime = new Date(tokenRecord.expires_at).getTime();
    if (expiresTime <= Date.now()) {
      return {
        ok: false,
        authenticated: false,
        statusCode: 401,
        error: {
          code: ERROR_CODES.AUTH_INVALID,
          message: "Token has expired.",
        },
        requestId,
      };
    }
  }

  // Verify client is active (suspension blocks all client tokens immediately)
  let client = tokenRecord.client;
  if (!client) {
    try {
      client = await db.getClientById(tokenRecord.client_id);
    } catch (_) {}
  }

  if (!client || client.status === "suspended") {
    return {
      ok: false,
      authenticated: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_INVALID,
        message: "Client account is suspended.",
      },
      requestId,
    };
  }

  // Non-blocking update of last_used_at
  db.updateTokenLastUsed(tokenRecord.id).catch(() => {});

  return {
    ok: true,
    authenticated: true,
    authMode: "client_token",
    principalId: tokenRecord.client_id,
    clientId: tokenRecord.client_id,
    tokenId: tokenRecord.id,
    clientName: client.name || "Client",
  };
}

/**
 * Authenticates any GhostAI incoming request.
 * Handles both client tokens (asynchronous) and legacy operator tokens (synchronous).
 *
 * @param {object} event - Netlify function event
 * @param {string} [requestId=""] - Optional request ID for error responses
 * @returns {object | Promise<object>}
 */
function authenticateGhostAIRequest(event, requestId = "") {
  const authHeader =
    event?.headers?.authorization ||
    event?.headers?.Authorization ||
    event?.headers?.AUTHORIZATION;

  if (!authHeader || typeof authHeader !== "string" || !authHeader.trim()) {
    return {
      ok: false,
      authenticated: false,
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
      authenticated: false,
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
      authenticated: false,
      statusCode: 401,
      error: {
        code: ERROR_CODES.AUTH_INVALID,
        message: "Authorization token cannot be empty.",
      },
      requestId,
    };
  }

  if (token.startsWith(TOKEN_PREFIX)) {
    return verifyClientToken(token, requestId);
  }

  return verifyLegacyToken(token, requestId);
}

/**
 * Backward-compatible wrapper for existing endpoints.
 * @param {object} event
 * @param {string} [requestId=""]
 * @returns {object | Promise<object>}
 */
function requireOperatorAuth(event, requestId = "") {
  return authenticateGhostAIRequest(event, requestId);
}

module.exports = {
  authenticateGhostAIRequest,
  requireOperatorAuth,
};
