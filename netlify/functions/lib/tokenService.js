/**
 * @file tokenService.js
 * Cryptographic token generator and validator for GhostAI Client Access Tokens.
 *
 * Token Format:
 *   gai_live_<publicId>.<secret>
 *   - publicId: 16 hex characters (64 bits of entropy) for database index lookup
 *   - secret: 64 hex characters (32 bytes = 256 bits of cryptographic entropy)
 *
 * Hash Algorithm:
 *   HMAC-SHA256 with server-side pepper from GHOSTAI_TOKEN_HASH_PEPPER.
 *   Stored in database as secret_hash.
 *
 * Never logs or reveals plaintext secrets, pepper, or full tokens.
 */

"use strict";

const crypto = require("crypto");
const db = require("./db");

const TOKEN_PREFIX = "gai_live_";
const TOKEN_REGEX = /^gai_live_([a-zA-Z0-9_-]{8,32})\.([a-zA-Z0-9_-]{32,128})$/;

/**
 * Reads the server-side pepper for token hashing.
 * Fails closed if not set or empty.
 * @returns {string}
 */
function getPepper() {
  const pepper = process.env.GHOSTAI_TOKEN_HASH_PEPPER;
  if (!pepper || typeof pepper !== "string" || !pepper.trim()) {
    throw new Error("GHOSTAI_TOKEN_HASH_PEPPER_MISSING");
  }
  return pepper.trim();
}

/**
 * Computes the HMAC-SHA256 hash of a token secret using the pepper.
 * @param {string} secret
 * @param {string} [pepper]
 * @returns {string} Hex-encoded HMAC
 */
function hashSecret(secret, pepper = null) {
  const activePepper = pepper || getPepper();
  return crypto.createHmac("sha256", activePepper).update(secret, "utf8").digest("hex");
}

/**
 * Safely compares candidate secret hash against stored secret hash using constant time.
 * @param {string} candidateSecret
 * @param {string} storedHash
 * @param {string} [pepper]
 * @returns {boolean}
 */
function verifySecret(candidateSecret, storedHash, pepper = null) {
  if (!candidateSecret || !storedHash) return false;
  try {
    const candidateHash = hashSecret(candidateSecret, pepper);
    const candidateBuf = Buffer.from(candidateHash, "utf8");
    const storedBuf = Buffer.from(storedHash, "utf8");

    if (candidateBuf.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(candidateBuf, storedBuf);
  } catch (_) {
    return false;
  }
}

/**
 * Generates a new client access token, hashes the secret, and persists the record.
 * Returns the full token string ONLY ONCE.
 *
 * @param {{
 *   clientId: string,
 *   label?: string | null,
 *   expiresAt?: string | null
 * }} params
 * @returns {Promise<{
 *   token: string,
 *   tokenId: string,
 *   clientId: string,
 *   label: string | null,
 *   createdAt: string,
 *   expiresAt: string | null
 * }>}
 */
async function generateClientToken({ clientId, label = null, expiresAt = null }) {
  // Validate client exists and is active
  const client = await db.getClientById(clientId);
  if (!client) {
    const err = new Error("Client not found");
    err.code = "CLIENT_NOT_FOUND";
    throw err;
  }
  if (client.status !== "active") {
    const err = new Error("Client is not active");
    err.code = "CLIENT_NOT_ACTIVE";
    throw err;
  }

  // Generate publicId (16 hex chars) and secret (64 hex chars = 256 bits)
  const publicId = crypto.randomBytes(8).toString("hex");
  const secret = crypto.randomBytes(32).toString("hex");
  const fullToken = `${TOKEN_PREFIX}${publicId}.${secret}`;

  // Hash the secret with pepper
  const secretHash = hashSecret(secret);

  // Persist record to DB (stores publicId, hash, metadata — NEVER full token or secret)
  const record = await db.createTokenRecord({
    clientId,
    tokenPublicId: publicId,
    secretHash,
    label: label || null,
    expiresAt: expiresAt || null,
  });

  return {
    token: fullToken,
    tokenId: record.id,
    clientId: record.client_id,
    label: record.label,
    createdAt: record.created_at,
    expiresAt: record.expires_at,
  };
}

/**
 * Parses and validates the structure of a client access token.
 * @param {string} tokenString
 * @returns {{ valid: boolean, publicId?: string, secret?: string }}
 */
function parseToken(tokenString) {
  if (!tokenString || typeof tokenString !== "string") {
    return { valid: false };
  }
  const match = tokenString.trim().match(TOKEN_REGEX);
  if (!match) {
    return { valid: false };
  }
  return {
    valid: true,
    publicId: match[1],
    secret: match[2],
  };
}

module.exports = {
  TOKEN_PREFIX,
  TOKEN_REGEX,
  getPepper,
  hashSecret,
  verifySecret,
  generateClientToken,
  parseToken,
};
