-- Additive tracking only. Existing member/key/period data is not backfilled.
ALTER TABLE public.ghostai_members
  ADD COLUMN IF NOT EXISTS last_email_type text CHECK (last_email_type IN ('NEW_ACCESS','ACCESS_REPLACEMENT','RESEND','RENEWAL')),
  ADD COLUMN IF NOT EXISTS last_email_key_id uuid REFERENCES public.ghostai_access_tokens(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_email_sent_by_name text,
  ADD COLUMN IF NOT EXISTS last_email_sent_by_role text CHECK (last_email_sent_by_role IN ('owner','operator','admin')),
  ADD COLUMN IF NOT EXISTS last_renewed_at timestamptz;

-- INVOKER: service_role only, with existing RLS/permissions left intact.
CREATE OR REPLACE FUNCTION public.ghostai_mark_member_email(
  p_member_id uuid, p_key_id uuid, p_sent boolean, p_expected_sent_at timestamptz,
  p_admin_id uuid, p_admin_name text, p_admin_role text, p_admin_email text,
  p_email_type text, p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE m public.ghostai_members%ROWTYPE; previous_sent_at timestamptz;
BEGIN
  IF p_admin_role NOT IN ('owner','operator','admin') OR p_email_type NOT IN ('NEW_ACCESS','ACCESS_REPLACEMENT','RESEND','RENEWAL') THEN
    RAISE EXCEPTION 'INVALID_EMAIL_TRACKING_CONTEXT';
  END IF;
  SELECT * INTO m FROM public.ghostai_members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND OR m.key_id IS DISTINCT FROM p_key_id THEN RETURN jsonb_build_object('conflict','KEY_CHANGED'); END IF;
  IF p_sent AND (m.status NOT IN ('pending','invited','active') OR m.revoked_at IS NOT NULL OR m.expires_at <= p_now) THEN
    RETURN jsonb_build_object('conflict','MEMBER_NOT_DELIVERABLE');
  END IF;
  IF m.last_email_sent_at IS DISTINCT FROM p_expected_sent_at THEN
    IF p_sent AND m.last_email_status = 'sent' THEN RETURN jsonb_build_object('changed',false); END IF;
    RETURN jsonb_build_object('conflict','EMAIL_CHANGED');
  END IF;
  IF NOT p_sent AND m.last_email_status = 'not_sent' THEN RETURN jsonb_build_object('changed',false); END IF;
  previous_sent_at := m.last_email_sent_at;
  IF p_sent AND p_now <= m.last_email_sent_at THEN p_now := m.last_email_sent_at + interval '1 millisecond'; END IF;
  UPDATE public.ghostai_members SET
    last_email_status = CASE WHEN p_sent THEN 'sent' ELSE 'not_sent' END,
    last_email_sent_at = CASE WHEN p_sent THEN p_now END,
    last_email_sent_by = CASE WHEN p_sent THEN p_admin_id END,
    last_email_sent_by_name = CASE WHEN p_sent THEN p_admin_name END,
    last_email_sent_by_role = CASE WHEN p_sent THEN p_admin_role END,
    last_email_type = CASE WHEN p_sent THEN p_email_type END,
    last_email_key_id = CASE WHEN p_sent THEN p_key_id END,
    last_email_error = NULL
  WHERE id = p_member_id;
  INSERT INTO public.ghostai_admin_audit_logs(admin_id,admin_email,admin_role,action,target_id,metadata)
  VALUES (p_admin_id,COALESCE(NULLIF(p_admin_email,''),'system'),p_admin_role,CASE WHEN p_sent THEN 'email_marked_sent' ELSE 'email_marked_unsent' END,p_member_id::text,
    jsonb_build_object('memberId',p_member_id,'adminId',p_admin_id,'emailType',p_email_type,'timestamp',p_now,'previousSentAt',previous_sent_at,'manual',true));
  RETURN jsonb_build_object('changed',true);
END $$;
REVOKE ALL ON FUNCTION public.ghostai_mark_member_email(uuid,uuid,boolean,timestamptz,uuid,text,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ghostai_mark_member_email(uuid,uuid,boolean,timestamptz,uuid,text,text,text,text,timestamptz) TO service_role;
NOTIFY pgrst, 'reload schema';
