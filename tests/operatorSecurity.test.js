"use strict";
const db = require("../netlify/functions/lib/db");
const { manageAdminKey } = require("../netlify/functions/lib/adminKeyService");
const { buildAdminSessionCookie, generateAdminSessionToken, parseAdminSessionToken } = require("../netlify/functions/lib/adminAuth");
const { createMemberWithAccess } = require("../netlify/functions/lib/memberService");
const login = require("../netlify/functions/admin-auth-login").handler;
const logout = require("../netlify/functions/admin-auth-logout").handler;
const status = require("../netlify/functions/admin-auth-status").handler;
const owner = { id: "00000000-0000-0000-0000-000000000000", role: "owner", name: "Owner" };
let partner, cookie;
const call = (name, method = "POST", body = {}, headers = { cookie }) => require(`../netlify/functions/${name}`).handler({ httpMethod: method, headers, body: JSON.stringify(body) });
beforeEach(async () => {
  process.env.GHOSTAI_ADMIN_AUTH_TOKEN = "unit-only-admin-secret";
  process.env.GHOSTAI_TOKEN_HASH_PEPPER = "unit-only-pepper";
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;
  process.env.GHOSTAI_EMAIL_MODE = "provider";
  db._setMemoryStoreEnabled(true); db._resetMemoryStore();
  partner = await manageAdminKey({ action: "create", name: "Test operator", requestingAdmin: owner });
  const res = await login({ httpMethod: "POST", body: JSON.stringify({ adminKey: partner.key }) });
  cookie = res.headers["Set-Cookie"].split(";")[0];
});
afterAll(() => db._setMemoryStoreEnabled(false));

test("key login is scoped and stores only hash; session has no raw key", async () => {
  const id = partner.key.slice(10).split(".")[0];
  const stored = await db.getAdminKey(id);
  expect(stored.secret_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(stored)).not.toContain(partner.key.split(".")[1]);
  expect(cookie).not.toContain(partner.key);
  const res = await status({ httpMethod: "GET", headers: { cookie } });
  expect(JSON.parse(res.body).admin.role).toBe("operator");
  const audit = await db.listAdminAuditLogs();
  expect(audit.some(e => e.action === "admin_key_login" && e.admin_role === "operator")).toBe(true);
  expect(JSON.stringify(audit)).not.toContain(partner.key);
});

test.each([
  ["admin-members", "POST"], ["admin-members-bulk", "POST"],
  ["admin-members-regenerate-key", "POST"], ["admin-access-tokens", "POST"],
  ["admin-users", "POST"], ["admin-users-status", "POST"], ["admin-keys", "POST"],
  ["admin-clients", "GET"], ["admin-access-tokens", "GET"], ["admin-audit-logs", "GET"],
  ["admin-members-renew", "POST"], ["admin-members-revoke", "POST"], ["admin-tts-operations", "GET"],
])("OPERATOR denied %s %s before side effects", async (endpoint, method) => {
  expect((await call(endpoint, method)).statusCode).toBe(403);
});

test("ADMIN also cannot generate new member keys; OWNER can", async () => {
  const admin = await db.createAdminUserRecord({ name: "Admin", email: "admin@example.test", role: "admin", status: "active" });
  const adminCookie = buildAdminSessionCookie(process.env.GHOSTAI_ADMIN_AUTH_TOKEN, admin).split(";")[0];
  for (const endpoint of ["admin-members", "admin-members-bulk", "admin-members-regenerate-key", "admin-access-tokens"]) {
    expect((await call(endpoint, "POST", {}, { cookie: adminCookie })).statusCode).toBe(403);
  }
  const res = await call("admin-members", "POST", { name: "QA", email: "qa@example.test", accessPlan: "monthly" }, { authorization: `Bearer ${process.env.GHOSTAI_ADMIN_AUTH_TOKEN}` });
  expect(res.statusCode).toBe(201);
  expect((await call("admin-members-regenerate-key", "POST", { memberId: JSON.parse(res.body).member.id }, { authorization: `Bearer ${process.env.GHOSTAI_ADMIN_AUTH_TOKEN}` })).statusCode).toBe(200);
});

