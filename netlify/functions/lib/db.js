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
let _memoryMembers = new Map(); // key: memberId
let _memoryActivationTokens = new Map(); // key: tokenHash
let _memoryAdminKeys = new Map();
let _memoryAdminUsers = new Map(); // key: adminId
let _memoryAdminActivationTokens = new Map(); // key: tokenHash
let _memoryAdminAuditLogs = [];

function _resetMemoryStore() {
  _memoryClients.clear();
  _memoryTokens.clear();
  _memorySessions.clear();
  _memoryItems.clear();
  _memoryEvents = [];
  _memoryMembers.clear();
  _memoryActivationTokens.clear();
  _memoryAdminUsers.clear();
  _memoryAdminKeys.clear();
  _memoryAdminActivationTokens.clear();
  _memoryAdminAuditLogs = [];
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

// ── Member Operations ───────────────────────────────────────────────

/**
 * Computes effective status for a member (e.g. checks expiration).
 */
function enrichMemberStatus(m) {
  if (!m) return null;
  if (isMemoryMode() && m.key_id) {
    const key = Array.from(_memoryTokens.values()).find(t => t.id === m.key_id);
    if (key) m.key = { id: key.id, token_public_id: key.token_public_id, label: key.label, created_at: key.created_at, status: key.status, expires_at: key.expires_at, last_used_at: key.last_used_at };
  }
  let status = m.status;
  if (status === "active" && m.expires_at) {
    if (new Date(m.expires_at).getTime() <= Date.now()) {
      status = "expired";
    }
  }
  return {
    ...m,
    status,
    computedStatus: status,
    tokenPublicId: m.tokenPublicId || m.key?.token_public_id || null,
    lastUsedAt: m.lastUsedAt || m.key?.last_used_at || null,
    operational: require("./memberOperations").getMemberOperationalState({ ...m, status }),
  };
}

/**
 * Creates a member record.
 * Status defaults to 'pending'.
 */
async function createMemberRecord({ clientId, keyId, name, email, accessPlan }) {
  const normalizedEmail = email.trim();
  const normalizedPlan = (accessPlan === "annual" || accessPlan === "Anual") ? "annual" : "monthly";
  const now = new Date().toISOString();

  if (isMemoryMode()) {
    // Check duplicate
    for (const m of _memoryMembers.values()) {
      if (m.email.toLowerCase() === normalizedEmail.toLowerCase()) {
        const err = new Error("Member with this email already exists");
        err.code = "MEMBER_ALREADY_EXISTS";
        throw err;
      }
    }
    const id = crypto.randomUUID();
    const record = {
      id,
      client_id: clientId,
      key_id: keyId || null,
      name: name.trim(),
      email: normalizedEmail,
      access_plan: normalizedPlan,
      status: "pending",
      created_at: now,
      invited_at: null,
      activated_at: null,
      expires_at: null,
      revoked_at: null,
    };
    _memoryMembers.set(id, record);
    return { ...record };
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_members")
    .insert([
      {
        client_id: clientId,
        key_id: keyId || null,
        name: name.trim(),
        email: normalizedEmail,
        access_plan: normalizedPlan,
        status: "pending",
      },
    ])
    .select()
    .single();

  if (error) {
    if (error.code === "23505" || error.message?.includes("unique")) {
      const err = new Error("Member with this email already exists");
      err.code = "MEMBER_ALREADY_EXISTS";
      throw err;
    }
    throw new Error(error.message);
  }
  return record;
}

/**
 * Gets a member by ID.
 */
async function getMemberById(memberId) {
  if (isMemoryMode()) {
    const m = _memoryMembers.get(memberId);
    if (!m) return null;
    return enrichMemberStatus({ ...m });
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_members")
    .select(`
      *,
      client:ghostai_clients(id, name, email, status),
      key:ghostai_access_tokens(id, token_public_id, label, created_at, status, expires_at, last_used_at)
    `)
    .eq("id", memberId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return record ? enrichMemberStatus(record) : null;
}

/**
 * Gets a member by email (case-insensitive).
 */
async function getMemberByEmail(email) {
  if (!email || typeof email !== "string") return null;
  const target = email.trim().toLowerCase();

  if (isMemoryMode()) {
    for (const m of _memoryMembers.values()) {
      if (m.email.toLowerCase() === target) {
        return enrichMemberStatus({ ...m });
      }
    }
    return null;
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_members")
    .select(`
      *,
      client:ghostai_clients(id, name, email, status),
      key:ghostai_access_tokens(id, token_public_id, label, created_at, status, expires_at, last_used_at)
    `)
    .ilike("email", target.replace(/([\\%_])/g, "\\$1"))
    .maybeSingle();

  if (error) throw new Error(error.message);
  return record ? enrichMemberStatus(record) : null;
}

/**
 * Gets a member by clientId.
 */
async function getMemberByClientId(clientId) {
  if (isMemoryMode()) {
    for (const m of _memoryMembers.values()) {
      if (m.client_id === clientId) {
        return enrichMemberStatus({ ...m });
      }
    }
    return null;
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_members")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return record ? enrichMemberStatus(record) : null;
}

/**
 * Lists all members with enriched token metadata.
 */
async function listMembers() {
  if (isMemoryMode()) {
    const list = Array.from(_memoryMembers.values()).map((m) => {
      const enriched = enrichMemberStatus({ ...m });
      let tokenPublicId = null;
      let lastUsedAt = null;
      if (m.key_id) {
        for (const t of _memoryTokens.values()) {
          if (t.id === m.key_id) {
            tokenPublicId = t.token_public_id;
            lastUsedAt = t.last_used_at;
            break;
          }
        }
      }
      return {
        ...enriched,
        tokenPublicId,
        lastUsedAt,
      };
    });
    return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_members")
    .select(`
      *,
      client:ghostai_clients(id, name, email, status),
      key:ghostai_access_tokens(id, token_public_id, label, created_at, status, expires_at, last_used_at)
    `)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data || []).map((m) => {
    const enriched = enrichMemberStatus(m);
    return {
      ...enriched,
      tokenPublicId: m.key?.token_public_id || null,
      lastUsedAt: m.key?.last_used_at || null,
    };
  });
}

/**
 * Updates a member.
 */
async function updateMember(memberId, updates) {
  if (isMemoryMode()) {
    const m = _memoryMembers.get(memberId);
    if (!m) return null;
    Object.assign(m, updates);
    return enrichMemberStatus({ ...m });
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_members")
    .update(updates)
    .eq("id", memberId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return record ? enrichMemberStatus(record) : null;
}

// A plan may change before activation; never restart or alter an access period.
async function updatePendingMemberPlan(memberId, expectedPlan, nextPlan) {
  if (!["monthly", "annual"].includes(nextPlan)) throw new Error("INVALID_PLAN");
  if (isMemoryMode()) {
    const member = _memoryMembers.get(memberId);
    if (!member || member.status !== "pending" || member.activated_at || member.expires_at || member.access_plan !== expectedPlan) return null;
    member.access_plan = nextPlan;
    return enrichMemberStatus({ ...member });
  }
  const { data, error } = await getSupabaseClient().from("ghostai_members")
    .update({ access_plan: nextPlan }).eq("id", memberId).eq("status", "pending")
    .eq("access_plan", expectedPlan).is("activated_at", null).is("expires_at", null).select().maybeSingle();
  if (error) throw new Error("PENDING_PLAN_UPDATE_FAILED");
  return data ? enrichMemberStatus(data) : null;
}

/**
 * Renews a member (+30 days if monthly, +365 days if annual).
 * If active: adds from current expires_at.
 * If expired / other: adds from now.
 */
async function renewMember(memberId, extension = null) {
  const member = await getMemberById(memberId);
  if (!member) {
    const err = new Error("Member not found");
    err.code = "MEMBER_NOT_FOUND";
    throw err;
  }

  const plan = extension || member.access_plan;
  const days = plan === "annual" ? 365 : 30;
  const durationMs = days * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let baseTime = now;
  if (member.status === "active" && member.expires_at) {
    const currentExp = new Date(member.expires_at).getTime();
    if (currentExp > now) {
      baseTime = currentExp;
    }
  }

  const newExpiresAt = new Date(baseTime + durationMs).toISOString();

  // Update member
  const updatedMember = await updateMember(memberId, {
    status: "active",
    expires_at: newExpiresAt,
    revoked_at: null,
    last_renewed_at: new Date(now).toISOString(),
  });

  // Update associated access token in ghostai_access_tokens
  if (member.key_id) {
    await updateTokenExpiresAt(member.key_id, newExpiresAt);
    await updateTokenStatus(member.key_id, "active");
  }

  // Reactivate client if was suspended
  if (member.client_id) {
    await updateClientStatus(member.client_id, "active");
  }

  return updatedMember;
}

/**
 * Revokes a member and all their access credentials immediately.
 */
async function revokeMember(memberId) {
  const member = await getMemberById(memberId);
  if (!member) {
    const err = new Error("Member not found");
    err.code = "MEMBER_NOT_FOUND";
    throw err;
  }

  const now = new Date().toISOString();

  // 1. Mark member revoked
  const updatedMember = await updateMember(memberId, {
    status: "revoked",
    revoked_at: now,
  });

  // 2. Revoke key in ghostai_access_tokens
  if (member.key_id) {
    await revokeToken(member.key_id);
  }

  // 3. Suspend client in ghostai_clients
  if (member.client_id) {
    await updateClientStatus(member.client_id, "suspended");
  }

  // 4. Revoke pending activation tokens
  await revokeActivationTokensForMember(memberId);

  return updatedMember;
}

// ── Activation Tokens Operations ────────────────────────────────────

/**
 * Creates an activation token record.
 */
async function createActivationTokenRecord({ memberId, tokenHash, tokenPublicId, encryptedKey = null, encryptedInvitationToken = null, expiresAt }) {
  const now = new Date().toISOString();
  if (isMemoryMode()) {
    const id = crypto.randomUUID();
    const record = {
      id,
      member_id: memberId,
      token_hash: tokenHash,
      token_public_id: tokenPublicId || null,
      encrypted_key: encryptedKey || null,
      encrypted_invitation_token: encryptedInvitationToken || null,
      status: "active",
      created_at: now,
      expires_at: expiresAt,
      consumed_at: null,
    };
    _memoryActivationTokens.set(tokenHash, record);
    return { ...record };
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_activation_tokens")
    .insert([
      {
        member_id: memberId,
        token_hash: tokenHash,
        token_public_id: tokenPublicId || null,
        encrypted_key: encryptedKey || null,
        encrypted_invitation_token: encryptedInvitationToken || null,
        status: "active",
        expires_at: expiresAt,
      },
    ])
    .select()
    .single();

  if (error) throw new Error(error.message);
  return record;
}

/**
 * Finds an activation token by its HMAC hash.
 */
async function getActivationTokenByHash(tokenHash) {
  if (isMemoryMode()) {
    const record = _memoryActivationTokens.get(tokenHash);
    if (!record) return null;
    const member = _memoryMembers.get(record.member_id);
    return {
      ...record,
      member: member ? enrichMemberStatus({ ...member }) : null,
    };
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_activation_tokens")
    .select(`
      *,
      member:ghostai_members(*)
    `)
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!record) return null;
  return {
    ...record,
    member: record.member ? enrichMemberStatus(record.member) : null,
  };
}

/**
 * Consumes an activation token atomically. Encrypted key remains for server-side delivery only.
 */
async function consumeActivationToken(tokenId) {
  const now = new Date().toISOString();
  if (isMemoryMode()) {
    for (const record of _memoryActivationTokens.values()) {
      if (record.id === tokenId && record.status === "active" && !record.consumed_at) {
        record.status = "consumed";
        record.consumed_at = now;
        record.encrypted_invitation_token = null;
        return { ...record };
      }
    }
    return null;
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_activation_tokens")
    .update({
      status: "consumed",
      consumed_at: now,
      encrypted_invitation_token: null,
    })
    .eq("id", tokenId)
    .eq("status", "active")
    .is("consumed_at", null)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  return record || null;
}

/**
 * Revokes all active activation tokens for a member.
 */
async function revokeActivationTokensForMember(memberId) {
  if (isMemoryMode()) {
    for (const record of _memoryActivationTokens.values()) {
      if (record.member_id === memberId && record.status === "active") {
        record.status = "revoked";
      }
    }
    return;
  }

  const supabase = getSupabaseClient();
  await supabase
    .from("ghostai_activation_tokens")
    .update({ status: "revoked" })
    .eq("member_id", memberId)
    .eq("status", "active");
}

/**
 * Retrieves the most recent activation token for a member that holds an escrowed key.
 */
async function getLatestActivationTokenForMember(memberId) {
  if (isMemoryMode()) {
    const list = Array.from(_memoryActivationTokens.values())
      .reverse() // Latest insertion wins when test timestamps share a millisecond.
      .filter((r) => r.member_id === memberId && r.encrypted_key)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return list[0] ? { ...list[0] } : null;
  }

  const supabase = getSupabaseClient();
  const { data: record, error } = await supabase
    .from("ghostai_activation_tokens")
    .select("*")
    .eq("member_id", memberId)
    .not("encrypted_key", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return record || null;
}

/**
 * Updates an activation token record (e.g. expiresAt or status).
 */
async function updateActivationTokenRecord(tokenId, updates = {}) {
  if (isMemoryMode()) {
    for (const record of _memoryActivationTokens.values()) {
      if (record.id === tokenId) {
        if (updates.expiresAt !== undefined) record.expires_at = updates.expiresAt;
        if (updates.status !== undefined) record.status = updates.status;
        return { ...record };
      }
    }
    return null;
  }

  const supabase = getSupabaseClient();
  const updateData = {};
  if (updates.expiresAt !== undefined) updateData.expires_at = updates.expiresAt;
  if (updates.status !== undefined) updateData.status = updates.status;

  const { data, error } = await supabase
    .from("ghostai_activation_tokens")
    .update(updateData)
    .eq("id", tokenId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * Updates token expiration timestamp in ghostai_access_tokens.
 */
async function updateTokenExpiresAt(tokenId, expiresAt) {
  if (isMemoryMode()) {
    for (const record of _memoryTokens.values()) {
      if (record.id === tokenId) {
        record.expires_at = expiresAt;
        return;
      }
    }
    return;
  }

  const supabase = getSupabaseClient();
  await supabase
    .from("ghostai_access_tokens")
    .update({ expires_at: expiresAt })
    .eq("id", tokenId);
}

/**
 * Updates token status in ghostai_access_tokens.
 */
async function updateTokenStatus(tokenId, status) {
  if (isMemoryMode()) {
    for (const record of _memoryTokens.values()) {
      if (record.id === tokenId) {
        record.status = status;
        if (status === "active") record.revoked_at = null;
        return;
      }
    }
    return;
  }

  const supabase = getSupabaseClient();
  await supabase
    .from("ghostai_access_tokens")
    .update({ status, revoked_at: status === "active" ? null : new Date().toISOString() })
    .eq("id", tokenId);
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
      alignment: data.alignment || null,
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
          alignment: data.alignment || null,
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
 * Updates the alignment JSONB field of a generation item.
 * @param {string} itemId
 * @param {object | null} alignment
 */
async function updateGenerationItemAlignment(itemId, alignment) {
  const now = new Date().toISOString();
  if (isMemoryMode()) {
    for (const [key, item] of _memoryItems.entries()) {
      if (item.id === itemId) {
        item.alignment = alignment;
        item.updated_at = now;
        return { ...item };
      }
    }
    return null;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("tts_generation_items")
    .update({ alignment, updated_at: now })
    .eq("id", itemId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * Gets a generation item by its ID.
 * @param {string} itemId
 */
async function getGenerationItemById(itemId) {
  if (isMemoryMode()) {
    for (const item of _memoryItems.values()) {
      if (item.id === itemId) return { ...item };
    }
    return null;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("tts_generation_items")
    .select("*")
    .eq("id", itemId)
    .single();

  if (error) return null;
  return data;
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

// ── Admin Users Operations ──────────────────────────────────────────

/**
 * Creates an admin user record.
 */
async function createAdminUserRecord({ name, email, role = "admin", status = "pending", passwordHash = null, invitedBy = null }) {
  const normalizedEmail = email ? email.toLowerCase().trim() : null;
  const now = new Date().toISOString();
  if (isMemoryMode()) {
    const id = crypto.randomUUID();
    const record = {
      id,
      name: name.trim(),
      email: normalizedEmail,
      role: ["owner", "admin", "operator"].includes(role) ? role : "admin",
      status,
      password_hash: passwordHash,
      created_at: now,
      invited_at: status === "pending" ? now : null,
      activated_at: status === "active" ? now : null,
      last_login_at: null,
      invited_by: invitedBy || null,
    };
    _memoryAdminUsers.set(id, record);
    return { ...record };
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_admin_users")
    .insert([
      {
        name: name.trim(),
        email: normalizedEmail,
        role: ["owner", "admin", "operator"].includes(role) ? role : "admin",
        status,
        password_hash: passwordHash,
        invited_at: status === "pending" ? now : null,
        activated_at: status === "active" ? now : null,
        invited_by: invitedBy || null,
      },
    ])
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * Retrieves an admin user by ID.
 */
async function getAdminUserById(id) {
  if (isMemoryMode()) {
    const user = _memoryAdminUsers.get(id);
    return user ? { ...user } : null;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_admin_users")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Retrieves an admin user by email (case-insensitive).
 */
async function getAdminUserByEmail(email) {
  const normalized = email.toLowerCase().trim();
  if (isMemoryMode()) {
    for (const user of _memoryAdminUsers.values()) {
      if (user.email?.toLowerCase() === normalized) {
        return { ...user };
      }
    }
    return null;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_admin_users")
    .select("*")
    .ilike("email", normalized)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Lists all admin users.
 */
async function listAdminUsers() {
  if (isMemoryMode()) {
    const list = Array.from(_memoryAdminUsers.values()).map((u) => {
      const copy = { ...u };
      delete copy.password_hash;
      return copy;
    });
    return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_admin_users")
    .select("id, name, email, role, status, created_at, invited_at, activated_at, last_login_at, invited_by")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Updates an admin user.
 */
async function updateAdminUser(id, updates) {
  if (isMemoryMode()) {
    const user = _memoryAdminUsers.get(id);
    if (!user) return null;
    Object.assign(user, updates);
    const copy = { ...user };
    delete copy.password_hash;
    return copy;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_admin_users")
    .update(updates)
    .eq("id", id)
    .select("id, name, email, role, status, created_at, invited_at, activated_at, last_login_at, invited_by")
    .single();

  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Counts active owners.
 */
async function countActiveOwners() {
  if (isMemoryMode()) {
    let count = 0;
    for (const u of _memoryAdminUsers.values()) {
      if (u.role === "owner" && u.status === "active") count++;
    }
    return count;
  }

  const supabase = getSupabaseClient();
  const { count, error } = await supabase
    .from("ghostai_admin_users")
    .select("*", { count: "exact", head: true })
    .eq("role", "owner")
    .eq("status", "active");

  if (error) throw new Error(error.message);
  return count || 0;
}

// ── Admin Activation Tokens ──────────────────────────────────────────

/**
 * Creates an admin activation token record.
 */
async function createAdminActivationTokenRecord({ adminId, tokenHash, tokenPublicId, expiresAt }) {
  const now = new Date().toISOString();
  if (isMemoryMode()) {
    const id = crypto.randomUUID();
    const record = {
      id,
      admin_id: adminId,
      token_hash: tokenHash,
      token_public_id: tokenPublicId,
      status: "active",
      created_at: now,
      expires_at: expiresAt,
      consumed_at: null,
    };
    _memoryAdminActivationTokens.set(tokenHash, record);
    return { ...record };
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_admin_activation_tokens")
    .insert([
      {
        admin_id: adminId,
        token_hash: tokenHash,
        token_public_id: tokenPublicId,
        status: "active",
        expires_at: expiresAt,
      },
    ])
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * Finds an admin activation token by its HMAC hash.
 */
async function getAdminActivationTokenByHash(tokenHash) {
  if (isMemoryMode()) {
    const record = _memoryAdminActivationTokens.get(tokenHash);
    if (!record) return null;
    const admin = _memoryAdminUsers.get(record.admin_id);
    return {
      ...record,
      admin: admin ? { ...admin } : null,
    };
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_admin_activation_tokens")
    .select(`
      *,
      admin:ghostai_admin_users(*)
    `)
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Consumes an admin activation token.
 */
async function consumeAdminActivationToken(tokenId) {
  const now = new Date().toISOString();
  if (isMemoryMode()) {
    for (const record of _memoryAdminActivationTokens.values()) {
      if (record.id === tokenId) {
        record.status = "consumed";
        record.consumed_at = now;
        return { ...record };
      }
    }
    return null;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_admin_activation_tokens")
    .update({
      status: "consumed",
      consumed_at: now,
    })
    .eq("id", tokenId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data || null;
}

// ── Admin Audit Logs ─────────────────────────────────────────────────

/**
 * Logs an administrative audit event.
 * Never logs secrets, passwords, or tokens.
 */
async function logAdminAuditEvent({ adminId, adminEmail, adminRole, action, targetId = null, metadata = {} }) {
  const now = new Date().toISOString();
  const cleanMeta = sanitizeOperationalMetadata(metadata);
  const record = {
    id: crypto.randomUUID(),
    admin_id: adminId || null,
    admin_email: adminEmail || "system",
    admin_role: adminRole || "owner",
    action,
    target_id: targetId ? String(targetId) : null,
    metadata: cleanMeta,
    created_at: now,
  };

  if (isMemoryMode()) {
    _memoryAdminAuditLogs.push(record);
    return record;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_admin_audit_logs")
    .insert([
      {
        admin_id: adminId || null,
        admin_email: adminEmail || "system",
        admin_role: adminRole || "owner",
        action,
        target_id: targetId ? String(targetId) : null,
        metadata: cleanMeta,
      },
    ])
    .select()
    .single();

  if (error) {
    console.warn("Failed to insert admin audit log:", error.message);
    return record;
  }
  return data;
}

/**
 * Lists administrative audit logs.
 */
async function listAdminAuditLogs(limit = 100, offset = 0) {
  if (isMemoryMode()) {
    return [..._memoryAdminAuditLogs]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(offset, offset + limit);
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ghostai_admin_audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Updates member email dispatch status.
 */
async function updateMemberEmailStatus(memberId, { status, sentAt = null, sentBy = null, error = null }) {
  const updates = {
    last_email_status: status,
    last_email_sent_at: sentAt || new Date().toISOString(),
    last_email_sent_by: sentBy || null,
    last_email_error: error || null,
  };

  if (isMemoryMode()) {
    const m = _memoryMembers.get(memberId);
    if (!m) return null;
    Object.assign(m, updates);
    return { ...m };
  }

  const supabase = getSupabaseClient();
  const { data, error: sbErr } = await supabase
    .from("ghostai_members")
    .update(updates)
    .eq("id", memberId)
    .select()
    .single();

  if (sbErr) throw new Error(sbErr.message);
  return data;
}

// Compare-and-set plus audit is atomic: a stale preview cannot mark a replacement key.
async function markMemberEmail({ memberId, keyId, sent, expectedSentAt, emailType, admin }) {
  let now = new Date().toISOString();
  const actorId = ["system_owner", "00000000-0000-0000-0000-000000000000"].includes(admin.id) ? null : admin.id;
  if (!isMemoryMode()) {
    const { data, error } = await getSupabaseClient().rpc("ghostai_mark_member_email", {
      p_member_id: memberId, p_key_id: keyId, p_sent: sent, p_expected_sent_at: expectedSentAt,
      p_admin_id: actorId, p_admin_name: admin.name, p_admin_role: admin.role, p_admin_email: admin.email,
      p_email_type: emailType, p_now: now,
    });
    if (error) throw new Error("EMAIL_TRACKING_FAILED");
    return data;
  }
  const member = _memoryMembers.get(memberId);
  if (!member || member.key_id !== keyId) return { conflict: "KEY_CHANGED" };
  const currentTime = member.last_email_sent_at ? Date.parse(member.last_email_sent_at) : null;
  const expectedTime = expectedSentAt ? Date.parse(expectedSentAt) : null;
  if (currentTime !== expectedTime) return sent && member.last_email_status === "sent" ? { changed: false } : { conflict: "EMAIL_CHANGED" };
  if (!sent && (!member.last_email_status || member.last_email_status === "not_sent")) return { changed: false };
  if (sent && currentTime !== null && Date.parse(now) <= currentTime) now = new Date(currentTime + 1).toISOString();
  const previousSentAt = member.last_email_sent_at || null;
  Object.assign(member, {
    last_email_status: sent ? "sent" : "not_sent", last_email_sent_at: sent ? now : null,
    last_email_sent_by: sent ? actorId : null, last_email_sent_by_name: sent ? admin.name : null,
    last_email_sent_by_role: sent ? admin.role : null, last_email_type: sent ? emailType : null,
    last_email_key_id: sent ? keyId : null, last_email_error: null,
  });
  await logAdminAuditEvent({ adminId: actorId, adminEmail: admin.email, adminRole: admin.role,
    action: sent ? "email_marked_sent" : "email_marked_unsent", targetId: memberId,
    metadata: { memberId, adminId: actorId, emailType, timestamp: now, previousSentAt, manual: true } });
  return { changed: true };
}

async function createAdminKey(record) {
  if (isMemoryMode()) { _memoryAdminKeys.set(record.public_id, { ...record }); return { ...record }; }
  const { data, error } = await getSupabaseClient().from("ghostai_admin_keys").insert(record).select().single();
  if (error) throw new Error("ADMIN_KEY_STORAGE_FAILED");
  return data;
}

async function getAdminKey(publicId) {
  if (isMemoryMode()) return _memoryAdminKeys.has(publicId) ? { ..._memoryAdminKeys.get(publicId) } : null;
  const { data, error } = await getSupabaseClient().from("ghostai_admin_keys").select("*").eq("public_id", publicId).maybeSingle();
  if (error) throw new Error("ADMIN_KEY_STORAGE_FAILED");
  return data;
}

async function updateAdminKey(publicId, updates) {
  if (isMemoryMode()) { Object.assign(_memoryAdminKeys.get(publicId), updates); return; }
  const { error } = await getSupabaseClient().from("ghostai_admin_keys").update(updates).eq("public_id", publicId);
  if (error) throw new Error("ADMIN_KEY_STORAGE_FAILED");
}

async function revokeAdminKeys(adminId) {
  if (isMemoryMode()) {
    for (const key of _memoryAdminKeys.values()) if (key.admin_user_id === adminId) key.status = "revoked";
    return;
  }
  const { error } = await getSupabaseClient().from("ghostai_admin_keys").update({ status: "revoked" }).eq("admin_user_id", adminId).eq("status", "active");
  if (error) throw new Error("ADMIN_KEY_STORAGE_FAILED");
}

module.exports = {
  isMemoryMode, getSupabaseClient,
  markMemberEmail,
  createAdminKey, getAdminKey, updateAdminKey, revokeAdminKeys,
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
  updateGenerationItemAlignment,
  getGenerationItemById,
  logOperationEvent,
  listOperationEvents,
  listAdminTtsSessions,
  getExpiredSessions,
  createMemberRecord,
  getMemberById,
  getMemberByEmail,
  getMemberByClientId,
  listMembers,
  updateMember,
  updatePendingMemberPlan,
  renewMember,
  revokeMember,
  createActivationTokenRecord,
  getActivationTokenByHash,
  consumeActivationToken,
  revokeActivationTokensForMember,
  getLatestActivationTokenForMember,
  updateActivationTokenRecord,
  updateTokenExpiresAt,
  updateTokenStatus,
  createAdminUserRecord,
  getAdminUserById,
  getAdminUserByEmail,
  listAdminUsers,
  updateAdminUser,
  countActiveOwners,
  createAdminActivationTokenRecord,
  getAdminActivationTokenByHash,
  consumeAdminActivationToken,
  logAdminAuditEvent,
  listAdminAuditLogs,
  updateMemberEmailStatus,
  _resetMemoryStore,
  _setMemoryStoreEnabled,
  isMemoryMode,
};
