/**
 * @file db.js
 * Database adapter for GhostAI Identity & Access Management and TTS Control Plane.
 * Uses Supabase PostgreSQL with service_role key server-side.
 * Includes an isolated in-memory engine for local offline testing.
 */

"use strict";

const crypto = require("crypto");
const { sanitizeOperationalError, sanitizeOperationalMetadata, sanitizeSourceManifest } = require("./errorCatalog");
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
let _memorySessions = new Map();
let _memoryItems = new Map(); // key: `${sessionId}:${narrationId}`
let _memoryEvents = [];

function _resetMemoryStore() {
  _memoryClients.clear();
  _memoryTokens.clear();
  _memorySessions.clear();
  _memoryItems.clear();
  _memoryEvents = [];
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
 * Lists all clients, enriched with token stats.
 * @returns {Promise<Array<{ id: string, name: string, email: string | null, status: string, created_at: string, activeTokensCount?: number, lastUsedAt?: string | null }>>}
 */
async function listClients() {
  if (isMemoryMode()) {
    const clients = Array.from(_memoryClients.values()).map((c) => {
      const clientTokens = Array.from(_memoryTokens.values()).filter((t) => t.client_id === c.id);
      const activeTokensCount = clientTokens.filter((t) => t.status === "active").length;
      let lastUsedAt = null;
      for (const t of clientTokens) {
        if (t.last_used_at && (!lastUsedAt || new Date(t.last_used_at) > new Date(lastUsedAt))) {
          lastUsedAt = t.last_used_at;
        }
      }
      return {
        ...c,
        activeTokensCount,
        lastUsedAt,
      };
    });
    return clients;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_clients")
    .select(`
      id, name, email, status, created_at, updated_at,
      tokens:ghostai_access_tokens(id, status, last_used_at)
    `)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data || []).map((c) => {
    const tokens = Array.isArray(c.tokens) ? c.tokens : [];
    const activeTokensCount = tokens.filter((t) => t.status === "active").length;
    let lastUsedAt = null;
    for (const t of tokens) {
      if (t.last_used_at && (!lastUsedAt || new Date(t.last_used_at) > new Date(lastUsedAt))) {
        lastUsedAt = t.last_used_at;
      }
    }
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      status: c.status,
      created_at: c.created_at,
      updated_at: c.updated_at,
      activeTokensCount,
      lastUsedAt,
    };
  });
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
 *   tokenPublicId: string,
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
        tokenPublicId: t.token_public_id,
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
      token_public_id,
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
    tokenPublicId: t.token_public_id,
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
    .update({ status, revoked_at: now })
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

// ── TTS Generation Sessions & Items ──────────────────────────────────

/**
 * Creates a new TTS generation session.
 * @param {{
 *   clientId: string,
 *   projectId?: string | null,
 *   projectTitle?: string | null,
 *   sourceManifest?: object | null,
 *   retentionHours?: number
 * }} data
 */
async function createGenerationSession({
  clientId,
  projectId = null,
  projectTitle = null,
  sourceManifest = null,
  retentionHours = 24,
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + retentionHours * 3600 * 1000).toISOString();
  const nowIso = now.toISOString();
  const safeManifest = sourceManifest ? sanitizeSourceManifest(sourceManifest) : null;

  if (isMemoryMode()) {
    const id = crypto.randomUUID();
    const session = {
      id,
      client_id: clientId,
      project_id: projectId || null,
      project_title: projectTitle || null,
      status: "generating",
      item_count: 0,
      ready_count: 0,
      error_count: 0,
      zip_status: "not_prepared",
      zip_verified_at: null,
      package_sha256: null,
      source_manifest: safeManifest,
      created_at: nowIso,
      updated_at: nowIso,
      expires_at: expiresAt,
    };
    _memorySessions.set(id, session);
    return { ...session };
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("tts_generation_sessions")
    .insert([
      {
        client_id: clientId,
        project_id: projectId || null,
        project_title: projectTitle || null,
        status: "generating",
        source_manifest: safeManifest,
        expires_at: expiresAt,
      },
    ])
    .select()
    .single();

  if (error) throw new Error(error.message);
  return record;
}

/**
 * Gets a generation session by ID.
 * @param {string} sessionId
 */
async function getGenerationSession(sessionId) {
  if (isMemoryMode()) {
    const session = _memorySessions.get(sessionId);
    return session ? { ...session } : null;
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("tts_generation_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return record || null;
}

/**
 * Lists non-deleted, non-expired sessions for a client.
 * @param {string} clientId
 */
async function listGenerationSessions(clientId) {
  const now = new Date().toISOString();
  if (isMemoryMode()) {
    return Array.from(_memorySessions.values())
      .filter((s) => s.client_id === clientId && s.status !== "deleted" && s.expires_at > now)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map((s) => ({ ...s }));
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("tts_generation_sessions")
    .select("*")
    .eq("client_id", clientId)
    .neq("status", "deleted")
    .gt("expires_at", now)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Updates a generation session.
 * @param {string} sessionId
 * @param {object} updates
 */
async function updateGenerationSession(sessionId, updates) {
  const payload = {
    ...updates,
    updated_at: new Date().toISOString(),
  };

  if (isMemoryMode()) {
    const session = _memorySessions.get(sessionId);
    if (!session) return null;
    Object.assign(session, payload);
    return { ...session };
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("tts_generation_sessions")
    .update(payload)
    .eq("id", sessionId)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return record || null;
}

/**
 * Deletes or marks a generation session as deleted.
 * @param {string} sessionId
 */
async function deleteGenerationSession(sessionId) {
  if (isMemoryMode()) {
    _memorySessions.delete(sessionId);
    for (const [key, item] of _memoryItems.entries()) {
      if (item.session_id === sessionId) {
        _memoryItems.delete(key);
      }
    }
    return true;
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("tts_generation_sessions")
    .delete()
    .eq("id", sessionId);

  if (error) throw new Error(error.message);
  return true;
}

/**
 * Upserts a generation item in a session.
 * @param {{
 *   sessionId: string,
 *   clientId: string,
 *   narrationId: string,
 *   sceneId?: string | null,
 *   sceneIndex?: number | null,
 *   status: string,
 *   storagePath?: string | null,
 *   mimeType?: string | null,
 *   sizeBytes?: number | null,
 *   sha256?: string | null,
 *   providerRequestId?: string | null,
 *   voiceId?: string | null,
 *   modelId?: string | null,
 *   outputFormat?: string | null,
 *   durationSeconds?: number | null,
 *   text?: string | null,
 *   errorCode?: string | null,
 *   errorStage?: string | null,
 *   expiresAt: string
 * }} data
 */
async function createOrUpdateGenerationItem(data) {
  const now = new Date().toISOString();
  const key = `${data.sessionId}:${data.narrationId}`;

  if (isMemoryMode()) {
    const existing = _memoryItems.get(key);
    const item = {
      id: existing ? existing.id : crypto.randomUUID(),
      session_id: data.sessionId,
      client_id: data.clientId,
      narration_id: data.narrationId,
      scene_id: data.sceneId || null,
      scene_index: typeof data.sceneIndex === "number" ? data.sceneIndex : null,
      status: data.status,
      storage_path: data.storagePath || null,
      mime_type: data.mimeType || "audio/mpeg",
      size_bytes: data.sizeBytes || null,
      sha256: data.sha256 || null,
      provider_request_id: data.providerRequestId || null,
      voice_id: data.voiceId || null,
      model_id: data.modelId || null,
      output_format: data.outputFormat || null,
      duration_seconds: data.durationSeconds || null,
      text: data.text || null,
      error_code: data.errorCode || null,
      error_stage: data.errorStage || null,
      created_at: existing ? existing.created_at : now,
      updated_at: now,
      expires_at: data.expiresAt,
    };
    _memoryItems.set(key, item);
    return { ...item };
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("tts_generation_items")
    .upsert(
      [
        {
          session_id: data.sessionId,
          client_id: data.clientId,
          narration_id: data.narrationId,
          scene_id: data.sceneId || null,
          scene_index: typeof data.sceneIndex === "number" ? data.sceneIndex : null,
          status: data.status,
          storage_path: data.storagePath || null,
          mime_type: data.mimeType || "audio/mpeg",
          size_bytes: data.sizeBytes || null,
          sha256: data.sha256 || null,
          provider_request_id: data.providerRequestId || null,
          voice_id: data.voiceId || null,
          model_id: data.modelId || null,
          output_format: data.outputFormat || null,
          duration_seconds: data.durationSeconds || null,
          text: data.text || null,
          error_code: data.errorCode || null,
          error_stage: data.errorStage || null,
          expires_at: data.expiresAt,
          updated_at: now,
        },
      ],
      { onConflict: "session_id,narration_id" }
    )
    .select()
    .single();

  if (error) throw new Error(error.message);
  return record;
}

/**
 * Lists items for a session.
 * @param {string} sessionId
 */
async function listGenerationItems(sessionId) {
  if (isMemoryMode()) {
    return Array.from(_memoryItems.values())
      .filter((i) => i.session_id === sessionId)
      .map((i) => ({ ...i }));
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("tts_generation_items")
    .select("*")
    .eq("session_id", sessionId)
    .order("scene_index", { ascending: true, nullsFirst: false });

  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Logs an operational event.
 * @param {{
 *   clientId?: string | null,
 *   sessionId?: string | null,
 *   narrationId?: string | null,
 *   requestId?: string | null,
 *   stage: string,
 *   eventType: string,
 *   errorCode?: string | null,
 *   messageSanitized?: string | null,
 *   metadata?: object | null
 * }} data
 */
async function logOperationEvent(data) {
  const record = {
    id: crypto.randomUUID(),
    client_id: data.clientId || null,
    session_id: data.sessionId || null,
    narration_id: data.narrationId || null,
    request_id: data.requestId || null,
    stage: data.stage,
    event_type: data.eventType,
    error_code: data.errorCode || null,
    message_sanitized: data.messageSanitized ? sanitizeOperationalError(data.messageSanitized) : null,
    metadata: data.metadata ? sanitizeOperationalMetadata(data.metadata) : null,
    created_at: new Date().toISOString(),
  };

  if (isMemoryMode()) {
    _memoryEvents.push(record);
    return record;
  }

  try {
    const supabase = getSupabaseClient();
    await supabase.from("tts_operation_events").insert([record]);
  } catch (_) {
    // Non-blocking logging
  }
  return record;
}

/**
 * Lists operation events (with optional filters).
 */
async function listOperationEvents(filter = {}) {
  if (isMemoryMode()) {
    let events = [..._memoryEvents];
    if (filter.clientId) events = events.filter((e) => e.client_id === filter.clientId);
    if (filter.sessionId) events = events.filter((e) => e.session_id === filter.sessionId);
    return events;
  }

  const supabase = getSupabaseClient();
  let query = supabase.from("tts_operation_events").select("*").order("created_at", { ascending: false });
  if (filter.clientId) query = query.eq("client_id", filter.clientId);
  if (filter.sessionId) query = query.eq("session_id", filter.sessionId);
  const { data } = await query.limit(100);
  return data || [];
}

/**
 * Admin view of TTS operations (metadata only, no audio blobs or tokens).
 */
async function listAdminTtsSessions() {
  if (isMemoryMode()) {
    return Array.from(_memorySessions.values())
      .map((s) => {
        const client = _memoryClients.get(s.client_id);
        return {
          id: s.id,
          clientId: s.client_id,
          clientName: client ? client.name : "Unknown",
          projectId: s.project_id,
          projectTitle: s.project_title || "Untitled Project",
          status: s.status,
          itemCount: s.item_count,
          readyCount: s.ready_count,
          errorCount: s.error_count,
          zipStatus: s.zip_status,
          createdAt: s.created_at,
          expiresAt: s.expires_at,
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("tts_generation_sessions")
    .select(`
      id,
      client_id,
      project_id,
      project_title,
      status,
      item_count,
      ready_count,
      error_count,
      zip_status,
      created_at,
      expires_at,
      client:ghostai_clients(name)
    `)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data || []).map((s) => ({
    id: s.id,
    clientId: s.client_id,
    clientName: s.client?.name || "Unknown",
    projectId: s.project_id,
    projectTitle: s.project_title || "Untitled Project",
    status: s.status,
    itemCount: s.item_count,
    readyCount: s.ready_count,
    errorCount: s.error_count,
    zipStatus: s.zip_status,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
  }));
}

/**
 * Finds sessions that have expired.
 */
async function getExpiredSessions() {
  const now = new Date().toISOString();
  if (isMemoryMode()) {
    return Array.from(_memorySessions.values()).filter(
      (s) => s.expires_at <= now && s.status !== "expired"
    );
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("tts_generation_sessions")
    .select("*")
    .lte("expires_at", now)
    .neq("status", "expired");

  if (error) throw new Error(error.message);
  return data || [];
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
  createGenerationSession,
  getGenerationSession,
  listGenerationSessions,
  updateGenerationSession,
  deleteGenerationSession,
  createOrUpdateGenerationItem,
  listGenerationItems,
  logOperationEvent,
  listOperationEvents,
  listAdminTtsSessions,
  getExpiredSessions,
  _resetMemoryStore,
  _setMemoryStoreEnabled,
  isMemoryMode,
};