test("operator can list, preview, prepare bulk, copy invite, send in sandbox without generating member keys", async () => {
  const { member } = await createMemberWithAccess({ name: "QA", email: "qa@example.test", accessPlan: "monthly" });
  expect((await call("admin-members", "GET")).statusCode).toBe(200);
  expect((await call("admin-members-email-preview", "POST", { memberId: member.id })).statusCode).toBe(200);
  const bulk = await call("admin-members-send-invitation", "POST", { memberIds: [member.id], previewOnly: true });
  expect(JSON.parse(bulk.body).zeroRealEmailsSent).toBe(true);
  expect((await db.getMemberById(member.id)).last_email_sent_at).toBeFalsy();
  const invite = await call("admin-members-invite", "POST", { memberId: member.id });
  expect(invite.statusCode).toBe(200);
  expect(JSON.parse(invite.body).sentCount).toBe(1);
  const send = await call("admin-members-send-invitation", "POST", { memberId: member.id });
  expect(JSON.parse(send.body).succeededCount).toBe(1);
  expect((await db.getMemberById(member.id)).key_id).toBe(member.key_id);
});

test.each(["revoke", "rotate", "disable", "logout"])("%s invalidates old sessions", async action => {
  if (action === "disable") await db.updateAdminUser(partner.admin.id, { status: "disabled" });
  else if (action === "logout") expect((await logout({ httpMethod: "POST", headers: { cookie } })).statusCode).toBe(200);
  else await manageAdminKey({ action, adminId: partner.admin.id, requestingAdmin: owner });
  const res = await status({ httpMethod: "GET", headers: { cookie } });
  expect(JSON.parse(res.body).authenticated).toBe(false);
  if (action !== "logout") expect((await login({ httpMethod: "POST", body: JSON.stringify({ adminKey: partner.key }) })).statusCode).toBe(401);
});

test("admin key is not a master token or a member key; unknown roles fail closed", async () => {
  expect((await login({ httpMethod: "POST", body: JSON.stringify({ adminToken: partner.key }) })).statusCode).toBe(401);
  const { authenticateGhostAIRequest: requireAuth } = require("../netlify/functions/lib/auth");
  expect((await requireAuth({ headers: { authorization: `Bearer ${partner.key}` } })).ok).toBe(false);
  const token = generateAdminSessionToken(process.env.GHOSTAI_ADMIN_AUTH_TOKEN, { id: partner.admin.id, role: "unknown" });
  expect(parseAdminSessionToken(token, process.env.GHOSTAI_ADMIN_AUTH_TOKEN)).toBeNull();
});

test("manual preparation reuses a valid personal link and leaves member pending and unsent", async () => {
  const { member } = await createMemberWithAccess({ name: "QA & Test", email: "qa@example.test", accessPlan: "annual" });
  const prepare = () => call("admin-members-prepare-email", "POST", { memberId: member.id });
  const first = await prepare();
  expect(first.statusCode).toBe(200);
  const draft = JSON.parse(first.body).preview;
  expect(draft.activationLink).not.toContain("preview_token");
  expect(draft.html).toContain("ACTIVAR MI ACCESO");
  expect(draft.html).toContain("Anual");
  expect(draft.text).not.toContain("gai_live_");
  expect(JSON.parse((await prepare()).body).preview.activationLink).toBe(draft.activationLink);
  const updated = await db.getMemberById(member.id);
  expect(updated.status).toBe("pending");
  expect(updated.last_email_sent_at).toBeFalsy();
  expect(updated.key_id).toBe(member.key_id);
  delete process.env.GHOSTAI_EMAIL_MODE;
  expect((await call("admin-members-send-invitation", "POST", { memberId: member.id })).statusCode).toBe(409);
  expect((await db.getMemberById(member.id)).last_email_sent_at).toBeFalsy();
  delete process.env.GHOSTAI_EMAIL_MODE;
});

test("activation links target Studio even when Netlify URL points to Gateway", () => {
  const previousUrl = process.env.URL;
  const previousStudio = process.env.GHOSTAI_STUDIO_URL;
  process.env.URL = "https://tts-test.smartbrain.lat";
  delete process.env.GHOSTAI_STUDIO_URL;
  const { buildActivationLink } = require("../netlify/functions/lib/memberService");
  expect(new URL(buildActivationLink("unit-token")).origin).toBe("https://ghostai-tts-studio.smartbrain.lat");
  if (previousUrl === undefined) delete process.env.URL; else process.env.URL = previousUrl;
  if (previousStudio === undefined) delete process.env.GHOSTAI_STUDIO_URL; else process.env.GHOSTAI_STUDIO_URL = previousStudio;
});
