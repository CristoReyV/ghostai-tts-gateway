BEGIN;
ALTER TABLE public.ghostai_admin_users DROP CONSTRAINT IF EXISTS ghostai_admin_users_role_check;
ALTER TABLE public.ghostai_admin_users ADD CONSTRAINT ghostai_admin_users_role_check CHECK (role IN ('owner', 'admin', 'operator'));
ALTER TABLE public.ghostai_admin_users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE public.ghostai_admin_users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.ghostai_admin_users ADD CONSTRAINT ghostai_admin_users_email_required CHECK (role = 'operator' OR email IS NOT NULL);

CREATE TABLE public.ghostai_admin_keys (
  public_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  admin_user_id UUID NOT NULL REFERENCES public.ghostai_admin_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role = 'operator'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX ghostai_admin_keys_one_active ON public.ghostai_admin_keys(admin_user_id) WHERE status = 'active';
ALTER TABLE public.ghostai_admin_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ghostai_admin_keys FROM anon, authenticated;
GRANT ALL ON public.ghostai_admin_keys TO service_role;
ALTER TABLE public.ghostai_activation_tokens ADD COLUMN encrypted_invitation_token TEXT;
COMMIT;
