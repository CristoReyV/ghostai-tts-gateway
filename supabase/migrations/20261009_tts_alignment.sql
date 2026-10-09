-- ─────────────────────────────────────────────────────────────
-- GhostAI TTS — Captions 01A Migration
-- Version: 20261009_tts_alignment
-- Purpose: Add canonical NarrationAlignment JSONB column to tts_generation_items
-- ─────────────────────────────────────────────────────────────

ALTER TABLE tts_generation_items
ADD COLUMN IF NOT EXISTS alignment JSONB;
