/**
 * @file tests/tts-provider-elevenlabs.test.js
 * Comprehensive integration tests for BYOK connect, status, and disconnect endpoints.
 * All ElevenLabs calls are strictly mocked. No external requests or credits.
 */

"use strict";

jest.mock("../netlify/functions/providers", () => ({
  getProvider: jest.fn(),
}));

const { getProvider } = require("../netlify/functions/providers");
const { handler: connectHandler } = require("../netlify/functions/tts-provider-elevenlabs-connect");
const { handler: statusHandler } = require("../netlify/functions/tts-provider-elevenlabs-status");
const { handler: disconnectHandler } = require("../netlify/functions/tts-provider-elevenlabs-disconnect");
const { BYOK_COOKIE_NAME, issueByokCookie } = require("../netlify/functions/lib/byok");

const TEST_OPERATOR_TOKEN = "test-operator-token";
const TEST_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeEvent(method, body = null, cookie = null, auth = `Bearer ${TEST_OPERATOR_TOKEN}`, origin = "https://studio.ghostai.io") {
  const headers = { origin };
  if (auth) headers.authorization = auth;
  if (cookie) headers.cookie = cookie;
  return {
    httpMethod: method,
    headers,
    body: body ? JSON.stringify(body) : null,
    queryStringParameters: {},
  };
}

