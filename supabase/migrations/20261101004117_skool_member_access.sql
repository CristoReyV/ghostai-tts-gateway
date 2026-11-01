BEGIN;
ALTER TABLE public.ghostai_members DROP CONSTRAINT ghostai_members_access_plan_check;
ALTER TABLE public.ghostai_members ADD CONSTRAINT ghostai_members_access_plan_check CHECK (access_plan IN ('monthly','annual','lifetime','skool'));
ALTER TABLE public.ghostai_members
  ADD COLUMN skool_source_id text,
  ADD COLUMN skool_removed_at timestamptz,
  ADD COLUMN skool_expires_at timestamptz,
  ADD COLUMN skool_synced_at timestamptz;
ALTER TABLE public.ghostai_members ADD CONSTRAINT ghostai_members_skool_source_check
  CHECK (access_plan <> 'skool' OR (skool_source_id IS NOT NULL AND length(skool_source_id) > 0));
ALTER TABLE public.ghostai_billing_transactions DROP CONSTRAINT ghostai_billing_transactions_access_plan_check;
ALTER TABLE public.ghostai_billing_transactions ADD CONSTRAINT ghostai_billing_transactions_access_plan_check CHECK (access_plan IN ('monthly','annual','lifetime','skool'));
CREATE TABLE public.ghostai_skool_sync (
  source_id text PRIMARY KEY,
  synced_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.ghostai_skool_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ghostai_skool_sync FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ghostai_skool_sync TO service_role;
COMMIT;
