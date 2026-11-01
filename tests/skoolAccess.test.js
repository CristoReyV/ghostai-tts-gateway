"use strict";
const db = require("../netlify/functions/lib/db");
const service = require("../netlify/functions/lib/skoolSync");
const state = require("../netlify/functions/lib/skoolStore");
const billing = require("../netlify/functions/lib/billingStore");
const members = require("../netlify/functions/lib/memberService");
const { authenticateGhostAIRequest: auth } = require("../netlify/functions/lib/auth");
const { buildAdminSessionCookie } = require("../netlify/functions/lib/adminAuth");
const { handler } = require("../netlify/functions/admin-skool-sync");
const { prepareMemberDelivery } = require("../netlify/functions/lib/memberDelivery");
const leases = require("../netlify/functions/lib/sheetSyncLease");
const owner = { id: "system_owner", name: "Owner", role: "owner", email: "owner@qa.invalid" };
let csv;
const run = async () => service.apply(owner, (await service.preview(owner)).previewToken);
const authorized = key => auth({ headers: { authorization: `Bearer ${key}` } });
beforeEach(() => {
  process.env.GHOSTAI_ADMIN_AUTH_TOKEN = "skool-unit-owner";
  process.env.GHOSTAI_TOKEN_HASH_PEPPER = "skool-unit-pepper";
  process.env.GHOSTAI_SKOOL_SHEET_ID = "skool-unit-sheet";
  process.env.GHOSTAI_SKOOL_SHEET_GID = "1942480519";
  db._setMemoryStoreEnabled(true); db._resetMemoryStore(); billing._reset(); state._reset(); leases._reset();
  csv = "Nombre completo,Correo electrónico\nAlice,alice@qa.invalid";
  jest.spyOn(global, "fetch").mockImplementation(async url => {
    expect(url).toContain("gid=1942480519");
    return { ok: true, headers: { get: () => "text/csv" }, text: async () => csv };
  });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => db._setMemoryStoreEnabled(false));

test("creates distinct SKOOL access with escrow, no email, no fixed expiry and no financial writes", async () => {
  const legacy = await members.createMemberWithAccess({ name: "Alice", email: "old@qa.invalid", accessPlan: "annual" });
  const old = await db.getMemberById(legacy.member.id);
  csv += "\nAlice,old@qa.invalid";
  const beforeBilling = await billing.read();
  const preview = await service.preview(owner);
  expect(preview.counts).toMatchObject({ newMembers: 1, removed: 0, invalid: 0 });
  expect(preview.details[0].name).toBe("Alice - 2");
  expect((await service.apply(owner, preview.previewToken)).created).toBe(1);
  const added = await db.getMemberByEmail("alice@qa.invalid");
  expect(added).toMatchObject({ name: "Alice - 2", access_plan: "skool", skool_source_id: "skool-unit-sheet", status: "pending", activated_at: null, expires_at: null });
  expect(added.last_email_sent_at ?? null).toBeNull();
  expect(await db.getMemberById(old.id)).toEqual(old);
  expect(await billing.read()).toEqual(beforeBilling);
  const delivery = await prepareMemberDelivery(added.id);
  expect(delivery.text).toContain("SKOOL");
  const escrow = await db.getLatestActivationTokenForMember(added.id);
  expect(escrow.encrypted_key).toBeTruthy();
  const activation = await members.activateMemberAccess(members.safeDecryptKey(escrow.encrypted_invitation_token));
  expect(activation.expiresAt).toBeNull();
  jest.spyOn(Date, "now").mockReturnValue(Date.parse("2056-01-01T12:00:00Z"));
  expect((await authorized(activation.accessKey)).ok).toBe(true);
  expect(JSON.stringify(await db.listAdminAuditLogs())).not.toContain(activation.accessKey);
});

test("removal revokes SKOOL keys and reappearance cannot silently restore revoked access", async () => {
  const legacy = await members.createMemberWithAccess({ name: "Legacy", email: "legacy@qa.invalid", accessPlan: "lifetime" });
  const legacyBefore = await db.getMemberById(legacy.member.id);
  csv += "\nLegacy,legacy@qa.invalid";
  await run(); const member = await db.getMemberByEmail("alice@qa.invalid");
  const token = await db.getLatestActivationTokenForMember(member.id);
  const active = await members.activateMemberAccess(members.safeDecryptKey(token.encrypted_invitation_token));
  csv = "Nombre,Correo\nLegacy,legacy@qa.invalid";
  expect((await service.preview(owner)).counts.removed).toBe(1);
  await run();
  expect((await authorized(active.accessKey)).ok).toBe(false);
  expect(await db.getMemberById(member.id)).toMatchObject({ status: "revoked", operational: { status: "SKOOL_REMOVED" } });
  await expect(prepareMemberDelivery(member.id)).rejects.toBeTruthy();
  expect(await db.getMemberById(legacy.member.id)).toEqual(legacyBefore);
  csv += "\nAlice,alice@qa.invalid";
  expect((await service.preview(owner)).details).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Alice", classification: "NEEDS_OWNER_REVIEW" })])); await run();
  expect((await authorized(active.accessKey)).ok).toBe(false);
  expect(await db.getMemberById(member.id)).toMatchObject({ key_id: member.key_id, status: "revoked", activated_at: active.activatedAt });
  expect((await db.listTokens()).find(t => t.id === member.key_id).status).toBe("revoked");
  expect(await db.listTokens()).toHaveLength(2);
});

test("removed pending members cannot activate; manual revocation is never undone", async () => {
  await run(); const member = await db.getMemberByEmail("alice@qa.invalid");
  const token = await db.getLatestActivationTokenForMember(member.id);
  csv = "Nombre,Correo\nAnother,another@qa.invalid"; await run();
  await expect(members.activateMemberAccess(members.safeDecryptKey(token.encrypted_invitation_token))).rejects.toBeTruthy();
  await members.revokeMemberAccess(member.id);
  csv += "\nAlice,alice@qa.invalid"; await run();
  const current = await db.getMemberById(member.id);
  expect(current.status).toBe("revoked"); expect(current.revoked_at).toBeTruthy();
  await db.updateMember(member.id, { skool_expires_at: "2020-01-01T00:00:00Z" });
  expect((await db.getMemberById(member.id)).status).toBe("revoked");
  expect((await db.listTokens()).find(t => t.id === member.key_id).status).toBe("revoked");
});

test("source dates use CDMX end of day, expire access, and may extend it using the same key", async () => {
  csv = "Nombre,Correo,Fecha de vencimiento\nAlice,alice@qa.invalid,31/12/2030"; await run();
  const member = await db.getMemberByEmail("alice@qa.invalid");
  const token = await db.getLatestActivationTokenForMember(member.id);
  const active = await members.activateMemberAccess(members.safeDecryptKey(token.encrypted_invitation_token));
  expect(active.expiresAt).toBe("2031-01-01T05:59:59.999Z");
  const clock = jest.spyOn(Date, "now").mockReturnValue(Date.parse("2031-01-02T12:00:00Z"));
  expect((await authorized(active.accessKey)).ok).toBe(false);
  csv = csv.replace("31/12/2030", "31/12/2032"); await run();
  expect((await authorized(active.accessKey)).ok).toBe(true);
  clock.mockRestore();
  csv = csv.replace("31/12/2032", "01/01/2020"); await run();
  expect(await db.getMemberById(member.id)).toMatchObject({ status: "expired", skool_removed_at: null, key_id: member.key_id });
});

test.each(["Nombre,Correo\n", "Nombre,Correo\nBroken,bad", "Nombre,Correo\nA,a@qa.invalid\nB,a@qa.invalid", "Nombre,Correo,Vence\nA,a@qa.invalid,31/02/2026", "Nombre,Correo,Vence\nA,a@qa.invalid,2026-02-31T12:00:00Z"])("bad or empty source never creates or removes access: %s", async invalid => {
  await run(); const before = await db.listMembers(); csv = invalid;
  const preview = await service.preview(owner); expect(preview.canApply).toBe(false);
  await expect(service.apply(owner, preview.previewToken)).rejects.toMatchObject({ statusCode: 400 });
  expect(await db.listMembers()).toEqual(before);
});

test("stale preview and unavailable Google source cannot mutate data", async () => {
  const preview = await service.preview(owner); csv += "\nBob,bob@qa.invalid";
  await expect(service.apply(owner, preview.previewToken)).rejects.toMatchObject({ statusCode: 409 });
  global.fetch.mockRejectedValue(new Error("unavailable"));
  await expect(service.apply(owner, preview.previewToken)).rejects.toMatchObject({ statusCode: 503 });
  expect(await db.listMembers()).toEqual([]);
});

test("bounded batches resume without duplicates and defer removals until all new members are loaded", async () => {
  await run(); csv = "Nombre,Correo\n" + Array.from({ length: 10 }, (_, i) => `Member ${i},member${i}@qa.invalid`).join("\n");
  const first = await run(); expect(first).toMatchObject({ created: 8, needsContinuation: true, removed: 0 });
  expect((await db.getMemberByEmail("alice@qa.invalid")).skool_removed_at).toBeNull();
  expect(await run()).toMatchObject({ created: 2, needsContinuation: false, removed: 1 });
  expect((await service.preview(owner)).counts).toMatchObject({ newMembers: 0, removed: 0, existing: 10 });
  expect(await db.listTokens()).toHaveLength(11);
  expect(await run()).toMatchObject({ created: 0, removed: 0 });
});

test.each(["monthly", "annual", "lifetime"])("sheet absence revokes legacy %s access, key and pending links", async accessPlan => {
  const legacy = await members.createMemberWithAccess({ name: "Legacy", email: "legacy@qa.invalid", accessPlan });
  const active = await members.activateMemberAccess(legacy.activationToken);
  const financialBefore = await billing.read();
  expect((await authorized(active.accessKey)).ok).toBe(true);
  expect((await service.preview(owner)).counts.removed).toBe(1);
  await run();
  expect(await db.getMemberById(legacy.member.id)).toMatchObject({ status: "revoked", access_plan: accessPlan });
  expect((await authorized(active.accessKey)).ok).toBe(false);
  expect((await db.getClientById(legacy.member.client_id)).status).toBe("suspended");
  expect((await db.listTokens()).find(t => t.id === legacy.member.key_id).status).toBe("revoked");
  expect(await billing.read()).toEqual(financialBefore);
});

test("large removal sets continue in bounded batches without creating duplicate access", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => `Legacy ${i},legacy${i}@qa.invalid`);
  csv = "Nombre,Correo\n" + entries.join("\n");
  for (let i = 0; i < 10; i++) await members.createMemberWithAccess({ name: `Legacy ${i}`, email: `legacy${i}@qa.invalid`, accessPlan: "annual" });
  csv = "Nombre,Correo\nKeeper,keeper@qa.invalid";
  expect(await run()).toMatchObject({ created: 1, removed: 7, needsContinuation: true, remaining: 3 });
  expect(await run()).toMatchObject({ created: 0, removed: 3, needsContinuation: false });
  expect((await service.preview(owner)).counts).toMatchObject({ removed: 0, newMembers: 0, existing: 1 });
  expect((await db.listMembers()).filter(m => m.status === "revoked")).toHaveLength(10);
});

