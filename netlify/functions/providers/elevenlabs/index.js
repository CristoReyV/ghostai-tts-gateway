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
    402: [402, ERROR_CODES.ELEVENLABS_PAYMENT_REQUIRED, "Esta voz o función requiere un plan de ElevenLabs compatible."],
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

/**
 * Queries the ElevenLabs public shared-voices library (/v1/shared-voices) and normalizes output.
 * STRICTLY READ-ONLY GET operation.
 *
 * @param {{
 *   language?: string;
 *   pageSize?: number;
 *   page?: number;
 *   sort?: string;
 *   search?: string;
 *   accent?: string;
 *   locale?: string;
 *   gender?: string;
 *   age?: string;
 *   use_cases?: string;
 * }} params
 * @param {string} requestId
 * @returns {Promise<
 *   | { ok: true; voices: unknown[]; page: number; pageSize: number; hasMore: boolean; totalCount: number }
 *   | { ok: false; statusCode: number; error: { code: string; message: string }; requestId: string }
 * >}
 */
async function getVoiceLibrary(params = {}, requestId) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, ...makeError(503, ERROR_CODES.GATEWAY_NOT_CONFIGURED, "TTS provider is not configured.", requestId) };
  }

  const {
    language = "es",
    pageSize = 24,
    page = 0,
    sort = "usage_character_count_1y",
    search,
    accent,
    locale,
    gender,
    age,
    use_cases,
  } = params;

  const validPageSize = Math.max(1, Math.min(Number(pageSize) || 24, 100));
  const validPage = Math.max(0, Number(page) || 0);

  const searchParams = new URLSearchParams();
  searchParams.set("page_size", String(validPageSize));
  searchParams.set("page", String(validPage));
  if (sort) searchParams.set("sort", String(sort));
  if (language) searchParams.set("language", String(language));
  if (search && typeof search === "string" && search.trim()) {
    searchParams.set("search", search.trim());
  }
  if (accent && typeof accent === "string" && accent.trim() && accent !== "all") {
    searchParams.set("accent", accent.trim());
  }
  if (locale && typeof locale === "string" && locale.trim() && locale !== "all") {
    searchParams.set("locale", locale.trim());
  }
  if (gender && typeof gender === "string" && gender.trim() && gender !== "all") {
    searchParams.set("gender", gender.trim());
  }
  if (age && typeof age === "string" && age.trim() && age !== "all") {
    searchParams.set("age", age.trim());
  }
  if (use_cases && typeof use_cases === "string" && use_cases.trim() && use_cases !== "all") {
    searchParams.set("use_cases", use_cases.trim());
  }

  const url = `${ELEVENLABS_BASE_URL}/v1/shared-voices?${searchParams.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startMs = Date.now();

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "xi-api-key": apiKey,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, ...(await handleElevenLabsError(res, requestId, Date.now() - startMs)) };
    }

    const raw = await res.json();
    const rawVoices = Array.isArray(raw.voices) ? raw.voices : [];

    const voices = rawVoices.map((v) => ({
      voiceId: v.voice_id,
      publicOwnerId: v.public_owner_id || null,
      name: v.name || "",
      language: v.language || language,
      locale: v.locale || null,
      accent: v.accent || null,
      gender: v.gender || null,
      age: v.age || null,
      useCase: v.use_case || null,
      descriptive: v.descriptive || null,
      description: v.description || "",
      category: v.category || null,
      previewUrl: v.preview_url || null,
      clonedByCount: typeof v.cloned_by_count === "number" ? v.cloned_by_count : 0,
      usageCharacterCount1y: typeof v.usage_character_count_1y === "number" ? v.usage_character_count_1y : 0,
      featured: !!v.featured,
      freeUsersAllowed: v.free_users_allowed !== false,
      liveModerationEnabled: !!v.live_moderation_enabled,
      noticePeriod: typeof v.notice_period === "number" ? v.notice_period : null,
      rate: typeof v.rate === "number" ? v.rate : null,
      verifiedLanguages: Array.isArray(v.verified_languages)
        ? v.verified_languages.map((vl) => ({
            language: vl.language,
            modelId: vl.model_id,
            accent: vl.accent,
            locale: vl.locale,
            previewUrl: vl.preview_url,
          }))
        : [],
    }));

    return {
      ok: true,
      voices,
      page: validPage,
      pageSize: validPageSize,
      hasMore: !!raw.has_more,
      totalCount: typeof raw.total_count === "number" ? raw.total_count : voices.length,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { ok: false, ...makeError(504, ERROR_CODES.ELEVENLABS_TIMEOUT, "Voice Library request to ElevenLabs timed out.", requestId) };
    }
    return { ok: false, ...makeError(502, ERROR_CODES.ELEVENLABS_NETWORK_ERROR, "Network error fetching Voice Library.", requestId) };
  }
}

/**
 * Adds a shared voice from the public library to the user's account collection.
 * Uses POST /v1/voices/add/{public_user_id}/{voice_id}
 *
 * @param {{
 *   voiceId: string;
 *   publicOwnerId: string;
 *   name: string;
 * }} request
 * @param {string} requestId
 * @returns {Promise<
 *   | { ok: true; voiceId: string; name: string; message: string }
 *   | { ok: false; statusCode: number; error: { code: string; message: string }; requestId: string }
 * >}
 */
async function addSharedVoice(request, requestId) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, ...makeError(503, ERROR_CODES.GATEWAY_NOT_CONFIGURED, "TTS provider is not configured.", requestId) };
  }

  const { voiceId, publicOwnerId, name } = request || {};
  if (!voiceId || typeof voiceId !== "string" || !voiceId.trim()) {
    return { ok: false, ...makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Field 'voiceId' is required.", requestId) };
  }
  if (!publicOwnerId || typeof publicOwnerId !== "string" || !publicOwnerId.trim()) {
    return { ok: false, ...makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Field 'publicOwnerId' is required.", requestId) };
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    return { ok: false, ...makeError(400, ERROR_CODES.VALIDATION_MISSING_FIELD, "Field 'name' is required.", requestId) };
  }

  // Sanitize name: max 100 characters, trimmed
  const sanitizedName = name.trim().slice(0, 100);

  const url = `${ELEVENLABS_BASE_URL}/v1/voices/add/${encodeURIComponent(publicOwnerId.trim())}/${encodeURIComponent(voiceId.trim())}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startMs = Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ new_name: sanitizedName }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, ...(await handleElevenLabsError(res, requestId, Date.now() - startMs)) };
    }

    const raw = await res.json().catch(() => ({}));
    // Invalidate cached account voices so subsequent calls to listVoices reflect the newly added voice
    voicesCache = null;

    return {
      ok: true,
      voiceId: raw.voice_id || voiceId.trim(),
      name: sanitizedName,
      message: "Voice added successfully to account",
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { ok: false, ...makeError(504, ERROR_CODES.ELEVENLABS_TIMEOUT, "Add shared voice request timed out.", requestId) };
    }
    return { ok: false, ...makeError(502, ERROR_CODES.ELEVENLABS_NETWORK_ERROR, "Network error adding shared voice.", requestId) };
  }
}

/** Legacy probe backward-compatibility wrapper */
async function probeSharedVoices(params = {}, requestId) {
  return getVoiceLibrary(params, requestId);
}

/** Invalidate caches (used in tests) */
function _clearCache() {
  voicesCache = null;
  modelsCache = null;
}

module.exports = {
  generate,
  listVoices,
  listModels,
  getVoiceLibrary,
  addSharedVoice,
  probeSharedVoices,
  _clearCache,
};


