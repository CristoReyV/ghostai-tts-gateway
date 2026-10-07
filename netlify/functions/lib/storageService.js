/**
 * @file storageService.js
 * Supabase Storage adapter for the Temporary Recovery Vault.
 * Bucket: tts-generations (PRIVATE)
 * Path: <clientId>/<generationSessionId>/<narrationId>.mp3
 */

"use strict";

const db = require("./db");

const BUCKET_NAME = "tts-generations";

// ── In-Memory Storage for Testing ────────────────────────────────────
const _memoryStorage = new Map(); // key: path, val: Buffer

function _resetMemoryStorage() {
  _memoryStorage.clear();
}

/**
 * Validates an ID segment strictly rejecting path traversal, slashes, or empty values.
 * @param {string} id
 * @param {string} fieldName
 * @returns {string}
 */
function validateIdSegment(id, fieldName) {
  if (!id || typeof id !== "string") {
    throw new Error(`Invalid ${fieldName}: must be a non-empty string`);
  }
  const str = id.trim();
  if (
    str.includes("..") ||
    str.includes("/") ||
    str.includes("\\") ||
    str.includes("\0") ||
    str.includes("%2f") ||
    str.includes("%2F") ||
    str.includes("%5c") ||
    str.includes("%5C")
  ) {
    throw new Error(`Path traversal attempt rejected in ${fieldName}`);
  }
  const sanitized = str.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!sanitized) {
    throw new Error(`Invalid ${fieldName}: no valid identifier characters`);
  }
  return sanitized;
}

/**
 * Builds the canonical storage path for a narration MP3.
 * Path format: <clientId>/<sessionId>/<narrationId>.mp3
 * Strictly rejects path traversal or invalid identifiers.
 *
 * @param {string} clientId
 * @param {string} sessionId
 * @param {string} narrationId
 * @returns {string}
 */
function buildStoragePath(clientId, sessionId, narrationId) {
  const safeClient = validateIdSegment(clientId, "clientId");
  const safeSession = validateIdSegment(sessionId, "sessionId");
  const safeNarration = validateIdSegment(narrationId, "narrationId");
  return `${safeClient}/${safeSession}/${safeNarration}.mp3`;
}

/**
 * Uploads an MP3 audio buffer to the Recovery Vault storage.
 *
 * @param {{
 *   clientId: string,
 *   sessionId: string,
 *   narrationId: string,
 *   audioBuffer: Buffer,
 *   mimeType?: string
 * }} options
 * @returns {Promise<{ ok: boolean, storagePath: string, error?: string }>}
 */
async function uploadAudio({ clientId, sessionId, narrationId, audioBuffer, mimeType = "audio/mpeg" }) {
  const storagePath = buildStoragePath(clientId, sessionId, narrationId);

  if (db.isMemoryMode()) {
    _memoryStorage.set(storagePath, Buffer.from(audioBuffer));
    return { ok: true, storagePath };
  }

  try {
    let supabase;
    try {
      // In db.js, getSupabaseClient is available or we can access via db or @supabase/supabase-js
      const { createClient } = require("@supabase/supabase-js");
      supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      });
    } catch (e) {
      return { ok: false, storagePath, error: "SUPABASE_SDK_NOT_AVAILABLE" };
    }

    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(storagePath, audioBuffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (error) {
      return { ok: false, storagePath, error: error.message };
    }

    return { ok: true, storagePath };
  } catch (err) {
    return { ok: false, storagePath, error: err.message };
  }
}

/**
 * Downloads an MP3 audio buffer from the Recovery Vault.
 *
 * @param {string} storagePath
 * @returns {Promise<{ ok: boolean, buffer?: Buffer, error?: string }>}
 */
async function downloadAudio(storagePath) {
  if (db.isMemoryMode()) {
    const buf = _memoryStorage.get(storagePath);
    if (!buf) return { ok: false, error: "FILE_NOT_FOUND" };
    return { ok: true, buffer: buf };
  }

  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const { data, error } = await supabase.storage.from(BUCKET_NAME).download(storagePath);
    if (error || !data) {
      return { ok: false, error: error ? error.message : "FILE_NOT_FOUND" };
    }

    const arrayBuffer = await data.arrayBuffer();
    return { ok: true, buffer: Buffer.from(arrayBuffer) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Deletes files associated with a storage path or session prefix.
 *
 * @param {string[]} storagePaths
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function deleteAudioFiles(storagePaths) {
  if (!storagePaths || storagePaths.length === 0) return { ok: true };

  if (db.isMemoryMode()) {
    for (const p of storagePaths) {
      _memoryStorage.delete(p);
    }
    return { ok: true };
  }

  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const { error } = await supabase.storage.from(BUCKET_NAME).remove(storagePaths);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  BUCKET_NAME,
  buildStoragePath,
  validateIdSegment,
  uploadAudio,
  downloadAudio,
  deleteAudioFiles,
  _resetMemoryStorage,
  _memoryStorage,
};
