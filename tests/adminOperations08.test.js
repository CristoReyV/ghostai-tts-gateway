"use strict";
const db = require("../netlify/functions/lib/db");
const service = require("../netlify/functions/lib/memberService");
const { buildAdminSessionCookie } = require("../netlify/functions/lib/adminAuth");
const { getMemberOperationalState, EXPIRES_SOON_DAYS } = require("../netlify/functions/lib/memberOperations");
const { prepareMemberDelivery } = require("../netlify/functions/lib/memberDelivery");
const track = require("../netlify/functions/admin-members-mark-email").handler;
let operator, cookie;
const call = (body, headers = { cookie }) => track({ httpMethod: "POST", headers, body: JSON.stringify(body) });
const mark = (member, status = "sent", extra = {}) => call({ memberId: member.id, keyId: member.key_id, status, expectedSentAt: member.last_email_sent_at || null, ...extra });
beforeEach(async () => {
  process.env.GHOSTAI_ADMIN_AUTH_TOKEN = "unit-admin-operations-08";
  process.env.GHOSTAI_TOKEN_HASH_PEPPER = "unit-member-operations-08-pepper";
  db._setMemoryStoreEnabled(true); db._resetMemoryStore();
  operator = await db.createAdminUserRecord({ name: "QA Operator", role: "operator", status: "active" });
  cookie = buildAdminSessionCookie(process.env.GHOSTAI_ADMIN_AUTH_TOKEN, operator).split(";")[0];
});
afterAll(() => db._setMemoryStoreEnabled(false));
const create = () => service.createMemberWithAccess({ name: "QA Operations", email: "operations@example.test", accessPlan: "monthly" });

test("pending → manual sent → activated; actor comes from session, never request body", async () => {
  const created = await create();
  expect((await db.getMemberById(created.member.id)).operational.status).toBe("READY_TO_SEND");
  const result = await mark(created.member, "sent", { adminId: "spoofed", adminName: "Fake", role: "owner" });
  expect(result.statusCode).toBe(200);
  const member = JSON.parse(result.body).member;
  expect(member.operational.status).toBe("SENT_PENDING_ACTIVATION");
  expect(member.operational.needsAction).toBe(false);
  expect(member.last_email_sent_by).toBe(operator.id);
  expect(member.last_email_sent_by_name).toBe(operator.name);
  expect(member.last_email_sent_by_role).toBe("operator");
  expect(member.last_email_type).toBe("NEW_ACCESS");
  expect(member.last_email_key_id).toBe(member.key_id);
  expect(Date.parse(member.last_email_sent_at)).toBeGreaterThan(0);
  await service.activateMemberAccess(created.activationToken);
  expect((await db.getMemberById(member.id)).operational.status).toBe("ACTIVE");
});

test("active key replacement requires resend; marking and undo preserve membership dates", async () => {
  const created = await create(); await service.activateMemberAccess(created.activationToken);
  const before = await db.getMemberById(created.member.id);
  expect(before.operational.status).toBe("ACTIVE");
  await service.regenerateMemberKey(before.id);
  const rotated = await db.getMemberById(before.id);
  expect(rotated.operational.status).toBe("ACCESS_REISSUED_NEEDS_RESEND");
  expect(rotated.operational.needsAction).toBe(true);
  expect((await prepareMemberDelivery(before.id)).emailType).toBe("ACCESS_REPLACEMENT");
  const response = await mark(rotated);
  expect(response.statusCode).toBe(200);
  const sent = JSON.parse(response.body).member;
  expect(sent.last_email_type).toBe("ACCESS_REPLACEMENT");
  expect(sent.operational.status).toBe("ACTIVE");
  expect((await mark(sent, "not_sent")).statusCode).toBe(200);
  const undone = await db.getMemberById(before.id);
  expect(undone.operational.status).toBe("ACCESS_REISSUED_NEEDS_RESEND");
  for (const field of ["id", "access_plan", "activated_at", "expires_at", "status"]) expect(undone[field]).toBe(before[field]);
  const audit = (await db.listAdminAuditLogs()).filter(e => e.action.startsWith("email_marked_"));
  expect(audit.map(e => e.action).sort()).toEqual(["email_marked_sent", "email_marked_unsent"]);
  expect(audit.every(e => e.admin_id === operator.id && e.admin_role === "operator")).toBe(true);
  expect(JSON.stringify(audit)).not.toMatch(/gai_(live|act)_|<html/i);
});

