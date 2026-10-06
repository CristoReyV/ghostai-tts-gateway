/**
 * @file tests/byokMultiUser.test.js
 * Multi-User BYOK Identity Binding Tests.
 *
 * Validates that ElevenLabs session cookies are strictly bound to the authenticated
 * GhostAI client principal (principalId).
 * Prevents cross-client credential reuse when multiple clients share a browser.
 * Demonstrates fail-closed behavior on identity mismatch, revocation, and legacy cookies.
 */

"use strict";

const crypto = require("crypto");

// Mock provider before requiring handlers
jest.mock("../netlify/functions/providers", () => ({
  getProvider: jest.fn(),
}));

const { getProvider } = require("../netlify/functions/providers");
const db = require("../netlify/functions/lib/db");
const { generateClientToken } = require("../netlify/functions/lib/tokenService");
const {
  issueByokCookie,
  buildSetCookie,
  BYOK_COOKIE_NAME,
} = require("../netlify/functions/lib/byok");
const { encryptCredential } = require("../netlify/functions/lib/credentialCrypto");
const { handler: generateHandler } = require("../netlify/functions/tts-generate");
const { handler: statusHandler } = require("../netlify/functions/tts-provider-elevenlabs-status");
const { handler: connectHandler } = require("../netlify/functions/tts-provider-elevenlabs-connect");
const { handler: revokeHandler } = require("../netlify/functions/admin-access-tokens-revoke");

const TEST_ADMIN_TOKEN = "TEST_ADMIN_BYOK_TOKEN_123";
const TEST_PEPPER = "TEST_PEPPER_BYOK_PEPPER_456";
const TEST_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_LEGACY_TOKEN = "TEST_LEGACY_STUDIO_AUTH_TOKEN_789";

const KEY_CLIENT_A = "sk_client_a_elevenlabs_key_11111111";
const KEY_CLIENT_B = "sk_client_b_elevenlabs_key_22222222";

const FAKE_AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x04]);

function extractCookieValue(setCookieHeader) {
  if (!setCookieHeader) return "";
  const first = setCookieHeader.split(";")[0];
  return first.trim();
}

