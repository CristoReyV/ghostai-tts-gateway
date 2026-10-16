/**
 * @file tests/multiAdminEmail.test.js
 * Comprehensive unit tests for Multi-Admin Users, RBAC, and Email Experience.
 * Tests:
 *  - Master admin token vs individual admin login
 *  - OWNER vs ADMIN role permissions (OWNER can manage admins; ADMIN is forbidden)
 *  - Admin invitation token generation & activation with scrypt password
 *  - Safety protection preventing last active owner from being disabled
 *  - Admin audit logging with attribution
 *  - GhostAIMemberInvitationEmail template HTML and plain text generation
 *  - Zero secret exposure in email body/headers
 *  - Single send & bulk send with batch safety (no full rollback on failure)
 *  - Duplicate click protection
 */

"use strict";

const db = require("../netlify/functions/lib/db");
const { hashPassword, verifyPassword } = require("../netlify/functions/lib/passwordService");
const { renderGhostAIMemberInvitationEmail } = require("../netlify/functions/lib/emailTemplates");
const { sendEmail } = require("../netlify/functions/lib/emailService");
const {
  inviteAdminUser,
  activateAdminUser,
  loginAdminWithPassword,
  updateAdminStatus,
} = require("../netlify/functions/lib/adminUserService");
const {
  requireAdminAuth,
  buildAdminSessionCookie,
  verifyAdminSessionToken,
} = require("../netlify/functions/lib/adminAuth");
const { handler: loginHandler } = require("../netlify/functions/admin-auth-login");
const { handler: statusHandler } = require("../netlify/functions/admin-auth-status");
const { handler: activateHandler } = require("../netlify/functions/admin-auth-activate");
const { handler: usersHandler } = require("../netlify/functions/admin-users");
const { handler: usersStatusHandler } = require("../netlify/functions/admin-users-status");
const { handler: previewHandler } = require("../netlify/functions/admin-members-email-preview");
const { handler: sendHandler } = require("../netlify/functions/admin-members-send-invitation");

const TEST_SECRET = "TEST_GHOSTAI_ADMIN_AUTH_TOKEN_XYZ123456";
const TEST_PEPPER = "TEST_PEPPER_KEY_FOR_ADMIN_TOKENS_987654";

