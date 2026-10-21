"use strict";
jest.mock("../netlify/functions/lib/personalKeyStore", () => {
  const records = new Map();
  return { UUID: /^[0-9a-f-]{36}$/i, get: async (a, k) => records.get(`${a}/${k}`) || null,
    list: async a => [...records.keys()].filter(k => k.startsWith(`${a}/`)).map(k => k.split("/")[1]),
    put: jest.fn(async (a, k, value) => records.set(`${a}/${k}`, value)), _records: records };
});
const db = require("../netlify/functions/lib/db");
const store = require("../netlify/functions/lib/personalKeyStore");
const service = require("../netlify/functions/lib/personalKeyService");
const { generateClientToken } = require("../netlify/functions/lib/tokenService");
const { buildAdminSessionCookie } = require("../netlify/functions/lib/adminAuth");
const { handler } = require("../netlify/functions/admin-personal-keys");
let operator, other, client, key, cookie;
const owner = { id: "system_owner", role: "owner", email: "owner@example.test" };
const call = (method, body = {}, query = {}, session = cookie) => handler({ httpMethod: method, headers: { cookie: session }, body: JSON.stringify(body), queryStringParameters: query });
beforeEach(async () => {
  process.env.GHOSTAI_ADMIN_AUTH_TOKEN = "personal-unit-admin";
  process.env.GHOSTAI_TOKEN_HASH_PEPPER = "personal-unit-pepper";
  process.env.GHOSTAI_CREDENTIAL_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  db._setMemoryStoreEnabled(true); db._resetMemoryStore(); store._records.clear(); store.put.mockClear();
  operator = await db.createAdminUserRecord({ name: "Socio", role: "operator", email: "socio@example.test", status: "active" });
  other = await db.createAdminUserRecord({ name: "Otro", role: "operator", email: "otro@example.test", status: "active" });
  cookie = buildAdminSessionCookie(process.env.GHOSTAI_ADMIN_AUTH_TOKEN, operator).split(";")[0];
  client = await db.createClient({ name: "GHOSTAI" });
  key = await generateClientToken({ clientId: client.id, label: "GHOSTAI 1" });
  await service.grant({ adminId: operator.id, token: key.token, actor: owner });
});
afterAll(() => db._setMemoryStoreEnabled(false));
test("lists only the signed-in operator's keys, without revealing or caching secrets", async () => {
  const otherKey = await generateClientToken({ clientId: client.id, label: "Other personal" });
  await service.grant({ adminId: other.id, token: otherKey.token, actor: owner });
  const response = await call("GET", {}, { adminId: other.id, clientId: client.id });
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).keys.map(k => k.label)).toEqual(["GHOSTAI 1"]);
  expect(response.body).not.toContain(key.token);
  expect(response.body).not.toContain("encrypted");
  expect(response.headers["Cache-Control"]).toContain("no-store");
  expect([...store._records.values()].join()).not.toContain(key.token);
});
test("reveals only an assigned key and audits identity without the secret", async () => {
  const response = await call("POST", { keyId: key.tokenId, adminId: other.id });
  expect(response.statusCode).toBe(200); expect(JSON.parse(response.body).accessKey).toBe(key.token);
  const audit = await db.listAdminAuditLogs();
  expect(audit.some(e => e.action === "personal_key_revealed" && e.admin_id === operator.id)).toBe(true);
  expect(JSON.stringify(audit)).not.toContain(key.token);
  const otherCookie = buildAdminSessionCookie(process.env.GHOSTAI_ADMIN_AUTH_TOKEN, other).split(";")[0];
  expect((await call("POST", { keyId: key.tokenId, adminId: operator.id }, {}, otherCookie)).statusCode).toBe(404);
});
test("operator cannot assign keys or use any legacy key management endpoint", async () => {
  const prior = store.put.mock.calls.length;
  expect((await call("PUT", { adminId: other.id, accessKey: key.token })).statusCode).toBe(403);
  expect(store.put.mock.calls.length).toBe(prior);
  for (const [name, method] of [["admin-access-tokens", "GET"], ["admin-access-tokens", "POST"], ["admin-members-regenerate-key", "POST"]]) {
    expect((await require(`../netlify/functions/${name}`).handler({ httpMethod: method, headers: { cookie }, body: "{}" })).statusCode).toBe(403);
  }
});
test("revoked keys and disabled users immediately lose reveal access", async () => {
  const publicId = key.token.split(".")[0].slice("gai_live_".length);
  await db.updateTokenStatus(key.tokenId, "revoked");
  expect((await call("POST", { keyId: key.tokenId })).statusCode).toBe(409);
  expect((await db.getTokenByPublicId(publicId)).status).toBe("revoked");
  await db.updateAdminUser(operator.id, { status: "disabled" });
  expect((await call("GET")).statusCode).toBe(401);
});
test("rejects member/email-linked accounts and ciphertext copied to another operator", async () => {
  const linked = await db.createClient({ name: "Member", email: "member@example.test" });
  const linkedKey = await generateClientToken({ clientId: linked.id });
  await expect(service.grant({ adminId: operator.id, token: linkedKey.token, actor: owner })).rejects.toMatchObject({ statusCode: 404 });
  store._records.set(`${other.id}/${key.tokenId}`, store._records.get(`${operator.id}/${key.tokenId}`));
  const otherCookie = buildAdminSessionCookie(process.env.GHOSTAI_ADMIN_AUTH_TOKEN, other).split(";")[0];
  expect((await call("POST", { keyId: key.tokenId }, {}, otherCookie)).statusCode).toBe(404);
});
test("unauthenticated, malformed and traversal requests fail without exposing a key", async () => {
  expect((await call("GET", {}, {}, "")).statusCode).toBe(401);
  for (const keyId of [undefined, "../other", "bad"]) {
    const response = await call("POST", { keyId });
    expect(response.statusCode).toBe(404); expect(response.body).not.toContain(key.token);
  }
});
