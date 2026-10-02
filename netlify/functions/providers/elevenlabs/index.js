/**
 * @file providers/elevenlabs/index.js
 * ElevenLabs TTS Provider Adapter.
 *
 * Implements the TTSProvider interface:
 *   generate(request) → { audioBuffer: Buffer, contentType: string, durationMs: number, responseBytes: number }
 *   generateStream(request) → [future]
 *   listVoices()  → { voices, hasMore, nextPageToken }
 *   listModels()  → { models }
 *
 * The xi-api-key header is set ONLY here — never in the gateway or in any
 * response sent to the client.
 */

"use strict";

const { ERROR_CODES, makeError } = require("../../lib/errors");
const { logProviderRequest, logProviderSuccess, logProviderError } = require("../../lib/logger");

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_MODEL_ID = process.env.ELEVENLABS_DEFAULT_MODEL_ID || "eleven_multilingual_v2";
const DEFAULT_OUTPUT_FORMAT = process.env.ELEVENLABS_DEFAULT_OUTPUT_FORMAT || "mp3_44100_128";
const DEFAULT_TIMEOUT_MS = Number(process.env.ELEVENLABS_TIMEOUT_MS) || 30000;

// Cache for voices / models to avoid hitting ElevenLabs on every render
/** @type {{ data: unknown; expiresAt: number } | null} */
let voicesCache = null;
/** @type {{ data: unknown; expiresAt: number } | null} */
let modelsCache = null;
const CACHE_TTL_MS = Number(process.env.ELEVENLABS_CACHE_TTL_MS) || 120_000; // 2 min

/**
 * Returns the configured ElevenLabs API key or null if missing.
 * @returns {string | null}
 */
function getApiKey() {
  return process.env.ELEVENLABS_API_KEY || null;
}

/**
 * Handles an ElevenLabs HTTP error and returns a normalised error object.
 * @param {Response} res
 * @param {string} requestId
 * @param {number} durationMs
 * @returns {Promise<{ statusCode: number; error: { code: string; message: string }; requestId: string }>}
 */
async function handleElevenLabsError(res, requestId, durationMs) {
  logProviderError(requestId, { status: res.status, durationMs });

  let bodyText = "";
  try { bodyText = await res.text(); } catch (_) {}

  if (res.status === 400 && bodyText.includes("api_key_id_used_as_api_key")) {
    return makeError(
      401,
      ERROR_CODES.ELEVENLABS_UNAUTHORIZED,
      "ElevenLabs API key is invalid: an API key ID was provided instead of the secret API key (starts with 'sk_').",
      requestId
    );
  }

  const map = {
    400: [400, ERROR_CODES.ELEVENLABS_UNPROCESSABLE, "ElevenLabs rejected the request parameters."],
    401: [401, ERROR_CODES.ELEVENLABS_UNAUTHORIZED, "ElevenLabs API key is invalid or missing."],
    403: [403, ERROR_CODES.ELEVENLABS_FORBIDDEN, "Access to this ElevenLabs resource is forbidden."],
    404: [404, ERROR_CODES.ELEVENLABS_NOT_FOUND, "ElevenLabs voice or model not found."],
    422: [422, ERROR_CODES.ELEVENLABS_UNPROCESSABLE, "ElevenLabs rejected the request parameters."],
    429: [429, ERROR_CODES.ELEVENLABS_RATE_LIMIT, "ElevenLabs rate limit reached. Please retry later."],
  };

  if (map[res.status]) {
    const [sc, code, msg] = map[res.status];
    return makeError(sc, code, msg, requestId);
  }

  return makeError(502, ERROR_CODES.ELEVENLABS_SERVER_ERROR, "ElevenLabs returned an unexpected error.", requestId);
}

/**
 * Generates TTS audio via ElevenLabs.
 *
 * @param {{
 *   requestId: string;
 *   voiceId: string;
 *   text: string;
 *   modelId?: string;
 *   voiceSettings?: {
 *     stability?: number;
 *     similarityBoost?: number;
 *     style?: number;
 *     speed?: number;
 *     useSpeakerBoost?: boolean;
 *   };
 *   outputFormat?: string;
 *   languageCode?: string;
 * }} request
 * @returns {Promise<
 *   | { ok: true; audioBuffer: Buffer; contentType: string; durationMs: number; responseBytes: number }
 *   | { ok: false; statusCode: number; error: { code: string; message: string }; requestId: string }
 * >}
 */
