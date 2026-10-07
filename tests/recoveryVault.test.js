/**
 * @file tests/recoveryVault.test.js
 * Test suite for Temporary Recovery Vault, Graceful Degradation on Storage Failure,
 * Cross-Client Isolation, and Cleanup Service.
 */

"use strict";

// Mock provider before requiring tts-generate
const mockGenerate = jest.fn().mockResolvedValue({
  ok: true,
  statusCode: 200,
  contentType: "audio/mpeg",
  audioBuffer: Buffer.from([0xff, 0xfb, 0x90]), // Valid MP3 sync header
});

jest.mock("../netlify/functions/providers", () => ({
  getProvider: jest.fn(() => ({
    name: "elevenlabs",
    generate: mockGenerate,
  })),
}));

const ttsGenerate = require("../netlify/functions/tts-generate");
const ttsGenerations = require("../netlify/functions/tts-generations");
const ttsRecover = require("../netlify/functions/tts-generations-recover");
const ttsAudio = require("../netlify/functions/tts-generations-audio");
const ttsVerify = require("../netlify/functions/tts-generations-verify");
const db = require("../netlify/functions/lib/db");
const storage = require("../netlify/functions/lib/storageService");
const { generateClientToken } = require("../netlify/functions/lib/tokenService");
const { cleanupExpiredTtsGenerations } = require("../netlify/functions/lib/cleanupService");
const { encryptCredential } = require("../netlify/functions/lib/credentialCrypto");

