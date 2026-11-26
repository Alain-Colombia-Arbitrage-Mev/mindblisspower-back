import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const container = `mb-pagar-accounting-${randomUUID()}`;
const database = 'mindbliss_curated_20261025';
const runtime = 'mindbliss_auth_core_v1';
const owner = 'pagar_accounting_test_owner';
const observer = 'pagar_accounting_observer';
const image = 'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
const psql = ['exec', '-i', container, 'psql', '-X', '-w', '-qAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'];

const token = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const wallet = '0x' + '7'.repeat(40);
const receiver = '0x0a600b03ef5f8e7f3e182b83440c6d292033db0e';
const hash = value => '0x' + value.repeat(64);
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const as = (role, sql) => (role ? 'SET ROLE ' + role + ';' : '') + sql;
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', shell: false });
function query(sql, role) {
  const result = docker(psql, as(role, sql));
  if (result.status !== 0) throw Error(result.stderr || result.error?.message || 'isolated query failed');
  return result.stdout.trim();
}
function rejects(sql, role, errorPattern) {
  const result = docker(psql, as(role, sql));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, errorPattern);
}
function parallel(sql, role) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', psql, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', status => status === 0 ? resolve(stdout.trim()) : reject(Error(stderr)));
    child.stdin.end(as(role, sql));
  });
}

function seedPayment(id, operation, paidAtomic, { subject = 'alice', status = 'confirmed', sink = receiver, ageDays = 0 } = {}) {
  const payment = [id, subject, wallet, token, paidAtomic].map(quote).join(',');
  const confirmedAt = ageDays ? `(((pg_catalog.clock_timestamp() AT TIME ZONE 'America/Bogota')::date-${ageDays})::timestamp
    +interval '12 hours') AT TIME ZONE 'America/Bogota'` : 'pg_catalog.statement_timestamp()';
  query(`INSERT INTO payments.personal_polygon_relay VALUES(
  ${payment},137,6,${quote(sink)},${quote(status)},${confirmedAt},
  12,${quote(hash(operation))},${quote(hash('a'))}
);
INSERT INTO payments.app_pagar_intent VALUES(${payment});`);
}
function seedCandidate(paymentID) {
  const lotID = randomUUID();
  query(`INSERT INTO payments.app_pagar_candidate VALUES(${quote(paymentID)},${quote(lotID)});`);
  return lotID;
}
function seedAllocation(paymentID, lotID, gross, received) {
  query(`INSERT INTO payments.app_pagar_allocation
SELECT ${quote(lotID)},id,${gross},${received},confirmed_at FROM payments.personal_polygon_relay WHERE id=${quote(paymentID)};`);
}
function post(paymentID, subject = 'alice') {
  return `SELECT concat_ws('|',gross_usd_minor,treasury_received_atomic,allocated_received_atomic,
    previous_gross_usd_minor,cumulative_gross_usd_minor,pv_delta)
    FROM payments.post_app_pagar_accounting_v1(${quote(subject)},${quote(paymentID)});`;
}

const start = docker(['run', '-d', '--rm', '--network', 'none', '--name', container,
  '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', `POSTGRES_DB=${database}`, image]);
