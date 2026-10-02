/**
 * @file providers/index.js
 * Provider registry — maps provider name → adapter.
 * Add future providers here without touching the gateway function.
 */

"use strict";

const elevenlabs = require("./elevenlabs");

/** @type {Record<string, { generate: Function; listVoices: Function; listModels: Function }>} */
const PROVIDERS = {
  elevenlabs,
  // supertonic: require('./supertonic'), // future — not implemented
};

/**
 * @param {string} name
 * @returns {{ generate: Function; listVoices: Function; listModels: Function } | null}
 */
function getProvider(name) {
  return PROVIDERS[name] || null;
}

module.exports = { getProvider, PROVIDERS };