describe("BYOK Multi-User Identity Binding & Cross-Client Protection", () => {
  let mockGenerate;
  let mockVerifyApiKey;
  let clientA;
  let tokenA;
  let clientB;
  let tokenB;

  beforeEach(async () => {
    db._setMemoryStoreEnabled(true);
    db._resetMemoryStore();

    process.env.GHOSTAI_ADMIN_AUTH_TOKEN = TEST_ADMIN_TOKEN;
    process.env.GHOSTAI_TOKEN_HASH_PEPPER = TEST_PEPPER;
    process.env.GHOSTAI_STUDIO_AUTH_TOKEN = TEST_LEGACY_TOKEN;
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY_HEX;

    // Create Client A and Client B
    clientA = await db.createClient({ name: "Client A" });
    tokenA = await generateClientToken({ clientId: clientA.id, label: "A Token" });

    clientB = await db.createClient({ name: "Client B" });
    tokenB = await generateClientToken({ clientId: clientB.id, label: "B Token" });

    mockGenerate = jest.fn().mockResolvedValue({
      ok: true,
      audioBuffer: FAKE_AUDIO,
      contentType: "audio/mpeg",
      durationMs: 100,
      responseBytes: FAKE_AUDIO.byteLength,
    });

    mockVerifyApiKey = jest.fn().mockResolvedValue({
      ok: true,
      tier: "starter",
      status: "active",
    });

    getProvider.mockReturnValue({
      generate: mockGenerate,
      verifyApiKey: mockVerifyApiKey,
    });
  });

  afterEach(() => {
    db._resetMemoryStore();
    db._setMemoryStoreEnabled(false);
    delete process.env.GHOSTAI_ADMIN_AUTH_TOKEN;
    delete process.env.GHOSTAI_TOKEN_HASH_PEPPER;
    delete process.env.GHOSTAI_STUDIO_AUTH_TOKEN;
    delete process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY;
  });

  test("Client A connects ElevenLabs and receives cookie bound to Client A", async () => {
    const res = await connectHandler({
      httpMethod: "POST",
      headers: {
        authorization: `Bearer ${tokenA.token}`,
        origin: "https://studio.ghostai.io",
      },
      body: JSON.stringify({ apiKey: KEY_CLIENT_A }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.connected).toBe(true);

    const setCookie = res.headers["Set-Cookie"];
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain(BYOK_COOKIE_NAME);

    // Status check with Client A Bearer returns connected: true
    const statusRes = await statusHandler({
      httpMethod: "GET",
      headers: {
        authorization: `Bearer ${tokenA.token}`,
        cookie: extractCookieValue(setCookie),
        origin: "https://studio.ghostai.io",
      },
    });
    expect(statusRes.statusCode).toBe(200);
    const statusBody = JSON.parse(statusRes.body);
    expect(statusBody.connected).toBe(true);
  });

  test("CRITICAL: Bearer Token B with Cookie A is rejected as NOT_CONNECTED and never invokes ElevenLabs", async () => {
    // 1. Client A creates valid BYOK session
    const cookieAHeader = issueByokCookie(KEY_CLIENT_A, clientA.id);
    const cookieAValue = extractCookieValue(cookieAHeader);

    // 2. Client B sends request with Client B's Bearer token but Client A's Cookie
    const statusRes = await statusHandler({
      httpMethod: "GET",
      headers: {
        authorization: `Bearer ${tokenB.token}`,
        cookie: cookieAValue,
        origin: "https://studio.ghostai.io",
      },
    });

    // Expect status to report connected: false because identity does not match
    expect(statusRes.statusCode).toBe(200);
    const statusBody = JSON.parse(statusRes.body);
    expect(statusBody.connected).toBe(false);

    // Expect cookie clearing header to invalidate the mismatched cookie
    expect(statusRes.headers["Set-Cookie"]).toBeDefined();
    expect(statusRes.headers["Set-Cookie"]).toContain("Max-Age=0");

    // 3. Client B attempts to generate using Client A's cookie
    const genRes = await generateHandler({
      httpMethod: "POST",
      headers: {
        authorization: `Bearer ${tokenB.token}`,
        cookie: cookieAValue,
        origin: "https://studio.ghostai.io",
      },
      body: JSON.stringify({
        provider: "elevenlabs",
        voiceId: "voice-123",
        text: "Testing cross-client protection",
      }),
    });

    // Must fail closed with 428 ELEVENLABS_NOT_CONNECTED
    expect(genRes.statusCode).toBe(428);
    const genBody = JSON.parse(genRes.body);
    expect(genBody.error.code).toBe("ELEVENLABS_NOT_CONNECTED");

    // Client A's key must NEVER be passed to ElevenLabs generate
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test("Client B connects their own key -> connected: true for B, but fails for A", async () => {
    // Client B connects KEY_CLIENT_B
    const connectResB = await connectHandler({
      httpMethod: "POST",
      headers: {
        authorization: `Bearer ${tokenB.token}`,
        origin: "https://studio.ghostai.io",
      },
      body: JSON.stringify({ apiKey: KEY_CLIENT_B }),
    });

    expect(connectResB.statusCode).toBe(200);
    const cookieBValue = extractCookieValue(connectResB.headers["Set-Cookie"]);

    // Client B generates audio successfully
    const genResB = await generateHandler({
      httpMethod: "POST",
      headers: {
        authorization: `Bearer ${tokenB.token}`,
        cookie: cookieBValue,
        origin: "https://studio.ghostai.io",
      },
      body: JSON.stringify({
        provider: "elevenlabs",
        voiceId: "voice-123",
        text: "Client B generation",
      }),
    });

    expect(genResB.statusCode).toBe(200);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: KEY_CLIENT_B })
    );

    // Switching back to Bearer A with Cookie B fails closed
    const genResA = await generateHandler({
      httpMethod: "POST",
      headers: {
        authorization: `Bearer ${tokenA.token}`,
        cookie: cookieBValue,
        origin: "https://studio.ghostai.io",
      },
      body: JSON.stringify({
        provider: "elevenlabs",
        voiceId: "voice-123",
        text: "Client A generation attempt with Cookie B",
      }),
    });

    expect(genResA.statusCode).toBe(428);
    // Provider was not called again
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  test("Revoking Client A token blocks generation with 401 even when valid BYOK cookie exists", async () => {
    // Client A has valid token + valid BYOK cookie
    const cookieAValue = extractCookieValue(issueByokCookie(KEY_CLIENT_A, clientA.id));

    // Admin revokes Token A
    const revokeRes = await revokeHandler({
      httpMethod: "POST",
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({ tokenId: tokenA.tokenId }),
    });
    expect(revokeRes.statusCode).toBe(200);

    // Attempt generate with revoked Token A and valid Cookie A
    const genRes = await generateHandler({
      httpMethod: "POST",
      headers: {
        authorization: `Bearer ${tokenA.token}`,
        cookie: cookieAValue,
        origin: "https://studio.ghostai.io",
      },
      body: JSON.stringify({
        provider: "elevenlabs",
        voiceId: "voice-123",
        text: "Post revocation attempt",
      }),
    });

    // Must return 401 Unauthorized (GhostAI auth takes precedence)
    expect(genRes.statusCode).toBe(401);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test("Legacy v1 cookie without principalId fails closed (428)", async () => {
    // Simulate legacy cookie where plaintext was raw apiKey string instead of v2 JSON
    const legacyCiphertext = encryptCredential(KEY_CLIENT_A);
    const legacyCookieHeader = `${BYOK_COOKIE_NAME}=${legacyCiphertext}`;

    const genRes = await generateHandler({
      httpMethod: "POST",
      headers: {
        authorization: `Bearer ${tokenA.token}`,
        cookie: legacyCookieHeader,
        origin: "https://studio.ghostai.io",
      },
      body: JSON.stringify({
        provider: "elevenlabs",
        voiceId: "voice-123",
        text: "Attempt with legacy cookie",
      }),
    });

    expect(genRes.statusCode).toBe(428);
    const body = JSON.parse(genRes.body);
    expect(body.error.code).toBe("ELEVENLABS_NOT_CONNECTED");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test("Legacy operator token with legacy-bound BYOK generates successfully", async () => {
    // Cookie issued for legacy operator
    const legacyCookie = extractCookieValue(issueByokCookie(KEY_CLIENT_A, "legacy_operator"));

    const genRes = await generateHandler({
      httpMethod: "POST",
      headers: {
        authorization: `Bearer ${TEST_LEGACY_TOKEN}`,
        cookie: legacyCookie,
        origin: "https://studio.ghostai.io",
      },
      body: JSON.stringify({
        provider: "elevenlabs",
        voiceId: "voice-123",
        text: "Legacy operator generation",
      }),
    });

    expect(genRes.statusCode).toBe(200);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: KEY_CLIENT_A })
    );
  });
});
