/**
 * @file db.js
 * Database adapter for GhostAI Identity & Access Management.
 * Uses Supabase PostgreSQL with service_role key server-side.
 * Includes an isolated in-memory engine for local offline testing.
 */

"use strict";

const crypto = require("crypto");
let supabaseJs = null;

try {
  supabaseJs = require("@supabase/supabase-js");
} catch (_) {
  // Supabase SDK optional in mock/test mode
}

// ── In-Memory Store for Testing / Offline Development ───────────────
let _memoryStoreEnabled = false;
let _memoryClients = new Map();
let _memoryTokens = new Map();

function _resetMemoryStore() {
  _memoryClients.clear();
  _memoryTokens.clear();
}

function _setMemoryStoreEnabled(enabled) {
  _memoryStoreEnabled = !!enabled;
}

function isMemoryMode() {
  if (_memoryStoreEnabled) return true;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !url.trim() || !key.trim()) return true;
  if (url.includes("placeholder") || key.includes("placeholder")) return true;
  return false;
}

// ── Live Supabase Client ─────────────────────────────────────────────
let _supabaseClientInstance = null;
let _cachedUrl = null;
let _cachedKey = null;

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_NOT_CONFIGURED");
  }

  if (!_supabaseClientInstance || _cachedUrl !== url || _cachedKey !== key) {
    if (!supabaseJs || !supabaseJs.createClient) {
      throw new Error("SUPABASE_SDK_NOT_AVAILABLE");
    }
    _supabaseClientInstance = supabaseJs.createClient(url, key, {
      auth: { persistSession: false },
    });
    _cachedUrl = url;
    _cachedKey = key;
  }

  return _supabaseClientInstance;
}

// ── Client Operations ────────────────────────────────────────────────

/**
 * Creates a new client.
 * @param {{ name: string, email?: string | null }} data
 * @returns {Promise<{ id: string, name: string, email: string | null, status: string, created_at: string, updated_at: string }>}
 */
