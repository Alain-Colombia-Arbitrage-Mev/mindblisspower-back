-- Pagar-only inputs for the funded weekly close. All amounts are USD cents.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-pagar-economy-v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
    OR pg_catalog.pg_is_in_recovery()
    OR pg_catalog.to_regclass('payments.app_pagar_bonus_obligation') IS NULL THEN
    RAISE EXCEPTION 'app_pagar_bonus_candidates_requires_review';
  END IF;
  LOCK TABLE payments.app_pagar_investment IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM payments.app_pagar_investment) THEN
    RAISE EXCEPTION 'app_pagar_bonus_candidates_requires_review';
  END IF;
END $preflight$;

-- One immutable snapshot per Pagar investment prevents a later sponsor edit
-- from transferring or duplicating a direct/generation-2 entitlement.
CREATE TABLE payments.app_pagar_bonus_source (
  payment_id uuid PRIMARY KEY REFERENCES payments.app_pagar_investment(payment_id) ON DELETE RESTRICT,
  sponsor_affiliate_id bigint CHECK(sponsor_affiliate_id>0),
  royalty_affiliate_id bigint CHECK(royalty_affiliate_id>0),
  is_founder boolean NOT NULL,
  sponsor_is_founder boolean NOT NULL,
  block_size integer NOT NULL CHECK(block_size>0),
  bonus_per_block_usd numeric(14,2) NOT NULL CHECK(bonus_per_block_usd>0),
  qualified_directs_left integer NOT NULL CHECK(qualified_directs_left BETWEEN 0 AND 32767),
  qualified_directs_right integer NOT NULL CHECK(qualified_directs_right BETWEEN 0 AND 32767),
  daily_cap_factor numeric(8,4) NOT NULL CHECK(daily_cap_factor>0),
  period_cap_factor numeric(8,4) NOT NULL CHECK(period_cap_factor>=0),
  referral_rate numeric(8,6) NOT NULL CHECK(referral_rate BETWEEN 0 AND 1),
  founder_referral_rate numeric(8,6) NOT NULL CHECK(founder_referral_rate BETWEEN 0 AND 1),
  founder_binary_matched_rate numeric(8,6) NOT NULL CHECK(founder_binary_matched_rate BETWEEN 0 AND 1),
  royalty_enabled boolean NOT NULL,
  royalty_rate numeric(8,6) NOT NULL CHECK(royalty_rate BETWEEN 0 AND 1),
  royalty_generation integer NOT NULL CHECK(NOT royalty_enabled OR royalty_generation=2),
  rank_installments integer NOT NULL CHECK(rank_installments BETWEEN 1 AND 104),
  rank_installment_cadence integer NOT NULL CHECK(rank_installment_cadence BETWEEN 1 AND 104),
  CHECK(sponsor_affiliate_id IS NULL OR royalty_affiliate_id IS DISTINCT FROM sponsor_affiliate_id)
);
CREATE INDEX app_pagar_bonus_source_sponsor_idx ON payments.app_pagar_bonus_source(sponsor_affiliate_id,payment_id)
  WHERE sponsor_affiliate_id IS NOT NULL;
CREATE INDEX app_pagar_investment_cutoff_idx ON payments.app_pagar_investment(activated_at,payment_id);
ALTER TABLE payments.app_pagar_bonus_source ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER app_pagar_bonus_source_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON payments.app_pagar_bonus_source
  FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_app_pagar_accounting_mutation();

