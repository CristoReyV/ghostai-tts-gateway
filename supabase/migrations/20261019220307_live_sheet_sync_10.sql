BEGIN;
-- Serialize OWNER sheet syncs across serverless instances. No public access.
CREATE TABLE public.ghostai_sheet_sync_leases (
  source_id text PRIMARY KEY,
  lease_token uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.ghostai_sheet_sync_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ghostai_sheet_sync_leases FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.ghostai_sheet_sync_leases TO service_role;
CREATE FUNCTION public.ghostai_sheet_sync_lease(p_source_id text,p_token uuid,p_mode text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF length(p_source_id) NOT BETWEEN 1 AND 200 OR p_token IS NULL THEN RAISE EXCEPTION 'INVALID_LEASE'; END IF;
  IF p_mode='acquire' THEN
    INSERT INTO public.ghostai_sheet_sync_leases(source_id,lease_token,expires_at)
    VALUES(p_source_id,p_token,now()+interval '120 seconds')
    ON CONFLICT(source_id) DO UPDATE SET lease_token=excluded.lease_token,expires_at=excluded.expires_at
    WHERE ghostai_sheet_sync_leases.expires_at<=now() OR ghostai_sheet_sync_leases.lease_token=p_token;
    RETURN FOUND;
  ELSIF p_mode='renew' THEN
    UPDATE public.ghostai_sheet_sync_leases SET expires_at=now()+interval '120 seconds'
    WHERE source_id=p_source_id AND lease_token=p_token AND expires_at>now();
    RETURN FOUND;
  ELSIF p_mode='release' THEN
    DELETE FROM public.ghostai_sheet_sync_leases WHERE source_id=p_source_id AND lease_token=p_token;
    RETURN FOUND;
  END IF;
  RAISE EXCEPTION 'INVALID_LEASE_MODE';
END;
$$;
REVOKE ALL ON FUNCTION public.ghostai_sheet_sync_lease(text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ghostai_sheet_sync_lease(text,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.ghostai_billing_write(p_action text,p_payload jsonb,p_actor jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE
  r jsonb; profile public.ghostai_member_billing%ROWTYPE;
  g public.ghostai_revenue_goals%ROWTYPE; t public.ghostai_billing_transactions%ROWTYPE;
  aid uuid; mid uuid; ekey text; created_count integer:=0; updated_count integer:=0;
  event_name text; event_meta jsonb; previous_amount bigint; previous_currency text;
BEGIN
  IF p_actor->>'role' IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  aid:=(p_actor->>'id')::uuid;
  PERFORM pg_advisory_xact_lock(hashtext('ghostai_billing_09'));
  IF p_action='sync' THEN
    IF jsonb_array_length(p_payload->'records') NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'INVALID_SYNC'; END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(p_payload->'records') LOOP
      mid:=(r->>'member_id')::uuid;
      SELECT * INTO profile FROM public.ghostai_member_billing WHERE member_id=mid;
      IF coalesce((p_payload->>'confirmedPreview')::boolean,false) AND coalesce(profile.revision,0) IS DISTINCT FROM (r->>'expectedProfileRevision')::integer THEN RAISE EXCEPTION 'BILLING_CONFLICT'; END IF;
      IF profile.member_id IS NULL OR profile.source_hash IS DISTINCT FROM r->>'source_hash' OR (coalesce((p_payload->>'applyCurrentValues')::boolean,false) AND (profile.amount_minor IS DISTINCT FROM (r->>'amount_minor')::bigint OR profile.currency IS DISTINCT FROM r->>'currency')) THEN
        IF profile.member_id IS NOT NULL THEN
          INSERT INTO public.ghostai_admin_audit_logs(admin_id,admin_email,admin_role,action,target_id,metadata)
          VALUES(aid,p_actor->>'email','owner','billing_amount_corrected',mid::text,jsonb_build_object('source','GOOGLE_SHEET','previousAmount',profile.amount_minor,'amount',(r->>'amount_minor')::bigint));
        END IF;
        INSERT INTO public.ghostai_member_billing(member_id,amount_minor,currency,source,source_hash,revision)
        VALUES(mid,(r->>'amount_minor')::bigint,r->>'currency','GOOGLE_SHEET',r->>'source_hash',1)
        ON CONFLICT(member_id) DO UPDATE SET amount_minor=excluded.amount_minor,currency=excluded.currency,source=excluded.source,source_hash=excluded.source_hash,revision=ghostai_member_billing.revision+1,updated_at=now();
        updated_count:=updated_count+1;
      END IF;
      IF NOT EXISTS(SELECT 1 FROM public.ghostai_billing_transactions WHERE entry_key=r->>'source_key') THEN
        INSERT INTO public.ghostai_billing_transactions(member_id,entry_key,revision,type,access_plan,amount_minor,currency,status,paid_at,billing_period,source,reason,created_by)
        VALUES(mid,r->>'source_key',1,'NEW_ACCESS',r->>'access_plan',(r->>'amount_minor')::bigint,r->>'currency',r->>'status',(r->>'paid_at')::date,r->>'billing_period','GOOGLE_SHEET','Importación de hoja actual',aid);
        created_count:=created_count+1;
      END IF;
    END LOOP;
    INSERT INTO public.ghostai_billing_sync(id,metadata) VALUES(p_payload->'metadata'->>'sourceId',p_payload->'metadata')
    ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,synced_at=now();
    event_name:='billing_sheet_synced';event_meta:=jsonb_build_object('created',created_count,'updated',updated_count,'matched',jsonb_array_length(p_payload->'records'));
  ELSIF p_action='goal' THEN
    SELECT * INTO g FROM public.ghostai_revenue_goals WHERE month=p_payload->>'month' AND currency=p_payload->>'currency';
    IF coalesce(g.revision,0) IS DISTINCT FROM (p_payload->>'expectedRevision')::integer THEN RAISE EXCEPTION 'BILLING_CONFLICT'; END IF;
    event_name:=CASE WHEN g.month IS NULL THEN 'revenue_goal_created' ELSE 'revenue_goal_updated' END;
    INSERT INTO public.ghostai_revenue_goals(month,currency,target_minor,revision) VALUES(p_payload->>'month',p_payload->>'currency',(p_payload->>'targetMinor')::bigint,1)
    ON CONFLICT(month,currency) DO UPDATE SET target_minor=excluded.target_minor,revision=ghostai_revenue_goals.revision+1,updated_at=now();
    event_meta:=jsonb_build_object('month',p_payload->>'month','currency',p_payload->>'currency','amount',p_payload->'targetMinor');
  ELSIF p_action='price' THEN
    mid:=(p_payload->>'memberId')::uuid;
    SELECT * INTO profile FROM public.ghostai_member_billing WHERE member_id=mid;
    IF coalesce(profile.revision,0) IS DISTINCT FROM (p_payload->>'expectedRevision')::integer THEN RAISE EXCEPTION 'BILLING_CONFLICT'; END IF;
    INSERT INTO public.ghostai_member_billing(member_id,amount_minor,currency,source,revision) VALUES(mid,(p_payload->>'amountMinor')::bigint,p_payload->>'currency','OWNER',1)
    ON CONFLICT(member_id) DO UPDATE SET amount_minor=excluded.amount_minor,currency=excluded.currency,source='OWNER',revision=ghostai_member_billing.revision+1,updated_at=now();
    event_name:='billing_amount_corrected';event_meta:=jsonb_build_object('amount',p_payload->'amountMinor','currency',p_payload->>'currency','reason',p_payload->>'reason');
  ELSIF p_action='payment' THEN
    mid:=(p_payload->>'memberId')::uuid;
    IF p_payload->>'entryId' IS NOT NULL THEN
      SELECT entry_key INTO ekey FROM public.ghostai_billing_transactions WHERE id=(p_payload->>'entryId')::uuid AND member_id=mid;
      IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_CONFLICT'; END IF;
      SELECT * INTO t FROM public.ghostai_billing_transactions WHERE entry_key=ekey ORDER BY revision DESC LIMIT 1;
      IF t.id IS DISTINCT FROM (p_payload->>'entryId')::uuid THEN RAISE EXCEPTION 'BILLING_CONFLICT'; END IF;
    ELSE
      ekey:='OWNER:'||mid::text||':'||(p_payload->>'period')||':'||(p_payload->>'type');
      IF EXISTS(SELECT 1 FROM public.ghostai_billing_transactions WHERE entry_key=ekey) THEN RETURN jsonb_build_object('changed',false); END IF;
    END IF;
    IF p_payload->>'status'='paid' AND (p_payload->>'paidAt' IS NULL OR p_payload->>'amountMinor' IS NULL) THEN RAISE EXCEPTION 'INVALID_PAID_CONTEXT'; END IF;
    INSERT INTO public.ghostai_billing_transactions(member_id,entry_key,revision,type,access_plan,amount_minor,currency,status,paid_at,billing_period,source,reason,created_by)
    VALUES(mid,ekey,coalesce(t.revision,0)+1,CASE WHEN t.id IS NULL THEN p_payload->>'type' ELSE 'ADJUSTMENT' END,p_payload->>'plan',(p_payload->>'amountMinor')::bigint,p_payload->>'currency',p_payload->>'status',(p_payload->>'paidAt')::date,p_payload->>'period','OWNER',p_payload->>'reason',aid);
    IF t.id IS NOT NULL AND (t.amount_minor IS DISTINCT FROM (p_payload->>'amountMinor')::bigint OR t.currency IS DISTINCT FROM p_payload->>'currency') THEN
      INSERT INTO public.ghostai_admin_audit_logs(admin_id,admin_email,admin_role,action,target_id,metadata)
      VALUES(aid,p_actor->>'email','owner','billing_amount_corrected',mid::text,jsonb_build_object('entryId',t.id,'reason',p_payload->>'reason'));
    END IF;
    event_name:='payment_status_changed';event_meta:=jsonb_build_object('status',p_payload->>'status','reason',p_payload->>'reason');
  ELSE RAISE EXCEPTION 'INVALID_BILLING_ACTION'; END IF;
  INSERT INTO public.ghostai_admin_audit_logs(admin_id,admin_email,admin_role,action,target_id,metadata)
  VALUES(aid,p_actor->>'email','owner',event_name,mid::text,event_meta);
  RETURN jsonb_build_object('changed',true,'created',created_count,'updated',updated_count);
END;
$$;
REVOKE ALL ON FUNCTION public.ghostai_billing_write(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ghostai_billing_write(text,jsonb,jsonb) TO service_role;

COMMIT;