if (start.status !== 0) throw Error(start.stderr || start.error?.message || 'failed to start isolated PostgreSQL');
try {
  for (let attempt = 0; ; attempt++) {
    if (docker(psql, 'SELECT 1;').status === 0) break;
    assert.ok(attempt < 60, 'isolated PostgreSQL failed to start');
    await delay(500);
  }

  // Synthetic upstream records exercise the accounting schema independently
  // of the live Polygon and MELD clients. No operation leaves this container.
  query(`
    CREATE ROLE ${runtime} NOLOGIN;
    CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${observer} NOLOGIN;
    CREATE SCHEMA payments;
    GRANT USAGE ON SCHEMA payments TO ${runtime},${owner},${observer};
    CREATE TABLE payments.personal_polygon_relay (
      id uuid PRIMARY KEY, subject text, wallet_address text, token_address text, amount_atomic text,
      chain_id integer, token_decimals integer, recipient_address text, status text, confirmed_at timestamptz,
      confirmations integer, user_operation_hash text, transaction_hash text
    );
    CREATE VIEW payments.personal_polygon_relay_internal AS SELECT * FROM payments.personal_polygon_relay;
    CREATE FUNCTION payments.read_personal_polygon_relay(p_subject text,p_payment uuid)
    RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $fixture$
      SELECT p.* FROM payments.personal_polygon_relay_internal p WHERE p.id=p_payment AND p.subject=p_subject
    $fixture$;
    REVOKE EXECUTE ON FUNCTION payments.read_personal_polygon_relay(text,uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION payments.read_personal_polygon_relay(text,uuid) TO ${owner};
    CREATE TABLE payments.app_pagar_intent (
      payment_id uuid PRIMARY KEY REFERENCES payments.personal_polygon_relay(id) DEFERRABLE INITIALLY DEFERRED,
      subject text, wallet_address text, token_address text, amount_atomic numeric(78,0)
    );
    CREATE TABLE payments.app_pagar_candidate (
      payment_id uuid REFERENCES payments.app_pagar_intent(payment_id), attempt_id uuid, PRIMARY KEY(payment_id,attempt_id)
    );
    CREATE TABLE payments.app_pagar_allocation (
      attempt_id uuid PRIMARY KEY, payment_id uuid REFERENCES payments.app_pagar_intent(payment_id),
      gross_usd_minor bigint NOT NULL, received_atomic bigint NOT NULL, confirmed_at timestamptz NOT NULL
    );
    ALTER TABLE payments.app_pagar_allocation OWNER TO ${owner};
    GRANT SELECT ON payments.app_pagar_intent,payments.app_pagar_candidate TO ${owner};
    CREATE FUNCTION payments.allocate_app_pagar_basis_v1(p_subject text,p_payment uuid,p_finalized_block bigint,p_attempt_ids uuid[])
    RETURNS SETOF payments.app_pagar_allocation LANGUAGE sql AS $fixture$
      SELECT a.* FROM payments.app_pagar_allocation a JOIN payments.app_pagar_intent i ON i.payment_id=a.payment_id
      WHERE a.payment_id=p_payment AND i.subject=p_subject AND p_finalized_block=10 AND a.attempt_id=ANY(p_attempt_ids)
    $fixture$;
    ALTER FUNCTION payments.allocate_app_pagar_basis_v1(text,uuid,bigint,uuid[]) OWNER TO ${owner};
    REVOKE EXECUTE ON FUNCTION payments.allocate_app_pagar_basis_v1(text,uuid,bigint,uuid[]) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION payments.allocate_app_pagar_basis_v1(text,uuid,bigint,uuid[]) TO ${runtime};
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT SELECT ON TABLES TO ${observer};
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT EXECUTE ON FUNCTIONS TO ${observer};
    `);
  query(await readFile(new URL('../_meta/migration/142_app_pagar_accounting.sql', import.meta.url), 'utf8'));

  const first = randomUUID();
  seedPayment(first, '1', 50_000_000);
  const firstLot = seedCandidate(first), secondLot = seedCandidate(first);
  assert.equal(query(post(first), owner), '');
  seedAllocation(first, firstLot, 4_000, 38_999_999);
  assert.equal(query(post(first), owner), '');
  seedAllocation(first, secondLot, 1_075, 9_000_001);
  assert.equal(query(post(first, 'bob'), owner), '');
  const firstResult = '5075|50000000|48000000|0|5075|50';
  const record = `SELECT payments.record_app_pagar_accounting_v1(
    'alice',${quote(first)},10,ARRAY[${quote(firstLot)},${quote(secondLot)}]::uuid[]);`;
  assert.deepEqual(await Promise.all([parallel(record, runtime), parallel(record, runtime)]), ['t', 't']);
  assert.equal(query(post(first), owner), firstResult);

  const second = randomUUID(), third = randomUUID();
  seedPayment(second, '2', 1_000_000);
  seedPayment(third, '3', 1_000_000);
  seedAllocation(second, seedCandidate(second), 40, 390_000);
  seedAllocation(third, seedCandidate(third), 45, 440_000);
  await Promise.all([parallel(post(second), owner), parallel(post(third), owner)]);
  assert.equal(query("SELECT sum(gross_usd_minor)||'|'||sum(pv_delta) FROM payments.app_pagar_accounting_receipt WHERE subject='alice';"), '5160|51');
  assert.equal(query("SELECT count(*) FROM payments.app_pagar_accounting_receipt WHERE subject='alice';"), '3');

  const other = randomUUID();
  seedPayment(other, '4', 2_000_000, { subject: 'bob' });
  seedAllocation(other, seedCandidate(other), 225, 1_999_999);
  assert.equal(query(post(other, 'bob'), owner), '225|2000000|1999999|0|225|2');
  assert.equal(query(post(other), owner), '');

  for (const [operation, config] of [['5', { status: 'pending' }], ['6', { sink: wallet }]]) {
    const invalid = randomUUID();
    seedPayment(invalid, operation, 1_000_000, config);
    seedAllocation(invalid, seedCandidate(invalid), 150, 900_000);
    assert.equal(query(post(invalid), owner), '');
  }
  const duplicate = randomUUID();
  seedPayment(duplicate, '1', 1_000_000);
  seedAllocation(duplicate, seedCandidate(duplicate), 150, 900_000);
  rejects(post(duplicate), owner, /user_operation_hash/);
  rejects(post(first), runtime, /permission denied/);
  rejects(post(first), observer, /permission denied/);
  rejects(record, observer, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_accounting_receipt;', runtime, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_accounting_receipt;', observer, /permission denied/);
  rejects('DELETE FROM payments.app_pagar_accounting_receipt;', owner, /app_pagar_accounting_immutable/);
  rejects('TRUNCATE payments.app_pagar_accounting_receipt;', owner, /app_pagar_accounting_immutable/);
  assert.equal(query(post(first), owner), firstResult);
  process.stdout.write('App Pagar accounting SQL passed (isolated PostgreSQL, no charges).\n');

  // Plain PostgreSQL versions of just the shared read-side tables. Pagar
  // reads these facts without acquiring any write privilege on them.
  query(`
    CREATE SCHEMA auth;
    CREATE SCHEMA identity;
    CREATE SCHEMA mlm;
    CREATE TABLE auth."user"(id text PRIMARY KEY,email text,email_verified boolean NOT NULL);
    CREATE TABLE mlm.person(id bigint PRIMARY KEY,email text,user_id text,public_id uuid,blocked boolean NOT NULL DEFAULT false);
    CREATE TABLE identity.auth_binding(subject text PRIMARY KEY,provider text,person_id bigint REFERENCES mlm.person(id));
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint UNIQUE REFERENCES mlm.person(id),
      status text,parent_id bigint,sponsor_id bigint,position text);
    CREATE TABLE mlm.affiliate_closure(ancestor_id bigint,descendant_id bigint,distance integer,PRIMARY KEY(ancestor_id,descendant_id));
    CREATE TABLE mlm.plan_config(id bigint PRIMARY KEY,effective_from timestamptz,effective_to timestamptz,
      cd_lock_days integer,lifetime_cap_factor numeric,cd_qualified_directs integer,cd_same_tier_required boolean,depth_cap integer);
    CREATE TABLE mlm.cd_roi_tier(id smallint PRIMARY KEY,min_amount_usd numeric,max_amount_usd numeric,base_annual_rate numeric,
      qualified_annual_rate numeric,active boolean);
    CREATE TABLE mlm.rank(id smallint PRIMARY KEY,code text NOT NULL,required_points numeric NOT NULL,bonus_amount_usd numeric(14,2) NOT NULL);
    CREATE FUNCTION identity.member_referral_person_eligible(p_person bigint)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
      AS $fixture$ SELECT EXISTS(SELECT 1 FROM mlm.person p WHERE p.id=p_person AND NOT p.blocked) $fixture$;
    REVOKE EXECUTE ON FUNCTION identity.member_referral_person_eligible(bigint) FROM PUBLIC;
    CREATE FUNCTION identity.administrative_wallet_person(p_subject text)
    RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
      AS $fixture$ SELECT b.person_id FROM identity.auth_binding b WHERE b.subject=p_subject $fixture$;
    CREATE FUNCTION identity.require_administrative_native_session(p_subject text,p_session text)
    RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fixture$
      BEGIN
        IF p_session IS DISTINCT FROM p_subject||'-session' THEN
          RAISE EXCEPTION 'fixture_invalid_session' USING ERRCODE='28000';
        END IF;
        RETURN pg_catalog.clock_timestamp()+interval '1 hour';
      END
    $fixture$;
    REVOKE EXECUTE ON FUNCTION identity.administrative_wallet_person(text),identity.require_administrative_native_session(text,text) FROM PUBLIC;
    CREATE TABLE payments.nowpayments_engine_obligation(id integer PRIMARY KEY);
    INSERT INTO payments.nowpayments_engine_obligation VALUES(1);
    CREATE TABLE mlm.wallet_movement(id integer PRIMARY KEY);
    INSERT INTO mlm.wallet_movement VALUES(1);
    INSERT INTO mlm.plan_config VALUES(11,clock_timestamp()-interval '500 days',NULL,365,2,2,true,10);
    INSERT INTO mlm.cd_roi_tier VALUES(1,0,501,.25,.30,true),(2,501,NULL,.25,.35,true);
    INSERT INTO mlm.rank VALUES(1,'BRONZE',100,100.00),(2,'SILVER',250,200.00);
    INSERT INTO auth."user" VALUES('erin','erin@example.invalid',true),('left','left@example.invalid',true),
      ('right','right@example.invalid',true),('solo','solo@example.invalid',true),('blocked','blocked@example.invalid',true),
      ('wrong-email','unknown@example.invalid',true);
    INSERT INTO mlm.person VALUES(100,'root@example.invalid',NULL,pg_catalog.gen_random_uuid(),false),
      (101,'erin@example.invalid','erin',pg_catalog.gen_random_uuid(),false),
      (102,'left@example.invalid','left',pg_catalog.gen_random_uuid(),false),(103,'right@example.invalid','right',pg_catalog.gen_random_uuid(),false),
      (104,'solo@example.invalid','solo',pg_catalog.gen_random_uuid(),false),(105,'blocked@example.invalid','blocked',pg_catalog.gen_random_uuid(),true),
      (106,'wrong-email@example.invalid','wrong-email',pg_catalog.gen_random_uuid(),false);
    INSERT INTO identity.auth_binding VALUES('erin','better_auth',101),('left','better_auth',102),('right','better_auth',103),
      ('solo','better_auth',104),('blocked','better_auth',105),('wrong-email','better_auth',106);
    INSERT INTO mlm.affiliate VALUES(10,100,'active',NULL,NULL,NULL),(1,101,'active',10,10,'L'),
      (2,102,'active',1,1,'L'),(3,103,'active',1,1,'R');
    INSERT INTO mlm.affiliate_closure VALUES(10,10,0),(1,1,0),(2,2,0),(3,3,0),(1,2,1),(1,3,1),
      (10,1,1),(10,2,2),(10,3,2);
  `);
  query(await readFile(new URL('../_meta/migration/143_app_pagar_roi.sql', import.meta.url), 'utf8'));
  query(await readFile(new URL('../_meta/migration/144_app_pagar_pv.sql', import.meta.url), 'utf8'));
  query(await readFile(new URL('../_meta/migration/145_app_pagar_rank_entitlement.sql', import.meta.url), 'utf8'));
  const placements = new Map();
  for (const [subject, operation] of [['erin','7'],['left','8'],['right','9'],['solo','b'],['blocked','c'],['wrong-email','d']]) {
    const id = randomUUID();
    seedPayment(id, operation, 97_000_000, { subject, ageDays: subject === 'solo' ? 366 : 3 });
    seedAllocation(id, seedCandidate(id), 10_000, 94_000_000);
    assert.match(query(post(id, subject), owner), /^10000\|97000000\|94000000\|/);
    placements.set(subject, id);
  }

  const runROI = 'SELECT activated||\'|\'||accrued_days FROM payments.run_app_pagar_roi_v1();';
  assert.equal(query(runROI, runtime), '4|4');
  assert.equal(query(`SELECT subject||'|'||coalesce(affiliate_id::text,'none')||'|'||gross_usd_minor||'|'||
    treasury_net_atomic||'|'||pv_delta||'|'||package_level||'|'||plan_config_id
    FROM payments.app_pagar_investment WHERE payment_id=${quote(placements.get('erin'))};`), 'erin|1|10000|94000000|100|2|11');
  assert.equal(query("SELECT count(*) FROM payments.app_pagar_investment WHERE subject IN('blocked','wrong-email');"), '0');
  assert.equal(query("SELECT count(*) FROM payments.app_pagar_investment WHERE subject='solo' AND affiliate_id IS NULL;"), '1');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_pv_source;'), '4');
  assert.equal(query("SELECT own_pv||'|'||left_pv||'|'||right_pv FROM payments.read_app_pagar_points_v1('erin','erin-session');", runtime), '100|100|100');
  assert.equal(query("SELECT own_pv||'|'||left_pv||'|'||right_pv FROM payments.read_app_pagar_points_v1('solo','solo-session');", runtime), '100|0|0');
  const rank = "SELECT rank_code||'|'||prize_usd_minor||'|'||status FROM payments.read_app_pagar_rank_entitlements_v1('erin','erin-session');";
  assert.equal(query(rank, runtime), 'BRONZE|10000|pending_close');
  const days = subject => `SELECT r.annual_rate||'|'||r.qualifying_directs||'|'||r.accrued_usd_minor
    FROM payments.app_pagar_roi_day r WHERE r.payment_id=${quote(placements.get(subject))} ORDER BY r.cutoff_day;`;
  assert.equal(query(days('erin')), '0.3000|true|8');
  const hold = (subject, receipt) => `SELECT payments.hold_app_pagar_economic_receipt_v1(${quote(subject)},${quote(receipt)});`;
  assert.equal(query(hold('erin', placements.get('right')), runtime), 'f');
  assert.equal(query(hold('right', placements.get('right')), runtime), 't');
  assert.equal(query(hold('right', placements.get('right')), runtime), 't');
  assert.equal(query(runROI, runtime), '0|3');
  assert.equal(query(rank, runtime), 'BRONZE|10000|review');
  assert.equal(query(days('erin')), '0.3000|true|8\n0.2500|false|7');
  assert.equal(query(days('right')), '0.2500|false|6');
  assert.equal(query(`SELECT count(*) FROM payments.app_pagar_roi_day d JOIN payments.app_pagar_investment i USING(payment_id)
    WHERE d.available_at<>i.matures_at OR (i.matures_at AT TIME ZONE 'America/Bogota')::date-(i.starts_at AT TIME ZONE 'America/Bogota')::date<>365;`), '0');

  // A complete 365-day synthetic run preserves fractional cents until they
  // add up and reaches the annual base exactly, with no further accrual.
  query(`DO $test$ BEGIN
    FOR day IN 1..366 LOOP PERFORM payments.run_app_pagar_roi_v1(); END LOOP;
  END $test$;`, runtime);
  assert.equal(query(`SELECT count(*)||'|'||sum(accrued_usd_minor) FROM payments.app_pagar_roi_day
    WHERE payment_id=${quote(placements.get('solo'))};`), '365|2500');
  assert.equal(query(runROI, runtime), '0|0');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_pv_source;'), '4');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_rank_entitlement;'), '1');
  assert.equal(query('SELECT count(*) FROM payments.nowpayments_engine_obligation;'), '1');
  assert.equal(query('SELECT count(*) FROM mlm.wallet_movement;'), '1');
  rejects(runROI, observer, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_roi_day;', runtime, /permission denied/);
  rejects('TRUNCATE payments.app_pagar_roi_day;', owner, /app_pagar_accounting_immutable/);
  process.stdout.write('App Pagar activation, daily ROI, PV attribution and rank prizes passed (isolated PostgreSQL, no wallet credits).\n');

  // Use production path and closure triggers against a synthetic tree, then
  // exercise the full-receipt guard and placement from the runtime entry point.
  query(`
    CREATE EXTENSION ltree;
    CREATE TYPE mlm.tree_position AS ENUM('L','R');
    ALTER TABLE mlm.affiliate ALTER COLUMN position TYPE mlm.tree_position USING position::mlm.tree_position;
    ALTER TABLE mlm.affiliate ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 1000);
    ALTER TABLE mlm.affiliate ADD COLUMN path public.ltree, ADD COLUMN depth integer NOT NULL DEFAULT 0,
      ADD COLUMN left_pv_current numeric NOT NULL DEFAULT 0, ADD COLUMN right_pv_current numeric NOT NULL DEFAULT 0,
      ADD COLUMN left_count bigint NOT NULL DEFAULT 0, ADD COLUMN right_count bigint NOT NULL DEFAULT 0,
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
    UPDATE mlm.affiliate SET path=CASE id WHEN 10 THEN '10' WHEN 1 THEN '10.L_1'
      WHEN 2 THEN '10.L_1.L_2' ELSE '10.L_1.R_3' END::public.ltree,
      depth=CASE id WHEN 10 THEN 0 WHEN 1 THEN 1 ELSE 2 END;
    ALTER TABLE mlm.affiliate ALTER COLUMN path SET NOT NULL;
    CREATE UNIQUE INDEX affiliate_parent_position_unique ON mlm.affiliate(parent_id,position) WHERE parent_id IS NOT NULL;
    ALTER TABLE mlm.affiliate OWNER TO ${owner};
    ALTER TABLE mlm.affiliate_closure OWNER TO ${owner};
    ALTER TABLE mlm.person ADD COLUMN status text NOT NULL DEFAULT 'pending',
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
    UPDATE mlm.person SET status='active' WHERE id BETWEEN 100 AND 103;
    GRANT SELECT(status) ON mlm.person TO ${owner};
    GRANT UPDATE ON mlm.person TO ${owner};
    CREATE TABLE identity.member_registration_sponsor(
      subject text PRIMARY KEY,person_id bigint UNIQUE NOT NULL,sponsor_person_id bigint NOT NULL,
      source text NOT NULL,company_affiliate_id bigint
    );
    GRANT SELECT ON identity.member_registration_sponsor TO ${owner};
    CREATE TABLE mlm.tree_event(id integer PRIMARY KEY);
    INSERT INTO mlm.tree_event VALUES(1);
    ALTER TABLE payments.personal_polygon_relay ADD COLUMN created_at timestamptz DEFAULT clock_timestamp(),
      ADD COLUMN expires_at timestamptz DEFAULT clock_timestamp()+interval '10 minutes',
      ADD COLUMN block_number bigint DEFAULT 10;
    CREATE OR REPLACE VIEW payments.personal_polygon_relay_internal AS SELECT * FROM payments.personal_polygon_relay;
    ALTER TABLE payments.app_pagar_intent ADD COLUMN registered_at timestamptz DEFAULT clock_timestamp();
    ALTER TABLE payments.app_pagar_candidate ADD COLUMN deferred boolean DEFAULT false;
    CREATE TABLE payments.app_meld_funding_attempt(
      id uuid PRIMARY KEY,subject text,wallet_address text,status text,chain_id integer,
      created_at timestamptz,updated_at timestamptz,destination_currency text
    );
    CREATE TABLE payments.app_meld_settlement(
      attempt_id uuid PRIMARY KEY,received_atomic bigint,gross_usd_minor bigint,chain_id integer,
      recorded_at timestamptz,provider_settled_at timestamptz,block_number bigint
    );
    GRANT SELECT ON payments.app_meld_funding_attempt,payments.app_meld_settlement TO ${owner};
  `);
  const treeSchema = await readFile(new URL('../_meta/schema_mlm.sql', import.meta.url), 'utf8');
  const pathTrigger = treeSchema.slice(treeSchema.indexOf('CREATE OR REPLACE FUNCTION mlm.fn_compute_affiliate_path()'),
    treeSchema.indexOf('CREATE OR REPLACE FUNCTION mlm.fn_maintain_affiliate_closure()'));
  const closureTrigger = treeSchema.match(/CREATE OR REPLACE FUNCTION mlm.fn_maintain_affiliate_closure\(\)[\s\S]+?EXECUTE FUNCTION mlm.fn_maintain_affiliate_closure\(\);/u);
  assert.ok(pathTrigger && closureTrigger, 'expected production binary triggers');
  query(pathTrigger + closureTrigger[0]);

  query(await readFile(new URL('../_meta/migration/150_app_pagar_full_payment.sql', import.meta.url), 'utf8'));
  query(await readFile(new URL('../_meta/migration/152_app_pagar_first_placement.sql', import.meta.url), 'utf8'));
  query(await readFile(new URL('../_meta/migration/153_app_pagar_activate_placed_member.sql', import.meta.url), 'utf8'));
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_first_placement;'), '0');
  rejects('SELECT * FROM payments.app_pagar_first_placement;', runtime, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_first_placement;', observer, /permission denied/);
  rejects('SELECT payments.place_first_app_pagar_v1(NULL,NULL);', runtime, /permission denied/);
  rejects('SELECT payments.retry_first_app_pagar_placements_v1();', observer, /permission denied/);

  const members = ['referred','company','waiting','future-sponsor','parallel-left','parallel-right','unattributed','busy','suspended'];
  for (const [index, subject] of members.entries()) {
    const personID = 200 + index;
    const email = quote(subject + '@example.invalid');
    query(`
      INSERT INTO auth."user" VALUES(${quote(subject)},${email},true);
      INSERT INTO mlm.person VALUES(${personID},${email},${quote(subject)},gen_random_uuid(),false);
      INSERT INTO identity.auth_binding VALUES(${quote(subject)},'better_auth',${personID});
    `);
  }
  query(`
    INSERT INTO identity.member_registration_sponsor VALUES
      ('referred',200,101,'referral',NULL),('company',201,100,'company',10),
      ('waiting',202,203,'referral',NULL),('future-sponsor',203,101,'referral',NULL),
      ('parallel-left',204,101,'referral',NULL),('parallel-right',205,101,'referral',NULL),
      ('busy',207,102,'referral',NULL),('suspended',208,101,'referral',NULL);
    INSERT INTO mlm.affiliate(person_id,parent_id,position,sponsor_id,status) VALUES(208,3,'R',1,'suspended');
    UPDATE mlm.affiliate SET left_pv_current= CASE id WHEN 10 THEN 100 ELSE 50 END,
      right_pv_current=0,left_count=CASE id WHEN 10 THEN 4 ELSE 1 END,right_count=CASE id WHEN 10 THEN 0 ELSE 2 END
    WHERE id IN (1,10);
  `);

  function settlement(subject, attemptID, received) {
    query(`
      INSERT INTO payments.app_meld_funding_attempt VALUES (${quote(attemptID)},${quote(subject)},${quote(wallet)},
        'session_created',137,statement_timestamp()-interval '1 minute',statement_timestamp()-interval '1 minute','USDC_POLYGON');
      INSERT INTO payments.app_meld_settlement VALUES (${quote(attemptID)},${received},5000,137,
        statement_timestamp()-interval '1 minute',statement_timestamp()-interval '1 minute',5);
    `);
  }

  function preparedPagar(subject, { status = 'confirmed', amount = 49_000_000, atomic = 49_000_000, omitted = 0 } = {}) {
    const id = randomUUID();
    const operationHash = id.replaceAll('-', '');
    const proofHash = '0x' + operationHash + operationHash;
    const lot = randomUUID();
    settlement(subject, lot, atomic);
    seedPayment(id, '0', amount, { subject, status });
    query(`
      UPDATE payments.personal_polygon_relay SET user_operation_hash=${quote(proofHash)} WHERE id=${quote(id)};
      INSERT INTO payments.app_pagar_candidate(payment_id,attempt_id) VALUES(${quote(id)},${quote(lot)});
    `);
    seedAllocation(id, lot, 5000, atomic);
    if (omitted) settlement(subject, randomUUID(), omitted);
    return {
      id,
      record: `SELECT payments.record_app_pagar_accounting_v1(${quote(subject)},${quote(id)},10,ARRAY[${quote(lot)}]::uuid[]);`,
    };
  }

  const allocation = subject => `SELECT a.parent_id||'|'||a.sponsor_id||'|'||a.position||'|'||a.path::text||'|'||a.depth
    FROM mlm.affiliate a JOIN mlm.person p ON p.id=a.person_id WHERE p.user_id=${quote(subject)};`;
  const runReceipt = payment => assert.equal(query(payment.record, runtime), 't');

  const unconfirmed = preparedPagar('referred', { status: 'submitted' });
  rejects(unconfirmed.record, runtime, /app_pagar_accounting_proof_conflict/);
  // Remove only the synthetic input so its allocation cannot mask the required-lot test.
  query(`DELETE FROM payments.app_meld_funding_attempt WHERE subject='referred';`);
  const partial = preparedPagar('referred', { omitted: 49_000_000 });
  rejects(partial.record, runtime, /polygon_relay_full_payment_required/);
  assert.equal(query(allocation('referred')), '');
  assert.equal(query("SELECT status FROM mlm.person WHERE user_id='referred';"), 'pending');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_first_placement;'), '0');
  query(`DELETE FROM payments.app_meld_funding_attempt WHERE subject='referred'
    AND id NOT IN (SELECT attempt_id FROM payments.app_pagar_allocation WHERE payment_id=${quote(partial.id)});`);

  runReceipt(partial);
  assert.equal(query(allocation('referred')), '3|1|L|10.L_1.R_3.L_1001|3');
  assert.equal(query("SELECT status FROM mlm.person WHERE user_id='referred';"), 'active');
  assert.equal(query(`SELECT left_count||'|'||right_count||'|'||left_pv_current||'|'||right_pv_current
    FROM mlm.affiliate WHERE id=1;`), '1|3|50|0');
  runReceipt(partial);
  runReceipt(preparedPagar('referred'));
  assert.equal(query(`SELECT count(*) FROM payments.app_pagar_first_placement WHERE subject='referred'
    AND payment_id=${quote(partial.id)} AND affiliate_id IS NOT NULL;`), '1');

  runReceipt(preparedPagar('company'));
  assert.match(query(allocation('company')), /^10\|10\|R\|10\.R_\d+\|1$/);

  const existing = query(allocation('left'));
  runReceipt(preparedPagar('left'));
  assert.equal(query(allocation('left')), existing);

  const waiting = preparedPagar('waiting');
  runReceipt(waiting);
  runReceipt(preparedPagar('unattributed'));
  runReceipt(preparedPagar('suspended'));
  assert.equal(query(`SELECT count(*) FROM payments.app_pagar_accounting_receipt WHERE payment_id=${quote(waiting.id)};`), '1');
  assert.equal(query(allocation('waiting')), '');
  assert.equal(query("SELECT status FROM mlm.person WHERE user_id='waiting';"), 'pending');
  assert.equal(query(allocation('unattributed')), '');
  query(`UPDATE payments.app_pagar_first_placement SET next_attempt_at='-infinity' WHERE subject IN('waiting','unattributed','suspended');`);
  query(runROI, runtime);
  assert.equal(query("SELECT count(*) FROM payments.app_pagar_investment WHERE subject IN('waiting','unattributed','suspended');"), '0');
  assert.equal(query("SELECT status FROM mlm.affiliate WHERE person_id=208;"), 'suspended');
  assert.equal(query("SELECT status FROM mlm.person WHERE user_id='unattributed';"), 'pending');

  runReceipt(preparedPagar('future-sponsor'));
  query(`UPDATE payments.app_pagar_first_placement SET next_attempt_at='-infinity' WHERE subject='waiting';`);
  query(runROI, runtime);
  assert.equal(query("SELECT status FROM mlm.person WHERE user_id='waiting';"), 'active');
  assert.equal(query(`SELECT count(*) FROM payments.app_pagar_investment i
    JOIN mlm.affiliate a ON a.id=i.affiliate_id JOIN mlm.affiliate s ON s.id=a.sponsor_id
    JOIN payments.app_pagar_pv_source pv ON pv.payment_id=i.payment_id
    WHERE i.payment_id=${quote(waiting.id)} AND s.person_id=203;`), '1');
  assert.equal(query("SELECT count(*) FROM payments.app_pagar_pv_source pv JOIN payments.app_pagar_investment i USING(payment_id) WHERE i.subject='referred';"), '2');

  const lockPlacement = preparedPagar('busy');
  const beforeLock = "SELECT pg_advisory_xact_lock(2,2);";
  // Simulate a legacy placement holding the sponsor lock while a receipt settles.
  // Separate backends are required, so track the lock through pg_locks.
  const lock = parallel(`BEGIN;${beforeLock}SELECT pg_sleep(4);ROLLBACK;`);
  try {
    for (let attempt = 0; query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=2 AND objid=2 AND granted;") === '0'; attempt++) {
      assert.ok(attempt < 15, 'isolated sponsor lock failed to start');
      await delay(100);
    }
    runReceipt(lockPlacement);
    assert.equal(query(allocation('busy')), '');
  } finally {
    await lock;
  }

  const concurrent = [preparedPagar('parallel-left'), preparedPagar('parallel-right')];
  assert.deepEqual(await Promise.all(concurrent.map(payment => parallel(payment.record, runtime))), ['t','t']);
  query(`UPDATE payments.app_pagar_first_placement SET next_attempt_at='-infinity'
    WHERE subject IN('busy','parallel-left','parallel-right') AND affiliate_id IS NULL;`);
  query(runROI, runtime);
  assert.equal(query(`SELECT count(*)||'|'||count(DISTINCT (a.parent_id,a.position))
    FROM payments.app_pagar_first_placement q JOIN mlm.affiliate a ON a.id=q.affiliate_id
    WHERE q.subject IN('parallel-left','parallel-right') AND a.sponsor_id=1;`), '2|2');
  assert.match(query(allocation('busy')), /^\d+\|2\|/);
  assert.equal(query('SELECT count(*) FROM mlm.tree_event;'), '1');
  assert.equal(query('SELECT count(*) FROM payments.nowpayments_engine_obligation;'), '1');
  assert.equal(query('SELECT count(*) FROM mlm.wallet_movement;'), '1');
  process.stdout.write('App Pagar first complete payment placement passed (isolated PostgreSQL, no charges).\n');

} finally {
  docker(['rm', '-f', container]);
}
