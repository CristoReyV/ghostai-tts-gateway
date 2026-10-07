/**
 * @file netlify/functions/cleanup-tts-generations.js
 * Netlify Scheduled Function (@hourly).
 * Idempotently sweeps and purges expired Temporary Recovery Vault generations and files.
 * Internal execution only: NOT exposed as a public API route in netlify.toml redirects.
 */

"use strict";

const { cleanupExpiredTtsGenerations } = require("./lib/cleanupService");

exports.handler = async () => {
  const result = await cleanupExpiredTtsGenerations();
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({ ok: true, result }),
  };
};
