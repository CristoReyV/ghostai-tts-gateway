/**
 * @file tests/auth.test.js
 * Comprehensive tests for requireOperatorAuth middleware and GET /api/tts/auth/verify endpoint.
 */

"use strict";

const { requireOperatorAuth } = require("../netlify/functions/lib/auth");
const { handler: authVerifyHandler } = require("../netlify/functions/tts-auth-verify");

const TEST_TOKEN = "secret-operator-token-12345";

describe("requireOperatorAuth middleware", () => {
  beforeEach(() => {
    process.env.GHOSTAI_STUDIO_AUTH_TOKEN = TEST_TOKEN;
  });

  afterEach(() => {
    delete process.env.GHOSTAI_STUDIO_AUTH_TOKEN;
  });

  test("fails closed with 500 when server GHOSTAI_STUDIO_AUTH_TOKEN is missing", () => {
    delete process.env.GHOSTAI_STUDIO_AUTH_TOKEN;
    const res = requireOperatorAuth({
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(500);
    expect(res.error.code).toBe("GATEWAY_NOT_CONFIGURED");
  });

  test("rejects request with 401 AUTH_REQUIRED when Authorization header is absent", () => {
    const res = requireOperatorAuth({ headers: {} });
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.error.code).toBe("AUTH_REQUIRED");
  });

  test("rejects non-Bearer scheme with 401 AUTH_INVALID", () => {
    const res = requireOperatorAuth({
      headers: { authorization: `Basic ${TEST_TOKEN}` },
    });
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.error.code).toBe("AUTH_INVALID");
  });

  test("rejects empty token with 401 AUTH_INVALID", () => {
    const res = requireOperatorAuth({
      headers: { authorization: "Bearer " },
    });
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.error.code).toBe("AUTH_INVALID");
  });

  test("rejects incorrect token with 401 AUTH_INVALID", () => {
    const res = requireOperatorAuth({
      headers: { authorization: "Bearer wrong-token-xyz" },
    });
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.error.code).toBe("AUTH_INVALID");
  });

  test("accepts correct token and returns ok: true", () => {
    const res = requireOperatorAuth({
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.ok).toBe(true);
  });

  test("never reflects or logs token in error response", () => {
    const badToken = "sensitive-leaked-guess";
    const res = requireOperatorAuth({
      headers: { authorization: `Bearer ${badToken}` },
    });
    expect(JSON.stringify(res)).not.toContain(badToken);
    expect(JSON.stringify(res)).not.toContain(TEST_TOKEN);
  });
});

describe("GET /api/tts/auth/verify endpoint", () => {
  beforeEach(() => {
    process.env.GHOSTAI_STUDIO_AUTH_TOKEN = TEST_TOKEN;
  });

  afterEach(() => {
    delete process.env.GHOSTAI_STUDIO_AUTH_TOKEN;
  });

  test("handles OPTIONS preflight without auth and returns 204", async () => {
    const res = await authVerifyHandler({
      httpMethod: "OPTIONS",
      headers: { origin: "https://studio.ghostai.io" },
    });
    expect(res.statusCode).toBe(204);
  });

  test("rejects POST with 405 Method Not Allowed", async () => {
    const res = await authVerifyHandler({
      httpMethod: "POST",
      headers: {
        origin: "https://studio.ghostai.io",
        authorization: `Bearer ${TEST_TOKEN}`,
      },
    });
    expect(res.statusCode).toBe(405);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  test("returns 401 AUTH_REQUIRED when no authorization header is sent", async () => {
    const res = await authVerifyHandler({
      httpMethod: "GET",
      headers: { origin: "https://studio.ghostai.io" },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });

  test("returns 401 AUTH_INVALID when wrong token is sent", async () => {
    const res = await authVerifyHandler({
      httpMethod: "GET",
      headers: {
        origin: "https://studio.ghostai.io",
        authorization: "Bearer wrong-token",
      },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("AUTH_INVALID");
  });

  test("returns 200 with ok: true, authenticated: true when correct token is sent", async () => {
    const res = await authVerifyHandler({
      httpMethod: "GET",
      headers: {
        origin: "https://studio.ghostai.io",
        authorization: `Bearer ${TEST_TOKEN}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.authenticated).toBe(true);
    expect(res.headers["Content-Type"]).toBe("application/json");
  });
});
