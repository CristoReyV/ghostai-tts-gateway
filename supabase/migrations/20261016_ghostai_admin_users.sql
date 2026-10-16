-- ─────────────────────────────────────────────────────────────
-- GhostAI TTS — Multi-Admin Users, Activation & Audit Log Migration
-- Version: 20261016_ghostai_admin_users
-- Tables: ghostai_admin_users, ghostai_admin_activation_tokens, ghostai_admin_audit_logs
-- Extensions: ghostai_members (email tracking columns)
-- ─────────────────────────────────────────────────────────────

-- ── 1. ghostai_admin_users ───────────────────────────────────
CREATE TABLE IF NOT EXISTS ghostai_admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
    password_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invited_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    invited_by UUID REFERENCES ghostai_admin_users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ghostai_admin_users_email_lower ON ghostai_admin_users(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_ghostai_admin_users_role ON ghostai_admin_users(role);
CREATE INDEX IF NOT EXISTS idx_ghostai_admin_users_status ON ghostai_admin_users(status);

-- ── 2. ghostai_admin_activation_tokens ───────────────────────
CREATE TABLE IF NOT EXISTS ghostai_admin_activation_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID NOT NULL REFERENCES ghostai_admin_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    token_public_id TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ghostai_admin_activation_tokens_hash ON ghostai_admin_activation_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_ghostai_admin_activation_tokens_admin_id ON ghostai_admin_activation_tokens(admin_id);
CREATE INDEX IF NOT EXISTS idx_ghostai_admin_activation_tokens_status ON ghostai_admin_activation_tokens(status);

-- ── 3. ghostai_admin_audit_logs ──────────────────────────────
CREATE TABLE IF NOT EXISTS ghostai_admin_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES ghostai_admin_users(id) ON DELETE SET NULL,
    admin_email TEXT NOT NULL,
    admin_role TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ghostai_admin_audit_logs_admin_id ON ghostai_admin_audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_ghostai_admin_audit_logs_action ON ghostai_admin_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_ghostai_admin_audit_logs_created_at ON ghostai_admin_audit_logs(created_at DESC);

-- ── 4. Extend ghostai_members for email tracking ─────────────
ALTER TABLE ghostai_members ADD COLUMN IF NOT EXISTS last_email_sent_at TIMESTAMPTZ;
ALTER TABLE ghostai_members ADD COLUMN IF NOT EXISTS last_email_status TEXT DEFAULT 'not_sent';
ALTER TABLE ghostai_members ADD COLUMN IF NOT EXISTS last_email_sent_by UUID REFERENCES ghostai_admin_users(id) ON DELETE SET NULL;
ALTER TABLE ghostai_members ADD COLUMN IF NOT EXISTS last_email_error TEXT;

CREATE INDEX IF NOT EXISTS idx_ghostai_members_last_email_status ON ghostai_members(last_email_status);

-- ── 5. Row Level Security (RLS) ──────────────────────────────
ALTER TABLE ghostai_admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE ghostai_admin_activation_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE ghostai_admin_audit_logs ENABLE ROW LEVEL SECURITY;

-- Server-side service_role key only
