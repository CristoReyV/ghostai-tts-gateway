/**
 * @file tests/credentialCrypto.test.js
 * Unit tests for AES-256-GCM authenticated credential encryption.
 */

"use strict";

const crypto = require("crypto");
const {
  encryptCredential,
  decryptCredential,
  isEncryptionConfigured,
} = require("../netlify/functions/lib/credentialCrypto");

const TEST_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_KEY_B64 = Buffer.from(TEST_KEY_HEX, "hex").toString("base64");

describe("credentialCrypto — AES-256-GCM", () => {
  afterEach(() => {
    delete process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY;
  });

  test("isEncryptionConfigured returns false when env var is absent", () => {
    delete process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY;
    expect(isEncryptionConfigured()).toBe(false);
  });

  test("isEncryptionConfigured returns false for degenerate/short keys", () => {
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = "too-short";
    expect(isEncryptionConfigured()).toBe(false);

    // 32 zero bytes
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = "00".repeat(32);
    expect(isEncryptionConfigured()).toBe(false);
  });

  test("isEncryptionConfigured returns true for valid 64-hex key", () => {
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_HEX;
    expect(isEncryptionConfigured()).toBe(true);
  });

  test("isEncryptionConfigured returns true for valid base64 key", () => {
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_B64;
    expect(isEncryptionConfigured()).toBe(true);
  });

  test("encryptCredential fails when master key is missing", () => {
    delete process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptCredential("sk_test12345678901234567890")).toThrow(
      "BYOK_ENCRYPTION_NOT_CONFIGURED"
    );
  });

  test("encrypt and decrypt roundtrip preserves exact plaintext", () => {
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_HEX;
    const plaintext = "sk_live_abcdef1234567890_elevenlabs_key";
    const token = encryptCredential(plaintext);

    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain(plaintext);

    const decrypted = decryptCredential(token);
    expect(decrypted).toBe(plaintext);
  });

  test("two encryptions of the same plaintext produce different ciphertexts (random IV)", () => {
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_HEX;
    const plaintext = "sk_same_key_test_1234567890";
    const tokenA = encryptCredential(plaintext);
    const tokenB = encryptCredential(plaintext);

    expect(tokenA).not.toBe(tokenB);
    expect(decryptCredential(tokenA)).toBe(plaintext);
    expect(decryptCredential(tokenB)).toBe(plaintext);
  });

  test("decryptCredential fails closed (returns null) on tampered ciphertext", () => {
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_HEX;
    const token = encryptCredential("sk_test_key_value_1234567890");
    const parts = token.split(".");

    // Flip a character in ciphertext
    const ctChars = parts[2].split("");
    ctChars[0] = ctChars[0] === "A" ? "B" : "A";
    const tampered = [parts[0], parts[1], ctChars.join(""), parts[3]].join(".");

    expect(decryptCredential(tampered)).toBeNull();
  });

  test("decryptCredential fails closed on tampered auth tag", () => {
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_HEX;
    const token = encryptCredential("sk_test_key_value_1234567890");
    const parts = token.split(".");

    const tagChars = parts[3].split("");
    tagChars[0] = tagChars[0] === "Z" ? "Y" : "Z";
    const tampered = [parts[0], parts[1], parts[2], tagChars.join("")].join(".");

    expect(decryptCredential(tampered)).toBeNull();
  });

  test("decryptCredential fails closed on tampered IV", () => {
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_HEX;
    const token = encryptCredential("sk_test_key_value_1234567890");
    const parts = token.split(".");

    const ivChars = parts[1].split("");
    ivChars[0] = ivChars[0] === "X" ? "W" : "X";
    const tampered = [parts[0], ivChars.join(""), parts[2], parts[3]].join(".");

    expect(decryptCredential(tampered)).toBeNull();
  });

  test("decryptCredential fails closed with wrong master key", () => {
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_HEX;
    const token = encryptCredential("sk_test_key_value_1234567890");

    // Change master key
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY =
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    expect(decryptCredential(token)).toBeNull();
  });

  test("decryptCredential fails closed on malformed / truncated tokens", () => {
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_HEX;
    expect(decryptCredential("")).toBeNull();
    expect(decryptCredential("not-a-token")).toBeNull();
    expect(decryptCredential("v2.iv.ct.tag")).toBeNull();
    expect(decryptCredential("v1.iv.ct")).toBeNull();
    expect(decryptCredential(null)).toBeNull();
  });
});