async function createClient({ name, email = null }) {
  if (isMemoryMode()) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const client = {
      id,
      name,
      email: email || null,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    _memoryClients.set(id, client);
    return { ...client };
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_clients")
    .insert([
      {
        name,
        email: email || null,
        status: "active",
      },
    ])
    .select()
    .single();

  if (error) throw new Error(error.message);
  return record;
}

/**
 * Retrieves a client by its ID.
 * @param {string} clientId
 * @returns {Promise<{ id: string, name: string, email: string | null, status: string } | null>}
 */
async function getClientById(clientId) {
  if (isMemoryMode()) {
    const client = _memoryClients.get(clientId);
    return client ? { ...client } : null;
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_clients")
    .select("id, name, email, status, created_at, updated_at")
    .eq("id", clientId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return record || null;
}

/**
 * Updates a client's status (e.g. active, suspended).
 * @param {string} clientId
 * @param {"active" | "suspended"} status
 * @returns {Promise<boolean>}
 */
async function updateClientStatus(clientId, status) {
  if (isMemoryMode()) {
    const client = _memoryClients.get(clientId);
    if (!client) return false;
    client.status = status;
    client.updated_at = new Date().toISOString();
    return true;
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("ghostai_clients")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", clientId);

  if (error) throw new Error(error.message);
  return true;
}

/**
 * Lists all clients.
 * @returns {Promise<Array<{ id: string, name: string, email: string | null, status: string, created_at: string }>>}
 */
async function listClients() {
  if (isMemoryMode()) {
    return Array.from(_memoryClients.values()).map((c) => ({ ...c }));
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_clients")
    .select("id, name, email, status, created_at, updated_at")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

// ── Access Token Operations ──────────────────────────────────────────

/**
 * Stores a new access token record.
 * @param {{
 *   clientId: string,
 *   tokenPublicId: string,
 *   secretHash: string,
 *   label?: string | null,
 *   expiresAt?: string | null
 * }} data
 * @returns {Promise<{
 *   id: string,
 *   client_id: string,
 *   token_public_id: string,
 *   label: string | null,
 *   status: string,
 *   created_at: string,
 *   expires_at: string | null
 * }>}
 */
async function createTokenRecord({ clientId, tokenPublicId, secretHash, label = null, expiresAt = null }) {
  if (isMemoryMode()) {
    const client = _memoryClients.get(clientId);
    if (!client) throw new Error("Client does not exist");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const record = {
      id,
      client_id: clientId,
      token_public_id: tokenPublicId,
      secret_hash: secretHash,
      label: label || null,
      status: "active",
      created_at: now,
      expires_at: expiresAt || null,
      last_used_at: null,
      revoked_at: null,
    };
    _memoryTokens.set(tokenPublicId, record);
    return { ...record };
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_access_tokens")
    .insert([
      {
        client_id: clientId,
        token_public_id: tokenPublicId,
        secret_hash: secretHash,
        label: label || null,
        status: "active",
        expires_at: expiresAt || null,
      },
    ])
    .select()
    .single();

  if (error) throw new Error(error.message);
  return record;
}

/**
 * Finds an access token by its publicId, including client info.
 * @param {string} tokenPublicId
 * @returns {Promise<{
 *   id: string,
 *   client_id: string,
 *   token_public_id: string,
 *   secret_hash: string,
 *   label: string | null,
 *   status: string,
 *   created_at: string,
 *   expires_at: string | null,
 *   last_used_at: string | null,
 *   revoked_at: string | null,
 *   client?: { id: string, name: string, status: string }
 * } | null>}
 */
async function getTokenByPublicId(tokenPublicId) {
  if (isMemoryMode()) {
    const token = _memoryTokens.get(tokenPublicId);
    if (!token) return null;
    const client = _memoryClients.get(token.client_id);
    return {
      ...token,
      client: client ? { id: client.id, name: client.name, status: client.status } : null,
    };
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_access_tokens")
    .select(`
      id,
      client_id,
      token_public_id,
      secret_hash,
      label,
      status,
      created_at,
      expires_at,
      last_used_at,
      revoked_at,
      client:ghostai_clients(id, name, status)
    `)
    .eq("token_public_id", tokenPublicId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return record || null;
}

/**
 * Lists tokens, optionally filtered by clientId.
 * Excludes secret_hash from returned objects.
 * @param {string} [clientId]
 * @returns {Promise<Array<{
 *   id: string,
 *   clientId: string,
 *   clientName: string,
 *   label: string | null,
 *   status: string,
 *   createdAt: string,
 *   expiresAt: string | null,
 *   lastUsedAt: string | null,
 *   revokedAt: string | null
 * }>>}
 */
async function listTokens(clientId = null) {
  if (isMemoryMode()) {
    let tokens = Array.from(_memoryTokens.values());
    if (clientId) {
      tokens = tokens.filter((t) => t.client_id === clientId);
    }
    return tokens.map((t) => {
      const client = _memoryClients.get(t.client_id);
      return {
        id: t.id,
        clientId: t.client_id,
        clientName: client ? client.name : "Unknown",
        label: t.label,
        status: t.status,
        createdAt: t.created_at,
        expiresAt: t.expires_at,
        lastUsedAt: t.last_used_at,
        revokedAt: t.revoked_at,
      };
    });
  }

  const supabase = getSupabaseClient();
  let query = supabase
    .from("ghostai_access_tokens")
    .select(`
      id,
      client_id,
      label,
      status,
      created_at,
      expires_at,
      last_used_at,
      revoked_at,
      client:ghostai_clients(id, name)
    `)
    .order("created_at", { ascending: false });

  if (clientId) {
    query = query.eq("client_id", clientId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data || []).map((t) => ({
    id: t.id,
    clientId: t.client_id,
    clientName: t.client?.name || "Unknown",
    label: t.label,
    status: t.status,
    createdAt: t.created_at,
    expiresAt: t.expires_at,
    lastUsedAt: t.last_used_at,
    revokedAt: t.revoked_at,
  }));
}

/**
 * Revokes an access token by its primary key ID.
 * @param {string} tokenId
 * @returns {Promise<{ id: string, status: string, revoked_at: string } | null>}
 */
async function revokeToken(tokenId) {
  const now = new Date().toISOString();
  if (isMemoryMode()) {
    for (const record of _memoryTokens.values()) {
      if (record.id === tokenId) {
        record.status = "revoked";
        record.revoked_at = now;
        return { id: record.id, status: "revoked", revoked_at: now };
      }
    }
    return null;
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_access_tokens")
    .update({ status: "revoked", revoked_at: now })
    .eq("id", tokenId)
    .select("id, status, revoked_at")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return record || null;
}

/**
 * Updates last_used_at timestamp on token.
 * Non-blocking, fails gracefully.
 * @param {string} tokenId
 * @returns {Promise<void>}
 */
async function updateTokenLastUsed(tokenId) {
  const now = new Date().toISOString();
  try {
    if (isMemoryMode()) {
      for (const record of _memoryTokens.values()) {
        if (record.id === tokenId) {
          record.last_used_at = now;
          break;
        }
      }
      return;
    }

    const supabase = getSupabaseClient();
    await supabase
      .from("ghostai_access_tokens")
      .update({ last_used_at: now })
      .eq("id", tokenId);
  } catch (_) {
    // Non-blocking update
  }
}

module.exports = {
  createClient,
  getClientById,
  listClients,
  updateClientStatus,
  createTokenRecord,
  getTokenByPublicId,
  listTokens,
  revokeToken,
  updateTokenLastUsed,
  _resetMemoryStore,
  _setMemoryStoreEnabled,
};
