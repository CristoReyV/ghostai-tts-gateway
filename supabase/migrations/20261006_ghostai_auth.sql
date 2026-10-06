-- ─────────────────────────────────────────────────────────────
-- GhostAI TTS — Identity & Access Management Migration
-- Version: 20261006_ghostai_auth
-- Tables: ghostai_clients, ghostai_access_tokens
-- ─────────────────────────────────────────────────────────────

-- Enable pgcrypto extension for gen_random_uuid if not already present
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── 1. ghostai_clients ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ghostai_clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for searching clients by status
CREATE INDEX IF NOT EXISTS idx_ghostai_clients_status ON ghostai_clients(status);

-- ── 2. ghostai_access_tokens ─────────────────────────────────
CREATE TABLE IF NOT EXISTS ghostai_access_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES ghostai_clients(id) ON DELETE CASCADE,
    token_public_id TEXT NOT NULL UNIQUE,
    secret_hash TEXT NOT NULL,
    label TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

-- Indexes for token lookup and filtering
CREATE INDEX IF NOT EXISTS idx_ghostai_access_tokens_public_id ON ghostai_access_tokens(token_public_id);
CREATE INDEX IF NOT EXISTS idx_ghostai_access_tokens_client_id ON ghostai_access_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_ghostai_access_tokens_status ON ghostai_access_tokens(status);

-- ── 3. Row Level Security (RLS) ──────────────────────────────
-- Enable RLS to prevent public / anonymous access via Supabase PostgREST
ALTER TABLE ghostai_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE ghostai_access_tokens ENABLE ROW LEVEL SECURITY;

-- Intentionally NO public policies created.
-- Only the server-side service_role key (which bypasses RLS) can access these tables.
-- The browser / anon key CANNOT read, insert, update or delete any rows.