describe("Temporary Recovery Vault & Pipeline", () => {
  const TEST_PEPPER = "test_pepper_at_least_32_bytes_long_123456789";
  let clientA, tokenDataA, authHeadersA, byokCookieA;
  let clientB, tokenDataB, authHeadersB, byokCookieB;

  beforeAll(async () => {
    process.env.GHOSTAI_ADMIN_AUTH_TOKEN = "test_admin_token";
    process.env.GHOSTAI_TOKEN_HASH_PEPPER = TEST_PEPPER;
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    db._setMemoryStoreEnabled(true);
  });

  beforeEach(async () => {
    db._resetMemoryStore();
    storage._resetMemoryStorage();
    mockGenerate.mockClear();

    // Setup Client A
    clientA = await db.createClient({ name: "Client A" });
    tokenDataA = await generateClientToken({ clientId: clientA.id, label: "Key A" });
    authHeadersA = { authorization: `Bearer ${tokenDataA.token}` };
    const encKeyA = encryptCredential(
      JSON.stringify({ v: 2, provider: "elevenlabs", principalId: clientA.id, apiKey: "sk_test_valid_key_12345678901234567890" })
    );
    byokCookieA = `__Host-ghostai_elevenlabs=${encKeyA}`;

    // Setup Client B
    clientB = await db.createClient({ name: "Client B" });
    tokenDataB = await generateClientToken({ clientId: clientB.id, label: "Key B" });
    authHeadersB = { authorization: `Bearer ${tokenDataB.token}` };
    const encKeyB = encryptCredential(
      JSON.stringify({ v: 2, provider: "elevenlabs", principalId: clientB.id, apiKey: "sk_test_valid_key_12345678901234567890" })
    );
    byokCookieB = `__Host-ghostai_elevenlabs=${encKeyB}`;
  });

  afterAll(() => {
    db._setMemoryStoreEnabled(false);
  });

  test("Successful generation creates recovery session and stores MP3 in vault", async () => {
    const res = await ttsGenerate.handler({
      httpMethod: "POST",
      headers: {
        ...authHeadersA,
        cookie: byokCookieA,
        origin: "http://localhost:5173",
      },
      body: JSON.stringify({
        provider: "elevenlabs",
        voiceId: "voice-123",
        text: "Audio test narration 1",
        projectId: "proj-abc",
        projectTitle: "Test Project",
        narrationId: "narr-01",
      }),
    });

    expect(res.statusCode).toBe(200);
    const sessionId = res.headers["X-TTS-Session-ID"];
    expect(sessionId).toBeDefined();

    // Verify session in db
    const session = await db.getGenerationSession(sessionId);
    expect(session).toBeDefined();
    expect(session.client_id).toBe(clientA.id);
    expect(session.item_count).toBe(1);
    expect(session.ready_count).toBe(1);

    // Verify item in storage
    const items = await db.listGenerationItems(sessionId);
    expect(items.length).toBe(1);
    expect(items[0].narration_id).toBe("narr-01");
    expect(items[0].storage_path).toBeDefined();

    const audioResult = await storage.downloadAudio(items[0].storage_path);
    expect(audioResult.ok).toBe(true);
    expect(audioResult.buffer).toBeDefined();
  });

  test("Graceful degradation: Storage failure still returns audio to user with warning header", async () => {
    const origUpload = storage.uploadAudio;
    storage.uploadAudio = jest.fn().mockRejectedValueOnce(new Error("Supabase Storage Down"));

    try {
      const res = await ttsGenerate.handler({
        httpMethod: "POST",
        headers: {
          ...authHeadersA,
          cookie: byokCookieA,
          origin: "http://localhost:5173",
        },
        body: JSON.stringify({
          provider: "elevenlabs",
          voiceId: "voice-123",
          text: "Audio test narration with failing storage",
          narrationId: "narr-fail-store",
        }),
      });

      // CRITICAL: Must return 200 OK binary audio
      expect(res.statusCode).toBe(200);
      expect(res.isBase64Encoded).toBe(true);
      expect(res.headers["X-TTS-Recovery-Warning"]).toBe("RECOVERY_STORAGE_FAILED");

      const sessionId = res.headers["X-TTS-Session-ID"];
      const items = await db.listGenerationItems(sessionId);
      expect(items.length).toBe(1);
      expect(items[0].error_code).toBe("RECOVERY_STORAGE_FAILED");
    } finally {
      storage.uploadAudio = origUpload;
    }
  });

  test("Cross-Client Isolation: Client B cannot access, recover, delete, or fetch audio from Client A session", async () => {
    // 1. Client A generates a session
    const genRes = await ttsGenerate.handler({
      httpMethod: "POST",
      headers: {
        ...authHeadersA,
        cookie: byokCookieA,
        origin: "http://localhost:5173",
      },
      body: JSON.stringify({
        provider: "elevenlabs",
        voiceId: "voice-123",
        text: "Top secret client A audio",
        narrationId: "narr-a-secret",
      }),
    });
    expect(genRes.statusCode).toBe(200);
    const sessionAId = genRes.headers["X-TTS-Session-ID"];
    expect(sessionAId).toBeDefined();

    // 2. Client B tries to list sessions -> does NOT see Session A
    const listResB = await ttsGenerations.handler({
      httpMethod: "GET",
      headers: authHeadersB,
    });
    expect(listResB.statusCode).toBe(200);
    const listBodyB = JSON.parse(listResB.body);
    expect(listBodyB.sessions.some((s) => s.id === sessionAId)).toBe(false);

    // 3. Client B tries to inspect Session A -> 404
    const inspectResB = await ttsGenerations.handler({
      httpMethod: "GET",
      headers: authHeadersB,
      queryStringParameters: { sessionId: sessionAId },
    });
    expect(inspectResB.statusCode).toBe(404);

    // 4. Client B tries to recover Session A -> 404
    const recoverResB = await ttsRecover.handler({
      httpMethod: "POST",
      headers: authHeadersB,
      body: JSON.stringify({ sessionId: sessionAId }),
    });
    expect(recoverResB.statusCode).toBe(404);

    // 5. Client B tries to download audio from Session A -> 404
    const audioResB = await ttsAudio.handler({
      httpMethod: "GET",
      headers: authHeadersB,
      queryStringParameters: { sessionId: sessionAId, narrationId: "narr-a-secret" },
    });
    expect(audioResB.statusCode).toBe(404);

    // 6. Client B tries to delete Session A -> 404
    const deleteResB = await ttsGenerations.handler({
      httpMethod: "DELETE",
      headers: authHeadersB,
      queryStringParameters: { sessionId: sessionAId },
    });
    expect(deleteResB.statusCode).toBe(404);
  });

  test("Client Suspended or Token Revoked blocks recovery access immediately", async () => {
    // Suspend Client A
    await db.updateClientStatus(clientA.id, "suspended");

    const res = await ttsGenerations.handler({
      httpMethod: "GET",
      headers: authHeadersA,
    });
    expect(res.statusCode).toBe(401);
  });

  test("Audio recovery stream and verification status update", async () => {
    // 1. Generate audio with Client A
    const genRes = await ttsGenerate.handler({
      httpMethod: "POST",
      headers: {
        ...authHeadersA,
        cookie: byokCookieA,
        origin: "http://localhost:5173",
      },
      body: JSON.stringify({
        provider: "elevenlabs",
        voiceId: "voice-123",
        text: "Voice audio to recover",
        narrationId: "narr-rec-01",
      }),
    });
    expect(genRes.statusCode).toBe(200);
    const sessionId = genRes.headers["X-TTS-Session-ID"];
    expect(sessionId).toBeDefined();

    // 2. Recover metadata
    const recoverRes = await ttsRecover.handler({
      httpMethod: "POST",
      headers: authHeadersA,
      body: JSON.stringify({ sessionId }),
    });
    expect(recoverRes.statusCode).toBe(200);
    const recBody = JSON.parse(recoverRes.body);
    expect(recBody.items.length).toBe(1);
    expect(recBody.items[0].hasAudio).toBe(true);

    // 3. Stream binary audio
    const audioRes = await ttsAudio.handler({
      httpMethod: "GET",
      headers: authHeadersA,
      queryStringParameters: { sessionId, narrationId: "narr-rec-01" },
    });
    expect(audioRes.statusCode).toBe(200);
    expect(audioRes.headers["Content-Type"]).toBe("audio/mpeg");
    expect(audioRes.body).toBeDefined();

    // 4. Update ZIP verification
    const verifyRes = await ttsVerify.handler({
      httpMethod: "POST",
      headers: authHeadersA,
      body: JSON.stringify({
        sessionId,
        verified: true,
        packageSha256: "a".repeat(64),
      }),
    });
    expect(verifyRes.statusCode).toBe(200);
    const session = await db.getGenerationSession(sessionId);
    expect(session.zip_status).toBe("verified");
    expect(session.package_sha256).toBe("a".repeat(64));
  });

  test("Cleanup service sweeps only expired sessions and deletes files", async () => {
    // Create an expired session (expires_at in past)
    const expiredSession = await db.createGenerationSession({
      clientId: clientA.id,
      retentionHours: -1, // Expired 1 hour ago
    });
    await storage.uploadAudio({
      clientId: clientA.id,
      sessionId: expiredSession.id,
      narrationId: "old-audio",
      audioBuffer: Buffer.from("old"),
    });
    const storagePath = storage.buildStoragePath(clientA.id, expiredSession.id, "old-audio");
    await db.createOrUpdateGenerationItem({
      sessionId: expiredSession.id,
      clientId: clientA.id,
      narrationId: "old-audio",
      status: "ready",
      storagePath,
      expiresAt: expiredSession.expires_at,
    });

    // Create an active (unexpired) session
    const activeSession = await db.createGenerationSession({
      clientId: clientA.id,
      retentionHours: 24,
    });

    // Run cleanup
    const cleanupResult = await cleanupExpiredTtsGenerations();
    expect(cleanupResult.ok).toBe(true);
    expect(cleanupResult.expiredSessionsCount).toBe(1);
    expect(cleanupResult.cleanedFilesCount).toBe(1);

    // Storage file should be deleted
    const checkFile = await storage.downloadAudio(storagePath);
    expect(checkFile.ok).toBe(false);

    // Active session remains untouched
    const checkActive = await db.getGenerationSession(activeSession.id);
    expect(checkActive.status).toBe("generating");
  });

  test("Canonical DTO: GET /api/tts/generations returns explicit camelCase RecoverySessionSummary without leaking DB fields", async () => {
    const testSession = await db.createGenerationSession({
      clientId: clientA.id,
      projectId: "Lia y el Faro Encantado",
      projectTitle: "Lia y el Faro Encantado",
      sourceManifest: { internal: "secret-manifest-data" },
      retentionHours: 24,
    });

    await db.updateGenerationSession(testSession.id, {
      item_count: 1,
      ready_count: 1,
      error_count: 0,
      status: "ready",
      zip_status: "not_prepared",
    });

    const res = await ttsGenerations.handler({
      httpMethod: "GET",
      headers: authHeadersA,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);

    const dto = body.sessions.find((s) => s.id === testSession.id);
    expect(dto).toBeDefined();

    // Required camelCase fields
    expect(dto.id).toBe(testSession.id);
    expect(dto.projectId).toBe("Lia y el Faro Encantado");
    expect(dto.projectTitle).toBe("Lia y el Faro Encantado");
    expect(dto.status).toBe("ready");
    expect(dto.itemCount).toBe(1);
    expect(dto.readyCount).toBe(1);
    expect(dto.errorCount).toBe(0);
    expect(dto.zipStatus).toBe("not_prepared");
    expect(typeof dto.createdAt).toBe("string");
    expect(new Date(dto.createdAt).toString()).not.toBe("Invalid Date");
    expect(typeof dto.expiresAt).toBe("string");
    expect(new Date(dto.expiresAt).toString()).not.toBe("Invalid Date");
    expect(dto.zipVerifiedAt).toBeNull();

    // Strictly verify raw DB snake_case and internal fields are NOT leaked
    expect(dto.project_id).toBeUndefined();
    expect(dto.project_title).toBeUndefined();
    expect(dto.item_count).toBeUndefined();
    expect(dto.ready_count).toBeUndefined();
    expect(dto.error_count).toBeUndefined();
    expect(dto.zip_status).toBeUndefined();
    expect(dto.created_at).toBeUndefined();
    expect(dto.expires_at).toBeUndefined();
    expect(dto.zip_verified_at).toBeUndefined();
    expect(dto.client_id).toBeUndefined();
    expect(dto.source_manifest).toBeUndefined();
  });

  test("Canonical DTO: GET /api/tts/generations?sessionId= returns camelCase session DTO", async () => {
    const testSession = await db.createGenerationSession({
      clientId: clientA.id,
      projectTitle: "Single Session DTO Test",
      retentionHours: 24,
    });

    const res = await ttsGenerations.handler({
      httpMethod: "GET",
      headers: authHeadersA,
      queryStringParameters: { sessionId: testSession.id },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.session).toBeDefined();
    expect(body.session.projectTitle).toBe("Single Session DTO Test");
    expect(body.session.project_title).toBeUndefined();
    expect(body.session.client_id).toBeUndefined();
  });
});