async function generate(request) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, ...makeError(503, ERROR_CODES.GATEWAY_NOT_CONFIGURED, "TTS provider is not configured.", request.requestId) };
  }

  const {
    requestId,
    voiceId,
    text,
    modelId = DEFAULT_MODEL_ID,
    voiceSettings,
    outputFormat = DEFAULT_OUTPUT_FORMAT,
    languageCode,
  } = request;

  logProviderRequest(requestId);

  const body = {
    text,
    model_id: modelId,
    ...(languageCode ? { language_code: languageCode } : {}),
    ...(voiceSettings
      ? {
          voice_settings: {
            stability: voiceSettings.stability ?? 0.5,
            similarity_boost: voiceSettings.similarityBoost ?? 0.75,
            style: voiceSettings.style ?? 0,
            speed: voiceSettings.speed ?? 1,
            use_speaker_boost: voiceSettings.useSpeakerBoost ?? true,
          },
        }
      : {}),
  };

  const url = `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startMs = Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/*",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const durationMs = Date.now() - startMs;

    if (!res.ok) {
      return { ok: false, ...(await handleElevenLabsError(res, requestId, durationMs)) };
    }

    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    const contentType = res.headers.get("Content-Type") || "audio/mpeg";

    logProviderSuccess(requestId, { durationMs, responseBytes: audioBuffer.byteLength });

    return { ok: true, audioBuffer, contentType, durationMs, responseBytes: audioBuffer.byteLength };
  } catch (err) {
    clearTimeout(timer);
    const durationMs = Date.now() - startMs;

    if (err.name === "AbortError") {
      logProviderError(requestId, { durationMs, error: "timeout" });
      return { ok: false, ...makeError(504, ERROR_CODES.ELEVENLABS_TIMEOUT, "Request to ElevenLabs timed out.", requestId) };
    }

    logProviderError(requestId, { durationMs, error: err.message });
    return { ok: false, ...makeError(502, ERROR_CODES.ELEVENLABS_NETWORK_ERROR, "Network error reaching ElevenLabs.", requestId) };
  }
}

/**
 * Lists available voices from ElevenLabs (/v2/voices) with a short in-memory cache.
 *
 * @param {string} requestId
 * @returns {Promise<
 *   | { ok: true; voices: unknown[]; hasMore: boolean; nextPageToken: string | null }
 *   | { ok: false; statusCode: number; error: { code: string; message: string }; requestId: string }
 * >}
 */
async function listVoices(requestId) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, ...makeError(503, ERROR_CODES.GATEWAY_NOT_CONFIGURED, "TTS provider is not configured.", requestId) };
  }

  const now = Date.now();
  if (voicesCache && voicesCache.expiresAt > now) {
    return { ok: true, ...voicesCache.data };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startMs = Date.now();

  try {
    const res = await fetch(`${ELEVENLABS_BASE_URL}/v2/voices?page_size=100`, {
      headers: { "xi-api-key": apiKey },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, ...(await handleElevenLabsError(res, requestId, Date.now() - startMs)) };
    }

    const raw = await res.json();

    const voices = (raw.voices || []).map((v) => ({
      voiceId: v.voice_id,
      name: v.name,
      category: v.category || null,
      labels: v.labels || {},
      previewUrl: v.preview_url || null,
    }));

    const result = {
      voices,
      hasMore: !!raw.has_more,
      nextPageToken: raw.last_voice_id || null,
    };

    voicesCache = { data: result, expiresAt: now + CACHE_TTL_MS };

    return { ok: true, ...result };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { ok: false, ...makeError(504, ERROR_CODES.ELEVENLABS_TIMEOUT, "Voices request to ElevenLabs timed out.", requestId) };
    }
    return { ok: false, ...makeError(502, ERROR_CODES.ELEVENLABS_NETWORK_ERROR, "Network error fetching voices.", requestId) };
  }
}

/**
 * Lists TTS-compatible models from ElevenLabs (/v1/models) with a short in-memory cache.
 *
 * @param {string} requestId
 * @returns {Promise<
 *   | { ok: true; models: unknown[] }
 *   | { ok: false; statusCode: number; error: { code: string; message: string }; requestId: string }
 * >}
 */
async function listModels(requestId) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, ...makeError(503, ERROR_CODES.GATEWAY_NOT_CONFIGURED, "TTS provider is not configured.", requestId) };
  }

  const now = Date.now();
  if (modelsCache && modelsCache.expiresAt > now) {
    return { ok: true, ...modelsCache.data };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startMs = Date.now();

  try {
    const res = await fetch(`${ELEVENLABS_BASE_URL}/v1/models`, {
      headers: { "xi-api-key": apiKey },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, ...(await handleElevenLabsError(res, requestId, Date.now() - startMs)) };
    }

    const raw = await res.json();
    const models = (Array.isArray(raw) ? raw : [])
      .filter((m) => m.can_do_text_to_speech === true)
      .map((m) => ({
        modelId: m.model_id,
        name: m.name,
        description: m.description || "",
        languages: (m.languages || []).map((l) => ({ code: l.language_id, name: l.name })),
        supportsStyle: !!(m.model_rates && m.can_do_text_to_speech),
        supportsSpeakerBoost: !!(m.model_rates && m.can_do_text_to_speech),
      }));

    const result = { models };
    modelsCache = { data: result, expiresAt: now + CACHE_TTL_MS };

    return { ok: true, ...result };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { ok: false, ...makeError(504, ERROR_CODES.ELEVENLABS_TIMEOUT, "Models request to ElevenLabs timed out.", requestId) };
    }
    return { ok: false, ...makeError(502, ERROR_CODES.ELEVENLABS_NETWORK_ERROR, "Network error fetching models.", requestId) };
  }
}

/** Invalidate caches (used in tests) */
function _clearCache() {
  voicesCache = null;
  modelsCache = null;
}

module.exports = { generate, listVoices, listModels, _clearCache };
