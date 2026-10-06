/**
 * @file scripts/local-dev-server.js
 * Lightweight local runtime server for GhostAI TTS Gateway.
 * Routes /api/tts/* requests to the corresponding Netlify function handlers.
 */

"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");
const { URL } = require("url");

// Load .env safely
function loadEnv() {
  const envPath = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

loadEnv();

const handlers = {
  "/api/tts/voice-library": require("../netlify/functions/tts-voice-library").handler,
  "/api/tts/voices/shared/add": require("../netlify/functions/tts-voices-shared-add").handler,
  "/api/tts/voices": require("../netlify/functions/tts-voices").handler,
  "/api/tts/models": require("../netlify/functions/tts-models").handler,
  "/api/tts/generate": require("../netlify/functions/tts-generate").handler,
  "/api/tts/auth/verify": require("../netlify/functions/tts-auth-verify").handler,
  "/api/tts/provider/elevenlabs/connect": require("../netlify/functions/tts-provider-elevenlabs-connect").handler,
  "/api/tts/provider/elevenlabs/status": require("../netlify/functions/tts-provider-elevenlabs-status").handler,
  "/api/tts/provider/elevenlabs/disconnect": require("../netlify/functions/tts-provider-elevenlabs-disconnect").handler,
  "/api/admin/clients": require("../netlify/functions/admin-clients").handler,
  "/api/admin/access-tokens": require("../netlify/functions/admin-access-tokens").handler,
  "/api/admin/access-tokens/revoke": require("../netlify/functions/admin-access-tokens-revoke").handler,
  "/api/tts/health": require("../netlify/functions/health").handler,
  "/api/health": require("../netlify/functions/health").handler,
  "/health": require("../netlify/functions/health").handler,
};

const PORT = process.env.PORT || 8888;

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-TTS-Request-ID, Authorization, xi-api-key");
  res.setHeader("Access-Control-Expose-Headers", "X-TTS-Request-ID, X-TTS-Output-Format");
  if (origin !== "*") {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const handler = handlers[pathname];
  if (!handler) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: `Route ${pathname} not found.` } }));
    return;
  }

  // Read request body if any
  let bodyBuffer = Buffer.alloc(0);
  req.on("data", (chunk) => {
    bodyBuffer = Buffer.concat([bodyBuffer, chunk]);
  });

  req.on("end", async () => {
    const rawBody = bodyBuffer.toString("utf8");
    const queryParams = Object.fromEntries(parsedUrl.searchParams.entries());

    const event = {
      httpMethod: req.method,
      path: pathname,
      headers: req.headers,
      queryStringParameters: queryParams,
      body: rawBody || null,
      isBase64Encoded: false,
    };

    try {
      const response = await handler(event, {});
      const resHeaders = response.headers || {};
      for (const [k, v] of Object.entries(resHeaders)) {
        res.setHeader(k, v);
      }
      res.writeHead(response.statusCode || 200);

      if (response.isBase64Encoded && response.body) {
        res.end(Buffer.from(response.body, "base64"));
      } else {
        res.end(response.body || "");
      }
    } catch (err) {
      console.error("Local server handler error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "SERVER_ERROR", message: err.message } }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[GhostAI Gateway Local] Listening on http://localhost:${PORT}`);
});
