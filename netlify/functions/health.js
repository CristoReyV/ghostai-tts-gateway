/**
 * @file netlify/functions/health.js
 * GET /health  and  GET /api/health  and  GET /api/tts/health
 *
 * Reports gateway liveness and configuration status.
 * NEVER returns the API key or any secret.
 */

"use strict";

const { corsHeaders, preflightResponse } = require("./lib/cors");

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, service: "ghostai-tts-gateway", error: `Method ${event.httpMethod} Not Allowed` }),
    };
  }

  const elevenLabsConfigured = !!(process.env.ELEVENLABS_API_KEY);

  try {
    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        service: "ghostai-tts-gateway",
        version: "1.0.0",
        provider: "elevenlabs",
        configured: elevenLabsConfigured,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, service: "ghostai-tts-gateway", error: "Internal server error" }),
    };
  }
};