describe("BYOK Provider Endpoints (Connect / Status / Disconnect)", () => {
  let mockVerifyApiKey;

  beforeEach(() => {
    process.env.GHOSTAI_STUDIO_AUTH_TOKEN = TEST_OPERATOR_TOKEN;
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_HEX;

    mockVerifyApiKey = jest.fn().mockResolvedValue({
      ok: true,
      tier: "starter",
      status: "active",
    });

    getProvider.mockReturnValue({
      verifyApiKey: mockVerifyApiKey,
    });
  });

  afterEach(() => {
    delete process.env.GHOSTAI_STUDIO_AUTH_TOKEN;
    delete process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY;
  });

  // ── CONNECT ─────────────────────────────────────────────────────────────────

  describe("POST /api/tts/provider/elevenlabs/connect", () => {
    test("rejects request without operator Bearer auth", async () => {
      const res = await connectHandler(makeEvent("POST", { apiKey: "sk_test12345678901234567890" }, null, null));
      expect(res.statusCode).toBe(401);
      const data = JSON.parse(res.body);
      expect(data.error.code).toBe("AUTH_REQUIRED");
      expect(mockVerifyApiKey).not.toHaveBeenCalled();
      expect(res.headers["Set-Cookie"]).toBeUndefined();
    });

    test("rejects request with invalid operator token", async () => {
      const res = await connectHandler(makeEvent("POST", { apiKey: "sk_test12345678901234567890" }, null, "Bearer bad-token"));
      expect(res.statusCode).toBe(401);
      const data = JSON.parse(res.body);
      expect(data.error.code).toBe("AUTH_INVALID");
      expect(mockVerifyApiKey).not.toHaveBeenCalled();
      expect(res.headers["Set-Cookie"]).toBeUndefined();
    });

    test("rejects missing apiKey in body", async () => {
      const res = await connectHandler(makeEvent("POST", {}));
      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error.code).toBe("VALIDATION_MISSING_FIELD");
      expect(mockVerifyApiKey).not.toHaveBeenCalled();
    });

    test("rejects empty / whitespace-only apiKey", async () => {
      const res = await connectHandler(makeEvent("POST", { apiKey: "   " }));
      expect(res.statusCode).toBe(400);
      expect(mockVerifyApiKey).not.toHaveBeenCalled();
    });

    test("rejects implausible / too short apiKey", async () => {
      const res = await connectHandler(makeEvent("POST", { apiKey: "short" }));
      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error.code).toBe("ELEVENLABS_INVALID_API_KEY");
      expect(mockVerifyApiKey).not.toHaveBeenCalled();
    });

    test("when ElevenLabs rejects key, returns 401 and issues NO cookie", async () => {
      mockVerifyApiKey.mockResolvedValueOnce({
        ok: false,
        statusCode: 401,
        error: { code: "ELEVENLABS_INVALID_API_KEY", message: "API key de ElevenLabs inválida o sin permisos." },
      });

      const res = await connectHandler(makeEvent("POST", { apiKey: "sk_invalid_elevenlabs_key_12345" }));
      expect(res.statusCode).toBe(401);
      const data = JSON.parse(res.body);
      expect(data.error.code).toBe("ELEVENLABS_INVALID_API_KEY");
      expect(res.headers["Set-Cookie"]).toBeUndefined();
      expect(res.headers["Cache-Control"]).toBe("no-store");
    });

    test("when key is valid, returns 200 with Set-Cookie HttpOnly/Secure/SameSite=Strict and safe metadata", async () => {
      const inputKey = "sk_valid_elevenlabs_key_1234567890";
      const res = await connectHandler(makeEvent("POST", { apiKey: inputKey }));

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.connected).toBe(true);
      expect(data.provider).toBe("elevenlabs");
      expect(data.tier).toBe("starter");

      // CRITICAL: NEVER leak key, partial key, or ciphertext in body
      expect(res.body).not.toContain(inputKey);
      expect(res.body).not.toContain("v1.");

      // Check cookie headers
      const setCookie = res.headers["Set-Cookie"];
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain(`${BYOK_COOKIE_NAME}=v1.`);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).not.toContain("Domain=");
      expect(res.headers["Cache-Control"]).toBe("no-store");
    });

    test("fails closed with 500 when server master encryption key is missing", async () => {
      delete process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY;
      const res = await connectHandler(makeEvent("POST", { apiKey: "sk_valid_elevenlabs_key_1234567890" }));
      expect(res.statusCode).toBe(500);
      const data = JSON.parse(res.body);
      expect(data.error.code).toBe("GATEWAY_NOT_CONFIGURED");
      expect(res.headers["Set-Cookie"]).toBeUndefined();
    });
  });

  // ── STATUS ──────────────────────────────────────────────────────────────────

  describe("GET /api/tts/provider/elevenlabs/status", () => {
    test("rejects status request without operator Bearer auth", async () => {
      const res = await statusHandler(makeEvent("GET", null, null, null));
      expect(res.statusCode).toBe(401);
    });

    test("returns connected: false when no BYOK cookie is present", async () => {
      const res = await statusHandler(makeEvent("GET"));
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.connected).toBe(false);
      expect(data.provider).toBe("elevenlabs");
      expect(res.headers["Cache-Control"]).toBe("no-store");
      // Does NOT call ElevenLabs
      expect(mockVerifyApiKey).not.toHaveBeenCalled();
    });

    test("returns connected: true when valid BYOK cookie is present", async () => {
      const cookieHeader = issueByokCookie("sk_active_user_key_1234567890");
      const cookieVal = cookieHeader.split(";")[0];

      const res = await statusHandler(makeEvent("GET", null, cookieVal));
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.connected).toBe(true);
      expect(data.provider).toBe("elevenlabs");
      expect(res.headers["Cache-Control"]).toBe("no-store");
      // Still does NOT call ElevenLabs (fast in-memory decryption)
      expect(mockVerifyApiKey).not.toHaveBeenCalled();
    });

    test("returns connected: false and expires cookie when cookie is tampered", async () => {
      const tamperedCookie = `${BYOK_COOKIE_NAME}=v1.tampered.bad.tag`;
      const res = await statusHandler(makeEvent("GET", null, tamperedCookie));
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.connected).toBe(false);

      const setCookie = res.headers["Set-Cookie"];
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("Max-Age=0");
    });
  });

  // ── DISCONNECT ──────────────────────────────────────────────────────────────

  describe("POST /api/tts/provider/elevenlabs/disconnect", () => {
    test("rejects disconnect without operator Bearer auth", async () => {
      const res = await disconnectHandler(makeEvent("POST", null, null, null));
      expect(res.statusCode).toBe(401);
    });

    test("clears cookie and returns connected: false", async () => {
      const res = await disconnectHandler(makeEvent("POST"));
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.connected).toBe(false);

      const setCookie = res.headers["Set-Cookie"];
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain(`${BYOK_COOKIE_NAME}=`);
      expect(setCookie).toContain("Max-Age=0");
      expect(setCookie).toContain("Expires=");
      expect(res.headers["Cache-Control"]).toBe("no-store");
      expect(mockVerifyApiKey).not.toHaveBeenCalled();
    });
  });
});
