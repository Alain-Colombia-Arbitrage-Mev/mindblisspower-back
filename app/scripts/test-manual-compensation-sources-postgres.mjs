// Entirely synthetic, opt-in PostgreSQL rehearsal. No host/cloud DSN, .env,
// customer data, provider network, OTP, payment or production write is accepted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

if (process.argv.slice(2).join(' ') !== '--synthetic-docker') throw new Error('Requires --synthetic-docker');
const image = 'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27';
const container = `manual-source-91-${randomBytes(8).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const environment = { ...process.env, POSTGRES_PASSWORD: password };
const database = 'manual_sources_synthetic';
const blockedDatabase = 'manual_sources_claimed';
const runtime = 'manual_source_runtime';
const reader = 'manual_source_reader';
const allowedDatabases = new Set(['postgres', database, blockedDatabase]);
const migrationPath = '../../_meta/migration/91_manual_compensation_sources.sql';
const migration = await readFile(new URL(migrationPath, import.meta.url), 'utf8');
let started = false;
let assertions = 0;

function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); assertions++; }
function run(args, input, success = true) {
  const result = spawnSync('docker', args, { env: environment, input, encoding: 'utf8', windowsHide: true,
    timeout: 60_000, maxBuffer: 6 * 1024 * 1024 });
  const diagnostic = String(result.stderr || result.stdout || result.error?.code || 'SYNTHETIC_DOCKER_FAILED')
    .replaceAll(password, '[redacted]');
  if (success && result.status !== 0) throw new Error(diagnostic);
  if (!success) { assert.notEqual(result.status, 0, 'synthetic operation must be rejected'); assertions++; return diagnostic; }
  return result.stdout.trim();
}
function sql(query, { db = database, user = 'postgres', success = true } = {}) {
  assert.ok(allowedDatabases.has(db));
  assert.ok(['postgres', runtime, reader].includes(user));
  return run(['exec', '-i', container, 'psql', '-X', '-q', '-A', '-t', '-F', '|', '-P', 'null=NULL',
    '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db], query, success);
}
async function applyFiles(paths) {
  const bodies = await Promise.all(paths.map(async path => `\n-- Synthetic fixture source: ${path}\n${
    (await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'))
      .split(/\r?\n/).filter(line => !line.trimStart().startsWith('\\')).join('\n')}`));
  sql(bodies.join('\n'));
}
const nowId = '11111111-1111-4111-8111-111111111111';
const missingNowId = '11111111-1111-4111-8111-111111111112';
const manualId = index => `22222222-2222-4222-8222-${index.toString().padStart(12, '0')}`;
const manifestColumns = `id,operation_key,person_id,affiliate_id,package_id,affiliate_package_id,
  investment_cd_id,plan_config_id,roi_tier_id,cd_lock_days,lifetime_cap_factor,plan_snapshot,
  roi_base_annual_rate,roi_qualified_annual_rate,gross_usd,fee_rate,fee_usd,net_usd,pv,
  effective_at,approved_at,actor_reason,authorization_digest,created_at`;

function manualOrder(index, overrides = {}) {
  const o = { person: '3', affiliate: '3', catalog: '9100', amount: '100', pv: '100', feeRate: '.03', fee: '3',
    net: '97', effective: 'now()', approved: 'now()', method: "'manual'", snapshot: 'to_jsonb(p)',
    created: 'now()', sourceKind: "'manual'", state: "'activated'", ...overrides };
  return `BEGIN;
    SELECT pg_advisory_xact_lock(hashtextextended('nowpayments-scoped-engine-v1',0));
    CREATE TEMP TABLE synthetic_manual_order_rows(package_id bigint,cd_id bigint) ON COMMIT DROP;
    WITH ap AS (
      INSERT INTO mlm.affiliate_package(affiliate_id,package_id,status,payment_method,transaction_hash,pv_remaining,activated_at)
      VALUES(${o.affiliate},${o.catalog},'active',${o.method},'manual:production:${manualId(index)}',100,${o.effective}) RETURNING id
    ) INSERT INTO synthetic_manual_order_rows(package_id) SELECT id FROM ap;
    WITH cd AS (
      INSERT INTO mlm.investment_cd(affiliate_id,affiliate_package_id,principal_usd,roi_tier_id,start_at,matures_at)
      SELECT ${o.affiliate},package_id,100,1,${o.effective},${o.effective}+interval '365 days' FROM synthetic_manual_order_rows RETURNING id
    ) UPDATE synthetic_manual_order_rows SET cd_id=cd.id FROM cd;
    INSERT INTO payments.manual_membership_order(${manifestColumns},source_kind,state)
      SELECT '${manualId(index)}','manual-membership:synthetic-${index.toString().padStart(4, '0')}',
        ${o.person},${o.affiliate},${o.catalog},r.package_id,r.cd_id,p.id,1,365,2,${o.snapshot},.25,.30,
        ${o.amount},${o.feeRate},${o.fee},${o.net},${o.pv},${o.effective},${o.approved},
        'Explicit synthetic operator authorization',repeat('a',64),${o.created},${o.sourceKind},${o.state}
      FROM synthetic_manual_order_rows r CROSS JOIN mlm.plan_config p WHERE p.version_label='synthetic-manual-v1';
    COMMIT;`;
}
function stateDigest() {
  return sql(`SELECT md5(jsonb_build_object(
    'auth',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM auth."user" u),
    'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY subject) FROM identity.auth_binding b),
    'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM mlm.person p),
    'tree',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM mlm.affiliate a),
    'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM mlm.wallet_movement m)
  )::text);`);
}
function binaryAllocation({ factor = '.98', entitlement = '9.80', unit = '10', missing = false, incomplete = false,
  wrongFactor = false, wrongAffiliate = false, duplicate = false } = {}) {
  return `BEGIN;
    WITH period AS (INSERT INTO payments.nowpayments_engine_period(period_start,period_end)
      VALUES(now(),now()+interval '7 days') RETURNING id),
    obligation AS (INSERT INTO payments.nowpayments_engine_obligation(external_ref,source_attempt_id,period_id,
      affiliate_id,affiliate_package_id,kind,entitlement_usd,unit_gross_usd,commission_factor,available_at)
      SELECT 'comp:binary:synthetic:${randomBytes(8).toString('hex')}',m.id,p.id,${wrongAffiliate ? '2' : '1'},
        m.affiliate_package_id,'binary_bonus',${entitlement},${unit},${factor},
        ((now() AT TIME ZONE 'America/Bogota')+interval '1 month') AT TIME ZONE 'America/Bogota'
      FROM payments.manual_membership_order m CROSS JOIN period p WHERE m.id='${manualId(6)}' RETURNING id)
    ${missing ? 'SELECT id FROM obligation;' : `INSERT INTO payments.compensation_binary_allocation(affiliate_id,block_no,leg,source_id,pv,commission_factor,obligation_id)
      SELECT 1,1,'L','${nowId}'::uuid,${incomplete ? '499' : '500'},${wrongFactor ? '.97' : '.99'},id FROM obligation
      UNION ALL SELECT 1,1,'R',m.id,100,.97,o.id FROM payments.manual_membership_order m CROSS JOIN obligation o
      WHERE m.id IN(${[1, 2, 3, 4, 5].map(i => `'${manualId(i)}'`).join(',')});`}
    ${duplicate ? `INSERT INTO payments.compensation_binary_allocation SELECT * FROM payments.compensation_binary_allocation WHERE leg='L';` : ''}
    COMMIT;`;
}

try {
  run(['run', '--pull=never', '--detach', '--name', container, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
    '--env', 'POSTGRES_PASSWORD', image]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 }).status === 0) {
      ready = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  equal(ready, true, 'disposable PostgreSQL must become ready');
  equal(run(['inspect', container, '--format', '{{.HostConfig.NetworkMode}}|{{len .HostConfig.PortBindings}}']), 'none|0');
  sql(`CREATE DATABASE ${database};`, { db: 'postgres' });
  sql(`CREATE EXTENSION ltree VERSION '1.2';
    CREATE ROLE engine_write NOLOGIN; CREATE ROLE engine_read NOLOGIN; CREATE ROLE vp_engine NOLOGIN;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${reader} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`);
  equal(sql('SHOW server_version_num;'), '170011');
  const helpers = await readFile(new URL('../../vp-engine/internal/payments/testhelpers_test.go', import.meta.url), 'utf8');
  const baseFiles = [...helpers.matchAll(/"(_meta\/[^"\r\n]+\.sql)"/g)].map(match => match[1]);
  assert.ok(baseFiles.length >= 30 && baseFiles.includes('_meta/schema_mlm.sql'));
  await applyFiles(baseFiles);
  await applyFiles(['70_stable_identity_bindings.sql', '74_nowpayments_membership_review.sql', '75_nowpayments_webhook_capture.sql',
    '77_nowpayments_included_pricing.sql', '79_nowpayments_operational_orders.sql', '80_nowpayments_scoped_engine.sql',
    '82_nowpayments_calendar_maturity.sql'].map(name => `_meta/migration/${name}`));
  sql(`INSERT INTO auth."user"(id,email,email_verified) VALUES('synthetic-now-buyer','now@example.invalid',true);
    INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,is_admin) VALUES
      ('Synthetic','Root','root@example.invalid','0','active',true),
      ('Synthetic','NOW','now@example.invalid','0','active',false),
      ('Synthetic','Manual','manual@example.invalid','0','active',false);
    INSERT INTO mlm.affiliate(person_id,parent_id,sponsor_id,position,status) VALUES
      (1,NULL,NULL,NULL,'active'),(2,1,1,'L','active'),(3,1,1,'R','active');
    SELECT set_config('app.bypass_approval','on',false);
    INSERT INTO mlm.plan_config(version_label,effective_from,block_size,bonus_per_block,depth_cap,daily_cap_factor,
      lifetime_cap_factor,treasury_alpha,carry_decay_days,qualified_directs_left,qualified_directs_right,created_by_person_id)
      VALUES('synthetic-manual-v1',now()-interval '1 day',500,10,10,3,2,.45,14,1,1,1);
    INSERT INTO mlm.package(id,name,amount_usd,pv,type) VALUES
      (9100,'Synthetic manual100',100,100,'enrollment'),(9101,'Synthetic NOW500',500,500,'enrollment'),
      (9102,'Synthetic NOW unverified',100,100,'enrollment');
    INSERT INTO payments.nowpayments_membership_attempt(id,environment,auth_subject,person_id,person_public_id,affiliate_id,
      sponsor_affiliate_id,package_id,package_name,pv,amount_usd,fee_usd,total_cents,pricing_policy,provider_cost_usd,commission_base_usd)
      SELECT '${nowId}','production','synthetic-now-buyer',2,public_id,2,1,9101,'Synthetic NOW500',500,500,0,50000,
        'catalog_includes_provider_1pct_v1',5,495 FROM mlm.person WHERE id=2;
    INSERT INTO payments.nowpayments_operational_order(attempt_id,capacity_slot,plan_config_id,roi_tier_id,cd_lock_days,
      lifetime_cap_factor,plan_snapshot,roi_base_annual_rate,roi_qualified_annual_rate)
      SELECT '${nowId}',1,id,1,365,2,to_jsonb(p),.25,.30 FROM mlm.plan_config p;
    GRANT USAGE ON SCHEMA mlm,payments TO ${runtime},${reader};
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON TABLES TO ${runtime};
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT EXECUTE ON FUNCTIONS TO ${runtime};`);
  const beforeDDL = stateDigest();
  sql(`CREATE DATABASE ${blockedDatabase} TEMPLATE ${database};`, { db: 'postgres' });
  sql('INSERT INTO payments.nowpayments_engine_binary_state(affiliate_id,claimed_blocks) VALUES(1,1);', { db: blockedDatabase });
  assert.match(sql(migration, { db: blockedDatabase, success: false }), /manual_source_requires_approved_binary_allocation_backfill/);
  assertions++;
  equal(sql(`SELECT to_regclass('payments.compensation_source') IS NULL AND NOT EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid='payments.nowpayments_engine_binary_state'::regclass AND attname='claimed_prefix_hash' AND NOT attisdropped);`, { db: blockedDatabase }), 't');
  sql(migration);
  equal(stateDigest(), beforeDDL, 'DDL must preserve auth, persons, ranks, positions and ledger');
  equal(sql('SELECT id::text,source_kind,nowpayments_attempt_id::text,manual_order_id FROM payments.compensation_source;'), `${nowId}|nowpayments|${nowId}|NULL`);
  equal(sql('SELECT count(*) FROM payments.v_compensation_source;'), '0', 'classification alone is not verified evidence');
  equal(sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='payments' AND p.proname IN('protect_manual_membership_order','classify_compensation_source',
      'validate_compensation_binary_allocation','check_compensation_binary_block','check_compensation_binary_obligation')
    AND p.prosecdef;`), '0');
  for (const table of ['manual_membership_order', 'compensation_source', 'v_compensation_source', 'compensation_binary_allocation', 'v_compensation_obligation_origin']) {
    equal(sql(`SELECT NOT has_table_privilege('${runtime}','payments.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE');`), 't', 'default ACL must not leak runtime privileges');
  }
  equal(sql(`SELECT NOT has_function_privilege('${runtime}','payments.protect_manual_membership_order()','EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid='payments.protect_manual_membership_order()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE');`), 't');
  equal(sql(`SELECT count(*) FROM pg_constraint WHERE conrelid IN('payments.nowpayments_engine_roi_state'::regclass,
    'payments.nowpayments_engine_roi_rate_day'::regclass,'payments.nowpayments_engine_obligation'::regclass)
    AND confrelid='payments.compensation_source'::regclass;`), '4');
  const beforeOrders = stateDigest();
  for (let index = 1; index <= 5; index++) sql(manualOrder(index));
  sql(manualOrder(6, { person: '1', affiliate: '1' }));
  equal(stateDigest(), beforeOrders, 'manual source must not mutate auth identities, tree, ranks or ledger');
  equal(sql(`SELECT count(*),sum(gross_usd),sum(fee_usd),sum(net_usd),sum(pv),bool_and(state='activated')
    FROM payments.manual_membership_order;`), '6|600.00|18.0000|582.0000|600|t');
  equal(sql(`SELECT count(*),bool_and(source_kind='manual') FROM payments.v_compensation_source;`), '6|t');
  equal(sql(`SELECT count(*) FROM auth."user" WHERE email='manual@example.invalid';`), '0', 'no auth account is fabricated');
  equal(sql(`SELECT count(*) FROM payments.nowpayments_membership_receipt;`), '0', 'manual order creates no provider evidence');
  equal(sql(`SELECT bool_and(matures_at=start_at+interval '365 days' AND principal_usd=100)
    FROM mlm.investment_cd WHERE affiliate_id=3;`), 't');
  const beforeRejected = sql(`SELECT (SELECT count(*) FROM payments.manual_membership_order),
    (SELECT count(*) FROM mlm.affiliate_package),(SELECT count(*) FROM mlm.investment_cd);`);
  for (const overrides of [
    { person: '2' }, { amount: '101' }, { pv: '99' }, { feeRate: '.01', fee: '1', net: '99' },
    { fee: '4' }, { net: '98' }, { snapshot: "'{}'::jsonb" }, { method: "'nowpayments'" },
    { effective: "now()-interval '1 day'", approved: "now()-interval '1 day'" },
    { effective: "now()+interval '1 hour'", approved: "now()+interval '1 hour'" },
    { state: "'risk_review'" }, { sourceKind: "'nowpayments'" },
  ]) sql(manualOrder(100, overrides), { success: false });
  equal(sql(`SELECT (SELECT count(*) FROM payments.manual_membership_order),
    (SELECT count(*) FROM mlm.affiliate_package),(SELECT count(*) FROM mlm.investment_cd);`), beforeRejected, 'rejected manifests roll back their linked package and CD');
  sql(`INSERT INTO payments.manual_membership_order SELECT * FROM payments.manual_membership_order WHERE id='${manualId(1)}'
    ON CONFLICT(operation_key) DO NOTHING;`);
  equal(sql('SELECT count(*) FROM payments.manual_membership_order;'), '6', 'operation key retry must not duplicate source');
  sql(`INSERT INTO payments.manual_membership_order SELECT * FROM payments.manual_membership_order LIMIT 1;`, { success: false });
  for (const query of [
    "UPDATE payments.manual_membership_order SET net_usd=99;", 'DELETE FROM payments.manual_membership_order;',
    'TRUNCATE payments.manual_membership_order;', "UPDATE payments.compensation_source SET source_kind='nowpayments';",
    'DELETE FROM payments.compensation_source;', 'TRUNCATE payments.compensation_source;',
  ]) sql(query, { success: false });
  sql(`INSERT INTO payments.manual_membership_order SELECT * FROM payments.manual_membership_order LIMIT 1;`, { user: runtime, success: false });
  sql('SELECT * FROM payments.manual_membership_order;', { user: runtime, success: false });
  sql(`INSERT INTO payments.compensation_source(id,source_kind,nowpayments_attempt_id,manual_order_id)
    VALUES(gen_random_uuid(),'manual','${nowId}','${manualId(1)}');`, { success: false });
  sql(`INSERT INTO payments.nowpayments_engine_binary_state(affiliate_id,claimed_blocks) VALUES(1,1);`, { success: false });

  // Add an awaiting NOW order after migration to test the invoker classifier.
  sql(`INSERT INTO payments.nowpayments_membership_attempt(id,environment,auth_subject,person_id,person_public_id,affiliate_id,
      package_id,package_name,pv,amount_usd,fee_usd,total_cents,pricing_policy,provider_cost_usd,commission_base_usd)
    SELECT '${missingNowId}','production','synthetic-now-buyer',2,public_id,2,9102,'Synthetic unverified',100,100,0,10000,
      'catalog_includes_provider_1pct_v1',1,99 FROM mlm.person WHERE id=2;
    INSERT INTO payments.nowpayments_operational_order(attempt_id,capacity_slot,plan_config_id,roi_tier_id,cd_lock_days,
      lifetime_cap_factor,plan_snapshot,roi_base_annual_rate,roi_qualified_annual_rate)
    SELECT '${missingNowId}',2,id,1,365,2,to_jsonb(p),.25,.30 FROM mlm.plan_config p;`);
  equal(sql(`SELECT count(*) FROM payments.compensation_source WHERE id='${missingNowId}';`), '1');
  equal(sql(`SELECT count(*) FROM payments.v_compensation_source WHERE source_kind='nowpayments';`), '0');

  // All provider evidence here is fabricated ONLY inside this isolated fixture.
  sql(`BEGIN;
    UPDATE payments.nowpayments_membership_attempt SET invoice_id='99001',payment_id='99002',state='pending_review' WHERE id='${nowId}';
    WITH ap AS (INSERT INTO mlm.affiliate_package(affiliate_id,package_id,status,payment_method,transaction_hash,pv_remaining,activated_at)
      VALUES(2,9101,'active','nowpayments','nowpayments:production:99002',500,now()) RETURNING id),
    cd AS (INSERT INTO mlm.investment_cd(affiliate_id,affiliate_package_id,principal_usd,roi_tier_id,start_at,matures_at)
      SELECT 2,id,500,1,now(),now()+interval '365 days' FROM ap RETURNING id,affiliate_package_id),
    pv AS (INSERT INTO payments.nowpayments_operational_pv_source(attempt_id,affiliate_id,pv) VALUES('${nowId}',2,500) RETURNING id),
    inflow AS (INSERT INTO payments.nowpayments_operational_inflow(attempt_id,gross_usd,provider_cost_usd,net_usd,payment_ref)
      VALUES('${nowId}',500,5,495,'nowpayments:production:99002') RETURNING id)
    UPDATE payments.nowpayments_operational_order SET state='activated',affiliate_id=2,affiliate_package_id=cd.affiliate_package_id,
      investment_cd_id=cd.id,pv_source_id=pv.id,inflow_id=inflow.id,activated_at=now() FROM cd,pv,inflow WHERE attempt_id='${nowId}';
    COMMIT;`);
  equal(sql(`SELECT count(*) FROM payments.v_compensation_source WHERE source_kind='nowpayments';`), '0', 'activated flag is not provider proof');
  sql(`INSERT INTO payments.nowpayments_payment_binding(environment,payment_id,attempt_id) VALUES('production','99002','${nowId}');
    INSERT INTO payments.nowpayments_membership_receipt(attempt_id,environment,payment_id,body_sha256,api_sha256,
      signed_evidence,api_evidence,finished_verified,multiple_payments)
      VALUES('${nowId}','production','99002',repeat('b',64),repeat('c',64),'{}','{"payment_status":"finished"}',true,false);`);
  equal(sql(`SELECT count(*) FROM payments.v_compensation_source WHERE source_kind='nowpayments';`), '0', 'receipt alone is insufficient');
  sql(`INSERT INTO payments.nowpayments_webhook_capture(environment,payment_id,invoice_id,order_id,matched_attempt_id,
      payment_status,finished_verified,risk_detected,disposition,body_sha256,api_sha256,signed_evidence,api_evidence)
    VALUES('production','99002','99001','${nowId}','${nowId}','finished',true,false,'matched',repeat('b',64),repeat('c',64),'{}','{}');`);
  equal(sql(`SELECT source_id::text,pv,gross_usd,net_usd FROM payments.v_compensation_source WHERE source_kind='nowpayments';`), `${nowId}|500|500.00|495.0000`);
  equal(sql(`BEGIN;
    INSERT INTO payments.nowpayments_membership_receipt(attempt_id,environment,payment_id,body_sha256,api_sha256,
      signed_evidence,api_evidence,finished_verified,multiple_payments)
    VALUES('${nowId}','production','99002',repeat('d',64),repeat('e',64),'{}','{"payment_status":"refunded"}',false,false);
    SELECT count(*) FROM payments.v_compensation_source WHERE source_kind='nowpayments'; ROLLBACK;`), '0', 'conflicting provider status excludes the NOW source');
  equal(sql(`BEGIN; UPDATE mlm.investment_cd SET principal_usd=101 WHERE id=(SELECT investment_cd_id
    FROM payments.manual_membership_order WHERE id='${manualId(1)}');
    SELECT count(*) FROM payments.v_compensation_source WHERE source_id='${manualId(1)}'; ROLLBACK;`), '0', 'mismatched principal is not an eligible manual source');
  sql(`INSERT INTO payments.nowpayments_engine_roi_state(attempt_id,cutoff_date) VALUES('${manualId(1)}',CURRENT_DATE);
    INSERT INTO payments.nowpayments_engine_roi_rate_day(attempt_id,cutoff_date,principal_usd,annual_rate,qualified,rate_day_numerator,entitlement_usd,credited_usd)
    VALUES('${manualId(1)}',CURRENT_DATE,100,.25,false,25,.06,.06);`);
  equal(sql(`SELECT count(*) FROM payments.nowpayments_engine_roi_state WHERE attempt_id='${manualId(1)}';`), '1', 'manual UUID is a canonical engine FK');
  sql(`INSERT INTO payments.nowpayments_engine_obligation(external_ref,source_attempt_id,affiliate_id,affiliate_package_id,
      kind,entitlement_usd,unit_gross_usd,commission_factor,available_at)
    SELECT 'comp:roi:synthetic:lock',m.id,m.affiliate_id,m.affiliate_package_id,'roi',.06,0,1,c.matures_at
      FROM payments.manual_membership_order m JOIN mlm.investment_cd c ON c.id=m.investment_cd_id WHERE m.id='${manualId(1)}';`);
  equal(sql(`SELECT e.available_at=c.matures_at FROM payments.nowpayments_engine_obligation e
    JOIN payments.manual_membership_order m ON m.id=e.source_attempt_id JOIN mlm.investment_cd c ON c.id=m.investment_cd_id
    WHERE e.external_ref='comp:roi:synthetic:lock';`), 't', 'ROI preserves the full principal maturity timestamp');
  for (const [index, created, available] of [
    [1, '2028-01-31T17:00:00Z', '2028-02-29T17:00:00Z'],
    [2, '2027-03-31T17:00:00Z', '2027-04-30T17:00:00Z'],
  ]) {
    equal(sql(`BEGIN;
      WITH p AS(INSERT INTO payments.nowpayments_engine_period(period_start,period_end)
        VALUES('${created}'::timestamptz,'${created}'::timestamptz+interval '7 days') RETURNING id)
      INSERT INTO payments.nowpayments_engine_obligation(external_ref,source_attempt_id,earning_source_id,period_id,affiliate_id,affiliate_package_id,
        kind,entitlement_usd,commission_factor,created_at,available_at)
      SELECT 'comp:calendar:synthetic:${index}',m.id,'${manualId(1)}',p.id,m.affiliate_id,m.affiliate_package_id,'direct_bonus',4.85,.97,
        '${created}'::timestamptz,'${available}'::timestamptz FROM payments.manual_membership_order m CROSS JOIN p WHERE m.id='${manualId(6)}';
      SELECT available_at='${available}'::timestamptz FROM payments.nowpayments_engine_obligation WHERE external_ref='comp:calendar:synthetic:${index}';
      ROLLBACK;`), 't', 'calendar-month hold clamps month ends without replacing them with thirty days');
  }
  const directOrigin = (origin, factor = '.99') => `BEGIN;
    WITH p AS(INSERT INTO payments.nowpayments_engine_period(period_start,period_end)
      VALUES(now(),now()+interval '7 days') RETURNING id)
    INSERT INTO payments.nowpayments_engine_obligation(external_ref,source_attempt_id,earning_source_id,period_id,
      affiliate_id,affiliate_package_id,kind,entitlement_usd,commission_factor,available_at)
    SELECT 'comp:origin:synthetic:direct',m.id,${origin},p.id,m.affiliate_id,m.affiliate_package_id,
      'direct_bonus',${factor === '.97' ? '4.85' : '24.75'},${factor},((now() AT TIME ZONE 'America/Bogota')+interval '1 month') AT TIME ZONE 'America/Bogota'
      FROM payments.manual_membership_order m CROSS JOIN p WHERE m.id='${manualId(6)}';
    SELECT source_provider FROM payments.v_compensation_obligation_origin v JOIN payments.nowpayments_engine_obligation e
      ON e.id=v.obligation_id WHERE e.external_ref='comp:origin:synthetic:direct'; ROLLBACK;`;
  equal(sql(directOrigin(`'${nowId}'`)), 'nowpayments', 'actual NOW sale stays NOW even when beneficiary owns a manual package');
  equal(sql(directOrigin(`'${manualId(1)}'`, '.97')), 'manual');
  sql(directOrigin('NULL'), { success: false });
  sql(directOrigin(`'${nowId}'`, '.97'), { success: false });
  sql(`UPDATE payments.nowpayments_engine_obligation SET earning_source_id=source_attempt_id WHERE kind='roi';`, { success: false });
  equal(sql(`SELECT v.source_provider FROM payments.v_compensation_obligation_origin v
    JOIN payments.nowpayments_engine_obligation e ON e.id=v.obligation_id WHERE e.kind='roi';`), 'manual');

  for (const options of [{ missing: true }, { incomplete: true }, { wrongFactor: true }, { wrongAffiliate: true },
    { factor: '.99' }, { entitlement: '9.81' }, { unit: '20' }, { duplicate: true }]) {
    sql(binaryAllocation(options), { success: false });
  }
  equal(sql('SELECT count(*) FROM payments.compensation_binary_allocation;'), '0');
  sql(binaryAllocation());
  equal(sql(`SELECT e.entitlement_usd,e.commission_factor,sum(a.pv),sum(a.pv*a.commission_factor),count(DISTINCT a.source_id)
    FROM payments.nowpayments_engine_obligation e JOIN payments.compensation_binary_allocation a ON a.obligation_id=e.id
    WHERE e.kind='binary_bonus' GROUP BY e.id;`), '9.80|0.980000|1000.00000000|980.00000000000000|6');
  equal(sql(`SELECT v.source_provider FROM payments.v_compensation_obligation_origin v
    JOIN payments.nowpayments_engine_obligation e ON e.id=v.obligation_id WHERE e.kind='binary_bonus';`), 'mixed', 'mixed binary origin follows consumed lots, not own package');
  equal(sql(`SELECT available_at=(((created_at AT TIME ZONE 'America/Bogota')+interval '1 month') AT TIME ZONE 'America/Bogota')
    FROM payments.nowpayments_engine_obligation WHERE kind='binary_bonus';`), 't');
  for (const query of ['UPDATE payments.compensation_binary_allocation SET pv=1;',
    'DELETE FROM payments.compensation_binary_allocation;', 'TRUNCATE payments.compensation_binary_allocation;']) sql(query, { success: false });
  sql(`GRANT SELECT ON payments.manual_membership_order,payments.compensation_source,payments.v_compensation_source,
    payments.nowpayments_operational_order,payments.nowpayments_membership_attempt,payments.nowpayments_operational_pv_source,
    payments.nowpayments_operational_inflow,payments.nowpayments_membership_receipt,payments.nowpayments_webhook_capture,
    mlm.affiliate,mlm.affiliate_package,mlm.package_cap_state,mlm.investment_cd TO ${reader};`);
  equal(sql('SELECT count(*) FROM payments.v_compensation_source;', { user: reader }), '7');
  sql(`UPDATE payments.manual_membership_order SET state='risk_review' WHERE id='${manualId(5)}';`);
  equal(sql(`SELECT count(*) FROM payments.v_compensation_source WHERE source_kind='manual';`), '5');
  sql(`UPDATE payments.manual_membership_order SET state='activated' WHERE id='${manualId(5)}';`, { success: false });
  sql(`UPDATE mlm.affiliate_package SET status='expired',expired_at=now() WHERE id=(SELECT affiliate_package_id FROM payments.manual_membership_order WHERE id='${manualId(4)}');
    UPDATE mlm.investment_cd SET status='closed',closed_at=now() WHERE id=(SELECT investment_cd_id FROM payments.manual_membership_order WHERE id='${manualId(4)}');`);
  equal(sql(`SELECT active,package_status,cd_status FROM payments.v_compensation_source WHERE source_id='${manualId(4)}';`), 'f|expired|closed', 'mature/expired history remains visible');
  equal(stateDigest(), beforeOrders, 'all source/accounting tests preserve original auth, tree, ranks and ledger');
  console.log(JSON.stringify({ status: 'passed', assertions, postgres: '17.11', network: 'none', publishedPorts: 0,
    scope: 'synthetic schema91/manual/canonical/weighted-binary/ACL', productionWrites: 0 }));
} finally {
  if (started) run(['rm', '--force', container]);
}
