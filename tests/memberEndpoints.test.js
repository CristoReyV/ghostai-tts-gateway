/**
 * @file tests/memberEndpoints.test.js
 * Integration tests for the 7 Member Access Netlify Function handlers:
 * admin-members, admin-members-bulk, admin-members-renew, admin-members-revoke,
 * admin-members-invite, admin-members-regenerate-key, members-activate.
 */

"use strict";

const db = require("../netlify/functions/lib/db");
const adminMembers = require("../netlify/functions/admin-members");
const adminMembersBulk = require("../netlify/functions/admin-members-bulk");
const adminMembersRenew = require("../netlify/functions/admin-members-renew");
const adminMembersRevoke = require("../netlify/functions/admin-members-revoke");
const adminMembersInvite = require("../netlify/functions/admin-members-invite");
const adminMembersRegenerateKey = require("../netlify/functions/admin-members-regenerate-key");
const membersActivate = require("../netlify/functions/members-activate");
const { get12MembersCsvText, parseCsv } = require("../netlify/functions/lib/memberImportParser");

const TEST_ADMIN_TOKEN = "endpoint-test-admin-secret-12345";
const TEST_PEPPER = "endpoint-test-pepper-12345";
const TEST_ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function adminEvent(method, body = null, path = "") {
  return {
    httpMethod: method,
    headers: {
      authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
      origin: "http://localhost:5173",
    },
    body: body ? JSON.stringify(body) : null,
  };
}

