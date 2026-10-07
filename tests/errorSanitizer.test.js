/**
 * @file tests/errorSanitizer.test.js
 * Test suite for Error Catalog and Operational Sanitizer.
 */

"use strict";

const { TtsErrorCode, TtsOperationStage, sanitizeOperationalError } = require("../netlify/functions/lib/errorCatalog");

describe("Error Catalog & Sanitizer", () => {
  test("Catalog contains all required error codes", () => {
    const requiredCodes = [
      "GHOSTAI_AUTH_INVALID",
      "GHOSTAI_CLIENT_SUSPENDED",
      "GHOSTAI_TOKEN_REVOKED",
      "ELEVENLABS_NOT_CONNECTED",
      "ELEVENLABS_AUTH_FAILED",
      "ELEVENLABS_GENERATION_FAILED",
      "ELEVENLABS_RATE_LIMITED",
      "RECOVERY_SESSION_CREATE_FAILED",
      "RECOVERY_STORAGE_FAILED",
      "RECOVERY_FETCH_FAILED",
      "RECOVERY_EXPIRED",
      "ZIP_BUILD_FAILED",
      "ZIP_TRANSFER_FAILED",
      "POPUP_BLOCKED",
      "BRIDGE_TIMEOUT",
      "RECEIVER_INHERITED_SANDBOX",
      "DOWNLOAD_TRIGGER_FAILED",
      "ZIP_VERIFICATION_FAILED",
      "ZIP_INTEGRITY_MISMATCH",
      "UNKNOWN_ERROR",
    ];

    for (const code of requiredCodes) {
      expect(TtsErrorCode[code]).toBe(code);
    }
  });

  test("Sanitizer strips client keys (gai_live_...)", () => {
    const msg = "Failed request for gai_live_ab12cd34.secret_1234567890abcdef on server";
    const sanitized = sanitizeOperationalError(msg);
    expect(sanitized).not.toContain("secret_1234567890abcdef");
    expect(sanitized).toContain("gai_live_[REDACTED]");
  });

  test("Sanitizer strips provider API keys (sk_...)", () => {
    const msg = "Invalid key sk_test_123456789012345678901234567890 for ElevenLabs";
    const sanitized = sanitizeOperationalError(msg);
    expect(sanitized).not.toContain("sk_test_123456789012345678901234567890");
    expect(sanitized).toContain("sk_[REDACTED]");
  });

  test("Sanitizer strips JWT tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozG4m1e_fake_signature_12345";
    const msg = `Supabase request failed with token ${jwt}`;
    const sanitized = sanitizeOperationalError(msg);
    expect(sanitized).not.toContain(jwt);
    expect(sanitized).toContain("[JWT_REDACTED]");
  });

  test("Sanitizer strips Authorization headers and Cookies", () => {
    const msg = "Headers: Authorization: Bearer some_secret_bearer_token; Cookie: session=secret_cookie_val";
    const sanitized = sanitizeOperationalError(msg);
    expect(sanitized).not.toContain("some_secret_bearer_token");
    expect(sanitized).not.toContain("secret_cookie_val");
  });
});
