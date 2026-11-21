import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const container = `mb-pagar-close-${randomUUID()}`;
const runtime = 'mindbliss_auth_core_v1';
const owner = 'app_pagar_close_test_owner';
const observer = 'app_pagar_close_observer';
const database = 'mindbliss_curated_20261025';
const image = 'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
const psql = ['exec','-i',container,'psql','-X','-w','-qAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'];
const roleSQL = (sql, role) => role ? `SET ROLE ${role};${sql}` : sql;
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', shell: false });

function query(sql, role) {
  const result = docker(psql, roleSQL(sql, role));
  if (result.status !== 0) throw Error(result.stderr || result.error?.message || 'isolated query failed');
  return result.stdout.trim();
}

function rejects(sql, role, pattern) {
  const result = docker(psql, roleSQL(sql, role));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
}

function parallel(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', psql, { stdio: ['pipe','pipe','pipe'], shell: false });
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    child.on('error', reject);
    child.on('close', status => status === 0 ? resolve(output.trim()) : reject(Error(error)));
    child.stdin.end(roleSQL(sql, runtime));
  });
}

const runClose = 'SELECT closed_weeks||\'|\'||credited_rows||\'|\'||credited_usd_minor FROM payments.run_app_pagar_close_v1();';
const payment = '812c8144-ad2d-4fd2-ae64-cea20c369420';
const held = 'c5899630-bd03-4233-82b8-e63edb978ca1';
const attempt = 'a76169dc-0df3-46d0-a9d9-a9629178c8f9';
const secondAttempt = 'dc3a0c28-7355-48a1-a261-51e3fba52d30';
const heldAttempt = '71338926-6ea0-42fa-a98b-c08f33d2b641';
const horizon = "date_trunc('week',(pg_catalog.clock_timestamp() AT TIME ZONE 'America/Bogota')-interval '30 minutes')::date";

function recordReview(subject, paymentId, attemptId, state) {
  return `SELECT payments.record_app_pagar_lot_review_v1('${subject}','${paymentId}','${attemptId}','${state}');`;
}

const started = docker(['run','-d','--rm','--network','none','--name',container,
  '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e',`POSTGRES_DB=${database}`,image]);
