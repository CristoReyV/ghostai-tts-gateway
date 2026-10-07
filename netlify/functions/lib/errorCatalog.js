/**
 * @file errorCatalog.js
 * Central catalog of standardized TTS Error Codes and operational error sanitization.
 */

"use strict";

/**
 * Standardized TTS Operational Error Codes
 * @readonly
 */
const TtsErrorCode = Object.freeze({
  GHOSTAI_AUTH_INVALID: "GHOSTAI_AUTH_INVALID",
  GHOSTAI_CLIENT_SUSPENDED: "GHOSTAI_CLIENT_SUSPENDED",
  GHOSTAI_TOKEN_REVOKED: "GHOSTAI_TOKEN_REVOKED",
  ELEVENLABS_NOT_CONNECTED: "ELEVENLABS_NOT_CONNECTED",
  ELEVENLABS_AUTH_FAILED: "ELEVENLABS_AUTH_FAILED",
  ELEVENLABS_GENERATION_FAILED: "ELEVENLABS_GENERATION_FAILED",
  ELEVENLABS_RATE_LIMITED: "ELEVENLABS_RATE_LIMITED",
  RECOVERY_SESSION_CREATE_FAILED: "RECOVERY_SESSION_CREATE_FAILED",
  RECOVERY_STORAGE_FAILED: "RECOVERY_STORAGE_FAILED",
  RECOVERY_FETCH_FAILED: "RECOVERY_FETCH_FAILED",
  RECOVERY_EXPIRED: "RECOVERY_EXPIRED",
  ZIP_BUILD_FAILED: "ZIP_BUILD_FAILED",
  ZIP_TRANSFER_FAILED: "ZIP_TRANSFER_FAILED",
  POPUP_BLOCKED: "POPUP_BLOCKED",
  BRIDGE_TIMEOUT: "BRIDGE_TIMEOUT",
  RECEIVER_INHERITED_SANDBOX: "RECEIVER_INHERITED_SANDBOX",
  DOWNLOAD_TRIGGER_FAILED: "DOWNLOAD_TRIGGER_FAILED",
  ZIP_VERIFICATION_FAILED: "ZIP_VERIFICATION_FAILED",
  ZIP_INTEGRITY_MISMATCH: "ZIP_INTEGRITY_MISMATCH",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
});

/**
 * Operational stages
 */
const TtsOperationStage = Object.freeze({
  AUTH: "auth",
  GENERATION: "generation",
  STORAGE: "storage",
  RECOVERY: "recovery",
  ZIP_BUILD: "zip_build",
  ZIP_TRANSFER: "zip_transfer",
  DOWNLOAD: "download",
  VERIFICATION: "verification",
  CLEANUP: "cleanup",
});

/**
 * Sanitizes an error message or object to guarantee no sensitive tokens,
 * keys, hashes, cookies, or secrets leak into logs or databases.
 *
 * @param {any} err - Error instance, string, or object
 * @returns {string} Sanitized safe string
 */
