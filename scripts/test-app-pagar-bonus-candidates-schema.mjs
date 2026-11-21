import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const container = `mb-pagar-bonuses-${randomUUID()}`;
const database = 'mindbliss_curated_20261025';
const owner = 'pagar_bonus_test_owner';
const runtime = 'mindbliss_auth_core_v1';
const observer = 'pagar_bonus_test_observer';
const image = 'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
const psql = ['exec', '-i', container, 'psql', '-X', '-w', '-qAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'];
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', shell: false });
const as = (role, sql) => role ? `SET ROLE ${role};${sql}` : sql;

function query(sql, role) {
  const result = docker(psql, as(role, sql));
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function rejects(sql, role, pattern) {
  const result = docker(psql, as(role, sql));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
}

const grandSponsor = randomUUID();
const sponsor = randomUUID();
const left = randomUUID();
const right = randomUUID();
const extraLeft = randomUUID();
const plan = JSON.stringify({
  block_size: 50, bonus_per_block: 10, qualified_directs_left: 1, qualified_directs_right: 1,
  daily_cap_factor: 3, period_cap_factor: 0, referral_rate: 0.05, founder_referral_rate: 0.10,
  founder_binary_matched_rate: 0.10, royalty_enabled: true, royalty_rate: 0.05, royalty_generation: 2,
  rank_installments: 4, rank_installment_cadence: 2, treasury_alpha: 0.45,
});
const candidates = date => `payments.app_pagar_bonus_candidates_v1('${date}')`;
const runClose = 'SELECT closed_weeks||\'|\'||credited_rows||\'|\'||credited_usd_minor FROM payments.run_app_pagar_close_v1();';
const eligible = (date, where = 'TRUE') => query(`
  SELECT reference||'|'||recipient_affiliate_id||'|'||gross_usd_minor||'|'||matched_pv
  FROM ${candidates(date)} WHERE ${where} ORDER BY reference;
`, owner);

const started = docker(['run', '-d', '--rm', '--pull', 'never', '--network', 'none', '--name', container,
  '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', `POSTGRES_DB=${database}`, image]);
assert.equal(started.status, 0, started.stderr || started.error?.message);
try {
  for (let attempt = 0; docker(psql, 'SELECT 1;').status !== 0; attempt++) {
    assert.ok(attempt < 60, 'isolated PostgreSQL failed to start');
    await delay(500);
  }
  const [cutoff, followingCutoff, lastInstallment, notMonday] = query(`
    SELECT horizon||'|'||(horizon+7)||'|'||(horizon+42)||'|'||(horizon+1)
    FROM (SELECT date_trunc('week',(pg_catalog.clock_timestamp() AT TIME ZONE 'America/Bogota')-interval '30 minutes')::date AS horizon) h;
  `).split('|');
  const activity = `(('${cutoff}'::date-3)::timestamp+interval '10 hours') AT TIME ZONE 'America/Bogota'`;

  query(`
    CREATE ROLE ${runtime} NOLOGIN;
    CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${observer} NOLOGIN;
    CREATE SCHEMA payments;
    CREATE SCHEMA mlm;
    GRANT USAGE ON SCHEMA payments TO ${owner},${runtime},${observer};
    GRANT USAGE ON SCHEMA mlm TO ${owner};
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,parent_id bigint,sponsor_id bigint,status text,is_founder boolean);
    INSERT INTO mlm.affiliate VALUES(1,NULL,NULL,'active',false),(2,1,1,'active',false),
      (3,2,2,'active',true),(4,3,3,'active',false),(5,3,3,'active',false);
    CREATE TABLE payments.app_pagar_accounting_receipt(payment_id uuid PRIMARY KEY,treasury_received_atomic numeric,confirmed_at timestamptz);
    CREATE TABLE payments.app_pagar_investment(
      payment_id uuid PRIMARY KEY,affiliate_id bigint REFERENCES mlm.affiliate(id),gross_usd_minor numeric,
      starts_at timestamptz,activated_at timestamptz,plan_snapshot jsonb,lifetime_cap_minor numeric,
      matures_at timestamptz,qualified_annual_rate numeric
    );
    ALTER TABLE payments.app_pagar_accounting_receipt OWNER TO ${owner};
    ALTER TABLE payments.app_pagar_investment OWNER TO ${owner};
    CREATE TABLE payments.app_pagar_economic_hold(payment_id uuid PRIMARY KEY);
    CREATE TABLE payments.app_pagar_pv_source(payment_id uuid PRIMARY KEY,pv_delta numeric);
    CREATE TABLE payments.app_pagar_pv_leg(payment_id uuid,affiliate_id bigint,leg text,PRIMARY KEY(payment_id,affiliate_id));
    CREATE TABLE payments.app_pagar_rank_entitlement(payment_id uuid,affiliate_id bigint,rank_id int,
      points_required numeric,prize_usd_minor numeric,earned_at timestamptz,PRIMARY KEY(affiliate_id,rank_id));
    CREATE TABLE payments.app_pagar_roi_cursor(payment_id uuid PRIMARY KEY,next_day date,
      accrued_usd_minor numeric,cumulative_rate_days numeric);
    CREATE TABLE payments.app_pagar_roi_day(payment_id uuid,accrued_usd_minor numeric);
    CREATE TABLE payments.nowpayments_engine_obligation(id integer PRIMARY KEY);
    CREATE TABLE mlm.wallet_movement(id integer PRIMARY KEY);
    INSERT INTO payments.nowpayments_engine_obligation VALUES(19);
    INSERT INTO mlm.wallet_movement VALUES(29);
    GRANT SELECT ON payments.app_pagar_economic_hold,payments.app_pagar_pv_source,payments.app_pagar_pv_leg,
      payments.app_pagar_rank_entitlement,payments.app_pagar_roi_cursor,payments.app_pagar_roi_day TO ${owner};
    CREATE FUNCTION payments.reject_app_pagar_accounting_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'app_pagar_accounting_immutable'; END;$$;
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT SELECT ON TABLES TO ${observer};
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT EXECUTE ON FUNCTIONS TO ${observer};
  `);
  for (const migration of ['146_app_pagar_close.sql', '147_app_pagar_bonus_candidates.sql']) {
    query(await readFile(new URL(`../_meta/migration/${migration}`, import.meta.url), 'utf8'));
  }
  assert.equal(eligible(cutoff), '');
  query(`
    INSERT INTO payments.app_pagar_investment
    SELECT payment,affiliate,gross_minor,${activity},${activity},'${plan}',2*gross_minor,
      (${activity})+interval '365 days',0.30
    FROM (VALUES ('${grandSponsor}'::uuid,2,10000),('${sponsor}',3,25001),('${left}',4,10001),
      ('${right}',5,10000),('${extraLeft}',4,2500)) AS p(payment,affiliate,gross_minor);
    INSERT INTO payments.app_pagar_pv_source VALUES('${sponsor}',250),('${left}',100),('${right}',100),('${extraLeft}',25);
    INSERT INTO payments.app_pagar_pv_leg VALUES
      ('${sponsor}',2,'L'),('${left}',2,'L'),('${right}',2,'L'),('${extraLeft}',2,'L'),
      ('${left}',3,'L'),('${right}',3,'R'),('${extraLeft}',3,'L');
    INSERT INTO payments.app_pagar_rank_entitlement VALUES('${right}',3,1,100,10001,${activity});
    INSERT INTO payments.app_pagar_accounting_receipt
    SELECT payment_id,gross_usd_minor*9900,starts_at FROM payments.app_pagar_investment;
    INSERT INTO payments.app_pagar_roi_cursor
    SELECT payment_id,'${followingCutoff}',0,0 FROM payments.app_pagar_investment;
  `);
  // Priority, percentages and rank installments use cents from each source,
  // independently of provider fees and of the NOWPayments ledger.
  assert.equal(eligible(cutoff), [
    `binary/3/${cutoff}|3|1000|100`,
    ...[`direct/${left}|3|1000|0`, `direct/${right}|3|1000|0`, `direct/${extraLeft}|3|250|0`].sort(),
    'rank/3/1/1|3|2500|0',
    ...[`royalty/${left}|2|500|0`, `royalty/${right}|2|500|0`, `royalty/${extraLeft}|2|125|0`].sort(),
  ].join('\n'));
  assert.equal(eligible(notMonday), '');
  assert.equal(query(runClose, runtime), '0|0|0', 'weekly close fails closed before the risk gate is deployed');

  query(`
    CREATE OR REPLACE FUNCTION payments.app_pagar_close_sources_ready_v1(p_before timestamptz)
    RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$SELECT p_before IS NOT NULL$$;
  `);
  assert.equal(query(runClose, runtime), '1|8|6875');
  assert.equal(query(runClose, runtime), '0|0|0');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_bonus_obligation;'), '8');
  query('UPDATE mlm.affiliate SET sponsor_id=2 WHERE id=4;');
  assert.equal(eligible(followingCutoff), eligible(cutoff), 'a frozen binary match cannot be generated twice');
  assert.equal(eligible(lastInstallment, "kind='rank'"), [
    'rank/3/1/1|3|2500|0', 'rank/3/1/2|3|2500|0', 'rank/3/1/3|3|2500|0', 'rank/3/1/4|3|2501|0',
  ].join('\n'));

  const exhausted = randomUUID();
  const repeatRight = randomUUID();
  assert.equal(query(`
    BEGIN;
    INSERT INTO payments.app_pagar_investment
    SELECT payment,affiliate,10000,(${activity})+interval '7 days',(${activity})+interval '7 days',
      '${plan}',20000,(${activity})+interval '372 days',0.30
    FROM (VALUES ('${exhausted}'::uuid,3),('${repeatRight}',5)) AS p(payment,affiliate);
    INSERT INTO payments.app_pagar_roi_cursor VALUES('${exhausted}',NULL,20000,7300000);
    INSERT INTO payments.app_pagar_pv_source VALUES('${repeatRight}',100);
    INSERT INTO payments.app_pagar_pv_leg VALUES('${repeatRight}',3,'R');
    SELECT count(*) FROM ${candidates(followingCutoff)} WHERE reference='binary/3/${followingCutoff}';
    UPDATE payments.app_pagar_pv_source SET pv_delta=50 WHERE payment_id='${extraLeft}';
    SELECT cap_payment_id||'|'||matched_pv FROM ${candidates(followingCutoff)}
    WHERE reference='binary/3/${followingCutoff}';
    ROLLBACK;
  `), `0\n${sponsor}|50`, 'create only full blocks and use the prior cap if the latest investment has no room');

  const movedLeft = randomUUID();
  query(`
    INSERT INTO payments.app_pagar_economic_hold VALUES('${right}');
    UPDATE mlm.affiliate SET sponsor_id=3 WHERE id=4;
    INSERT INTO payments.app_pagar_investment VALUES('${movedLeft}',4,10000,
      (${activity})+interval '7 days',(${activity})+interval '7 days','${plan}',20000,
      (${activity})+interval '372 days',0.30);
    INSERT INTO payments.app_pagar_pv_source VALUES('${movedLeft}',100);
    INSERT INTO payments.app_pagar_pv_leg VALUES('${movedLeft}',3,'R');
  `);
  assert.equal(eligible(followingCutoff), [
    `royalty/${left}|2|500|0`, `royalty/${extraLeft}|2|125|0`, `royalty/${movedLeft}|2|500|0`,
  ].sort().join('\n'), 'a held source and a moved direct cannot sustain rank or qualify both legs');

  rejects(`SELECT * FROM ${candidates(cutoff)};`, runtime, /permission denied/);
  rejects(`SELECT * FROM ${candidates(cutoff)};`, observer, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_binary_available_caps_v1();', runtime, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_bonus_source;', runtime, /permission denied/);
  rejects('UPDATE payments.app_pagar_bonus_source SET is_founder=false;', owner, /app_pagar_accounting_immutable/);
  assert.equal(query('SELECT (SELECT id FROM payments.nowpayments_engine_obligation)||\'|\'||(SELECT id FROM mlm.wallet_movement);'), '19|29');
  console.log('Pagar bonus candidates passed (isolated PostgreSQL, no provider or chain calls).');
} finally {
  docker(['stop', '-t', '1', container]);
}
