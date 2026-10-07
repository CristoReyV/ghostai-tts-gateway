-- ─────────────────────────────────────────────────────────────
-- GhostAI TTS — Storage Bucket Configuration
-- Bucket: tts-generations (PRIVATE)
-- Purpose: Temporary Recovery Vault for MP3 generations
-- Structure: <clientId>/<generationSessionId>/<narrationId>.mp3
-- ─────────────────────────────────────────────────────────────

-- 1. Create the private bucket if it does not already exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'tts-generations',
    'tts-generations',
    false, -- STRICTLY PRIVATE. No permanent public URLs.
    52428800, -- 50MB per file limit
    ARRAY['audio/mpeg', 'audio/mp3']
)
ON CONFLICT (id) DO UPDATE SET
    public = false,
    file_size_limit = 52428800,
    allowed_mime_types = ARRAY['audio/mpeg', 'audio/mp3'];

-- 2. Storage Policies:
-- Disallow public anonymous access completely.
-- Gateway connects using SUPABASE_SERVICE_ROLE_KEY which bypasses RLS policies.
