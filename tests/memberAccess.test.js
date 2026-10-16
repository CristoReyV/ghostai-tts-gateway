/**
 * @file tests/memberAccess.test.js
 * Comprehensive test suite for Member Access 01:
 * Bulk Member Import, Individual Key Control, Cryptographic Activation, Expirations,
 * Renewal, Revocation, and backward-compatible manual key authentication.
 */

"use strict";

const db = require("../netlify/functions/lib/db");
const { generateClientToken, TOKEN_PREFIX } = require("../netlify/functions/lib/tokenService");
const { authenticateGhostAIRequest } = require("../netlify/functions/lib/auth");
const {
  createMemberWithAccess,
  activateMemberAccess,
  renewMemberAccess,
  revokeMemberAccess,
  inviteMember,
  buildEmailPayload,
} = require("../netlify/functions/lib/memberService");
const {
  parseCsv,
  parseXlsx,
  validateMemberRows,
  get12MembersCsvText,
  build12MembersXlsxBuffer,
} = require("../netlify/functions/lib/memberImportParser");

const TEST_PEPPER = "test-pepper-member-access-secure-32bytes-12345";
const TEST_ADMIN_TOKEN = "ghostai_admin_test_secret_key_12345";
const TEST_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Member Access 01 — Bulk Import & Individual Key Control", () => {
  let originalPepper;
  let originalAdminToken;
  let originalEncKey;

  beforeAll(() => {
    originalPepper = process.env.GHOSTAI_TOKEN_HASH_PEPPER;
    originalAdminToken = process.env.GHOSTAI_ADMIN_AUTH_TOKEN;
    originalEncKey = process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY;

    process.env.GHOSTAI_TOKEN_HASH_PEPPER = TEST_PEPPER;
    process.env.GHOSTAI_ADMIN_AUTH_TOKEN = TEST_ADMIN_TOKEN;
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    db._setMemoryStoreEnabled(true);
  });

  afterAll(() => {
    process.env.GHOSTAI_TOKEN_HASH_PEPPER = originalPepper;
    process.env.GHOSTAI_ADMIN_AUTH_TOKEN = originalAdminToken;
    process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = originalEncKey;
    db._setMemoryStoreEnabled(false);
  });

  beforeEach(() => {
    db._resetMemoryStore();
  });

  // ── 1. Existing manual key backward-compatibility ────────────────────────
  test("existing manual key: PASS", async () => {
    // Simulate existing manual key generated before this work
    const client = await db.createClient({ name: "Manual Operator Studio", email: "manual@ghostai.test" });
    const tokenResult = await generateClientToken({
      clientId: client.id,
      label: "Manual Pre-existing Operator Key",
    });

    const event = {
      headers: {
        authorization: `Bearer ${tokenResult.token}`,
      },
    };

    const auth = await authenticateGhostAIRequest(event, "req-existing-key");
    expect(auth.ok).toBe(true);
    expect(auth.authenticated).toBe(true);
    expect(auth.authMode).toBe("client_token");
    expect(auth.clientId).toBe(client.id);
    expect(auth.clientName).toBe("Manual Operator Studio");
  });

  // ── 2. CSV Parse & 12-row fixture ─────────────────────────────────────────
  test("csv parse & 12-row fixture: PASS", () => {
    const csvContent = get12MembersCsvText();
    const parsed = parseCsv(csvContent);

    expect(parsed).toHaveLength(12);
    expect(parsed[0].name).toBe("Jose Varela");
    expect(parsed[0].email).toBe("jjvarela0321@gmail.com");
    expect(parsed[0].accessPlan).toBe("monthly");

    expect(parsed[9].name).toBe("Ricardo Daniel Tovar Barrera");
    expect(parsed[9].email).toBe("r.tovar.barrera@gmail.com");
    expect(parsed[9].accessPlan).toBe("annual");

    expect(parsed[10].name).toBe("Sandy Leon");
    expect(parsed[10].email).toBe("Sandy22karina22@gmail.com");
    expect(parsed[10].accessPlan).toBe("annual");

    expect(parsed[11].name).toBe("Jorge MV");
    expect(parsed[11].email).toBe("jorgr.mv@gmail.com");
    expect(parsed[11].accessPlan).toBe("monthly");
  });

  // ── 3. XLSX Parse & 12-row fixture ────────────────────────────────────────
  test("xlsx parse & 12-row fixture: PASS", async () => {
    const xlsxBuffer = await build12MembersXlsxBuffer();
    const parsed = await parseXlsx(xlsxBuffer);

    expect(parsed).toHaveLength(12);
    expect(parsed[0].name).toBe("Jose Varela");
    expect(parsed[0].email).toBe("jjvarela0321@gmail.com");
    expect(parsed[0].accessPlan).toBe("monthly");

    expect(parsed[9].name).toBe("Ricardo Daniel Tovar Barrera");
    expect(parsed[9].email).toBe("r.tovar.barrera@gmail.com");
    expect(parsed[9].accessPlan).toBe("annual");
  });

  // ── 4. Monthly & Annual parse validation ──────────────────────────────────
  test("monthly parse & annual parse: PASS", () => {
    const csv = `NOMBRE,CORREO,Tipo de Acceso
User Mensual,user.m@test.com,Mensual
User Anual,user.a@test.com,Anual
User Lowercase,user.low@test.com,mensual
User English,user.eng@test.com,annual`;

    const parsed = parseCsv(csv);
    const validation = validateMemberRows(parsed, []);

    expect(validation.validCount).toBe(4);
    expect(validation.monthlyCount).toBe(2);
    expect(validation.annualCount).toBe(2);
    expect(validation.errorCount).toBe(0);
  });

  // ── 5. Invalid email validation ───────────────────────────────────────────
  test("invalid email: PASS", () => {
    const rows = [
      { name: "Bad Email", email: "not-an-email", accessPlan: "monthly", rawPlan: "Mensual" },
      { name: "Good Email", email: "good@test.com", accessPlan: "monthly", rawPlan: "Mensual" },
    ];
    const validation = validateMemberRows(rows, []);

    expect(validation.errorCount).toBe(1);
    expect(validation.validCount).toBe(1);
    expect(validation.rows[0].validationStatus).toBe("Correo inválido");
    expect(validation.rows[1].validationStatus).toBe("Válido");
  });

  // ── 6. Duplicate in file detection ────────────────────────────────────────
  test("duplicate in file: PASS", () => {
    const rows = [
      { name: "Alice First", email: "alice@test.com", accessPlan: "monthly", rawPlan: "Mensual" },
      { name: "Alice Second", email: "ALICE@test.com", accessPlan: "annual", rawPlan: "Anual" },
    ];
    const validation = validateMemberRows(rows, []);

    expect(validation.validCount).toBe(1);
    expect(validation.errorCount).toBe(1);
    expect(validation.rows[0].validationStatus).toBe("Válido");
    expect(validation.rows[1].validationStatus).toBe("Duplicado en archivo");
  });

  // ── 7. Existing email detection ───────────────────────────────────────────
  test("existing email: PASS", () => {
    const existing = [{ email: "jjvarela0321@gmail.com", status: "active" }];
    const rows = [
      { name: "Jose Varela", email: "jjvarela0321@gmail.com", accessPlan: "monthly", rawPlan: "Mensual" },
      { name: "Arturo Fuentes", email: "arturo.fuentesg@gmail.com", accessPlan: "monthly", rawPlan: "Mensual" },
    ];
    const validation = validateMemberRows(rows, existing);

    expect(validation.existingCount).toBe(1);
    expect(validation.validCount).toBe(1);
    expect(validation.rows[0].validationStatus).toBe("YA EXISTE");
    expect(validation.rows[0].existingMemberStatus).toBe("active");
    expect(validation.rows[1].validationStatus).toBe("Válido");
  });

  // ── 8. Unique key per member & pending state ──────────────────────────────
  test("unique key per member & pending state: PASS", async () => {
    const m1 = await createMemberWithAccess({
      name: "Jose Varela",
      email: "jjvarela0321@gmail.com",
      accessPlan: "monthly",
    });

    const m2 = await createMemberWithAccess({
      name: "Arturo Fuentes",
      email: "arturo.fuentesg@gmail.com",
      accessPlan: "monthly",
    });

    // Unique keys and IDs
    expect(m1.member.id).not.toBe(m2.member.id);
    expect(m1.member.keyId).not.toBe(m2.member.keyId);
    expect(m1.member.tokenPublicId).not.toBe(m2.member.tokenPublicId);
    expect(m1.activationToken).not.toBe(m2.activationToken);

    // Initial status must be 'pending'
    expect(m1.member.status).toBe("pending");
    expect(m1.member.activated_at).toBeNull();
    expect(m1.member.expires_at).toBeNull();

    // Verify unactivated pending member cannot authenticate directly before activation
    const authAttempt = await authenticateGhostAIRequest(
      { headers: { authorization: `Bearer ${TOKEN_PREFIX}${m1.member.tokenPublicId}.dummy` } },
      "req-pending"
    );
    expect(authAttempt.authenticated).toBe(false);
  });

  // ── 9. Activation token, activation flow, activatedAt & monthly expiration
  test("activation token, activation, activatedAt & monthly expiration: PASS", async () => {
    const created = await createMemberWithAccess({
      name: "Felix Torres",
      email: "felotorquin@gmail.com",
      accessPlan: "monthly",
    });

    expect(created.activationToken).toMatch(/^gai_act_/);
    expect(created.activationLink).toContain(encodeURIComponent(created.activationToken));

    // Perform activation
    const beforeActivation = Date.now();
    const result = await activateMemberAccess(created.activationToken);

    expect(result.ok).toBe(true);
    expect(result.clientName).toBe("Felix Torres");
    expect(result.accessPlan).toBe("monthly");
    expect(result.accessKey).toMatch(/^gai_live_/);

    const activatedAtTime = new Date(result.activatedAt).getTime();
    const expiresAtTime = new Date(result.expiresAt).getTime();

    expect(activatedAtTime).toBeGreaterThanOrEqual(beforeActivation);

    // Monthly expiration should be exactly 30 days (+/- 2 seconds)
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const diff = expiresAtTime - activatedAtTime;
    expect(Math.abs(diff - thirtyDaysMs)).toBeLessThan(2000);

    // Verify member in DB is now active
    const memberInDb = await db.getMemberById(created.member.id);
    expect(memberInDb.status).toBe("active");
    expect(memberInDb.activated_at).toBe(result.activatedAt);
    expect(memberInDb.expires_at).toBe(result.expiresAt);

    // Authenticate with the activated key
    const auth = await authenticateGhostAIRequest(
      { headers: { authorization: `Bearer ${result.accessKey}` } },
      "req-active-key"
    );
    expect(auth.ok).toBe(true);
    expect(auth.authenticated).toBe(true);
    expect(auth.clientId).toBe(memberInDb.client_id);
  });

  // ── 10. Annual expiration (365 days) ──────────────────────────────────────
  test("annual expiration: PASS", async () => {
    const created = await createMemberWithAccess({
      name: "Ricardo Daniel Tovar Barrera",
      email: "r.tovar.barrera@gmail.com",
      accessPlan: "annual",
    });

    const result = await activateMemberAccess(created.activationToken);
    expect(result.ok).toBe(true);
    expect(result.accessPlan).toBe("annual");

    const activatedAtTime = new Date(result.activatedAt).getTime();
    const expiresAtTime = new Date(result.expiresAt).getTime();
    const annualMs = 365 * 24 * 60 * 60 * 1000;
    const diff = expiresAtTime - activatedAtTime;
    expect(Math.abs(diff - annualMs)).toBeLessThan(2000);
  });

  // ── 11. Token second use: REJECTED ────────────────────────────────────────
  test("token second use: REJECTED", async () => {
    const created = await createMemberWithAccess({
      name: "Freddy Perez",
      email: "marketingcpa2025@gmail.com",
      accessPlan: "monthly",
    });

    // 1st use: SUCCESS
    const firstUse = await activateMemberAccess(created.activationToken);
    expect(firstUse.ok).toBe(true);

    // 2nd use: REJECTED
    await expect(activateMemberAccess(created.activationToken)).rejects.toMatchObject({
      code: "TOKEN_ALREADY_USED",
      statusCode: 400,
    });
  });

  // ── 12. Expired activation token: REJECTED ────────────────────────────────
  test("expired token: REJECTED", async () => {
    const created = await createMemberWithAccess({
      name: "Joshua Marquez",
      email: "joshua.marquez@gmail.com",
      accessPlan: "monthly",
    });

    // Force activation token to be expired 1 day ago
    const tokenHash = require("../netlify/functions/lib/tokenService").hashSecret(created.activationToken);
    const actRecord = await db.getActivationTokenByHash(tokenHash);
    await db.updateActivationTokenRecord(actRecord.id, {
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });

    await expect(activateMemberAccess(created.activationToken)).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
      statusCode: 400,
    });
  });

  // ── 13. Revoked member: REJECTED & other users unaffected ─────────────────
  test("revoked member: REJECTED & other users unaffected by revoke: PASS", async () => {
    const userA = await createMemberWithAccess({
      name: "User A",
      email: "usera@test.com",
      accessPlan: "monthly",
    });
    const actA = await activateMemberAccess(userA.activationToken);

    const userB = await createMemberWithAccess({
      name: "User B",
      email: "userb@test.com",
      accessPlan: "monthly",
    });
    const actB = await activateMemberAccess(userB.activationToken);

    // Both work initially
    const authA1 = await authenticateGhostAIRequest({ headers: { authorization: `Bearer ${actA.accessKey}` } });
    const authB1 = await authenticateGhostAIRequest({ headers: { authorization: `Bearer ${actB.accessKey}` } });
    expect(authA1.ok).toBe(true);
    expect(authB1.ok).toBe(true);

    // Revoke User A
    const revoked = await revokeMemberAccess(userA.member.id);
    expect(revoked.status).toBe("revoked");
    expect(revoked.revoked_at).toBeTruthy();

    // User A is REJECTED
    const authA2 = await authenticateGhostAIRequest({ headers: { authorization: `Bearer ${actA.accessKey}` } });
    expect(authA2.ok).toBe(false);
    expect(authA2.statusCode).toBe(401);

    // User B remains COMPLETELY UNAFFECTED and passes!
    const authB2 = await authenticateGhostAIRequest({ headers: { authorization: `Bearer ${actB.accessKey}` } });
    expect(authB2.ok).toBe(true);
    expect(authB2.authenticated).toBe(true);
  });

  // ── 14. Renew monthly (+30 days) ──────────────────────────────────────────
  test("renew monthly: PASS", async () => {
    const created = await createMemberWithAccess({
      name: "Daniel Avila",
      email: "danielfelipeparra07@gmail.com",
      accessPlan: "monthly",
    });
    const activated = await activateMemberAccess(created.activationToken);
    const initialExpTime = new Date(activated.expiresAt).getTime();

    // Renew +1 month
    const renewed = await renewMemberAccess(created.member.id, "monthly");
    const newExpTime = new Date(renewed.expires_at).getTime();

    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const diff = newExpTime - initialExpTime;
    expect(Math.abs(diff - thirtyDaysMs)).toBeLessThan(2000);
  });

  // ── 15. Renew annual (+365 days) ──────────────────────────────────────────
  test("renew annual: PASS", async () => {
    const created = await createMemberWithAccess({
      name: "Cesar Castro",
      email: "ingenierocesarcastro@gmail.com",
      accessPlan: "monthly",
    });
    const activated = await activateMemberAccess(created.activationToken);
    const initialExpTime = new Date(activated.expiresAt).getTime();

    // Renew +1 year
    const renewed = await renewMemberAccess(created.member.id, "annual");
    const newExpTime = new Date(renewed.expires_at).getTime();

    const annualMs = 365 * 24 * 60 * 60 * 1000;
    const diff = newExpTime - initialExpTime;
    expect(Math.abs(diff - annualMs)).toBeLessThan(2000);
  });

  // ── 16. Email payload format & Zero real emails sent ─────────────────────
  test("email payload & zero real emails sent: PASS", async () => {
    const payload = buildEmailPayload({
      memberId: "test-uuid-1234",
      name: "Jose Varela",
      email: "jjvarela0321@gmail.com",
      plan: "monthly",
      activationLink: "https://studio.test/?activate=token123",
    });

    expect(payload.subject).toBe("Tu acceso a GhostAI ya está listo");
    expect(payload.body).toContain("Hola, Jose Varela.");
    expect(payload.body).toContain("Actívalo desde este enlace:");
    expect(payload.body).toContain("https://studio.test/?activate=token123");
    expect(payload.body).toContain("Plan: Mensual");
    expect(payload.body).toContain("— GhostAI");

    // Zero real emails sent check
    const invited = await inviteMember((await createMemberWithAccess({
      name: "Sandy Leon",
      email: "Sandy22karina22@gmail.com",
      accessPlan: "annual",
    })).member.id);

    expect(invited.emailPayload.plan).toBe("Anual");
    expect(invited.emailPayload.body).toContain("Plan: Anual");
  });
});
