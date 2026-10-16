-- ─────────────────────────────────────────────────────────────
-- GhostAI TTS — Member Access & Activation Migration
-- Version: 20261016_ghostai_members
-- Tables: ghostai_members, ghostai_activation_tokens
-- ─────────────────────────────────────────────────────────────

-- ── 1. ghostai_members ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ghostai_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES ghostai_clients(id) ON DELETE CASCADE,
    key_id UUID REFERENCES ghostai_access_tokens(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    access_plan TEXT NOT NULL CHECK (access_plan IN ('monthly', 'annual')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'invited', 'active', 'expired', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invited_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

-- Indexes for members lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_ghostai_members_email_lower ON ghostai_members(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_ghostai_members_client_id ON ghostai_members(client_id);
CREATE INDEX IF NOT EXISTS idx_ghostai_members_key_id ON ghostai_members(key_id);
CREATE INDEX IF NOT EXISTS idx_ghostai_members_status ON ghostai_members(status);

-- ── 2. ghostai_activation_tokens ─────────────────────────────
CREATE TABLE IF NOT EXISTS ghostai_activation_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES ghostai_members(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    token_public_id TEXT,
    encrypted_key TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ghostai_activation_tokens_hash ON ghostai_activation_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_ghostai_activation_tokens_member_id ON ghostai_activation_tokens(member_id);
CREATE INDEX IF NOT EXISTS idx_ghostai_activation_tokens_status ON ghostai_activation_tokens(status);

-- ── 3. Row Level Security (RLS) ──────────────────────────────
ALTER TABLE ghostai_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE ghostai_activation_tokens ENABLE ROW LEVEL SECURITY;

-- Deny public / anonymous access directly.
-- Only the server-side service_role key can access these tables.
