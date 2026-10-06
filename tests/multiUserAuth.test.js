/**
 * @file tests/multiUserAuth.test.js
 * Comprehensive unit tests for Multi-User Access Tokens and Admin Endpoints.
 * Validates identity model, token entropy, HMAC hashing, revocation, expiration,
 * suspension, admin separation, and auth verification.
 */

"use strict";

const crypto = require("crypto");
const db = require("../netlify/functions/lib/db");
const {
  generateClientToken,
  parseToken,
  hashSecret,
  verifySecret,
} = require("../netlify/functions/lib/tokenService");
const { authenticateGhostAIRequest } = require("../netlify/functions/lib/auth");
const { handler: adminClientsHandler } = require("../netlify/functions/admin-clients");
const { handler: adminTokensHandler } = require("../netlify/functions/admin-access-tokens");
const { handler: adminRevokeHandler } = require("../netlify/functions/admin-access-tokens-revoke");
const { handler: authVerifyHandler } = require("../netlify/functions/tts-auth-verify");

const TEST_ADMIN_TOKEN = "TEST_ADMIN_SECRET_KEY_ABC123";
const TEST_PEPPER = "TEST_PEPPER_SECRET_KEY_XYZ789";
const TEST_LEGACY_TOKEN = "TEST_LEGACY_STUDIO_AUTH_TOKEN_456";

