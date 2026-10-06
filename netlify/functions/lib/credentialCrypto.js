/**
 * @file credentialCrypto.js
 * Server-side authenticated encryption for BYOK provider credentials.
 *
 * Algorithm: AES-256-GCM
 *   - 32-byte master key from GHOSTAI_CREDENTIAL_ENCRYPTION_KEY (server-only secret)
 *   - fresh random 96-bit IV per encryption
 *   - 128-bit authentication tag
 *   - fixed AAD binding the ciphertext to its purpose/version
 *
 * Serialized, versioned format (all segments Base64URL, no padding):
 *   v1.<iv>.<ciphertext>.<authTag>
 *
 * Fail-closed: any malformed input, wrong key, tampered segment or missing /
 * invalid master key results in `null` (decrypt) or a thrown error (encrypt).
 * Never logs or returns the master key or plaintext.
 */

"use strict";

const crypto = require("crypto");

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const AAD = Buffer.from("ghostai-byok:elevenlabs:v1", "utf8");
const MAX_PLAINTEXT_BYTES = 512;
const MAX_TOKEN_LENGTH = 2048;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Reads and decodes the master key at call time (so tests can override env).
 * Accepts 64 hex chars, or Base64 / Base64URL that decodes to exactly 32 bytes.
 *
 * @returns {Buffer | null} 32-byte key, or null if missing / invalid.
 */
function getMasterKey() {
  const raw = process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw || typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    key = Buffer.from(normalized, "base64");
  }

  if (!key || key.length !== KEY_BYTES) return null;

  // Reject degenerate keys (e.g. all-zero / single repeated byte)
  if (key.every((b) => b === key[0])) return null;

  return key;
}

/**
 * @returns {boolean} true when a valid 32-byte master key is configured.
 */
function isEncryptionConfigured() {
  return getMasterKey() !== null;
}

/**
 * Encrypts a credential with AES-256-GCM.
 *
 * @param {string} plaintext
 * @returns {string} `v1.<iv>.<ciphertext>.<tag>`
 * @throws {Error} when the master key is missing/invalid or plaintext is unusable.
 */
function encryptCredential(plaintext) {
  const key = getMasterKey();
  if (!key) {
    throw new Error("BYOK_ENCRYPTION_NOT_CONFIGURED");
  }
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("BYOK_INVALID_PLAINTEXT");
  }
  const data = Buffer.from(plaintext, "utf8");
  if (data.length > MAX_PLAINTEXT_BYTES) {
    throw new Error("BYOK_INVALID_PLAINTEXT");
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

/**
 * Decrypts and authenticates a token produced by encryptCredential().
 *
 * @param {string} token
 * @returns {string | null} plaintext, or null on ANY failure (fail closed).
 */
function decryptCredential(token) {
  try {
    const key = getMasterKey();
    if (!key) return null;
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) return null;

    const parts = token.split(".");
    if (parts.length !== 4) return null;
    const [version, ivB64, ctB64, tagB64] = parts;
    if (version !== VERSION) return null;
    if (![ivB64, ctB64, tagB64].every((p) => p && B64URL_RE.test(p))) return null;

    const iv = Buffer.from(ivB64, "base64url");
    const ciphertext = Buffer.from(ctB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    if (ciphertext.length === 0 || ciphertext.length > MAX_PLAINTEXT_BYTES) return null;

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return plaintext || null;
  } catch (_) {
    // Authentication failure / malformed input — never leak the reason.
    return null;
  }
}

module.exports = {
  encryptCredential,
  decryptCredential,
  isEncryptionConfigured,
  // exported for tests only
  _internals: { VERSION, IV_BYTES, TAG_BYTES, KEY_BYTES },
};
