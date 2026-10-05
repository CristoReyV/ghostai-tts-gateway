/**
 * @file tests/cors.test.js
 */

"use strict";

const { corsHeaders, preflightResponse, resolveOrigin } = require("../netlify/functions/lib/cors");

describe("CORS utility", () => {
  afterEach(() => {
    delete process.env.GHOSTAI_ALLOWED_ORIGINS;
  });

  test("resolves * when GHOSTAI_ALLOWED_ORIGINS is not set", () => {
    expect(resolveOrigin("https://attacker.example.com")).toBe("*");
  });

  test("reflects matching origin when allowlist is set", () => {
    process.env.GHOSTAI_ALLOWED_ORIGINS = "https://studio.ghostai.io,https://app.ghostai.io";
    expect(resolveOrigin("https://studio.ghostai.io")).toBe("https://studio.ghostai.io");
  });

  test("rejects non-listed origin when allowlist is set by returning null and omitting ACAO", () => {
    process.env.GHOSTAI_ALLOWED_ORIGINS = "https://studio.ghostai.io";
    expect(resolveOrigin("https://attacker.example.com")).toBeNull();
    const headers = corsHeaders("https://attacker.example.com");
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("corsHeaders includes required CORS fields and Authorization", () => {
    const h = corsHeaders(undefined);
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
    expect(h["Access-Control-Allow-Methods"]).toContain("POST");
    expect(h["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(h["Access-Control-Allow-Headers"]).toContain("Content-Type");
    expect(h["X-GhostAI-Gateway"]).toBe("true");
  });

  test("preflightResponse returns 204 with correct headers", () => {
    const res = preflightResponse("https://studio.ghostai.io");
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["Access-Control-Allow-Origin"]).toBeTruthy();
  });
});