if (started.status !== 0) throw Error(started.stderr || started.error?.message || 'failed to start isolated PostgreSQL');
try {
  for (let attempt = 0; docker(psql,'SELECT 1;').status !== 0; attempt++) {
    assert.ok(attempt < 60, 'isolated PostgreSQL failed to start');
    await delay(500);
  }
  query(`
    CREATE ROLE ${runtime} NOLOGIN;
    CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${observer} NOLOGIN;
    CREATE SCHEMA payments;
    CREATE SCHEMA mlm;
    CREATE SCHEMA identity;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA payments TO ${runtime},${owner},${observer};
    GRANT USAGE ON SCHEMA mlm,identity TO ${owner};
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,parent_id bigint,status text,person_id bigint);
    INSERT INTO mlm.affiliate VALUES(1,NULL,'active',1),(2,1,'active',2),(3,1,'active',3),(4,1,'inactive',4);
    GRANT SELECT ON mlm.affiliate TO ${owner};
    CREATE TABLE payments.app_pagar_accounting_receipt(
      payment_id uuid PRIMARY KEY,treasury_received_atomic numeric,confirmed_at timestamptz,posted_at timestamptz,subject text
    );
    ALTER TABLE payments.app_pagar_accounting_receipt OWNER TO ${owner};
    CREATE TABLE payments.app_pagar_investment(
      payment_id uuid PRIMARY KEY,affiliate_id bigint,activated_at timestamptz,plan_snapshot jsonb,lifetime_cap_minor numeric,
      gross_usd_minor numeric,matures_at timestamptz,qualified_annual_rate numeric,subject text,person_id bigint
    );
    ALTER TABLE payments.app_pagar_investment OWNER TO ${owner};
    CREATE TABLE payments.app_pagar_rank_entitlement(payment_id uuid);
    CREATE TABLE payments.app_pagar_roi_cursor(
      payment_id uuid PRIMARY KEY,next_day date,accrued_usd_minor numeric,cumulative_rate_days numeric
    );
    CREATE TABLE payments.app_pagar_roi_day(payment_id uuid,accrued_usd_minor numeric);
    CREATE TABLE payments.app_pagar_economic_hold(payment_id uuid PRIMARY KEY);
    CREATE TABLE payments.app_meld_funding_attempt(id uuid PRIMARY KEY,subject text);
    CREATE TABLE payments.app_meld_settlement(
      attempt_id uuid PRIMARY KEY,meld_transaction_id text,blockchain_tx_hash text,
      block_number bigint,block_hash text,transfer_log_index integer
    );
    CREATE TABLE payments.app_pagar_allocation(
      attempt_id uuid PRIMARY KEY REFERENCES payments.app_meld_settlement(attempt_id),payment_id uuid,
      gross_usd_minor bigint,received_atomic bigint
    );
    CREATE TABLE payments.nowpayments_engine_payment(amount numeric);
    CREATE TABLE mlm.wallet_movement(amount numeric);
    INSERT INTO payments.nowpayments_engine_payment VALUES(123456);
    INSERT INTO mlm.wallet_movement VALUES(567890);
    GRANT SELECT ON payments.app_pagar_roi_cursor,payments.app_pagar_roi_day,payments.app_pagar_economic_hold,
      payments.app_meld_funding_attempt,payments.app_meld_settlement,payments.app_pagar_allocation TO ${owner};
    GRANT INSERT ON payments.app_pagar_economic_hold TO ${owner};
    CREATE FUNCTION payments.reject_app_pagar_accounting_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'app_pagar_accounting_immutable'; END;$$;
    CREATE FUNCTION payments.hold_app_pagar_economic_receipt_v1(p_subject text,p_payment uuid)
    RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        INSERT INTO payments.app_pagar_economic_hold
        SELECT r.payment_id FROM payments.app_pagar_accounting_receipt r
        WHERE r.subject=p_subject AND r.payment_id=p_payment ON CONFLICT DO NOTHING;
        RETURN FOUND;
      END;
    $$;
    REVOKE EXECUTE ON FUNCTION payments.hold_app_pagar_economic_receipt_v1(text,uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION payments.hold_app_pagar_economic_receipt_v1(text,uuid) TO ${owner};
    CREATE FUNCTION identity.administrative_wallet_person(p_subject text)
    RETURNS bigint LANGUAGE sql STABLE AS $$
      SELECT CASE p_subject WHEN 'source-owner' THEN 2 WHEN 'held-owner' THEN 3 WHEN 'no-recharge' THEN 4 ELSE 99 END::bigint
    $$;
    CREATE TABLE auth.session(id text PRIMARY KEY,user_id text,expires_at timestamptz);
    INSERT INTO auth.session
    SELECT 'native-'||subject,subject,clock_timestamp()+interval '1 hour'
    FROM (VALUES('source-owner'),('held-owner'),('no-recharge'),('no-affiliate')) AS members(subject);
    INSERT INTO auth.session VALUES('expired-native','source-owner',clock_timestamp()-interval '1 hour');
    CREATE FUNCTION identity.require_administrative_native_session(p_subject text,p_session text)
    RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_expires timestamptz;
      BEGIN
        SELECT expires_at INTO v_expires FROM auth.session
        WHERE id=p_session AND user_id=p_subject AND expires_at>clock_timestamp() FOR SHARE;
        IF v_expires IS NULL THEN RAISE EXCEPTION 'native_session_required' USING ERRCODE='28000'; END IF;
        RETURN v_expires;
      END;
    $$;
    REVOKE EXECUTE ON FUNCTION identity.require_administrative_native_session(text,text),
      identity.administrative_wallet_person(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION identity.require_administrative_native_session(text,text),
      identity.administrative_wallet_person(text) TO ${owner};
    CREATE FUNCTION payments.read_app_pagar_points_v1(p_subject text,p_native_session text)
    RETURNS TABLE(own_pv text) LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
      BEGIN
        IF p_native_session IS DISTINCT FROM 'native-'||p_subject THEN RAISE EXCEPTION 'native_session_required'; END IF;
        RETURN QUERY SELECT coalesce(sum(div(i.gross_usd_minor,100::numeric)),0)::text
        FROM payments.app_pagar_investment i WHERE i.subject=p_subject
          AND NOT EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=i.payment_id);
      END;
    $$;
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT SELECT ON TABLES TO ${observer};
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT EXECUTE ON FUNCTIONS TO ${observer};
    INSERT INTO payments.app_pagar_investment VALUES
      ('${payment}',2,((${horizon})-8)::timestamp AT TIME ZONE 'America/Bogota','{"treasury_alpha":0.45}',3000,12500,
        ((${horizon})-6)::timestamp AT TIME ZONE 'America/Bogota',0.50,'source-owner',2),
      ('${held}',3,((${horizon})-8)::timestamp AT TIME ZONE 'America/Bogota','{"treasury_alpha":0.45}',100000,100000,
        ((${horizon})+365)::timestamp AT TIME ZONE 'America/Bogota',0.50,'held-owner',3);
    INSERT INTO payments.app_pagar_accounting_receipt
    SELECT payment_id,CASE WHEN payment_id='${held}' THEN 1000000000 ELSE 100999999 END,activated_at,activated_at,subject
    FROM payments.app_pagar_investment;
    INSERT INTO payments.app_pagar_roi_cursor VALUES('${payment}',${horizon},2000,730360),
      ('${held}',${horizon},20000,7300000);
    INSERT INTO payments.app_pagar_roi_day VALUES('${payment}',2000),('${held}',20000);
    INSERT INTO payments.app_meld_funding_attempt VALUES
      ('${attempt}','source-owner'),('${secondAttempt}','source-owner'),('${heldAttempt}','held-owner');
    INSERT INTO payments.app_meld_settlement VALUES
      ('${attempt}','lot-verified-1','tx-1',100,'block-1',0),
      ('${secondAttempt}','lot-verified-2','tx-2',101,'block-2',1),
      ('${heldAttempt}','lot-failed','tx-3',102,'block-3',2);
    INSERT INTO payments.app_pagar_allocation VALUES
      ('${attempt}','${payment}',8000,80000000),
      ('${secondAttempt}','${payment}',4500,20000000),
      ('${heldAttempt}','${held}',100000,1000000000);
  `);
  query(await readFile(new URL('../_meta/migration/146_app_pagar_close.sql', import.meta.url), 'utf8'));
  assert.equal(query(runClose, runtime), '0|0|0');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_bonus_period;'), '0');

  // Exercise the real source-review migration with synthetic provider observations.
  query(await readFile(new URL('../_meta/migration/148_app_pagar_close_risk.sql', import.meta.url), 'utf8'));
  assert.equal(query(runClose, runtime), '0|0|0', 'missing reviews block closing');
  const listLots = 'SELECT subject||\'|\'||meld_transaction_id FROM payments.read_app_pagar_lot_reviews_v1() ORDER BY meld_transaction_id;';
  assert.equal(query(listLots, runtime), 'held-owner|lot-failed\nsource-owner|lot-verified-1\nsource-owner|lot-verified-2');
  assert.equal(query(recordReview('held-owner', payment, attempt, 'confirmed'), runtime), 'f');
  assert.equal(query(recordReview('source-owner', payment, heldAttempt, 'confirmed'), runtime), 'f');
  rejects(recordReview('source-owner', payment, attempt, 'confirmed'), observer, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_lot_review;', runtime, /permission denied/);
  rejects(listLots, observer, /permission denied/);
  const readContext = `SELECT subject FROM payments.read_app_pagar_review_context_v1('source-owner','${attempt}');`;
  assert.equal(query(readContext, runtime), 'source-owner');
  assert.equal(query(readContext.replace('source-owner','held-owner'), runtime), '');
  rejects(readContext, observer, /permission denied/);
  rejects(recordReview('source-owner', payment, attempt, 'complete'), runtime, /app_pagar_invalid_lot_review/);
  assert.equal(query(recordReview('held-owner', held, heldAttempt, 'failed'), runtime), 't');
  assert.equal(query(recordReview('held-owner', held, heldAttempt, 'confirmed'), runtime), 't');
  assert.equal(query(listLots, runtime), 'source-owner|lot-verified-1\nsource-owner|lot-verified-2');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_economic_hold;'), '1');
  assert.equal(query(recordReview('source-owner', payment, attempt, 'confirmed'), runtime), 't');
  assert.equal(query(runClose, runtime), '0|0|0', 'every allocated lot needs a current verification');
  assert.equal(query(recordReview('source-owner', payment, secondAttempt, 'confirmed'), runtime), 't');
  assert.equal(query(recordReview('source-owner', payment, attempt, 'pending'), runtime), 't');
  assert.equal(query(runClose, runtime), '0|0|0', 'a later pending result revokes earlier confirmation');
  assert.equal(query(recordReview('source-owner', payment, attempt, 'confirmed'), runtime), 't');

  // Supply deterministic obligations to isolate accounting from the candidate producer.
  query(`
    CREATE FUNCTION payments.app_pagar_bonus_candidates_v1(p_cutoff date)
    RETURNS TABLE(kind text,reference text,recipient_affiliate_id bigint,gross_usd_minor numeric,
      cap_payment_id uuid,matched_pv numeric,source_payment_id uuid)
    LANGUAGE sql STABLE AS $$
      SELECT * FROM (VALUES
        ('direct','valid-direct',2::bigint,3000::numeric,NULL::uuid,0::numeric,'${payment}'::uuid),
        ('royalty','valid-royalty',3,7000,NULL,0,'${payment}'),
        ('binary','first-binary',2,2000,'${payment}',500,'${payment}'),
        ('binary','second-binary',2,2000,'${payment}',500,'${payment}'),
        ('rank','on-hold',3,10000,NULL,0,'${held}'),
        ('rank','duplicate',2,10000,NULL,0,'${payment}'),
        ('rank','duplicate',2,15000,NULL,0,'${payment}'),
        ('rank','inactive',4,10000,NULL,0,'${payment}')
      ) AS m(kind,reference,recipient_affiliate_id,gross_usd_minor,cap_payment_id,matched_pv,source_payment_id)
    $$;
    ALTER FUNCTION payments.app_pagar_bonus_candidates_v1(date) OWNER TO ${owner};
    UPDATE payments.app_pagar_roi_cursor SET next_day=(${horizon})-7 WHERE payment_id='${payment}';
  `);
  assert.equal(query(runClose, runtime), '0|0|0', 'the ROI reserve must be up to date before closing');
  query(`UPDATE payments.app_pagar_roi_cursor SET next_day=(${horizon})-6 WHERE payment_id='${payment}';`);
  const executions = await Promise.all([parallel(runClose), parallel(runClose)]);
  assert.ok(executions.includes('1|3|2526'));
  // The second week is blocked until its remaining ROI accrues.
  assert.ok(executions.includes('0|0|0'));
  assert.equal(query(`
    SELECT treasury_token_atomic||'|'||treasury_cap_usd_minor||'|'||roi_reserved_usd_minor||'|'||eligible_usd_minor||'|'||credited_usd_minor
    FROM payments.app_pagar_bonus_period ORDER BY week_end LIMIT 1;
  `), '100999999|4544|2018|10982|2526');
  assert.equal(query(`
    SELECT reference||'|'||credited_usd_minor FROM payments.app_pagar_bonus_credit ORDER BY reference;
  `), 'first-binary|226\nvalid-direct|690\nvalid-royalty|1610');
  assert.equal(query(`
    SELECT sum(credited_usd_minor) FROM payments.app_pagar_bonus_credit;
  `), '2526');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_bonus_obligation;'), '4');
  query(`UPDATE payments.app_pagar_roi_cursor SET next_day=NULL,accrued_usd_minor=2018,cumulative_rate_days=736610
    WHERE payment_id='${payment}';`);
  query("INSERT INTO payments.app_pagar_roi_day VALUES ('"+payment+"',18);");
  assert.equal(query(runClose, runtime), '1|0|0');
  assert.equal(query(runClose, runtime), '0|0|0');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_bonus_period;'), '2');
  assert.equal(query("SELECT (SELECT amount FROM mlm.wallet_movement)||'|'||(SELECT amount FROM payments.nowpayments_engine_payment);"),
    '567890|123456');
  rejects(runClose, observer, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_bonus_credit;', runtime, /permission denied/);
  rejects('UPDATE payments.app_pagar_bonus_credit SET credited_usd_minor=5;', owner, /app_pagar_accounting_immutable/);
  rejects('TRUNCATE payments.app_pagar_bonus_credit;', owner, /app_pagar_accounting_immutable/);
  const benefits = "SELECT active_gross_usd_minor||'|'||roi_accrued_usd_minor||'|'||own_pv||'|'||bonus_credited_usd_minor "+
    "FROM payments.read_app_pagar_benefits_v1('source-owner','native-source-owner');";
  assert.equal(query(benefits, runtime), '12500|2018|125|916');
  rejects(benefits, observer, /permission denied/);
  rejects(benefits.replace('native-source-owner','native-held-owner'), runtime, /native_session_required/);
  assert.equal(query(recordReview('source-owner', payment, attempt, 'failed'), runtime), 't');
  assert.equal(query(benefits, runtime), '0|0|0|916', 'holds do not erase previously posted credits');

  query(await readFile(new URL('../_meta/migration/149_app_pagar_commissions.sql', import.meta.url), 'utf8'));
  const commissions = (subject, session, cursor = 'NULL') =>
    `SELECT row_to_json(r) FROM payments.read_app_pagar_commissions_v1('${subject}','${session}',${cursor}) r;`;
  const readSource = commissions('source-owner', 'native-source-owner');
  const source = JSON.parse(query(readSource, runtime));
  assert.equal(source.virtual_balance_usd_minor, '916');
  assert.deepEqual(source.periods.map(({ binary_usd_minor,rank_usd_minor }) => [binary_usd_minor,rank_usd_minor]), [['226','0']]);
  assert.equal(source.next_before, null);
  assert.deepEqual(JSON.parse(query(commissions('held-owner', 'native-held-owner'), runtime)),
    { virtual_balance_usd_minor: '1610', periods: [], next_before: null }, 'royalty affects only its recipient total');
  assert.deepEqual(JSON.parse(query(commissions('no-affiliate', 'native-no-affiliate'), runtime)),
    { virtual_balance_usd_minor: '0', periods: [], next_before: null });
  rejects(commissions('source-owner', 'native-held-owner'), runtime, /native_session_required/);
  rejects(commissions('source-owner', 'expired-native'), runtime, /native_session_required/);
  rejects(commissions('source-owner', 'native-source-owner', "'infinity'::date"), runtime, /invalid_cursor/);
  rejects(commissions('source-owner', 'native-source-owner', "'2026-11-17'::date"), runtime, /invalid_cursor/);
  rejects(readSource, observer, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_bonus_credit;', runtime, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_bonus_obligation;', runtime, /permission denied/);
  query(`
    INSERT INTO payments.app_pagar_bonus_period(week_end,treasury_token_atomic,treasury_cap_usd_minor,
      roi_reserved_usd_minor,previous_bonus_usd_minor,eligible_usd_minor,credited_usd_minor)
    SELECT (${horizon})-(7*(i+4)),100000000,7000,0,0,1000,1000 FROM generate_series(0,14) AS series(i);
    INSERT INTO payments.app_pagar_bonus_obligation(kind,reference,recipient_affiliate_id,gross_usd_minor,cap_payment_id,
      matched_pv,source_payment_id,identified_week)
    VALUES('binary','commission-history-binary',2,500,'${payment}',100,'${payment}',(${horizon})-126),
      ('rank','commission-history-rank',2,500,NULL,0,'${payment}',(${horizon})-126),
      ('rank','commission-history-other-rank',4,600,NULL,0,'${payment}',(${horizon})-126),
      ('direct','commission-history-direct-only',2,800,NULL,0,'${payment}',(${horizon})-126);
    INSERT INTO payments.app_pagar_bonus_credit(week_end,kind,reference,credited_usd_minor)
    SELECT (${horizon})-(7*(i+4)),kind,reference,value
    FROM generate_series(0,13) AS series(i)
    CROSS JOIN (VALUES('binary','commission-history-binary',10),('rank','commission-history-rank',20)) AS partial(kind,reference,value);
    INSERT INTO payments.app_pagar_bonus_credit VALUES((${horizon})-126,'direct','commission-history-direct-only',30),
      ((${horizon})-126,'rank','commission-history-other-rank',60);
  `);
  const firstPage = JSON.parse(query(readSource, runtime));
  assert.equal(firstPage.virtual_balance_usd_minor, '1366');
  assert.equal(firstPage.periods.length, 12);
  assert.equal(firstPage.next_before, firstPage.periods[11].week_end);
  assert.deepEqual(firstPage.periods[0], source.periods[0], 'prior credits are projected without data rewrites');
  assert.deepEqual(firstPage.periods.slice(1).map(({ binary_usd_minor,rank_usd_minor }) => [binary_usd_minor,rank_usd_minor]),
    new Array(11).fill(['10','20']));
  const secondPage = JSON.parse(query(commissions('source-owner', 'native-source-owner', `'${firstPage.next_before}'::date`), runtime));
  assert.equal(secondPage.virtual_balance_usd_minor, firstPage.virtual_balance_usd_minor);
  assert.deepEqual(secondPage.periods.map(({ binary_usd_minor,rank_usd_minor }) => [binary_usd_minor,rank_usd_minor]),
    new Array(3).fill(['10','20']));
  assert.equal(secondPage.next_before, null);
  assert.ok(secondPage.periods.every(({ week_end }) => week_end < firstPage.next_before));
  const noRecharge = JSON.parse(query(commissions('no-recharge', 'native-no-recharge'), runtime));
  assert.equal(noRecharge.virtual_balance_usd_minor, '60');
  assert.deepEqual(noRecharge.periods.map(({ binary_usd_minor,rank_usd_minor }) => [binary_usd_minor,rank_usd_minor]), [['0','60']]);
  assert.equal(noRecharge.next_before, null);
  assert.equal(query("SELECT (SELECT amount FROM mlm.wallet_movement)||'|'||(SELECT amount FROM payments.nowpayments_engine_payment);"),
    '567890|123456');
  console.log('Pagar weekly close and owner-only commission history passed (isolated PostgreSQL, no provider or chain calls).');
} finally {
  docker(['stop','-t','1',container]);
}
