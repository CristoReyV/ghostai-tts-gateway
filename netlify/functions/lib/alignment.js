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

/**
 * Normalizes ElevenLabs /v1/forced-alignment response into canonical GhostAI NarrationAlignment.
 *
 * ElevenLabs raw shape:
 * {
 *   characters?: Array<{ text: string; start: number; end: number }>,
 *   words?: Array<{ text: string; start: number; end: number; loss?: number }>,
 *   loss?: number
 * }
 *
 * @param {unknown} rawAlignment
 * @returns {{ words: Array<{ text: string; start: number; end: number }> } | null}
 */
function normalizeElevenLabsForcedAlignment(rawAlignment) {
  if (!rawAlignment || typeof rawAlignment !== "object") return null;

  // 1. If words array is present (standard /v1/forced-alignment response)
  if (Array.isArray(rawAlignment.words) && rawAlignment.words.length > 0) {
    const words = [];
    let lastStart = -1;

    for (let i = 0; i < rawAlignment.words.length; i++) {
      const w = rawAlignment.words[i];
      if (!w || typeof w !== "object") return null;
      if (typeof w.text !== "string" || w.text.trim().length === 0) continue;
      if (typeof w.start !== "number" || !Number.isFinite(w.start) || w.start < 0) return null;
      if (typeof w.end !== "number" || !Number.isFinite(w.end) || w.end < w.start) return null;
      if (w.start < lastStart) return null; // monotonic check
      lastStart = w.start;

      words.push({
        text: w.text,
        start: Math.round(w.start * 1000) / 1000,
        end: Math.round(w.end * 1000) / 1000,
      });
    }

    if (words.length === 0) return null;
    const canonical = { words };
    if (!isValidCanonicalAlignment(canonical)) return null;
    return canonical;
  }

  // 2. Fallback: if only characters array is present as [{ text, start, end }]
  if (Array.isArray(rawAlignment.characters) && rawAlignment.characters.length > 0) {
    const words = [];
    let currentChars = [];
    let tokenStart = null;
    let tokenEnd = null;

    for (let i = 0; i < rawAlignment.characters.length; i++) {
      const c = rawAlignment.characters[i];
      if (!c || typeof c !== "object") return null;
      const char = c.text;
      const s = c.start;
      const e = c.end;

      if (
        typeof char !== "string" ||
        typeof s !== "number" ||
        !Number.isFinite(s) ||
        s < 0 ||
        typeof e !== "number" ||
        !Number.isFinite(e) ||
        e < s
      ) {
        return null;
      }

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
        if (tokenStart === null) tokenStart = s;
        tokenEnd = e;
        currentChars.push(char);
      }
    }

    if (currentChars.length > 0) {
      words.push({
        text: currentChars.join(""),
        start: Math.round(tokenStart * 1000) / 1000,
        end: Math.round(tokenEnd * 1000) / 1000,
      });
    }

    if (words.length === 0) return null;
    const canonical = { words };
    if (!isValidCanonicalAlignment(canonical)) return null;
    return canonical;
  }

  // 3. Fallback: if parallel arrays shape was passed
  if (Array.isArray(rawAlignment.character_start_times_seconds)) {
    return normalizeElevenLabsAlignment({ rawAlignment });
  }

  return null;
}

module.exports = {
  normalizeElevenLabsAlignment,
  normalizeElevenLabsForcedAlignment,
  isValidCanonicalAlignment,
};
