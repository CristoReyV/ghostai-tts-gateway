-- Commercial records only. No membership, key, activation or expiration updates.
CREATE TABLE public.ghostai_member_billing (
  member_id uuid PRIMARY KEY REFERENCES public.ghostai_members(id),
  amount_minor bigint CHECK (amount_minor BETWEEN 0 AND 100000000000),
  currency text CHECK (currency IN ('USD','MXN')),
  source text NOT NULL CHECK (source IN ('GOOGLE_SHEET','OWNER')),
  source_hash text,
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ghostai_billing_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES public.ghostai_members(id),
  entry_key text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  type text NOT NULL CHECK (type IN ('NEW_ACCESS','RENEWAL','ADJUSTMENT')),
  access_plan text NOT NULL CHECK (access_plan IN ('monthly','annual')),
  amount_minor bigint CHECK (amount_minor BETWEEN 0 AND 100000000000),
  currency text CHECK (currency IN ('USD','MXN')),
  status text NOT NULL CHECK (status IN ('paid','pending','unknown')),
  paid_at date,
  billing_period text CHECK (billing_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  source text NOT NULL CHECK (source IN ('GOOGLE_SHEET','OWNER')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.ghostai_admin_users(id),
  UNIQUE(entry_key, revision)
);
CREATE INDEX ghostai_billing_member_idx ON public.ghostai_billing_transactions(member_id);
CREATE TABLE public.ghostai_revenue_goals (
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  currency text NOT NULL CHECK (currency IN ('USD','MXN')),
  target_minor bigint NOT NULL CHECK (target_minor BETWEEN 1 AND 100000000000),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(month,currency)
);
CREATE TABLE public.ghostai_billing_sync (
  id text PRIMARY KEY,
  synced_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL
);
ALTER TABLE public.ghostai_member_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ghostai_billing_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ghostai_revenue_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ghostai_billing_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ghostai_member_billing,public.ghostai_billing_transactions,public.ghostai_revenue_goals,public.ghostai_billing_sync FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.ghostai_member_billing,public.ghostai_revenue_goals,public.ghostai_billing_sync TO service_role;
-- Ledger is append only, even for the backend. Corrections create a new revision.
GRANT SELECT,INSERT ON public.ghostai_billing_transactions TO service_role;

CREATE FUNCTION public.ghostai_billing_write(p_action text,p_payload jsonb,p_actor jsonb)
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
      IF NOT FOUND OR profile.source_hash IS DISTINCT FROM r->>'source_hash' THEN
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