describe("Multi-User Access Tokens & Identity Management", () => {
  beforeEach(() => {
    db._setMemoryStoreEnabled(true);
    db._resetMemoryStore();
    process.env.GHOSTAI_ADMIN_AUTH_TOKEN = TEST_ADMIN_TOKEN;
    process.env.GHOSTAI_TOKEN_HASH_PEPPER = TEST_PEPPER;
    process.env.GHOSTAI_STUDIO_AUTH_TOKEN = TEST_LEGACY_TOKEN;
  });

  afterEach(() => {
    db._resetMemoryStore();
    db._setMemoryStoreEnabled(false);
    delete process.env.GHOSTAI_ADMIN_AUTH_TOKEN;
    delete process.env.GHOSTAI_TOKEN_HASH_PEPPER;
    delete process.env.GHOSTAI_STUDIO_AUTH_TOKEN;
  });

  describe("1. Admin Endpoints: Client Management", () => {
    test("POST /api/admin/clients creates a client when called with valid admin token", async () => {
      const res = await adminClientsHandler({
        httpMethod: "POST",
        headers: {
          authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
          origin: "https://admin.ghostai.io",
        },
        body: JSON.stringify({ name: "Studio Client A", email: "clienta@example.com" }),
      });

      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.id).toBeDefined();
      expect(data.name).toBe("Studio Client A");
      expect(data.email).toBe("clienta@example.com");
      expect(data.status).toBe("active");
      expect(data.createdAt).toBeDefined();
    });

    test("POST /api/admin/clients rejects requests without admin token (401)", async () => {
      const res = await adminClientsHandler({
        httpMethod: "POST",
        headers: {},
        body: JSON.stringify({ name: "Studio Client A" }),
      });
      expect(res.statusCode).toBe(401);
    });

    test("POST /api/admin/clients rejects requests with wrong admin token (401)", async () => {
      const res = await adminClientsHandler({
        httpMethod: "POST",
        headers: { authorization: "Bearer wrong-admin-token" },
        body: JSON.stringify({ name: "Studio Client A" }),
      });
      expect(res.statusCode).toBe(401);
    });

    test("POST /api/admin/clients rejects client tokens on admin endpoints (401)", async () => {
      const client = await db.createClient({ name: "Client A" });
      const tokenResult = await generateClientToken({ clientId: client.id });

      const res = await adminClientsHandler({
        httpMethod: "POST",
        headers: { authorization: `Bearer ${tokenResult.token}` },
        body: JSON.stringify({ name: "Sub-Client" }),
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("2. Token Generation, Entropy & Storage Security", () => {
    test("token has expected format gai_live_<publicId>.<secret>", async () => {
      const client = await db.createClient({ name: "Entropy Tester" });
      const { token } = await generateClientToken({ clientId: client.id });

      expect(token).toMatch(/^gai_live_[a-f0-9]{16}\.[a-f0-9]{64}$/);
      const parsed = parseToken(token);
      expect(parsed.valid).toBe(true);
      expect(parsed.publicId).toHaveLength(16);
      expect(parsed.secret).toHaveLength(64); // 32 bytes = 256 bits of entropy
    });

    test("token secret is never stored plaintext in database", async () => {
      const client = await db.createClient({ name: "DB Storage Tester" });
      const { token, tokenId } = await generateClientToken({ clientId: client.id });
      const parsed = parseToken(token);

      const record = await db.getTokenByPublicId(parsed.publicId);
      expect(record).toBeDefined();
      expect(record.token_public_id).toBe(parsed.publicId);
      // Ensure secret_hash is NOT the plaintext secret
      expect(record.secret_hash).not.toBe(parsed.secret);
      // Ensure the full token string does not appear in record
      expect(JSON.stringify(record)).not.toContain(token);
      expect(JSON.stringify(record)).not.toContain(parsed.secret);
    });

    test("secret is hashed via HMAC-SHA256 with pepper", async () => {
      const client = await db.createClient({ name: "HMAC Tester" });
      const { token } = await generateClientToken({ clientId: client.id });
      const parsed = parseToken(token);

      const expectedHmac = crypto
        .createHmac("sha256", TEST_PEPPER)
        .update(parsed.secret, "utf8")
        .digest("hex");

      const record = await db.getTokenByPublicId(parsed.publicId);
      expect(record.secret_hash).toBe(expectedHmac);
      expect(verifySecret(parsed.secret, record.secret_hash, TEST_PEPPER)).toBe(true);
    });

    test("POST /api/admin/access-tokens returns full token ONCE upon creation", async () => {
      const client = await db.createClient({ name: "One Time Display Tester" });

      const res = await adminTokensHandler({
        httpMethod: "POST",
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
        body: JSON.stringify({ clientId: client.id, label: "Laptop Key" }),
      });

      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.token).toBeDefined();
      expect(data.token).toMatch(/^gai_live_/);
      expect(data.tokenId).toBeDefined();
      expect(data.clientId).toBe(client.id);
      expect(data.label).toBe("Laptop Key");
    });

    test("GET /api/admin/access-tokens listing NEVER reveals full token or secret_hash", async () => {
      const client = await db.createClient({ name: "Listing Tester" });
      const token1 = await generateClientToken({ clientId: client.id, label: "Token 1" });

      const res = await adminTokensHandler({
        httpMethod: "GET",
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(Array.isArray(data.tokens)).toBe(true);
      expect(data.tokens.length).toBeGreaterThanOrEqual(1);

      const listed = data.tokens.find((t) => t.id === token1.tokenId);
      expect(listed).toBeDefined();
      expect(listed.clientId).toBe(client.id);
      expect(listed.clientName).toBe("Listing Tester");
      expect(listed.label).toBe("Token 1");
      expect(listed.status).toBe("active");

      // Verify no leaks in listing JSON
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain("secret_hash");
      expect(serialized).not.toContain(token1.token);
      expect(serialized).not.toContain(TEST_PEPPER);
    });
  });

  describe("3. Authentication Verification & Enforcement", () => {
    test("valid client token authenticates and resolves principal", async () => {
      const client = await db.createClient({ name: "Enterprise Corp" });
      const { token, tokenId } = await generateClientToken({ clientId: client.id });

      const auth = await authenticateGhostAIRequest({
        headers: { authorization: `Bearer ${token}` },
      });

      expect(auth.authenticated).toBe(true);
      expect(auth.ok).toBe(true);
      expect(auth.authMode).toBe("client_token");
      expect(auth.principalId).toBe(client.id);
      expect(auth.clientId).toBe(client.id);
      expect(auth.tokenId).toBe(tokenId);
      expect(auth.clientName).toBe("Enterprise Corp");
    });

    test("GET /api/tts/auth/verify returns 200 with client identity for valid client token", async () => {
      const client = await db.createClient({ name: "Studio Tester" });
      const { token } = await generateClientToken({ clientId: client.id });

      const res = await authVerifyHandler({
        httpMethod: "GET",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.authenticated).toBe(true);
      expect(data.authMode).toBe("client_token");
      expect(data.client).toEqual({
        id: client.id,
        name: "Studio Tester",
      });
      // Never leaks internal tokenId, secret, or hash
      expect(data.tokenId).toBeUndefined();
      expect(data.secret).toBeUndefined();
    });

    test("token with wrong secret fails authentication (401)", async () => {
      const client = await db.createClient({ name: "Wrong Secret Tester" });
      const { token } = await generateClientToken({ clientId: client.id });
      const parsed = parseToken(token);

      // Tamper with secret portion
      const tamperedSecret = "0".repeat(64);
      const tamperedToken = `gai_live_${parsed.publicId}.${tamperedSecret}`;

      const auth = await authenticateGhostAIRequest({
        headers: { authorization: `Bearer ${tamperedToken}` },
      });
      expect(auth.authenticated).toBe(false);
      expect(auth.statusCode).toBe(401);
    });

    test("token with non-existent publicId fails authentication (401)", async () => {
      const fakeToken = `gai_live_${"a".repeat(16)}.${"b".repeat(64)}`;
      const auth = await authenticateGhostAIRequest({
        headers: { authorization: `Bearer ${fakeToken}` },
      });
      expect(auth.authenticated).toBe(false);
      expect(auth.statusCode).toBe(401);
    });

    test("revoked token fails authentication immediately (401)", async () => {
      const client = await db.createClient({ name: "Revocation Tester" });
      const { token, tokenId } = await generateClientToken({ clientId: client.id });

      // Before revocation: works
      const authBefore = await authenticateGhostAIRequest({
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authBefore.authenticated).toBe(true);

      // Admin revokes token
      const revokeRes = await adminRevokeHandler({
        httpMethod: "POST",
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
        body: JSON.stringify({ tokenId }),
      });
      expect(revokeRes.statusCode).toBe(200);

      // After revocation: blocked immediately
      const authAfter = await authenticateGhostAIRequest({
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authAfter.authenticated).toBe(false);
      expect(authAfter.statusCode).toBe(401);
    });

    test("expired token fails authentication (401)", async () => {
      const client = await db.createClient({ name: "Expiry Tester" });
      // Create token that expired 10 minutes ago
      const pastDate = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { token } = await generateClientToken({
        clientId: client.id,
        expiresAt: pastDate,
      });

      const auth = await authenticateGhostAIRequest({
        headers: { authorization: `Bearer ${token}` },
      });
      expect(auth.authenticated).toBe(false);
      expect(auth.statusCode).toBe(401);
    });

    test("suspended client blocks all its tokens logically even if token is active", async () => {
      const client = await db.createClient({ name: "Suspended Client" });
      const { token } = await generateClientToken({ clientId: client.id });

      // Suspend client
      await db.updateClientStatus(client.id, "suspended");

      const auth = await authenticateGhostAIRequest({
        headers: { authorization: `Bearer ${token}` },
      });
      expect(auth.authenticated).toBe(false);
      expect(auth.statusCode).toBe(401);
    });

    test("legacy operator token continues to authenticate with authMode: legacy", async () => {
      const auth = await authenticateGhostAIRequest({
        headers: { authorization: `Bearer ${TEST_LEGACY_TOKEN}` },
      });
      expect(auth.authenticated).toBe(true);
      expect(auth.authMode).toBe("legacy");
      expect(auth.principalId).toBe("legacy_operator");

      const verifyRes = await authVerifyHandler({
        httpMethod: "GET",
        headers: { authorization: `Bearer ${TEST_LEGACY_TOKEN}` },
      });
      expect(verifyRes.statusCode).toBe(200);
      const data = JSON.parse(verifyRes.body);
      expect(data.ok).toBe(true);
      expect(data.authenticated).toBe(true);
    });
  });
});
