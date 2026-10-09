/**
 * @file netlify/functions/lib/alignment.js
 * Provider-agnostic alignment normalization layer for GhostAI TTS Gateway.
 *
 * Converts provider-specific character-level timing (e.g. ElevenLabs)
 * into the canonical GhostAI NarrationAlignment structure:
 *
 *   NarrationAlignment = {
 *     words: [
 *       { text: string, start: number, end: number }
 *     ]
 *   }
 *
 * RULES:
 * - Preserves the exact original text (casing, accents, ñ, ¿?, ¡!, punctuation).
 * - Whitespace separates words.
 * - Punctuation stays attached to the corresponding visible word token.
 * - start = timestamp of first character of the token.
 * - end = timestamp of the last character of the token.
 * - Validates: start >= 0, end >= start, monotonic ordering.
 * - Malformed input returns null gracefully without throwing.
 * - Does NOT expose characters[], character_start_times_seconds[] outside adapter.
 */

"use strict";

/**
 * Validates a canonical NarrationAlignment structure.
 * @param {unknown} alignment
 * @returns {boolean}
 */
function isValidCanonicalAlignment(alignment) {
  if (!alignment || typeof alignment !== "object") return false;
  const words = alignment.words;
  if (!Array.isArray(words)) return false;

  let lastStart = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || typeof w !== "object") return false;
    if (typeof w.text !== "string" || w.text.length === 0) return false;
    if (typeof w.start !== "number" || !Number.isFinite(w.start) || w.start < 0) return false;
    if (typeof w.end !== "number" || !Number.isFinite(w.end) || w.end < w.start) return false;
    if (w.start < lastStart) return false; // Monotonic check
    lastStart = w.start;
  }
  return true;
}

/**
 * Normalizes ElevenLabs character-level alignment to canonical GhostAI NarrationAlignment.
 *
 * ElevenLabs raw shape:
 * {
 *   characters: string[],
 *   character_start_times_seconds: number[],
 *   character_end_times_seconds: number[]
 * }
 *
 * @param {{
 *   text: string;
 *   rawAlignment: unknown;
 * }} options
 * @returns {{ words: Array<{ text: string; start: number; end: number }> } | null}
 */
function normalizeElevenLabsAlignment(options) {
  if (!options || typeof options !== "object") return null;
  const { rawAlignment } = options;

  if (!rawAlignment || typeof rawAlignment !== "object") return null;

  const characters = rawAlignment.characters;
  const starts = rawAlignment.character_start_times_seconds;
  const ends = rawAlignment.character_end_times_seconds;

  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) {
    return null;
  }

  const len = characters.length;
  if (len === 0 || starts.length !== len || ends.length !== len) {
    return null;
  }

  // Group characters into word tokens separated by whitespace
  const words = [];
  let currentChars = [];
  let tokenStart = null;
  let tokenEnd = null;

  for (let i = 0; i < len; i++) {
    const char = characters[i];
    const s = starts[i];
    const e = ends[i];

    // Basic validity check per character timestamp
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0 ||
        typeof e !== "number" || !Number.isFinite(e) || e < s) {
      return null; // Malformed timestamp data
    }

    // Check if character is whitespace
    const isWhitespace = /^\s$/.test(char);

    if (isWhitespace) {
      if (currentChars.length > 0) {
        words.push({
          text: currentChars.join(""),
          start: Math.round(tokenStart * 1000) / 1000,
          end: Math.round(tokenEnd * 1000) / 1000,
        });
        currentChars = [];
        tokenStart = null;
        tokenEnd = null;
      }
    } else {
      if (tokenStart === null) {
        tokenStart = s;
      }
      tokenEnd = e;
      currentChars.push(char);
    }
  }

  // Flush remaining token if any
  if (currentChars.length > 0) {
    words.push({
      text: currentChars.join(""),
      start: Math.round(tokenStart * 1000) / 1000,
      end: Math.round(tokenEnd * 1000) / 1000,
    });
  }

  if (words.length === 0) {
    return null;
  }

  const canonical = { words };
  if (!isValidCanonicalAlignment(canonical)) {
    return null;
  }

  return canonical;
}

module.exports = {
  normalizeElevenLabsAlignment,
  isValidCanonicalAlignment,
};
