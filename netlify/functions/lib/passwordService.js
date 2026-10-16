/**
 * @file netlify/functions/lib/passwordService.js
 * Secure password hashing using Node.js crypto.scrypt.
 * Format: scrypt:<salt_hex>:<hash_hex>
 */

"use strict";

const crypto = require("crypto");

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELISM = 1; // p

/**
 * Hashes a plaintext password using crypto.scrypt.
 * @param {string} password
 * @returns {Promise<string>}
 */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    if (!password || typeof password !== "string" || password.length < 8) {
      return reject(new Error("Password must be at least 8 characters long."));
    }

    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM },
      (err, derivedKey) => {
        if (err) return reject(err);
        resolve(`scrypt:${salt}:${derivedKey.toString("hex")}`);
      }
    );
  });
}

/**
 * Verifies a password against a stored scrypt hash string.
 * @param {string} password
 * @param {string} storedHash
 * @returns {Promise<boolean>}
 */
function verifyPassword(password, storedHash) {
  return new Promise((resolve) => {
    if (!password || !storedHash || typeof storedHash !== "string") {
      return resolve(false);
    }

    const parts = storedHash.split(":");
    if (parts.length !== 3 || parts[0] !== "scrypt") {
      return resolve(false);
    }

    const salt = parts[1];
    const expectedHashBuf = Buffer.from(parts[2], "hex");

    crypto.scrypt(
      password,
      salt,
      expectedHashBuf.length,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM },
      (err, derivedKey) => {
        if (err) return resolve(false);
        if (derivedKey.length !== expectedHashBuf.length) return resolve(false);
        try {
          resolve(crypto.timingSafeEqual(derivedKey, expectedHashBuf));
        } catch (_) {
          resolve(false);
        }
      }
    );
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
};