describe("Multi-Admin Users & Email Experience (Phase 02)", () => {
  beforeEach(() => {
    db._setMemoryStoreEnabled(true);
    db._resetMemoryStore();
    process.env.GHOSTAI_ADMIN_AUTH_TOKEN = TEST_SECRET;
    process.env.GHOSTAI_TOKEN_HASH_PEPPER = TEST_PEPPER;
    process.env.GHOSTAI_EMAIL_SANDBOX = "true";
  });

  afterEach(() => {
    db._resetMemoryStore();
    db._setMemoryStoreEnabled(false);
    delete process.env.GHOSTAI_ADMIN_AUTH_TOKEN;
    delete process.env.GHOSTAI_TOKEN_HASH_PEPPER;
    delete process.env.GHOSTAI_EMAIL_SANDBOX;
  });

  // ── 1. Password Service ─────────────────────────────────────────────
  describe("1. Password Security (scrypt)", () => {
    test("hashes password securely and verifies correctly", async () => {
      const plain = "SuperSecretPassword123!";
      const hash = await hashPassword(plain);

      expect(hash).toMatch(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
      expect(hash).not.toContain(plain);

      const isValid = await verifyPassword(plain, hash);
      expect(isValid).toBe(true);

      const isInvalid = await verifyPassword("WrongPassword!", hash);
      expect(isInvalid).toBe(false);
    });

    test("rejects passwords shorter than 8 characters", async () => {
      await expect(hashPassword("short")).rejects.toThrow("at least 8 characters");
    });
  });

  // ── 2. Admin Authentication & RBAC ───────────────────────────────────
  describe("2. Admin Authentication & Role-Based Access Control", () => {
    test("master adminToken logs in as OWNER", async () => {
      const res = await loginHandler({
        httpMethod: "POST",
        body: JSON.stringify({ adminToken: TEST_SECRET }),
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.authenticated).toBe(true);
      expect(data.admin.role).toBe("owner");
      expect(res.headers["Set-Cookie"]).toBeDefined();
      expect(res.headers["Set-Cookie"]).toContain("ghostai_admin_session=");
      expect(res.headers["Set-Cookie"]).toContain("HttpOnly");
    });

    test("requireAdminAuth allows OWNER for owner-required endpoints", () => {
      const event = {
        headers: { authorization: `Bearer ${TEST_SECRET}` },
      };
      const auth = requireAdminAuth(event, "req-1", "owner");
      expect(auth.ok).toBe(true);
      expect(auth.admin.role).toBe("owner");
    });

    test("requireAdminAuth rejects ADMIN for owner-required endpoints with 403", () => {
      const sessionCookie = buildAdminSessionCookie(TEST_SECRET, {
        id: "admin-uuid-1",
        name: "Test Admin",
        email: "admin@test.com",
        role: "admin",
      });

      const event = {
        headers: { cookie: sessionCookie },
      };

      // General endpoint: allowed
      const generalAuth = requireAdminAuth(event, "req-2");
      expect(generalAuth.ok).toBe(true);
      expect(generalAuth.admin.role).toBe("admin");

      // Owner endpoint: forbidden
      const ownerAuth = requireAdminAuth(event, "req-3", "owner");
      expect(ownerAuth.ok).toBe(false);
      expect(ownerAuth.statusCode).toBe(403);
      expect(ownerAuth.error.code).toBe("FORBIDDEN");
    });
  });

  // ── 3. Multi-Admin Lifecycle ────────────────────────────────────────
  describe("3. Admin User Lifecycle & One-Time Activation", () => {
    test("OWNER invites new admin, generating one-time activation link", async () => {
      const requestingAdmin = { id: "owner-1", email: "owner@test.com", role: "owner" };
      const res = await inviteAdminUser({
        name: "Arturo Admin",
        email: "arturo@example.test",
        role: "admin",
        requestingAdmin,
      });

      expect(res.adminUser).toBeDefined();
      expect(res.adminUser.name).toBe("Arturo Admin");
      expect(res.adminUser.status).toBe("pending");
      expect(res.adminUser.role).toBe("admin");
      expect(res.activationToken).toMatch(/^gai_adm_act_[a-f0-9]{16}\.[a-f0-9]{48}$/);
      expect(res.activationLink).toContain(res.activationToken);

      // Audit log recorded
      const logs = await db.listAdminAuditLogs();
      const createLog = logs.find((l) => l.action === "admin_created");
      expect(createLog).toBeDefined();
      expect(createLog.admin_id).toBe("owner-1");
      expect(createLog.target_id).toBe(res.adminUser.id);
    });

    test("admin activates account with password via public activate endpoint", async () => {
      const requestingAdmin = { id: "owner-1", email: "owner@test.com", role: "owner" };
      const invite = await inviteAdminUser({
        name: "Sofia Admin",
        email: "sofia@example.test",
        role: "admin",
        requestingAdmin,
      });

      // Activate via handler
      const actRes = await activateHandler({
        httpMethod: "POST",
        body: JSON.stringify({
          token: invite.activationToken,
          password: "MySecurePassword1234!",
        }),
      });

      expect(actRes.statusCode).toBe(200);
      const actData = JSON.parse(actRes.body);
      expect(actData.ok).toBe(true);
      expect(actData.admin.email).toBe("sofia@example.test");
      expect(actData.admin.role).toBe("admin");
      expect(actRes.headers["Set-Cookie"]).toBeDefined();

      // Trying to activate with same token again is rejected (single-use)
      const secondRes = await activateHandler({
        httpMethod: "POST",
        body: JSON.stringify({
          token: invite.activationToken,
          password: "AnotherPassword123!",
        }),
      });
      expect(secondRes.statusCode).toBe(400);

      // Admin can now log in with email and password
      const loginRes = await loginHandler({
        httpMethod: "POST",
        body: JSON.stringify({
          email: "sofia@example.test",
          password: "MySecurePassword1234!",
        }),
      });
      expect(loginRes.statusCode).toBe(200);
      const loginData = JSON.parse(loginRes.body);
      expect(loginData.admin.email).toBe("sofia@example.test");
    });

    test("prevents deactivating the only active OWNER", async () => {
      // Create single active owner in DB
      const owner = await db.createAdminUserRecord({
        name: "Primary Owner",
        email: "primary@example.test",
        role: "owner",
        status: "active",
      });

      const requestingAdmin = { id: owner.id, email: owner.email, role: "owner" };

      await expect(
        updateAdminStatus({
          adminId: owner.id,
          status: "disabled",
          requestingAdmin,
        })
      ).rejects.toThrow("No se puede desactivar al único OWNER activo");
    });
  });

  // ── 4. Email Template & Safety ──────────────────────────────────────
  describe("4. Email Template (GhostAIMemberInvitationEmail)", () => {
    test("generates responsive dark premium HTML email and plain text fallback without secret keys", () => {
      const emailParams = {
        name: "Carlos Santana",
        email: "carlos@example.test",
        plan: "annual",
        activationLink: "https://ghostai-tts-studio.smartbrain.lat/?activate=gai_act_sample001.sec123",
        invitationExpiresAt: "2026-10-23T00:00:00.000Z",
      };

      const rendered = renderGhostAIMemberInvitationEmail(emailParams);

      expect(rendered.subject).toBe("Tu acceso a GhostAI ya está listo");
      expect(rendered.preheader).toBe("Activa tu acceso a GhostAI TTS Studio.");

      // HTML validations
      expect(rendered.html).toContain("GHOSTAI");
      expect(rendered.html).toContain("Tu acceso ya está listo");
      expect(rendered.html).toContain("Carlos Santana");
      expect(rendered.html).toContain("Anual");
      expect(rendered.html).toContain("ACTIVAR MI ACCESO");
      expect(rendered.html).toContain(emailParams.activationLink);
      expect(rendered.html).toContain("Este enlace es personal");

      // Strictly NO permanent GhostAI key secret in the email
      expect(rendered.html).not.toContain("gai_live_");
      expect(rendered.text).not.toContain("gai_live_");

      // Plain text fallback (Section 8)
      expect(rendered.text).toContain("Hola, Carlos Santana.");
      expect(rendered.text).toContain("Plan: Anual");
      expect(rendered.text).toContain("Activa tu acceso:");
      expect(rendered.text).toContain(emailParams.activationLink);
      expect(rendered.text).toContain("— GhostAI");
    });
  });

  // ── 5. Member Email Preview & Send Handlers ──────────────────────────
  describe("5. Member Email Preview & Send Handlers", () => {
    let testMember;

    beforeEach(async () => {
      const client = await db.createClient({ name: "Client A", email: "clienta@test.com" });
      testMember = await db.createMemberRecord({
        clientId: client.id,
        name: "Juan Perez",
        email: "juan@example.test",
        accessPlan: "monthly",
      });
      await db.createActivationTokenRecord({
        memberId: testMember.id,
        tokenHash: "hash123",
        tokenPublicId: "pub123",
        encryptedKey: "encKey123",
        expiresAt: new Date(Date.now() + 86400000 * 7).toISOString(),
      });
    });

    test("POST /api/admin/members/email-preview returns rendered preview without sending", async () => {
      const res = await previewHandler({
        httpMethod: "POST",
        headers: { authorization: `Bearer ${TEST_SECRET}` },
        body: JSON.stringify({ memberId: testMember.id }),
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.preview.to).toBe("juan@example.test");
      expect(data.preview.subject).toBe("Tu acceso a GhostAI ya está listo");
      expect(data.preview.html).toContain("ACTIVAR MI ACCESO");
      expect(data.preview.text).toContain("Plan: Mensual");
    });

    test("POST /api/admin/members/send-invitation dispatches email, updates member, and logs audit", async () => {
      const res = await sendHandler({
        httpMethod: "POST",
        headers: { authorization: `Bearer ${TEST_SECRET}` },
        body: JSON.stringify({ memberId: testMember.id }),
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(data.processed).toBe(1);
      expect(data.succeededCount).toBe(1);
      expect(data.failedCount).toBe(0);

      // Verify member email status was updated
      const updated = await db.getMemberById(testMember.id);
      expect(updated.last_email_status).toBe("sent");
      expect(updated.last_email_sent_at).toBeDefined();

      // Verify audit log entry
      const logs = await db.listAdminAuditLogs();
      const sendLog = logs.find((l) => l.action === "invite_sent");
      expect(sendLog).toBeDefined();
      expect(sendLog.target_id).toBe(testMember.id);
    });

    test("bulk send processes individually and isolates failures (batch safety)", async () => {
      const client = await db.createClient({ name: "Client B" });
      const failMember = await db.createMemberRecord({
        clientId: client.id,
        name: "Fail Member",
        email: "error-fail@example.test",
        accessPlan: "monthly",
      });

      const res = await sendHandler({
        httpMethod: "POST",
        headers: { authorization: `Bearer ${TEST_SECRET}` },
        body: JSON.stringify({ memberIds: [testMember.id, failMember.id] }),
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.processed).toBe(2);
      expect(data.succeededCount).toBe(1);
      expect(data.failedCount).toBe(1);
      expect(data.failed[0].email).toBe("error-fail@example.test");

      // testMember should still be sent (no rollback because failMember failed)
      const memberA = await db.getMemberById(testMember.id);
      expect(memberA.last_email_status).toBe("sent");

      const memberB = await db.getMemberById(failMember.id);
      expect(memberB.last_email_status).toBe("failed");
    });
  });
});
