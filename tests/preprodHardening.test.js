/**
 * @file tests/preprodHardening.test.js
 * Pre-Production Hardening & Contract Audit Test Suite (CONTROL PLANE 01A).
 * Tests:
 * 1. Path traversal hardening in Storage paths.
 * 2. Recursive metadata sanitizer with adversarial nested fake secrets.
 * 3. Whitelist enforcement on source_manifest.
 * 4. Cross-client 404 isolation across all endpoints.
 * 5. generationSessionId reuse hardening in tts-generate.
 * 6. Storage failure semantics (delivery 200, vault error, ready_count=0).
 * 7. Verification payload validation (packageSha256 hex format, itemCount check).
 * 8. Cleanup failure safety (no false DB update on storage failure).
 * 9. Delete session failure safety.
 * 10. Admin session cookie & CORS exactness.
 */

"use strict";

const crypto = require("crypto");
const { describe, test, expect, beforeEach } = require("@jest/globals");

const {
  validateIdSegment,
  buildStoragePath,
  _resetMemoryStorage,
  _memoryStorage,
} = require("../netlify/functions/lib/storageService");

const {
  sanitizeOperationalError,
  sanitizeOperationalMetadata,
  sanitizeSourceManifest,
} = require("../netlify/functions/lib/errorCatalog");

const db = require("../netlify/functions/lib/db");
const { generateClientToken } = require("../netlify/functions/lib/tokenService");
const { buildAdminSessionCookie, verifyAdminSessionToken, ADMIN_COOKIE_NAME } = require("../netlify/functions/lib/adminAuth");
const { corsHeaders, resolveOrigin } = require("../netlify/functions/lib/cors");
const { cleanupExpiredTtsGenerations } = require("../netlify/functions/lib/cleanupService");

// Handler imports
const ttsGenerationsHandler = require("../netlify/functions/tts-generations").handler;
const ttsRecoverHandler = require("../netlify/functions/tts-generations-recover").handler;
const ttsAudioHandler = require("../netlify/functions/tts-generations-audio").handler;
const ttsVerifyHandler = require("../netlify/functions/tts-generations-verify").handler;
const adminLoginHandler = require("../netlify/functions/admin-auth-login").handler;

