BEGIN;
ALTER TABLE public.ghostai_members DROP CONSTRAINT ghostai_members_access_plan_check;
ALTER TABLE public.ghostai_members ADD CONSTRAINT ghostai_members_access_plan_check CHECK (access_plan IN ('monthly','annual','lifetime'));
ALTER TABLE public.ghostai_members ADD CONSTRAINT ghostai_members_lifetime_no_expiry_check CHECK (access_plan <> 'lifetime' OR expires_at IS NULL);
ALTER TABLE public.ghostai_billing_transactions DROP CONSTRAINT ghostai_billing_transactions_access_plan_check;
ALTER TABLE public.ghostai_billing_transactions ADD CONSTRAINT ghostai_billing_transactions_access_plan_check CHECK (access_plan IN ('monthly','annual','lifetime'));
COMMIT;
