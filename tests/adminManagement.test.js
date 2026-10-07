/**
 * @file tests/adminManagement.test.js
 * Test suite for Client management, Access Token lifecycle, and TTS Operations audit view.
 */

"use strict";

const adminClients = require("../netlify/functions/admin-clients");
const adminTokens = require("../netlify/functions/admin-access-tokens");
const adminTokensRevoke = require("../netlify/functions/admin-access-tokens-revoke");
const adminTtsOps = require("../netlify/functions/admin-tts-operations");
const db = require("../netlify/functions/lib/db");

describe("Admin Management Operations", () => {
  const TEST_ADMIN_SECRET = "test_admin_super_secret_token_1234567890";
  const authHeaders = {
    authorization: `Bearer ${TEST_ADMIN_SECRET}`,
  };

  beforeAll(() => {
    process.env.GHOSTAI_ADMIN_AUTH_TOKEN = TEST_ADMIN_SECRET;
    process.env.GHOSTAI_TOKEN_HASH_PEPPER = "test_pepper_at_least_32_bytes_long_123456789";
    db._setMemoryStoreEnabled(true);
  });

  beforeEach(() => {
    db._resetMemoryStore();
  });

  afterAll(() => {
    db._setMemoryStoreEnabled(false);
  });

  test("Client lifecycle: Create, List with stats, Suspend, and Reactivate", async () => {
    // 1. Create client
    const createRes = await adminClients.handler({
      httpMethod: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "Acme Studios", email: "contact@acme.test" }),
    });
    expect(createRes.statusCode).toBe(201);
    const client = JSON.parse(createRes.body);
    expect(client.id).toBeDefined();
    expect(client.status).toBe("active");

    // 2. List clients (stats check)
    const listRes = await adminClients.handler({
      httpMethod: "GET",
      headers: authHeaders,
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    expect(listBody.clients.length).toBe(1);
    expect(listBody.clients[0].activeTokensCount).toBe(0);

    // 3. Suspend client (PATCH)
    const suspendRes = await adminClients.handler({
      httpMethod: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ clientId: client.id, status: "suspended" }),
    });
    expect(suspendRes.statusCode).toBe(200);
    const suspendBody = JSON.parse(suspendRes.body);
    expect(suspendBody.status).toBe("suspended");

    const fetchedSuspended = await db.getClientById(client.id);
    expect(fetchedSuspended.status).toBe("suspended");

    // 4. Reactivate client (PATCH)
    const reactivateRes = await adminClients.handler({
      httpMethod: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ clientId: client.id, status: "active" }),
    });
    expect(reactivateRes.statusCode).toBe(200);
    const reactivateBody = JSON.parse(reactivateRes.body);
    expect(reactivateBody.status).toBe("active");
  });

  test("Token lifecycle: Create returns one-time secret; List returns publicId and NO secret hash", async () => {
    const clientRecord = await db.createClient({ name: "Partner Studio" });

    // 1. Generate Token
    const createRes = await adminTokens.handler({
      httpMethod: "POST",
      headers: authHeaders,
      body: JSON.stringify({ clientId: clientRecord.id, label: "Production Key" }),
    });
    expect(createRes.statusCode).toBe(201);
    const tokenData = JSON.parse(createRes.body);
    expect(tokenData.token).toBeDefined();
    expect(tokenData.token.startsWith("gai_live_")).toBe(true);
    expect(tokenData.tokenId).toBeDefined();

    // 2. List tokens
    const listRes = await adminTokens.handler({
      httpMethod: "GET",
      headers: authHeaders,
      queryStringParameters: { clientId: clientRecord.id },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    expect(listBody.tokens.length).toBe(1);

    const listedToken = listBody.tokens[0];
    // Public ID must be present (16 hex characters)
    expect(listedToken.tokenPublicId).toBeDefined();
    expect(listedToken.tokenPublicId.length).toBe(16);
    // Secret hash or full secret must NOT be present
    expect(listedToken.secret_hash).toBeUndefined();
    expect(listedToken.secretHash).toBeUndefined();
    expect(listedToken.token).toBeUndefined();

    // 3. Revoke Token
    const revokeRes = await adminTokensRevoke.handler({
      httpMethod: "POST",
      headers: authHeaders,
      body: JSON.stringify({ tokenId: tokenData.tokenId }),
    });
    expect(revokeRes.statusCode).toBe(200);

    const revokedToken = await db.getTokenByPublicId(listedToken.tokenPublicId);
    expect(revokedToken.status).toBe("revoked");
    expect(revokedToken.revoked_at).toBeDefined();
  });

  test("Admin TTS Operations view returns metadata only (no audio URLs, no audio binary)", async () => {
    const client = await db.createClient({ name: "Operation Client" });
    const session = await db.createGenerationSession({
      clientId: client.id,
      projectId: "proj-123",
      projectTitle: "Docu-Serie Episodio 1",
    });

    const res = await adminTtsOps.handler({
      httpMethod: "GET",
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.sessions.length).toBe(1);

    const item = body.sessions[0];
    expect(item.id).toBe(session.id);
    expect(item.clientName).toBe("Operation Client");
    expect(item.projectTitle).toBe("Docu-Serie Episodio 1");
    expect(item.zipStatus).toBe("not_prepared");

    // Enforce NO signed URLs, NO audio blobs, NO token secrets
    expect(item.audioUrl).toBeUndefined();
    expect(item.audioBuffer).toBeUndefined();
    expect(item.signedUrl).toBeUndefined();
    expect(item.narrationText).toBeUndefined();
  });
});
