/**
 * @file netlify/functions/tts-voice-library.js
 * GET /api/tts/voice-library
 *
 * Productive read-only proxy to ElevenLabs Voice Library (/v1/shared-voices).
 * Strictly GET-only. Validates parameters, normalizes voice objects, never exposes API key,
 * never generates TTS audio.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { getProvider } = require("./providers");

function jsonResponse(statusCode, body, extraHeaders, origin) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

const ALLOWED_SORTS = new Set([
  "usage_character_count_1y",
  "usage_character_count_7d",
  "cloned_by_count",
  "created_date",
  "trending",
]);

const ALLOWED_GENDERS = new Set(["male", "female", "neutral"]);
const ALLOWED_AGES = new Set(["young", "middle_aged", "old"]);

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  if (event.httpMethod !== "GET") {
    const requestId = crypto.randomUUID();
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Only GET is accepted on this endpoint.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }

  const requestId = crypto.randomUUID();
  const providerName = event.queryStringParameters?.provider || "elevenlabs";
  const provider = getProvider(providerName);

  if (!provider || typeof provider.getVoiceLibrary !== "function") {
    const err = makeError(500, ERROR_CODES.GATEWAY_NOT_CONFIGURED, "Voice Library is not supported by this provider.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }

  const query = event.queryStringParameters || {};

  // Validate and sanitize parameters strictly
  const rawPageSize = query.page_size !== undefined ? Number(query.page_size) : 24;
  if (isNaN(rawPageSize) || rawPageSize < 1) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_PARAM, "Parameter 'page_size' must be a positive number.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }
  const pageSize = Math.min(rawPageSize, 100);

  const rawPage = query.page !== undefined ? Number(query.page) : 0;
  if (isNaN(rawPage) || rawPage < 0) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_PARAM, "Parameter 'page' must be a non-negative number.", requestId);
    return jsonResponse(err.statusCode, err, { "X-TTS-Request-ID": requestId }, origin);
  }
  const page = rawPage;

  let sort = query.sort || "usage_character_count_1y";
  if (!ALLOWED_SORTS.has(sort)) {
    sort = "usage_character_count_1y";
  }

  let gender = query.gender ? query.gender.trim().toLowerCase() : undefined;
  if (gender && !ALLOWED_GENDERS.has(gender) && gender !== "all") {
    gender = undefined;
  }

  let age = query.age ? query.age.trim().toLowerCase() : undefined;
  if (age && !ALLOWED_AGES.has(age) && age !== "all") {
    age = undefined;
  }

  const params = {
    language: (query.language || "es").trim().toLowerCase().slice(0, 10),
    pageSize,
    page,
    sort,
    search: query.search ? query.search.trim().slice(0, 80) : undefined,
    accent: query.accent && query.accent !== "all" ? query.accent.trim().slice(0, 50) : undefined,
    locale: query.locale && query.locale !== "all" ? query.locale.trim().slice(0, 20) : undefined,
    gender: gender && gender !== "all" ? gender : undefined,
    age: age && age !== "all" ? age : undefined,
    use_cases: query.use_cases && query.use_cases !== "all" ? query.use_cases.trim().slice(0, 50) : undefined,
  };

  const result = await provider.getVoiceLibrary(params, requestId);

  if (!result.ok) {
    return jsonResponse(result.statusCode, { error: result.error, requestId }, { "X-TTS-Request-ID": requestId }, origin);
  }

  return jsonResponse(
    200,
    {
      voices: result.voices,
      page: result.page,
      pageSize: result.pageSize,
      hasMore: result.hasMore,
      totalCount: result.totalCount,
    },
    { "X-TTS-Request-ID": requestId, "X-TTS-Provider": providerName },
    origin
  );
};
