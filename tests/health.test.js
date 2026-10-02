/**
 * @file tests/health.test.js
 * Tests for the health function handler.
 */

"use strict";

const { handler } = require("../netlify/functions/health");

function makeEvent(method) {
  return { httpMethod: method, headers: { origin: "https://studio.ghostai.io" } };
}

describe("GET /health", () => {
  test("returns 204 for OPTIONS", async () => {
    const res = await handler(makeEvent("OPTIONS"));
    expect(res.statusCode).toBe(204);
  });

  test("returns 200 JSON for GET", async () => {
    const res = await handler(makeEvent("GET"));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.service).toBe("ghostai-tts-gateway");
    expect(body.version).toBe("1.0.0");
    expect(body.provider).toBe("elevenlabs");
    expect(typeof body.configured).toBe("boolean");
  });

  test("reports configured=true when API key is present", async () => {
    process.env.ELEVENLABS_API_KEY = "sk-test-key";
    const res = await handler(makeEvent("GET"));
    const body = JSON.parse(res.body);
    expect(body.configured).toBe(true);
    delete process.env.ELEVENLABS_API_KEY;
  });

  test("reports configured=false when API key is absent", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const res = await handler(makeEvent("GET"));
    const body = JSON.parse(res.body);
    expect(body.configured).toBe(false);
  });

  test("never returns ELEVENLABS_API_KEY in body", async () => {
    process.env.ELEVENLABS_API_KEY = "sk-should-never-appear";
    const res = await handler(makeEvent("GET"));
    expect(res.body).not.toContain("sk-should-never-appear");
    delete process.env.ELEVENLABS_API_KEY;
  });

  test("returns 405 for POST", async () => {
    const res = await handler(makeEvent("POST"));
    expect(res.statusCode).toBe(405);
  });

  test("has CORS headers", async () => {
    const res = await handler(makeEvent("GET"));
    expect(res.headers["Access-Control-Allow-Origin"]).toBeTruthy();
    expect(res.headers["X-GhostAI-Gateway"]).toBe("true");
  });
});
