/**
 * @file tests/byok.test.js
 * Unit tests for BYOK cookie construction, parsing, and resolution.
 */

"use strict";

const {
  BYOK_COOKIE_NAME,
  buildSetCookie,
  buildClearCookie,
  readByokCookie,
  resolveByokApiKey,
  isPlausibleApiKey,
  issueByokCookie,
} = require("../netlify/functions/lib/byok");

const TEST_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("BYOK helper utilities", () => {
  beforeEach(() => {
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_HEX;
  });

  afterEach(() => {
    delete process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY;
  });

  test("BYOK_COOKIE_NAME uses __Host- prefix for host-only security", () => {
    expect(BYOK_COOKIE_NAME).toBe("__Host-ghostai_elevenlabs");
  });

  test("buildSetCookie includes HttpOnly, Secure, SameSite=Strict, Path=/ and NO Domain / Max-Age", () => {
    const cookie = buildSetCookie("v1.ciphertext");
    expect(cookie).toContain("__Host-ghostai_elevenlabs=v1.ciphertext");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain("Max-Age=");
    expect(cookie).not.toContain("Expires=");
  });

  test("buildClearCookie expires the cookie with Max-Age=0 and epoch date", () => {
    const clear = buildClearCookie();
    expect(clear).toContain("__Host-ghostai_elevenlabs=");
    expect(clear).toContain("Max-Age=0");
    expect(clear).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });

  test("readByokCookie extracts value from headers.cookie", () => {
    const event = {
      headers: {
        cookie: `other=123; ${BYOK_COOKIE_NAME}=token_value_abc; foo=bar`,
      },
    };
    expect(readByokCookie(event)).toBe("token_value_abc");
  });

  test("readByokCookie extracts value from multiValueHeaders.cookie", () => {
    const event = {
      headers: {},
      multiValueHeaders: {
        cookie: [`session=xyz`, `${BYOK_COOKIE_NAME}=token_from_multi`],
      },
    };
    expect(readByokCookie(event)).toBe("token_from_multi");
  });

  test("readByokCookie returns null when cookie is absent", () => {
    expect(readByokCookie({})).toBeNull();
    expect(readByokCookie({ headers: { cookie: "other=123" } })).toBeNull();
  });

  test("isPlausibleApiKey validates sensible format", () => {
    expect(isPlausibleApiKey("sk_1234567890123456789012345678")).toBe(true);
    expect(isPlausibleApiKey("too-short")).toBe(false);
    expect(isPlausibleApiKey("")).toBe(false);
    expect(isPlausibleApiKey(null)).toBe(false);
    expect(isPlausibleApiKey("with spaces 12345678901234567890")).toBe(false);
  });

  test("issueByokCookie and resolveByokApiKey work end-to-end", () => {
    const rawKey = "sk_valid_elevenlabs_key_1234567890";
    const setCookie = issueByokCookie(rawKey);

    // Extract value between '=' and ';'
    const token = setCookie.split(";")[0].split("=")[1];

    const event = {
      headers: {
        cookie: `${BYOK_COOKIE_NAME}=${token}`,
      },
    };

    const result = resolveByokApiKey(event);
    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe(rawKey);
  });

  test("resolveByokApiKey fails closed when encryption is not configured", () => {
    delete process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY;
    const event = { headers: { cookie: `${BYOK_COOKIE_NAME}=something` } };
    const res = resolveByokApiKey(event);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not_configured");
  });

  test("resolveByokApiKey returns missing when cookie is absent", () => {
    const res = resolveByokApiKey({ headers: {} });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("missing");
  });

  test("resolveByokApiKey returns invalid when token is tampered", () => {
    const event = { headers: { cookie: `${BYOK_COOKIE_NAME}=tampered_token` } };
    const res = resolveByokApiKey(event);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid");
  });
});