CREATE FUNCTION payments.capture_app_pagar_bonus_source_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE v_buyer bigint; v_sponsor bigint; v_royalty bigint; v_founder boolean; v_sponsor_founder boolean;
BEGIN
  v_buyer:=NEW.affiliate_id;
  IF v_buyer IS NOT NULL THEN
    SELECT a.sponsor_id,s.sponsor_id,coalesce(a.is_founder,false),coalesce(s.is_founder,false)
    INTO STRICT v_sponsor,v_royalty,v_founder,v_sponsor_founder
    FROM mlm.affiliate a LEFT JOIN mlm.affiliate s ON s.id=a.sponsor_id
    WHERE a.id=v_buyer;
    IF v_sponsor=v_buyer OR v_royalty=v_buyer OR v_royalty=v_sponsor THEN
      RAISE EXCEPTION 'app_pagar_bonus_invalid_sponsorship' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO payments.app_pagar_bonus_source(payment_id,sponsor_affiliate_id,royalty_affiliate_id,is_founder,sponsor_is_founder,
    block_size,bonus_per_block_usd,qualified_directs_left,qualified_directs_right,daily_cap_factor,period_cap_factor,
    referral_rate,founder_referral_rate,founder_binary_matched_rate,royalty_enabled,royalty_rate,royalty_generation,
    rank_installments,rank_installment_cadence)
  SELECT NEW.payment_id,v_sponsor,v_royalty,coalesce(v_founder,false),coalesce(v_sponsor_founder,false),
    p.block_size,p.bonus_per_block,p.qualified_directs_left,p.qualified_directs_right,p.daily_cap_factor,p.period_cap_factor,
    p.referral_rate,p.founder_referral_rate,p.founder_binary_matched_rate,p.royalty_enabled,p.royalty_rate,p.royalty_generation,
    p.rank_installments,p.rank_installment_cadence
  FROM pg_catalog.jsonb_to_record(NEW.plan_snapshot) AS p(
    block_size integer,bonus_per_block numeric,qualified_directs_left integer,qualified_directs_right integer,
    daily_cap_factor numeric,period_cap_factor numeric,referral_rate numeric,founder_referral_rate numeric,
    founder_binary_matched_rate numeric,royalty_enabled boolean,royalty_rate numeric,royalty_generation integer,
    rank_installments integer,rank_installment_cadence integer);
  RETURN NEW;
END $function$;
CREATE TRIGGER app_pagar_investment_bonus_source AFTER INSERT ON payments.app_pagar_investment
  FOR EACH ROW EXECUTE FUNCTION payments.capture_app_pagar_bonus_source_v1();

