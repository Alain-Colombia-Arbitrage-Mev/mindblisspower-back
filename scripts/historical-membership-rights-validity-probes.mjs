import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export async function runHistoricalMembershipRightsValidityProbes({ psql, value, concurrent, owner, runtime }) {
  const operator = 'mindbliss_stripe_rights_operator_v1', batch = '9f488abd-f4fd-421e-8bb7-3d92ca4ca199';
  const fileHash = 'e8d27b0af998f8a290a478d8f4e8b907e1f361e30b2ba0e350395a0405c38e20';
  const catHash = '1a66ef14184878c0a1ece0281b5607f6b4e274e67094d1502af47ee2e9c6a2a0';
  const policy = 'historical_membership_access_until_revoked_v1', pi = i => `pi_rights118${String(i).padStart(4, '0')}`;
  const literal = v => `'${String(v).replaceAll("'", "''")}'`, json = v => `${literal(JSON.stringify(v))}::jsonb`;
  const admin = source => value(source, ''), exec = (source, role = operator) => value(source, role);
  let probes = 0;
  const equal = (source, expected, role = '') => { assert.equal(value(source, role), expected, source); probes++; };
  const deny = (source, pattern, role = operator) => { const result = psql(`SET ROLE ${role};${source}`, true); assert.notEqual(result.status, 0, source); if (pattern) assert.match(result.stderr, pattern); probes++; };
  psql(`CREATE SCHEMA IF NOT EXISTS recovery;
   ALTER TABLE mlm.affiliate_package ADD COLUMN IF NOT EXISTS transaction_hash text;
   ALTER TABLE payments.purchase_intent ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
   CREATE TABLE IF NOT EXISTS payments.manual_membership_order(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),person_id bigint,state text);
   CREATE TABLE IF NOT EXISTS payments.sales_import_batch(id uuid PRIMARY KEY,file_sha256 text NOT NULL,status text NOT NULL,row_count bigint NOT NULL);
   CREATE TABLE IF NOT EXISTS payments.admin_sales_source(provider text PRIMARY KEY,active_batch_id uuid NOT NULL);
   CREATE TABLE IF NOT EXISTS payments.stripe_sale(payment_intent_id text PRIMARY KEY);
   ALTER TABLE payments.stripe_sale ADD COLUMN IF NOT EXISTS source_record_sha256 text,
    ADD COLUMN IF NOT EXISTS livemode boolean,ADD COLUMN IF NOT EXISTS payment_status text,ADD COLUMN IF NOT EXISTS charged_at timestamptz,
    ADD COLUMN IF NOT EXISTS currency text,ADD COLUMN IF NOT EXISTS captured_minor bigint,ADD COLUMN IF NOT EXISTS gross_minor bigint,
    ADD COLUMN IF NOT EXISTS refunded_minor bigint,ADD COLUMN IF NOT EXISTS dispute_count integer,
    ADD COLUMN IF NOT EXISTS metadata jsonb,ADD COLUMN IF NOT EXISTS source_eligible boolean,ADD COLUMN IF NOT EXISTS source_review_reasons jsonb,
    ADD COLUMN IF NOT EXISTS product_evidence jsonb;
   CREATE TABLE IF NOT EXISTS recovery.stripe_sale_identity(payment_intent_id text PRIMARY KEY,person_id bigint,affiliate_id bigint,identity_verified boolean,catalog_verified boolean);
   CREATE TABLE IF NOT EXISTS recovery.package_catalog_snapshot(source_package_id bigint PRIMARY KEY,currency text,base_minor bigint,fee_minor bigint,source_sha256 text);
   CREATE TABLE IF NOT EXISTS payments.sales_import_row(batch_id uuid NOT NULL,external_id text NOT NULL,provider_reference text,source_row integer,
    record_sha256 text,canonical_payment_intent_id text,person_id bigint,affiliate_id bigint,package_id bigint,package_name text,base_minor bigint,
    gross_minor bigint,currency text,paid_at timestamptz,refunded_minor bigint,canonical_refunded_minor bigint,canonical_dispute_count integer,
    canonical_source_eligible boolean,activation_status text,provider_verified boolean,commission_eligible boolean,product_scope text,
    display_status text,source_status text,risk_status text,PRIMARY KEY(batch_id,external_id));
   INSERT INTO mlm.person(id,public_id,email,status,first_name,last_name,phone_number)VALUES(18001,gen_random_uuid(),'rights-pending@example.invalid','pending','Rights','Pending','');
   INSERT INTO mlm.affiliate(id,person_id,status,invitation_link)VALUES(180001,18001,'pending','RIGHTS-PENDING');
   INSERT INTO payments.sales_import_batch VALUES('${batch}','${fileHash}','reviewed',737);
   INSERT INTO payments.admin_sales_source VALUES('stripe','${batch}');
   INSERT INTO recovery.package_catalog_snapshot VALUES(1001,'usd',10000,100,'${catHash}');
   INSERT INTO payments.stripe_sale(payment_intent_id,source_record_sha256,livemode,payment_status,charged_at,currency,captured_minor,gross_minor,
    refunded_minor,dispute_count,metadata,source_eligible,source_review_reasons,product_evidence)
   SELECT 'pi_rights118'||lpad(n::text,4,'0'),encode(sha256(convert_to('canonical118:'||n,'UTF8')),'hex'),true,'succeeded','2024-01-10T12:00:00Z','usd',10100,10100,
    0,0,'{"packmindbliss":"true","package_id":"1001"}'::jsonb,n<=4,'[]'::jsonb,'["explicit_product_tag"]'::jsonb FROM generate_series(1,737)n;
   INSERT INTO recovery.stripe_sale_identity
   SELECT 'pi_rights118'||lpad(n::text,4,'0'),CASE n WHEN 1 THEN 11700 WHEN 2 THEN 11701 WHEN 3 THEN 18001 WHEN 4 THEN 11700 END,
    CASE n WHEN 1 THEN 117000 WHEN 3 THEN 180001 WHEN 4 THEN 117000 END,n<=4,n<=4 FROM generate_series(1,737)n;
   INSERT INTO payments.sales_import_row
   SELECT '${batch}','pi_rights118'||lpad(n::text,4,'0'),'ch_rights118'||lpad(n::text,4,'0'),n,encode(sha256(convert_to('row118:'||n,'UTF8')),'hex'),
    'pi_rights118'||lpad(n::text,4,'0'),CASE n WHEN 1 THEN 11700 WHEN 2 THEN 11701 WHEN 3 THEN 18001 WHEN 4 THEN 11700 END,
    CASE n WHEN 1 THEN 117000 WHEN 3 THEN 180001 WHEN 4 THEN 117000 END,1001,'1001',10000,10100,'usd','2024-01-10T12:00:00Z',0,0,0,n<=4,
    'not_inferred_from_import',false,false,CASE WHEN n<=733 THEN 'mindbliss_membership' ELSE 'unattributed' END,
    CASE WHEN n<=4 THEN 'paid' ELSE 'under_review' END,CASE WHEN n<=4 THEN 'Paid' ELSE 'En Revisión' END,
    CASE WHEN n<=4 THEN 'none' ELSE 'source_review' END FROM generate_series(1,737)n;
   GRANT USAGE ON SCHEMA recovery TO ${owner};
   GRANT SELECT ON payments.sales_import_batch,payments.sales_import_row,payments.admin_sales_source,payments.stripe_sale,
    recovery.stripe_sale_identity,recovery.package_catalog_snapshot,payments.manual_membership_order TO ${owner};
   ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO referral117_default;`);
  const tables = ['payments.stripe_membership_rights_run', 'payments.stripe_membership_entitlement', 'payments.stripe_membership_rights_event'];
  const signatures = ['payments.reject_stripe_membership_rights_mutation()', 'payments.stripe_membership_rights_source_snapshot(text)',
    'payments.register_stripe_membership_rights_run(uuid,jsonb,text,text,text)', 'payments.recognize_stripe_membership_right(uuid,text)',
    'payments.record_stripe_membership_rights_decision(uuid,text,text,text,text,text)', 'payments.read_member_package_rights(text,text)'];
  const rowsQuery = `SELECT jsonb_object_agg(name,fingerprint)::text FROM(SELECT n.nspname||'.'||c.relname name,
   md5(coalesce((xpath('/row/value/text()',query_to_xml(format('SELECT string_agg(to_jsonb(t)::text,E''\\n''ORDER BY to_jsonb(t)::text) AS value FROM %I.%I t',n.nspname,c.relname),false,true,'')))[1]::text,''))fingerprint
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r'AND n.nspname IN('identity','payments','mlm','auth','recovery')
   AND n.nspname||'.'||c.relname NOT IN(${tables.map(literal).join(',')}))s;`;
  const oldFunctions = `SELECT md5(coalesce(string_agg(pg_get_functiondef(p.oid)||p.proowner::text||coalesce(p.proacl::text,'')||coalesce(p.proconfig::text,''),E'\n'ORDER BY p.oid),''))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('identity','payments','mlm','recovery')AND p.oid NOT IN(${signatures.map(s => `coalesce(to_regprocedure(${literal(s)})::oid,0)`).join(',')});`;
  const before = { rows: admin(rowsQuery), functions: admin(oldFunctions) };
  const migration = await readFile(new URL('../_meta/migration/118_historical_membership_rights_only.sql', import.meta.url), 'utf8');
  psql(migration); equal(rowsQuery, before.rows); equal(oldFunctions, before.functions);
  const snapshot = i => JSON.parse(admin(`SELECT payments.stripe_membership_rights_source_snapshot('${pi(i)}')::text;`));
  const canonicalHash = object => admin(`SELECT encode(sha256(convert_to(${json(object)}::text,'UTF8')),'hex');`);
  const createManifest = ids => ({ version: 1, policy, sourceBatchId: batch, sourceFileSha256: fileHash,
    members: ids.map(i => { const s = snapshot(i); return { paymentIntentId: pi(i), recordSha256: s.recordSha256, snapshotSha256: canonicalHash(s),
      providerReadback: { paymentIntentId: pi(i), chargeReference: s.chargeReference, livemode: true, status: 'succeeded', currency: 'usd',
        capturedMinor: s.capturedMinor, refundedMinor: '0', disputeCount: 0, packmindbliss: true, paid: true, captured: true,
        sourceMetadataMatches: true, verifiedAt: new Date().toISOString(), proofSha256: 'b'.repeat(64) } }; }) });
  const register = (manifest, id = randomUUID(), digest = canonicalHash(manifest)) =>
    `SELECT row_to_json(r)::text FROM payments.register_stripe_membership_rights_run('${id}',${json(manifest)},'${digest}','synthetic-reviewed-operator','Explicit synthetic access rights only')r;`;
  const recognize = (run, i) => `SELECT row_to_json(r)::text FROM payments.recognize_stripe_membership_right('${run}','${pi(i)}')r;`;
  const own = (i, session = `ref117-session-${i}`) => `SELECT payments.read_member_package_rights('ref117-owner-${i}','${session}')::text;`;
  const manifest = createManifest([1, 2, 3, 4]), run = randomUUID();
  exec(register(manifest, run)); for (const i of [1, 2, 3]) exec(recognize(run, i));
  const changed = ['payments.stripe_membership_rights_source_snapshot(text)', 'payments.read_member_package_rights(text,text)'];
  const helper = 'payments.stripe_membership_rights_evidence_snapshot(text)';
  const functionInfo = signature => JSON.parse(admin(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),
   'owner',p.proowner,'securityDefiner',p.prosecdef,'proconfig',p.proconfig,'acl',p.proacl,'volatility',p.provolatile)::text FROM pg_proc p WHERE p.oid=${literal(signature)}::regprocedure;`));
  const allRows = rowsQuery.replace(`AND n.nspname||'.'||c.relname NOT IN(${tables.map(literal).join(',')})`, '');
  const others = `SELECT md5(coalesce(string_agg(pg_get_functiondef(p.oid)||p.proowner::text||coalesce(p.proacl::text,'')||coalesce(p.proconfig::text,''),E'\n'ORDER BY p.oid),''))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('identity','payments','mlm','recovery')AND p.oid NOT IN(${[...changed, helper].map(s => `coalesce(to_regprocedure(${literal(s)})::oid,0)`).join(',')});`;
  const original = { rows: admin(allRows), others: admin(others), functions: changed.map(functionInfo),
    snapshots: [1, 2, 3, 4].map(snapshot), dto: JSON.parse(exec(own(0), runtime)),
    journal: admin('SELECT jsonb_agg(to_jsonb(t)ORDER BY id)::text FROM payments.stripe_membership_entitlement t;') };
  assert.equal(createHash('sha256').update(migration).digest('hex'), '9a2237b18c8e041f10312ce2640d2a2f08b4b3197008a377a6b1c4a2b27d7790');
  const validityMigration = await readFile(new URL('../_meta/migration/119_historical_membership_rights_validity.sql', import.meta.url), 'utf8');
  psql(validityMigration);
  equal(allRows, original.rows); equal(others, original.others);
  for (const i of [1, 2, 3, 4]) {
    assert.deepEqual(snapshot(i), original.snapshots[i - 1]);
    const evidence = JSON.parse(admin(`SELECT payments.stripe_membership_rights_evidence_snapshot('${pi(i)}')::text;`));
    assert.deepEqual(evidence, original.snapshots[i - 1]);
    assert.equal(canonicalHash(evidence), canonicalHash(original.snapshots[i - 1])); probes += 3;
  }
  assert.deepEqual(JSON.parse(exec(own(0), runtime)), original.dto); probes++;
  const gates = [
    { patch: "UPDATE payments.admin_sales_source SET active_batch_id='00000000-0000-4000-8000-000000000000' WHERE provider='stripe';", target: 4 },
    { patch: "INSERT INTO payments.manual_membership_order(person_id,state)VALUES(11700,'activated');", target: 4 },
    { patch: `INSERT INTO mlm.affiliate_package(id,affiliate_id,status,transaction_hash)VALUES(11900001,117000,'active','${pi(1)}');`, target: 1 },
    { patch: `INSERT INTO payments.purchase_intent(stripe_payment_intent_id)VALUES('${pi(1)}');`, target: 1 },
  ];
  for (const { patch, target } of gates) {
    const read = JSON.parse(admin(`BEGIN;${patch}SET ROLE ${runtime};${own(0)}ROLLBACK;`));
    assert.deepEqual(read, original.dto); probes++;
    const evidence = JSON.parse(admin(`BEGIN;${patch}SELECT payments.stripe_membership_rights_evidence_snapshot('${pi(1)}')::text;ROLLBACK;`));
    assert.deepEqual(evidence, original.snapshots[0]); probes++;
    equal(`BEGIN;${patch}SELECT payments.stripe_membership_rights_source_snapshot('${pi(target)}') IS NULL;ROLLBACK;`, 't');
    const result = psql(`BEGIN;${patch}SET ROLE ${operator};${recognize(run, target)}ROLLBACK;`, true);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /member_package_rights_source_requires_review/); probes++;
  }
  for (const [table, condition, patch] of [
    ['payments.stripe_sale', `payment_intent_id='${pi(1)}'`, 'refunded_minor=1,source_eligible=false'],
    ['payments.stripe_sale', `payment_intent_id='${pi(1)}'`, 'dispute_count=1,source_eligible=false'],
    ['recovery.stripe_sale_identity', `payment_intent_id='${pi(1)}'`, 'person_id=11701'],
    ['recovery.stripe_sale_identity', `payment_intent_id='${pi(1)}'`, 'identity_verified=false'],
    ['recovery.stripe_sale_identity', `payment_intent_id='${pi(1)}'`, 'catalog_verified=false'],
    ['recovery.package_catalog_snapshot', 'source_package_id=1001', "source_sha256=repeat('e',64)"],
    ['payments.stripe_sale', `payment_intent_id='${pi(1)}'`, "product_evidence='[]'::jsonb"],
  ]) {
    const read = JSON.parse(admin(`BEGIN;UPDATE ${table} SET ${patch} WHERE ${condition};SET ROLE ${runtime};${own(0)}ROLLBACK;`));
    assert.equal(read.activeCount, 0); assert.equal(read.items[0].status, 'review_required'); probes += 2;
    equal(`BEGIN;UPDATE ${table} SET ${patch} WHERE ${condition};SELECT payments.stripe_membership_rights_evidence_snapshot('${pi(1)}') IS NULL;ROLLBACK;`, 't');
  }
  const proof = JSON.parse(exec(own(1), runtime)); assert.equal(proof.activeCount, 1); assert.equal(proof.items[0].term.type, 'until_revoked'); probes += 2;
  deny(own(0, 'ref117-session-1'), /member_package_rights_forbidden/, runtime);
  for (const role of [runtime, operator, 'referral117_default', 'mindbliss_go_payments_reader_v1']) equal(`SELECT has_function_privilege('${role}','${helper}','EXECUTE');`, 'f');
  const functions = [...changed, helper].map(functionInfo);
  for (const previous of original.functions) {
    const current = functions.find(fn => fn.signature === previous.signature);
    const permissions = fn => ({ owner: fn.owner, acl: fn.acl, config: fn.proconfig, definer: fn.securityDefiner, volatility: fn.volatility });
    assert.deepEqual(permissions(current), permissions(previous)); assert.notEqual(current.md5, previous.md5); probes += 2;
  }
  assert.equal(functions.find(fn => fn.signature === helper).owner, original.functions[0].owner); probes++;
  equal(`SELECT bool_and(a.grantee=p.proowner)FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl)a WHERE p.oid='${helper}'::regprocedure;`, 't');
  equal('SELECT jsonb_agg(to_jsonb(t)ORDER BY id)::text FROM payments.stripe_membership_entitlement t;', original.journal);
  equal(allRows, original.rows); equal(others, original.others);
  const report = { migrationSha256: createHash('sha256').update(validityMigration).digest('hex'), syntheticPostgresPassed: true, probes,
    tables: [], constraints: [], addedTriggers: [],
    functions: functions.map(fn => ({ ...fn, ownerReferenceSignature: 'identity.require_administrative_native_session(text,text)',
      runtimeExecute: fn.signature === 'payments.read_member_package_rights(text,text)', operatorExecute: false })),
    addedFunctions: [helper],
    changedFunctions: functions.filter(fn => changed.includes(fn.signature)).map(fn => ({ ...fn,
      beforeMd5: original.functions.find(previous => previous.signature === fn.signature).md5,
      ownerReferenceSignature: 'identity.require_administrative_native_session(text,text)',
      runtimeExecute: fn.signature === 'payments.read_member_package_rights(text,text)', operatorExecute: false })),
    allOldRowsUnchanged: true, allOtherFunctionsUnchanged: true, allExistingPermissionsUnchanged: true,
    sourceSnapshotJsonAndHashesUnchanged: true, grantOnlyGatesDoNotRevokeExistingAccess: true,
    currentEvidenceRiskAndIdentityDriftStillHeld: true, policy, productionConnections: 0, providerCalls: 0, charges: 0, transfers: 0, network: 'none' };
  await writeFile(new URL('../.wrangler/historical-membership-rights-119-manifest.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ historicalMembershipRightsValidity: 'passed', probes, newFunctions: 1, changedFunctions: 2,
    sourceSnapshotJsonAndHashesUnchanged: true, allOldRowsUnchanged: true, allExistingPermissionsUnchanged: true, syntheticOnly: true }));
}