test("concurrent repeated mark is idempotent and a stale preview cannot cover a new key", async () => {
  const { member } = await create();
  const responses = await Promise.all([mark(member), mark(member)]);
  expect(responses.map(r => JSON.parse(r.body).changed).sort()).toEqual([false, true]);
  expect((await db.listAdminAuditLogs()).filter(e => e.action === "email_marked_sent")).toHaveLength(1);
  await service.regenerateMemberKey(member.id);
  expect((await mark(member)).statusCode).toBe(409);
  const updated = await db.getMemberById(member.id);
  expect(updated.last_email_sent_at).toBeNull();
  expect(updated.operational.status).toBe("ACCESS_REISSUED_NEEDS_RESEND");
});

test("fresh preparation after a sent email selects RESEND and allows a new attestation", async () => {
  const { member } = await create(); await mark(member);
  const sent = await db.getMemberById(member.id);
  const preview = await prepareMemberDelivery(member.id);
  expect(preview.emailType).toBe("RESEND");
  expect(preview.expectedSentAt).toBe(sent.last_email_sent_at);
  expect((await mark(sent)).statusCode).toBe(200);
  expect((await db.getMemberById(member.id)).last_email_type).toBe("RESEND");
});

test("a stale undo cannot erase a newer resend, even in the same clock millisecond", async () => {
  const { member } = await create(); await mark(member);
  const first = await db.getMemberById(member.id);
  await mark(first);
  expect((await mark(first, "not_sent")).statusCode).toBe(409);
  expect((await db.getMemberById(member.id)).last_email_status).toBe("sent");
});

test("unknown historic delivery is never treated as sent just because invited_at exists", () => {
  expect(getMemberOperationalState({ status: "invited", key_id: "key", invited_at: "2026-10-10", last_email_status: "not_sent" }).status).toBe("READY_TO_SEND");
});

test("renewal chooses renewal copy; ordinary active resend never claims old key was revoked", async () => {
  const created = await create(); await service.activateMemberAccess(created.activationToken);
  const ordinary = await prepareMemberDelivery(created.member.id);
  expect(ordinary.emailType).toBe("RESEND");
  expect(ordinary.text).not.toContain("Tu llave anterior dejó de funcionar");
  expect(ordinary.text).toContain("ABRIR GHOSTAI");
  expect(ordinary.activationLink).not.toContain("activate=");
  await service.renewMemberAccess(created.member.id);
  const renewed = await prepareMemberDelivery(created.member.id);
  expect(renewed.emailType).toBe("RENEWAL");
  expect(renewed.text).toContain("renovado");
});

test.each([
  [{ status: "revoked", key_id: "key" }, "REVOKED", false],
  [{ status: "expired", key_id: "key" }, "EXPIRED", true],
  [{ status: "pending", key_id: null }, "NEEDS_REVIEW", true],
  [{ status: "active", key_id: "key" }, "ACTIVE", false],
])("operational classification %# uses real state", (member, status, needsAction) => {
  expect(getMemberOperationalState(member)).toMatchObject({ status, needsAction });
});

test("expiry threshold includes exactly 7 days, and old unactivated deliveries need follow-up", () => {
  const now = Date.parse("2026-10-19T10:00:00Z");
  const member = { status: "active", key_id: "key", expires_at: new Date(now + EXPIRES_SOON_DAYS * 86400000).toISOString() };
  expect(getMemberOperationalState(member, now).status).toBe("EXPIRES_SOON");
  expect(getMemberOperationalState({ ...member, expires_at: new Date(now + 8 * 86400000).toISOString() }, now).status).toBe("ACTIVE");
  expect(getMemberOperationalState({ status: "pending", key_id: "key", last_email_status: "sent", last_email_sent_at: "2026-10-10T10:00:00Z" }, now)).toMatchObject({ status: "SENT_PENDING_ACTIVATION", needsAction: true });
});

test("unauthenticated mark is rejected and key/admin operations stay OWNER-only", async () => {
  const { member } = await create();
  expect((await call({ memberId: member.id }, {})).statusCode).toBe(401);
  for (const endpoint of ["admin-members", "admin-members-regenerate-key", "admin-users"]) {
    const response = await require(`../netlify/functions/${endpoint}`).handler({ httpMethod: "POST", headers: { cookie }, body: JSON.stringify({ memberId: member.id }) });
    expect(response.statusCode).toBe(403);
  }
  const owner = { authorization: `Bearer ${process.env.GHOSTAI_ADMIN_AUTH_TOKEN}` };
  expect((await call({ memberId: member.id, keyId: member.key_id, status: "sent", expectedSentAt: null }, owner)).statusCode).toBe(200);
});
