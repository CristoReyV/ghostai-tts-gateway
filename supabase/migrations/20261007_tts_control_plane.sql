-- ─────────────────────────────────────────────────────────────
-- GhostAI TTS — Control Plane 01 Migration
-- Version: 20261007_tts_control_plane
-- Tables: tts_generation_sessions, tts_generation_items, tts_operation_events
-- ─────────────────────────────────────────────────────────────

-- ── 1. tts_generation_sessions ──────────────────────────────
CREATE TABLE IF NOT EXISTS tts_generation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES ghostai_clients(id) ON DELETE CASCADE,
    project_id TEXT,
    project_title TEXT,
    status TEXT NOT NULL CHECK (status IN ('generating', 'partial', 'ready', 'error', 'expired', 'deleted')),
    item_count INTEGER NOT NULL DEFAULT 0,
    ready_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    zip_status TEXT NOT NULL DEFAULT 'not_prepared' CHECK (zip_status IN ('not_prepared', 'prepared', 'download_triggered', 'verification_pending', 'verified', 'failed')),
    zip_verified_at TIMESTAMPTZ,
    package_sha256 TEXT,
    source_manifest JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tts_gen_sessions_client_id ON tts_generation_sessions(client_id);
CREATE INDEX IF NOT EXISTS idx_tts_gen_sessions_created_at ON tts_generation_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_tts_gen_sessions_expires_at ON tts_generation_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_tts_gen_sessions_status ON tts_generation_sessions(status);

-- ── 2. tts_generation_items ─────────────────────────────────
CREATE TABLE IF NOT EXISTS tts_generation_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES tts_generation_sessions(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES ghostai_clients(id) ON DELETE CASCADE,
    narration_id TEXT NOT NULL,
    scene_id TEXT,
    scene_index INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending', 'generating', 'ready', 'error', 'expired')),
    storage_path TEXT,
    mime_type TEXT,
    size_bytes BIGINT,
    sha256 TEXT,
    provider_request_id TEXT,
    voice_id TEXT,
    model_id TEXT,
    output_format TEXT,
    duration_seconds NUMERIC,
    text TEXT,
    error_code TEXT,
    error_stage TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_tts_generation_items_session_narration UNIQUE (session_id, narration_id)
);

CREATE INDEX IF NOT EXISTS idx_tts_gen_items_session_id ON tts_generation_items(session_id);
CREATE INDEX IF NOT EXISTS idx_tts_gen_items_client_id ON tts_generation_items(client_id);
CREATE INDEX IF NOT EXISTS idx_tts_gen_items_expires_at ON tts_generation_items(expires_at);
CREATE INDEX IF NOT EXISTS idx_tts_gen_items_status ON tts_generation_items(status);

-- ── 3. tts_operation_events ─────────────────────────────────
CREATE TABLE IF NOT EXISTS tts_operation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES ghostai_clients(id) ON DELETE SET NULL,
    session_id UUID REFERENCES tts_generation_sessions(id) ON DELETE SET NULL,
    narration_id TEXT,
    request_id TEXT,
    stage TEXT NOT NULL,
    event_type TEXT NOT NULL,
    error_code TEXT,
    message_sanitized TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tts_op_events_client_id ON tts_operation_events(client_id);
CREATE INDEX IF NOT EXISTS idx_tts_op_events_session_id ON tts_operation_events(session_id);
CREATE INDEX IF NOT EXISTS idx_tts_op_events_created_at ON tts_operation_events(created_at);
CREATE INDEX IF NOT EXISTS idx_tts_op_events_error_code ON tts_operation_events(error_code);

-- ── 4. Row Level Security (RLS) ──────────────────────────────
ALTER TABLE tts_generation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tts_generation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tts_operation_events ENABLE ROW LEVEL SECURITY;

-- Deny public / anonymous access directly.
-- Only the gateway service_role key server-side accesses these tables.