test("concurrent applies serialize, and OPERATOR may read status but cannot preview or apply", async () => {
  const preview = await service.preview(owner);
  const both = await Promise.allSettled([service.apply(owner, preview.previewToken), service.apply(owner, preview.previewToken)]);
  expect(both.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(await db.listMembers()).toHaveLength(1);
  const operator = await db.createAdminUserRecord({ name: "Operator", role: "operator", status: "active" });
  const headers = { cookie: buildAdminSessionCookie(process.env.GHOSTAI_ADMIN_AUTH_TOKEN, operator).split(";")[0] };
  for (const action of ["preview", "apply"]) expect((await handler({ httpMethod: "POST", headers, body: JSON.stringify({ action }) })).statusCode).toBe(403);
  expect((await handler({ httpMethod: "GET", headers })).statusCode).toBe(200);
});

test("unscoped SKOOL creation and renewals are rejected; auth fails closed on membership lookup errors", async () => {
  await expect(members.createMemberWithAccess({ name: "Unscoped", email: "unscoped@qa.invalid", accessPlan: "skool" })).rejects.toMatchObject({ code: "VALIDATION_SKOOL_SOURCE" });
  expect(await db.listClients()).toEqual([]); expect(await db.listTokens()).toEqual([]);
  await run(); const member = await db.getMemberByEmail("alice@qa.invalid");
  await expect(members.renewMemberAccess(member.id, "monthly")).rejects.toMatchObject({ code: "SKOOL_NO_RENEWAL" });
  const token = await db.getLatestActivationTokenForMember(member.id);
  const active = await members.activateMemberAccess(members.safeDecryptKey(token.encrypted_invitation_token));
  jest.spyOn(db, "getMemberByClientId").mockRejectedValue(new Error("unavailable"));
  expect((await authorized(active.accessKey)).statusCode).toBe(503);
});
