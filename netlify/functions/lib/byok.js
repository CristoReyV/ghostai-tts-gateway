/**
 * @file byok.js
 * Bring-Your-Own-Key (BYOK) session helpers for the ElevenLabs provider.
 *
 * Security & Identity Binding:
 *  - The user's ElevenLabs API key is NEVER stored by the Gateway and NEVER
 *    returned to the browser.
 *  - In v2, the encrypted cookie payload binds the API key to the GhostAI identity
 *    (principalId):
 *    {
 *      "v": 2,
 *      "provider": "elevenlabs",
 *      "principalId": "...",
 *      "apiKey": "..."
 *    }
 *  - Only the Gateway can decrypt it using AES-256-GCM.
 *  - Cross-client cookie reuse is strictly blocked (fail-closed, mismatch check).
 *  - Legacy v1 cookies without principalId fail closed (user must reconnect).
 */

"use strict";

const { encryptCredential, decryptCredential, isEncryptionConfigured } = require("./credentialCrypto");
const { ERROR_CODES, makeError } = require("./errors");

/** `__Host-` prefix: requires Secure, Path=/ and forbids Domain → host-only cookie. */
const BYOK_COOKIE_NAME = "__Host-ghostai_elevenlabs";

/**
 * Attributes shared by set and clear. Intentionally NO `Domain`, NO `Expires`,
 * NO `Max-Age` on set → browser-session cookie.
 */
const COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";

/** User-facing message when no valid BYOK connection exists. */
const NOT_CONNECTED_MESSAGE = "Conecta tu cuenta de ElevenLabs antes de generar.";

/** User-facing message when ElevenLabs rejects a previously connected key. */
const KEY_REJECTED_MESSAGE =
  "ElevenLabs rechazó tu API key (revocada o inválida). Vuelve a conectar tu cuenta de ElevenLabs.";

/**
 * @param {string} ciphertext  value produced by encryptCredential()
 * @returns {string} Set-Cookie header value
 */
function buildSetCookie(ciphertext) {
  return `${BYOK_COOKIE_NAME}=${ciphertext}; ${COOKIE_ATTRIBUTES}`;
}

/**
 * @returns {string} Set-Cookie header value that expires the BYOK cookie.
 */
function buildClearCookie() {
  return `${BYOK_COOKIE_NAME}=; ${COOKIE_ATTRIBUTES}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/**
 * Extracts the raw BYOK cookie value from a Netlify Functions event.
 * Supports `headers.cookie` (any casing) and `multiValueHeaders.cookie`.
 *
 * @param {object} event
 * @returns {string | null}
 */
function readByokCookie(event) {
  const headers = (event && event.headers) || {};
  const multi = (event && event.multiValueHeaders) || {};

  const candidates = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "cookie" && typeof value === "string") candidates.push(value);
  }
  for (const [name, values] of Object.entries(multi)) {
    if (name.toLowerCase() === "cookie" && Array.isArray(values)) {
      for (const v of values) if (typeof v === "string") candidates.push(v);
    }
  }

  for (const header of candidates) {
    for (const pair of header.split(";")) {
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      if (name === BYOK_COOKIE_NAME) {
        const value = pair.slice(idx + 1).trim();
        return value || null;
      }
    }
  }
  return null;
}

/**
 * Resolves the user's ElevenLabs API key from the BYOK session cookie,
 * ensuring the session cookie belongs to the authenticated principal.
 *
 * @param {object} event
 * @param {string | null} [expectedPrincipalId=null] - The authenticated principalId
 * @returns {
 *   | { ok: true; apiKey: string; principalId: string }
 *   | { ok: false; reason: "not_configured" | "missing" | "invalid"; mismatch?: boolean }
 * }
 */
function resolveByokApiKey(event, expectedPrincipalId = null) {
  if (!isEncryptionConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  const token = readByokCookie(event);
  if (!token) {
    return { ok: false, reason: "missing" };
  }
  const decrypted = decryptCredential(token);
  if (!decrypted) {
    return { ok: false, reason: "invalid" };
  }

  // Parse JSON payload (v2 format with principalId binding)
  let parsed;
  try {
    parsed = JSON.parse(decrypted);
  } catch (_) {
    // Legacy v1 format (raw string without principalId) -> fail closed
    return { ok: false, reason: "invalid" };
  }

  if (
    !parsed ||
    parsed.v !== 2 ||
    parsed.provider !== "elevenlabs" ||
    !parsed.principalId ||
    !parsed.apiKey
  ) {
    return { ok: false, reason: "invalid" };
  }

  // Verify principal binding if expectedPrincipalId is specified
  if (expectedPrincipalId && parsed.principalId !== expectedPrincipalId) {
    return { ok: false, reason: "invalid", mismatch: true };
  }

  if (!isPlausibleApiKey(parsed.apiKey)) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, apiKey: parsed.apiKey, principalId: parsed.principalId };
}

/**
 * Structural validation for a user-supplied ElevenLabs API key.
 * Does NOT prove validity — only that it is a sane, header-safe token.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlausibleApiKey(value) {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 200 &&
    /^[\x21-\x7E]+$/.test(value) // printable ASCII, no whitespace/control chars
  );
}

/**
 * Encrypts a validated API key bound to principalId and returns the Set-Cookie header value.
 * @param {string} apiKey
 * @param {string} [principalId="legacy_operator"]
 * @returns {string}
 */
function issueByokCookie(apiKey, principalId = "legacy_operator") {
  const payload = JSON.stringify({
    v: 2,
    provider: "elevenlabs",
    principalId: String(principalId || "legacy_operator"),
    apiKey,
  });
  return buildSetCookie(encryptCredential(payload));
}

/**
 * Maps a failed resolveByokApiKey() result to a normalised public error.
 * The response never reveals cryptographic details.
 *
 * @param {{ reason: string }} resolution
 * @param {string} requestId
 * @returns {{ statusCode: number; error: { code: string; message: string }; requestId: string; clearCookie: boolean }}
 */
function byokFailureError(resolution, requestId) {
  if (resolution.reason === "not_configured") {
    return {
      ...makeError(503, ERROR_CODES.GATEWAY_NOT_CONFIGURED, "BYOK credential encryption is not configured on the server.", requestId),
      clearCookie: false,
    };
  }
  return {
    ...makeError(428, ERROR_CODES.ELEVENLABS_NOT_CONNECTED, NOT_CONNECTED_MESSAGE, requestId),
    clearCookie: resolution.reason === "invalid",
  };
}

module.exports = {
  BYOK_COOKIE_NAME,
  NOT_CONNECTED_MESSAGE,
  KEY_REJECTED_MESSAGE,
  buildSetCookie,
  buildClearCookie,
  readByokCookie,
  resolveByokApiKey,
  isPlausibleApiKey,
  issueByokCookie,
  byokFailureError,
};