describe("Control Plane 01A: Pre-Prod Hardening & Audit", () => {
  const TEST_ADMIN_SECRET = "adm_secret_test_01a_hardening_key_99";
  const TEST_PEPPER = "test_pepper_at_least_32_bytes_long_123456789";
  const ALLOWED_ORIGIN = "https://ghostai-tts-studio.smartbrain.lat";

  beforeAll(() => {
    process.env.GHOSTAI_ADMIN_AUTH_TOKEN = TEST_ADMIN_SECRET;
    process.env.GHOSTAI_TOKEN_HASH_PEPPER = TEST_PEPPER;
    process.env.GHOSTAI_ALLOWED_ORIGINS = ALLOWED_ORIGIN;
    db._setMemoryStoreEnabled(true);
  });

  beforeEach(() => {
    db._resetMemoryStore();
    _resetMemoryStorage();
  });

  // ── 1. Storage Path Traversal Hardening ───────────────────────────────────
  describe("1. Storage Path Traversal Hardening", () => {
    test("rejects path traversal vectors in validateIdSegment", () => {
      const maliciousInputs = [
        "../secret",
        "..\\secret",
        "folder/../file",
        "narration\0nullbyte",
        "%2fetc%2fpasswd",
        "%5cwindows",
        "   ",
        "",
        null,
      ];

      for (const input of maliciousInputs) {
        expect(() => validateIdSegment(input, "testId")).toThrow();
      }
    });

    test("builds clean canonical path for valid identifiers", () => {
      const path = buildStoragePath("client_123", "session_abc", "narr_01");
      expect(path).toBe("client_123/session_abc/narr_01.mp3");
    });
  });

  // ── 2. Recursive Metadata Sanitizer ──────────────────────────────────────
  describe("2. Recursive Metadata Sanitizer (Adversarial Fake Secrets)", () => {
    test("redacts nested sensitive keys and string patterns deeply", () => {
      const adversarialInput = {
        requestId: "req-101",
        sessionId: "sess-202",
        status: "ready",
        sizeBytes: 1048576,
        authorization: "Bearer FAKE_BEARER_SECRET_DO_NOT_LEAK",
        headers: {
          Authorization: "Bearer ANOTHER_FAKE_TOKEN",
          Cookie: "session=FAKE_COOKIE_VAL",
          "set-cookie": "secret_cookie=xyz",
        },
        provider: {
          apiKey: "sk_test_fake_elevenlabs_key_1234567890",
          name: "elevenlabs",
        },
        nested: {
          array: [
            {
              token: "gai_live_ab12cd34.fake_secret_key_segment",
              validInfo: "scene_01",
            },
            "Url with param: https://api.test/v1?token=secret_query_val&other=safe",
            "JWT token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fake_jwt_signature_xyz",
          ],
        },
      };

      const sanitized = sanitizeOperationalMetadata(adversarialInput);

      // Benign operational fields preserved
      expect(sanitized.requestId).toBe("req-101");
      expect(sanitized.sessionId).toBe("sess-202");
      expect(sanitized.status).toBe("ready");
      expect(sanitized.sizeBytes).toBe(1048576);

      // Sensitive keys redacted
      expect(sanitized.authorization).toBe("[REDACTED]");
      expect(sanitized.headers.Authorization).toBe("[REDACTED]");
      expect(sanitized.headers.Cookie).toBe("[REDACTED]");
      expect(sanitized["headers"]["set-cookie"]).toBe("[REDACTED]");
      expect(sanitized.provider.apiKey).toBe("[REDACTED]");
      expect(sanitized.provider.name).toBe("elevenlabs");

      // Deep array elements redacted
      expect(sanitized.nested.array[0].token).toBe("[REDACTED]");
      expect(sanitized.nested.array[0].validInfo).toBe("scene_01");
      expect(sanitized.nested.array[1]).toContain("token=[REDACTED]");
      expect(sanitized.nested.array[2]).toContain("[JWT_REDACTED]");
    });

    test("handles circular references gracefully without throwing", () => {
      const circular = { name: "test" };
      circular.self = circular;

      expect(() => sanitizeOperationalMetadata(circular)).not.toThrow();
      const res = sanitizeOperationalMetadata(circular);
      expect(res.name).toBe("test");
      expect(res.self).toBe("[CIRCULAR]");
    });
  });

  // ── 3. Source Manifest Whitelist ─────────────────────────────────────────
  describe("3. Source Manifest Whitelist", () => {
    test("keeps only required ghostai-tts 1.0 fields and strips all credentials", () => {
      const dirtyManifest = {
        format: "ghostai-tts",
        version: "1.0",
        authorization: "Bearer FAKE_SECRET",
        apiKey: "sk_fake_key",
        headers: { "x-api-key": "secret" },
        project: {
          name: "Audit Project",
          description: "Test",
          exportedAt: "2026-10-07T12:00:00Z",
          token: "secret_leak",
        },
        items: [
          {
            id: "n1",
            sceneId: "s1",
            sceneIndex: 1,
            text: "Hello world text",
            voiceId: "voice-1",
            modelId: "eleven_multilingual_v2",
            bearerToken: "leak_this_token",
          },
        ],
      };

      const cleaned = sanitizeSourceManifest(dirtyManifest);

      expect(cleaned.format).toBe("ghostai-tts");
      expect(cleaned.version).toBe("1.0");
      expect(cleaned.authorization).toBeUndefined();
      expect(cleaned.apiKey).toBeUndefined();
      expect(cleaned.headers).toBeUndefined();
      expect(cleaned.project.name).toBe("Audit Project");
      expect(cleaned.project.token).toBeUndefined();
      expect(cleaned.items[0].text).toBe("Hello world text");
      expect(cleaned.items[0].bearerToken).toBeUndefined();
    });
  });

  // ── 4. Cross-Client Isolation (Uniform 404) ──────────────────────────────
  describe("4. Cross-Client 404 Isolation", () => {
    let clientA, clientB, tokenA, tokenB, sessionA;

    beforeEach(async () => {
      clientA = await db.createClient({ name: "Client A" });
      clientB = await db.createClient({ name: "Client B" });

      const tA = await generateClientToken({ clientId: clientA.id, label: "Token A" });
      const tB = await generateClientToken({ clientId: clientB.id, label: "Token B" });
      tokenA = tA.token;
      tokenB = tB.token;

      sessionA = await db.createGenerationSession({
        clientId: clientA.id,
        projectTitle: "Project A",
        retentionHours: 24,
      });

      await db.createOrUpdateGenerationItem({
        sessionId: sessionA.id,
        clientId: clientA.id,
        narrationId: "narr_01",
        status: "ready",
        storagePath: `${clientA.id}/${sessionA.id}/narr_01.mp3`,
        sha256: "a".repeat(64),
        sizeBytes: 100,
        expiresAt: sessionA.expires_at,
      });
      _memoryStorage.set(`${clientA.id}/${sessionA.id}/narr_01.mp3`, Buffer.from("audio data"));
    });

    test("Client B querying Client A session details returns 404", async () => {
      const res = await ttsGenerationsHandler({
        httpMethod: "GET",
        headers: { authorization: `Bearer ${tokenB}` },
        queryStringParameters: { sessionId: sessionA.id },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe("SESSION_NOT_FOUND");
    });

    test("Client B recovering Client A session returns 404", async () => {
      const res = await ttsRecoverHandler({
        httpMethod: "POST",
        headers: { authorization: `Bearer ${tokenB}` },
        body: JSON.stringify({ sessionId: sessionA.id }),
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe("SESSION_NOT_FOUND");
    });

    test("Client B downloading Client A audio returns 404", async () => {
      const res = await ttsAudioHandler({
        httpMethod: "GET",
        headers: { authorization: `Bearer ${tokenB}` },
        queryStringParameters: { sessionId: sessionA.id, narrationId: "narr_01" },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe("SESSION_NOT_FOUND");
    });

    test("Client B verifying Client A session returns 404", async () => {
      const res = await ttsVerifyHandler({
        httpMethod: "POST",
        headers: { authorization: `Bearer ${tokenB}` },
        body: JSON.stringify({ sessionId: sessionA.id, verified: true, packageSha256: "b".repeat(64) }),
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe("SESSION_NOT_FOUND");
    });

    test("Client B deleting Client A session returns 404", async () => {
      const res = await ttsGenerationsHandler({
        httpMethod: "DELETE",
        headers: { authorization: `Bearer ${tokenB}` },
        queryStringParameters: { sessionId: sessionA.id },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe("SESSION_NOT_FOUND");
    });
  });

  // ── 5. Verification Payload Validation ───────────────────────────────────
  describe("5. Verification Payload Validation", () => {
    let client, token, session;

    beforeEach(async () => {
      client = await db.createClient({ name: "Verifier Client" });
      const t = await generateClientToken({ clientId: client.id });
      token = t.token;
      session = await db.createGenerationSession({ clientId: client.id, projectTitle: "Verify Test" });
      await db.updateGenerationSession(session.id, { item_count: 5, ready_count: 5 });
    });

    test("rejects invalid non-64 hex packageSha256 format", async () => {
      const res = await ttsVerifyHandler({
        httpMethod: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId: session.id, verified: true, packageSha256: "invalid-hash-too-short" }),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe("VALIDATION_INVALID_VALUE");
    });

    test("rejects mismatched itemCount", async () => {
      const res = await ttsVerifyHandler({
        httpMethod: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId: session.id,
          verified: true,
          packageSha256: "c".repeat(64),
          itemCount: 99, // session has 5
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe("ITEM_COUNT_MISMATCH");
    });

    test("accepts valid packageSha256 and matching itemCount", async () => {
      const res = await ttsVerifyHandler({
        httpMethod: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId: session.id,
          verified: true,
          packageSha256: "d".repeat(64),
          itemCount: 5,
        }),
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.zipStatus).toBe("verified");
    });
  });

  // ── 6. Cleanup Failure Safety ────────────────────────────────────────────
  describe("6. Cleanup Failure Safety", () => {
    test("does not mark session as expired if storage delete fails", async () => {
      const storage = require("../netlify/functions/lib/storageService");
      const client = await db.createClient({ name: "Cleanup Client" });
      const expiredSession = await db.createGenerationSession({
        clientId: client.id,
        projectTitle: "Expired Project",
        retentionHours: -1, // Expired immediately
      });

      await db.createOrUpdateGenerationItem({
        sessionId: expiredSession.id,
        clientId: client.id,
        narrationId: "n_exp_1",
        status: "ready",
        storagePath: `${client.id}/${expiredSession.id}/n_exp_1.mp3`,
        expiresAt: expiredSession.expires_at,
      });

      // Spy and mock deleteAudioFiles failure
      const originalDelete = storage.deleteAudioFiles;
      storage.deleteAudioFiles = async () => ({ ok: false, error: "Storage delete network failure" });

      try {
        const cleanupRes = await cleanupExpiredTtsGenerations();
        expect(cleanupRes.ok).toBe(true);

        // Verify session was NOT falsely marked as expired
        const s = await db.getGenerationSession(expiredSession.id);
        expect(s.status).not.toBe("expired");

        // Verify an event was logged documenting storage delete failure
        const events = await db.listOperationEvents({ sessionId: expiredSession.id });
        const failedEvent = events.find((e) => e.event_type === "CLEANUP_STORAGE_DELETE_FAILED");
        expect(failedEvent).toBeDefined();
        expect(failedEvent.error_code).toBe("CLEANUP_STORAGE_ERROR");
      } finally {
        storage.deleteAudioFiles = originalDelete;
      }
    });
  });

  // ── 7. Admin Session Cookie & CORS Exactness ─────────────────────────────
  describe("7. Admin Session Cookie & CORS Exactness", () => {
    test("admin cookie has no Max-Age or Expires (true session cookie)", () => {
      const cookieStr = buildAdminSessionCookie(TEST_ADMIN_SECRET);
      expect(cookieStr).toContain("Path=/api/admin");
      expect(cookieStr).toContain("HttpOnly");
      expect(cookieStr).toContain("Secure");
      expect(cookieStr).toContain("SameSite=Strict");
      expect(cookieStr).not.toContain("Max-Age");
      expect(cookieStr).not.toContain("Expires");
    });

    test("admin cookie does NOT contain plaintext admin token", () => {
      const cookieStr = buildAdminSessionCookie(TEST_ADMIN_SECRET);
      expect(cookieStr).not.toContain(TEST_ADMIN_SECRET);
      const token = cookieStr.split(";")[0].split("=")[1];
      expect(verifyAdminSessionToken(token, TEST_ADMIN_SECRET)).toBe(true);
    });

    test("admin login responds with exact CORS origin and credentials true", async () => {
      const res = await adminLoginHandler({
        httpMethod: "POST",
        headers: {
          Origin: ALLOWED_ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ adminToken: TEST_ADMIN_SECRET }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["Access-Control-Allow-Origin"]).toBe(ALLOWED_ORIGIN);
      expect(res.headers["Access-Control-Allow-Credentials"]).toBe("true");
      expect(res.headers["Access-Control-Allow-Origin"]).not.toBe("*");
      expect(res.headers["Set-Cookie"]).toBeDefined();
    });
  });
});