CREATE FUNCTION payments.app_pagar_bonus_candidates_v1(p_cutoff date)
RETURNS TABLE(kind text,reference text,recipient_affiliate_id bigint,gross_usd_minor numeric,
  cap_payment_id uuid,matched_pv numeric,source_payment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='15s' AS $function$
  WITH bounds AS (
    SELECT p_cutoff::timestamp AT TIME ZONE 'America/Bogota' AS week_end,
      (p_cutoff-7)::timestamp AT TIME ZONE 'America/Bogota' AS week_start
    WHERE extract(isodow FROM p_cutoff)=1
  ), funded AS MATERIALIZED (
    SELECT i.payment_id AS payment, i.affiliate_id AS affiliate, i.gross_usd_minor AS gross_minor,
      i.activated_at, s.*
    FROM payments.app_pagar_investment i
    JOIN payments.app_pagar_bonus_source s ON s.payment_id=i.payment_id
    CROSS JOIN bounds b
    WHERE i.activated_at<b.week_end AND i.starts_at<b.week_end
      AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=i.payment_id)
  ), own AS MATERIALIZED (
    SELECT DISTINCT ON (f.affiliate) f.*
    FROM funded f JOIN mlm.affiliate a ON a.id=f.affiliate AND a.status::text='active'
    WHERE a.parent_id IS NOT NULL
    ORDER BY f.affiliate,f.activated_at DESC,f.payment DESC
  ), leg_pv AS MATERIALIZED (
    SELECT l.affiliate_id,
      coalesce(sum(p.pv_delta) FILTER(WHERE l.leg='L'),0) AS left_pv,
      coalesce(sum(p.pv_delta) FILTER(WHERE l.leg='R'),0) AS right_pv
    FROM funded f JOIN payments.app_pagar_pv_source p ON p.payment_id=f.payment
    JOIN payments.app_pagar_pv_leg l ON l.payment_id=p.payment_id
    GROUP BY l.affiliate_id
  ), direct_placement AS (
    -- The latest eligible placement of each active direct can qualify only
    -- one leg even when previous payments were posted on a different leg.
    SELECT DISTINCT ON (f.affiliate) l.affiliate_id,l.leg
    FROM funded f JOIN own child ON child.affiliate=f.affiliate
    JOIN payments.app_pagar_pv_leg l ON l.payment_id=f.payment AND l.affiliate_id=f.sponsor_affiliate_id
    ORDER BY f.affiliate,f.activated_at DESC,f.payment DESC
  ), direct_counts AS (
    SELECT d.affiliate_id,count(*) FILTER(WHERE d.leg='L') AS direct_left,
      count(*) FILTER(WHERE d.leg='R') AS direct_right
    FROM direct_placement d GROUP BY d.affiliate_id
  ), qualified AS MATERIALIZED (
    SELECT o.* FROM own o LEFT JOIN direct_counts d ON d.affiliate_id=o.affiliate
    WHERE coalesce(d.direct_left,0)>=o.qualified_directs_left
      AND coalesce(d.direct_right,0)>=o.qualified_directs_right
  ), obligations AS MATERIALIZED (
    SELECT o.* FROM payments.app_pagar_bonus_obligation o WHERE o.identified_week<=p_cutoff
  ), direct_and_royalty AS (
    SELECT 'direct'::text AS stream,'direct/'||f.payment::text AS ref,a.affiliate AS recipient,
      floor(f.gross_minor*CASE WHEN f.sponsor_is_founder THEN f.founder_referral_rate ELSE f.referral_rate END) AS amount,
      NULL::uuid AS cap_payment,0::numeric AS matched,f.payment AS source_payment
    FROM funded f JOIN qualified a ON a.affiliate=f.sponsor_affiliate_id CROSS JOIN bounds b
    WHERE f.activated_at>=b.week_start
      OR EXISTS(SELECT 1 FROM obligations o WHERE o.kind='direct' AND o.reference='direct/'||f.payment::text)
    UNION ALL
    SELECT 'royalty','royalty/'||f.payment::text,a.affiliate,floor(f.gross_minor*f.royalty_rate),NULL::uuid,0::numeric,f.payment
    FROM funded f JOIN own a ON a.affiliate=f.royalty_affiliate_id
    JOIN mlm.affiliate sponsor ON sponsor.id=f.sponsor_affiliate_id
      AND sponsor.status::text='active' AND sponsor.parent_id IS NOT NULL
    CROSS JOIN bounds b
    WHERE f.royalty_enabled AND f.royalty_generation=2 AND
      (f.activated_at>=b.week_start
        OR EXISTS(SELECT 1 FROM obligations o WHERE o.kind='royalty' AND o.reference='royalty/'||f.payment::text))
  ), prior_binary AS MATERIALIZED (
    SELECT o.*,sum(o.matched_pv) OVER(
      PARTITION BY o.recipient_affiliate_id ORDER BY o.identified_week,o.reference
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS consumed
    FROM obligations o WHERE o.kind='binary'
  ), consumed_binary AS (
    SELECT o.recipient_affiliate_id,max(o.consumed) AS consumed FROM prior_binary o GROUP BY o.recipient_affiliate_id
  ), binary_plan AS (
    SELECT DISTINCT ON (f.affiliate) f.*
    FROM funded f JOIN own member ON member.affiliate=f.affiliate
    JOIN payments.app_pagar_binary_available_caps_v1() a ON a.payment_id=f.payment AND a.cap_remaining>0
    LEFT JOIN direct_counts d ON d.affiliate_id=f.affiliate
    WHERE coalesce(d.direct_left,0)>=f.qualified_directs_left
      AND coalesce(d.direct_right,0)>=f.qualified_directs_right
    ORDER BY f.affiliate,f.activated_at DESC,f.payment DESC
  ), carry_binary AS (
    SELECT o.kind,o.reference,o.recipient_affiliate_id,o.gross_usd_minor,o.cap_payment_id,o.matched_pv,o.source_payment_id
    FROM prior_binary o
    JOIN leg_pv v ON v.affiliate_id=o.recipient_affiliate_id AND least(v.left_pv,v.right_pv)>=o.consumed
    JOIN own member ON member.affiliate=o.recipient_affiliate_id
    JOIN funded capped ON capped.payment=o.cap_payment_id AND capped.affiliate=o.recipient_affiliate_id
    JOIN funded source ON source.payment=o.source_payment_id
    LEFT JOIN direct_counts d ON d.affiliate_id=o.recipient_affiliate_id
    WHERE coalesce(d.direct_left,0)>=capped.qualified_directs_left
      AND coalesce(d.direct_right,0)>=capped.qualified_directs_right
  ), valid_rank AS MATERIALIZED (
    SELECT r.* FROM payments.app_pagar_rank_entitlement r
    JOIN leg_pv v ON v.affiliate_id=r.affiliate_id AND least(v.left_pv,v.right_pv)>=r.points_required
    JOIN own o ON o.affiliate=r.affiliate_id
    JOIN funded f ON f.payment=r.payment_id
    CROSS JOIN bounds b
    WHERE r.earned_at<b.week_end
  ), new_binary AS (
    SELECT 'binary'::text,'binary/'||q.affiliate::text||'/'||to_char(p_cutoff,'YYYY-MM-DD'),q.affiliate,
      least(floor(CASE WHEN q.is_founder THEN m.matched*q.founder_binary_matched_rate*100
        ELSE m.blocks*q.bonus_per_block_usd*100 END),
        CASE WHEN q.period_cap_factor>0 THEN floor(q.gross_minor*q.period_cap_factor)
          ELSE floor(q.daily_cap_factor*coalesce(r.rank_prize_minor,10000)) END),
      q.payment,m.matched,q.payment
    FROM binary_plan q JOIN leg_pv v ON v.affiliate_id=q.affiliate
    LEFT JOIN consumed_binary c ON c.recipient_affiliate_id=q.affiliate
    LEFT JOIN LATERAL (
      SELECT x.prize_usd_minor AS rank_prize_minor FROM valid_rank x WHERE x.affiliate_id=q.affiliate
      ORDER BY x.points_required DESC,x.rank_id DESC LIMIT 1
    ) r ON true
    CROSS JOIN LATERAL (
      SELECT div(greatest(least(v.left_pv,v.right_pv)-coalesce(c.consumed,0),0),q.block_size::numeric) AS blocks
    ) b
    CROSS JOIN LATERAL (SELECT b.blocks,b.blocks*q.block_size AS matched) m
    WHERE m.blocks>0
      AND NOT EXISTS(SELECT 1 FROM prior_binary o WHERE o.recipient_affiliate_id=q.affiliate AND o.identified_week=p_cutoff)
  ), rank_installments AS (
    SELECT 'rank'::text,'rank/'||r.affiliate_id::text||'/'||r.rank_id::text||'/'||n.installment::text,r.affiliate_id,
      CASE WHEN n.installment=f.rank_installments THEN r.prize_usd_minor
        -div(r.prize_usd_minor,f.rank_installments::numeric)*(f.rank_installments-1)
        ELSE div(r.prize_usd_minor,f.rank_installments::numeric) END,
      NULL::uuid,0::numeric,r.payment_id
    FROM valid_rank r JOIN funded f ON f.payment=r.payment_id
    CROSS JOIN LATERAL generate_series(1,f.rank_installments) n(installment)
    WHERE date_trunc('week',r.earned_at AT TIME ZONE 'America/Bogota')::date+7
      +(7*f.rank_installment_cadence*(n.installment-1))<=p_cutoff
  ), candidates(stream,ref,recipient,amount,cap_payment,matched,source_payment) AS (
    SELECT * FROM direct_and_royalty
    UNION ALL SELECT * FROM carry_binary
    UNION ALL SELECT * FROM new_binary
    UNION ALL SELECT * FROM rank_installments
  )
  SELECT c.stream,c.ref,c.recipient,c.amount,c.cap_payment,c.matched,c.source_payment
  FROM candidates c WHERE c.amount>0
  ORDER BY c.stream,c.ref;
$function$;

DO $permissions$
DECLARE v_owner name; v_role text; v_signature text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO STRICT v_owner
    FROM pg_catalog.pg_class c WHERE c.oid='payments.app_pagar_investment'::regclass;
  EXECUTE pg_catalog.format('GRANT SELECT(id,sponsor_id,is_founder,status,parent_id) ON mlm.affiliate TO %I',v_owner);
  EXECUTE pg_catalog.format('ALTER TABLE payments.app_pagar_bonus_source OWNER TO %I',v_owner);
  FOR v_role IN
    SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
    FROM pg_catalog.pg_class c,LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    WHERE c.oid='payments.app_pagar_bonus_source'::regclass AND a.grantee<>c.relowner
  LOOP
    EXECUTE 'REVOKE ALL ON TABLE payments.app_pagar_bonus_source FROM '||v_role;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY[
    'payments.capture_app_pagar_bonus_source_v1()','payments.app_pagar_bonus_candidates_v1(date)'
  ] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_role IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
      FROM pg_catalog.pg_proc p,LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner
    LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role;
    END LOOP;
  END LOOP;
  IF pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.app_pagar_bonus_source','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.app_pagar_bonus_candidates_v1(date)','EXECUTE') THEN
    RAISE EXCEPTION 'app_pagar_bonus_source_permissions_changed';
  END IF;
END $permissions$;
COMMIT;