describe("Member Access Netlify Function Endpoints", () => {
  let origAdmin;
  let origPepper;
  let origEnc;

  beforeAll(() => {
    origAdmin = process.env.GHOSTAI_ADMIN_AUTH_TOKEN;
    origPepper = process.env.GHOSTAI_TOKEN_HASH_PEPPER;
    origEnc = process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY;

    process.env.GHOSTAI_ADMIN_AUTH_TOKEN = TEST_ADMIN_TOKEN;
    process.env.GHOSTAI_TOKEN_HASH_PEPPER = TEST_PEPPER;
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_ENC_KEY;

    db._setMemoryStoreEnabled(true);
  });

  afterAll(() => {
    process.env.GHOSTAI_ADMIN_AUTH_TOKEN = origAdmin;
    process.env.GHOSTAI_TOKEN_HASH_PEPPER = origPepper;
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = origEnc;
    db._setMemoryStoreEnabled(false);
  });

  beforeEach(() => {
    db._resetMemoryStore();
  });

  test("admin-members: GET (empty) & POST (create single)", async () => {
    // 1. GET empty list
    const getRes = await adminMembers.handler(adminEvent("GET"));
    expect(getRes.statusCode).toBe(200);
    const getData = JSON.parse(getRes.body);
    expect(getData.ok).toBe(true);
    expect(getData.members).toHaveLength(0);

    // 2. POST create member
    const postRes = await adminMembers.handler(
      adminEvent("POST", {
        name: "Jose Varela",
        email: "jjvarela0321@gmail.com",
        accessPlan: "monthly",
      })
    );
    expect(postRes.statusCode).toBe(201);
    const postData = JSON.parse(postRes.body);
    expect(postData.ok).toBe(true);
    expect(postData.member.name).toBe("Jose Varela");
    expect(postData.activationToken).toMatch(/^gai_act_/);
    expect(postData.emailPayload.subject).toBe("Tu acceso a GhostAI ya está listo");
    expect(postData.emailPayload.plan).toBe("Mensual");

    // 3. GET list should have 1
    const getRes2 = await adminMembers.handler(adminEvent("GET"));
    const getData2 = JSON.parse(getRes2.body);
    expect(getData2.members).toHaveLength(1);
    expect(getData2.members[0].status).toBe("pending");
  });

  test("admin-members-bulk: imports the official 12 members", async () => {
    const csv12 = get12MembersCsvText();
    const rows = parseCsv(csv12);

    const bulkRes = await adminMembersBulk.handler(adminEvent("POST", { members: rows }));
    expect(bulkRes.statusCode).toBe(200);
    const data = JSON.parse(bulkRes.body);

    expect(data.ok).toBe(true);
    expect(data.summary.processed).toBe(12);
    expect(data.summary.newCount).toBe(12);
    expect(data.summary.existingCount).toBe(0);
    expect(data.summary.errorCount).toBe(0);
    expect(data.summary.monthlyCount).toBe(10);
    expect(data.summary.annualCount).toBe(2);
    expect(data.zeroRealEmailsSent).toBe(true);

    // Re-importing same 12 should yield existingCount = 12, newCount = 0
    const bulkRes2 = await adminMembersBulk.handler(adminEvent("POST", { members: rows }));
    const data2 = JSON.parse(bulkRes2.body);
    expect(data2.summary.newCount).toBe(0);
    expect(data2.summary.existingCount).toBe(12);
  });

  test("members-activate: public activation endpoint", async () => {
    const postRes = await adminMembers.handler(
      adminEvent("POST", {
        name: "Arturo Fuentes",
        email: "arturo.fuentesg@gmail.com",
        accessPlan: "monthly",
      })
    );
    const postData = JSON.parse(postRes.body);
    const actToken = postData.activationToken;

    // Public call to /api/members/activate
    const actRes = await membersActivate.handler({
      httpMethod: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: actToken }),
    });

    expect(actRes.statusCode).toBe(200);
    const actData = JSON.parse(actRes.body);
    expect(actData.ok).toBe(true);
    expect(actData.authenticated).toBe(true);
    expect(actData.clientName).toBe("Arturo Fuentes");
    expect(actData.accessPlan).toBe("monthly");
    expect(actData.accessKey).toMatch(/^gai_live_/);
    expect(actData.activatedAt).toBeTruthy();
    expect(actData.expiresAt).toBeTruthy();

    // Calling again should fail (single-use)
    const actRes2 = await membersActivate.handler({
      httpMethod: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: actToken }),
    });
    expect(actRes2.statusCode).toBe(400);
    const actData2 = JSON.parse(actRes2.body);
    expect(actData2.error.code).toBe("TOKEN_ALREADY_USED");
  });

  test("admin-members-renew: renews member access", async () => {
    const postRes = await adminMembers.handler(
      adminEvent("POST", {
        name: "Renew Test User",
        email: "renew@ghostai.test",
        accessPlan: "monthly",
      })
    );
    const { member, activationToken } = JSON.parse(postRes.body);
    await membersActivate.handler({
      httpMethod: "POST",
      body: JSON.stringify({ token: activationToken }),
    });

    // Renew +1 year
    const renewRes = await adminMembersRenew.handler(
      adminEvent("POST", { memberId: member.id, extension: "annual" })
    );
    expect(renewRes.statusCode).toBe(200);
    const renewData = JSON.parse(renewRes.body);
    expect(renewData.ok).toBe(true);
    expect(renewData.status).toBe("active");
  });

  test("admin-members-revoke: revokes member access", async () => {
    const postRes = await adminMembers.handler(
      adminEvent("POST", {
        name: "Revoke Test User",
        email: "revoke@ghostai.test",
        accessPlan: "monthly",
      })
    );
    const { member } = JSON.parse(postRes.body);

    const revokeRes = await adminMembersRevoke.handler(
      adminEvent("POST", { memberId: member.id })
    );
    expect(revokeRes.statusCode).toBe(200);
    const revokeData = JSON.parse(revokeRes.body);
    expect(revokeData.ok).toBe(true);
    expect(revokeData.status).toBe("revoked");
  });

  test("admin-members-invite: batch invitations generation", async () => {
    const p1 = await adminMembers.handler(adminEvent("POST", { name: "M1", email: "m1@test.com", accessPlan: "monthly" }));
    const p2 = await adminMembers.handler(adminEvent("POST", { name: "M2", email: "m2@test.com", accessPlan: "annual" }));
    const id1 = JSON.parse(p1.body).member.id;
    const id2 = JSON.parse(p2.body).member.id;

    const inviteRes = await adminMembersInvite.handler(
      adminEvent("POST", { memberIds: [id1, id2] })
    );
    expect(inviteRes.statusCode).toBe(200);
    const inviteData = JSON.parse(inviteRes.body);
    expect(inviteData.sentCount).toBe(2);
    expect(inviteData.invitations).toHaveLength(2);
    expect(inviteData.zeroRealEmailsSent).toBe(true);
  });

  test("admin-members-regenerate-key: regenerates member key", async () => {
    const postRes = await adminMembers.handler(
      adminEvent("POST", {
        name: "Regen Key User",
        email: "regen@ghostai.test",
        accessPlan: "monthly",
      })
    );
    const { member } = JSON.parse(postRes.body);
    const initialKeyId = member.keyId;

    const regenRes = await adminMembersRegenerateKey.handler(
      adminEvent("POST", { memberId: member.id })
    );
    expect(regenRes.statusCode).toBe(200);
    const regenData = JSON.parse(regenRes.body);
    expect(regenData.ok).toBe(true);
    expect(regenData.member.key_id).not.toBe(initialKeyId);
    expect(regenData.activationToken).toMatch(/^gai_act_/);
  });
});
