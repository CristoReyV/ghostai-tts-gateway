/**
 * @file tests/adminAuthSession.test.js
 * Test suite for Administrator temporary HttpOnly cookie sessions and security guards.
 */

"use strict";

const adminLogin = require("../netlify/functions/admin-auth-login");
const adminLogout = require("../netlify/functions/admin-auth-logout");
const adminStatus = require("../netlify/functions/admin-auth-status");
const adminClients = require("../netlify/functions/admin-clients");
const { buildAdminSessionCookie } = require("../netlify/functions/lib/adminAuth");
const db = require("../netlify/functions/lib/db");

describe("Admin Authentication & Session Cookie", () => {
  const TEST_ADMIN_SECRET = "test_admin_super_secret_token_1234567890";

  beforeAll(() => {
    process.env.GHOSTAI_ADMIN_AUTH_TOKEN = TEST_ADMIN_SECRET;
    db._setMemoryStoreEnabled(true);
  });

  beforeEach(() => {
    db._resetMemoryStore();
  });

  afterAll(() => {
    db._setMemoryStoreEnabled(false);
  });

  test("POST /api/admin/auth/login rejects invalid credential with 401", async () => {
    const res = await adminLogin.handler({
      httpMethod: "POST",
      body: JSON.stringify({ adminToken: "wrong_password" }),
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("AUTH_INVALID");
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });

  test("POST /api/admin/auth/login issues HttpOnly, Secure, SameSite=Strict cookie on success", async () => {
    const res = await adminLogin.handler({
      httpMethod: "POST",
      body: JSON.stringify({ adminToken: TEST_ADMIN_SECRET }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.authenticated).toBe(true);

    const cookie = res.headers["Set-Cookie"];
    expect(cookie).toBeDefined();
    expect(cookie).toContain("ghostai_admin_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/admin");
    // Verify plaintext secret is NOT inside cookie
    expect(cookie).not.toContain(TEST_ADMIN_SECRET);
  });

  test("GET /api/admin/auth/status returns authenticated: true with valid session cookie", async () => {
    const setCookie = buildAdminSessionCookie(TEST_ADMIN_SECRET);
    const cookieVal = setCookie.split(";")[0]; // ghostai_admin_session=...

    const res = await adminStatus.handler({
      httpMethod: "GET",
      headers: {
        cookie: cookieVal,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.authenticated).toBe(true);
  });

  test("GET /api/admin/auth/status returns authenticated: false without cookie", async () => {
    const res = await adminStatus.handler({
      httpMethod: "GET",
      headers: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.authenticated).toBe(false);
  });

  test("POST /api/admin/auth/logout expires session cookie with Max-Age=0", async () => {
    const res = await adminLogout.handler({
      httpMethod: "POST",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.authenticated).toBe(false);

    const cookie = res.headers["Set-Cookie"];
    expect(cookie).toContain("ghostai_admin_session=;");
    expect(cookie).toContain("Max-Age=0");
  });

  test("Protected admin endpoint accepts session cookie", async () => {
    const setCookie = buildAdminSessionCookie(TEST_ADMIN_SECRET);
    const cookieVal = setCookie.split(";")[0];

    const res = await adminClients.handler({
      httpMethod: "GET",
      headers: {
        cookie: cookieVal,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.clients)).toBe(true);
  });

  test("Protected admin endpoint rejects client access tokens and legacy tokens", async () => {
    // Attempt with dummy bearer
    const res = await adminClients.handler({
      httpMethod: "GET",
      headers: {
        authorization: "Bearer gai_live_fakeclienttoken.secret123",
      },
    });

    expect(res.statusCode).toBe(401);
  });
});