function sanitizeOperationalError(err) {
  if (!err) return "Unknown error occurred.";

  let raw = "";
  if (typeof err === "string") {
    raw = err;
  } else if (err instanceof Error) {
    raw = err.message || "Error occurred";
  } else if (typeof err === "object") {
    raw = err.message || err.error || JSON.stringify(err);
  } else {
    raw = String(err);
  }

  let sanitized = raw
    // 1. GhostAI Access keys: gai_live_<publicId>.<secret>
    .replace(/gai_live_[A-Za-z0-9_.-]+/g, "gai_live_[REDACTED]")
    // 2. ElevenLabs / OpenAI keys: sk_...
    .replace(/sk_[A-Za-z0-9_-]{20,}/g, "sk_[REDACTED]")
    // 3. JWTs (Supabase anon/service role)
    .replace(/eyJh[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]")
    // 4. Authorization headers (Bearer / Basic)
    .replace(/(?:Authorization|authorization):\s*(?:Bearer|Basic)\s+[^\s,;]+/gi, "Authorization: [REDACTED]")
    .replace(/(?:Bearer|bearer)\s+[A-Za-z0-9_.~+\/=-]{12,}/g, "Bearer [REDACTED]")
    // 5. Sensitive query params / body fields
    .replace(/(key|token|secret|password|apiKey|api_key)=([^&\s]+)/gi, "$1=[REDACTED]")
    // 6. Cookie headers
    .replace(/(?:cookie|set-cookie):\s*[^;\r\n]+/gi, "Cookie: [REDACTED]");

  // Strip external stack traces if accidentally embedded
  sanitized = sanitized.split("\n")[0].trim();

  return sanitized || "Operational error occurred.";
}

const SENSITIVE_KEY_REGEX = /^(?:authorization|cookie|set-cookie|apiKey|api_key|token|secret|password|credential|serviceRoleKey|service_role_key|adminToken|admin_token|bearer)$/i;

/**
 * Sanitizes a string value from known secret formats (Bearer, tokens, keys, JWTs).
 * @param {string} str
 * @returns {string}
 */
function sanitizeStringValue(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/gai_live_[A-Za-z0-9_.-]+/g, "gai_live_[REDACTED]")
    .replace(/sk_[A-Za-z0-9_-]{10,}/g, "sk_[REDACTED]")
    .replace(/eyJh[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]")
    .replace(/(?:Authorization|authorization):\s*(?:Bearer|Basic)\s+[^\s,;]+/gi, "Authorization: [REDACTED]")
    .replace(/(?:Bearer|bearer)\s+[A-Za-z0-9_.~+\/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/(key|token|secret|password|apiKey|api_key)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/(?:cookie|set-cookie):\s*[^;\r\n]+/gi, "Cookie: [REDACTED]");
}

/**
 * Recursively sanitizes an operational metadata object or array.
 * Redacts keys by name (authorization, cookie, token, secret, apiKey, etc.)
 * and redacts string values by pattern (Bearer, JWT, keys, etc.).
 * Preserves benign operational fields (requestId, sessionId, duration, status, etc.).
 *
 * @param {any} value
 * @param {WeakSet} [seen]
 * @returns {any}
 */
function sanitizeOperationalMetadata(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return sanitizeStringValue(value);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOperationalMetadata(item, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);

    const sanitizedObj = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        sanitizedObj[key] = "[REDACTED]";
      } else {
        sanitizedObj[key] = sanitizeOperationalMetadata(val, seen);
      }
    }
    return sanitizedObj;
  }

  return String(value);
}

/**
 * Validates and whitelists source_manifest to prevent storing request bodies,
 * credentials, authorization tokens, or cookies inside the recovery session.
 *
 * @param {any} manifest
 * @returns {object|null}
 */
function sanitizeSourceManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return null;

  const sanitized = {
    format: typeof manifest.format === "string" ? manifest.format : "ghostai-tts",
    version: typeof manifest.version === "string" ? manifest.version : "1.0",
  };

  if (manifest.project && typeof manifest.project === "object") {
    sanitized.project = {
      name: manifest.project.name || "Untitled",
      description: manifest.project.description || "",
      exportedAt: manifest.project.exportedAt || new Date().toISOString(),
      duration: typeof manifest.project.duration === "number" ? manifest.project.duration : undefined,
      sceneCount: typeof manifest.project.sceneCount === "number" ? manifest.project.sceneCount : undefined,
    };
  }

  if (Array.isArray(manifest.items)) {
    sanitized.items = manifest.items.map((i) => ({
      id: i.id || i.narrationId,
      sceneId: i.sceneId || null,
      sceneIndex: typeof i.sceneIndex === "number" ? i.sceneIndex : null,
      text: typeof i.text === "string" ? i.text : "",
      voiceId: i.voiceId || null,
      modelId: i.modelId || null,
      speed: typeof i.speed === "number" ? i.speed : 1,
      voiceSettings: i.voiceSettings && typeof i.voiceSettings === "object" ? {
        stability: i.voiceSettings.stability,
        similarity_boost: i.voiceSettings.similarity_boost,
      } : undefined,
      outputFormat: i.outputFormat || null,
      duration: typeof i.duration === "number" ? i.duration : null,
      requestId: i.requestId || null,
      file: i.file || null,
    }));
  }

  return sanitized;
}

module.exports = {
  TtsErrorCode,
  TtsOperationStage,
  sanitizeOperationalError,
  sanitizeOperationalMetadata,
  sanitizeSourceManifest,
};
