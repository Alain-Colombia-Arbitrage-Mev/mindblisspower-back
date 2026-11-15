import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export async function runHistoricalMembershipRightsProbes({ psql, value, concurrent, owner, runtime }) {
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
    0,0,'{"packmindbliss":"true","package_id":"1001"}'::jsonb,n<=3,'[]'::jsonb,'["explicit_product_tag"]'::jsonb FROM generate_series(1,737)n;
   INSERT INTO recovery.stripe_sale_identity
   SELECT 'pi_rights118'||lpad(n::text,4,'0'),CASE n WHEN 1 THEN 11700 WHEN 2 THEN 11701 WHEN 3 THEN 18001 END,
    CASE n WHEN 1 THEN 117000 WHEN 3 THEN 180001 END,n<=3,n<=3 FROM generate_series(1,737)n;
   INSERT INTO payments.sales_import_row
   SELECT '${batch}','pi_rights118'||lpad(n::text,4,'0'),'ch_rights118'||lpad(n::text,4,'0'),n,encode(sha256(convert_to('row118:'||n,'UTF8')),'hex'),
    'pi_rights118'||lpad(n::text,4,'0'),CASE n WHEN 1 THEN 11700 WHEN 2 THEN 11701 WHEN 3 THEN 18001 END,
    CASE n WHEN 1 THEN 117000 WHEN 3 THEN 180001 END,1001,'1001',10000,10100,'usd','2024-01-10T12:00:00Z',0,0,0,n<=3,
    'not_inferred_from_import',false,false,CASE WHEN n<=733 THEN 'mindbliss_membership' ELSE 'unattributed' END,
    CASE WHEN n<=3 THEN 'paid' ELSE 'under_review' END,CASE WHEN n<=3 THEN 'Paid' ELSE 'En Revisión' END,
    CASE WHEN n<=3 THEN 'none' ELSE 'source_review' END FROM generate_series(1,737)n;
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
  const manifest = createManifest([1, 2, 3]), run = randomUUID();
  for (const key of Object.keys(manifest)) { const copy = structuredClone(manifest); copy[key] = null; deny(register(copy), /member_package_rights_invalid_manifest/); }
  for (const key of Object.keys(manifest.members[0].providerReadback)) {
    const copy = structuredClone(manifest); copy.members[0].providerReadback[key] = null; deny(register(copy), /member_package_rights_provider_proof_required/);
  }
  for (const [key, invalid] of Object.entries({ livemode: false, captured: false, paid: false, sourceMetadataMatches: false, packmindbliss: false,
    status: 'processing', currency: 'eur', capturedMinor: '10101', refundedMinor: '1', disputeCount: 1, paymentIntentId: pi(2), chargeReference: 'ch_foreign118',
    verifiedAt: '2020-01-01T00:00:00Z', proofSha256: 'not-a-hash' })) {
    const copy = structuredClone(manifest); copy.members[0].providerReadback[key] = invalid; deny(register(copy), /member_package_rights_provider_proof_required/);
  }
  const duplicate = structuredClone(manifest); duplicate.members.push(duplicate.members[0]); deny(register(duplicate), /member_package_rights_invalid_manifest/);
  const mismatch = structuredClone(manifest); mismatch.members[0].snapshotSha256 = '0'.repeat(64); deny(register(mismatch), /member_package_rights_source_requires_review/);
  deny(register(manifest, randomUUID(), '0'.repeat(64)), /member_package_rights_invalid_manifest/);
  equal('SELECT count(*)FROM payments.stripe_membership_rights_run;', '0');
  const registered = JSON.parse(exec(register(manifest, run))); assert.equal(registered.id, run); assert.equal(registered.created, true); probes += 2;
  assert.equal(JSON.parse(exec(register(manifest, run))).created, false); probes++;
  const changedRun = structuredClone(manifest); changedRun.members.pop(); deny(register(changedRun, run), /member_package_rights_conflict/);
  deny(recognize(run, 1), /permission denied/, runtime); deny(register(manifest), /permission denied/, runtime);
  for (const [relation, where, patch] of [
    ['payments.stripe_sale', `payment_intent_id='${pi(1)}'`, "refunded_minor=1,source_eligible=false"],
    ['recovery.stripe_sale_identity', `payment_intent_id='${pi(1)}'`, 'identity_verified=false'],
    ['recovery.stripe_sale_identity', `payment_intent_id='${pi(1)}'`, 'person_id=11701'],
    ['recovery.stripe_sale_identity', `payment_intent_id='${pi(1)}'`, 'affiliate_id=180001'],
    ['recovery.stripe_sale_identity', `payment_intent_id='${pi(1)}'`, 'catalog_verified=false'],
    ['payments.stripe_sale', `payment_intent_id='${pi(1)}'`, "product_evidence='[]'::jsonb"],
    ['payments.stripe_sale', `payment_intent_id='${pi(1)}'`, "metadata='{" + '"packmindbliss":"false","package_id":"1001"' + "}'::jsonb"],
    ['payments.stripe_sale', `payment_intent_id='${pi(1)}'`, 'dispute_count=1,source_eligible=false'],
    ['payments.stripe_sale', `payment_intent_id='${pi(1)}'`, 'livemode=false'],
    ['payments.stripe_sale', `payment_intent_id='${pi(1)}'`, "currency='eur'"],
    ['recovery.package_catalog_snapshot', 'source_package_id=1001', "source_sha256=repeat('c',64)"],
    ['mlm.person', 'id=11700', "status='suspended'"],
    ['payments.admin_sales_source', "provider='stripe'", "active_batch_id='00000000-0000-4000-8000-000000000000'"],
  ]) {
    const result = psql(`BEGIN;UPDATE ${relation} SET ${patch} WHERE ${where};SET ROLE ${operator};${recognize(run, 1)}ROLLBACK;`, true);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /member_package_rights_source_requires_review/); probes++;
  }
  // Every mutation fixture is one disposable transaction and rolls back.
  const blocked = psql(`BEGIN;INSERT INTO mlm.blacklist(email_norm)VALUES('ref117-owner-0@example.invalid');SET ROLE ${operator};${recognize(run, 1)}ROLLBACK;`, true);
  assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /member_package_rights_source_requires_review/); probes++;
  const overlap = psql(`BEGIN;INSERT INTO payments.manual_membership_order(person_id,state)VALUES(11700,'activated');SET ROLE ${operator};${recognize(run, 1)}ROLLBACK;`, true);
  assert.notEqual(overlap.status, 0); assert.match(overlap.stderr, /member_package_rights_source_requires_review/); probes++;
  const raced = await Promise.all([concurrent(`SET ROLE ${operator};${recognize(run, 1)}`).complete, concurrent(`SET ROLE ${operator};${recognize(run, 1)}`).complete]);
  assert.ok(raced.every(x => x.status === 0), JSON.stringify(raced));
  assert.deepEqual(raced.map(x => JSON.parse(x.stdout.trim()).created).sort(), [false, true]); probes += 2;
  equal(`SELECT count(*)FROM payments.stripe_membership_entitlement WHERE payment_intent_id='${pi(1)}';`, '1');
  const first = JSON.parse(exec(own(0), runtime)); assert.equal(first.activeCount, 1); assert.equal(first.totalCount, 1); assert.equal(first.items[0].packageBaseUsd, '100.00');
  assert.equal(first.items[0].boughtAt, '2024-01-10T12:00:00.000000Z'); assert.equal(first.items[0].recognizedAt, first.items[0].term.startsAt);
  assert.notEqual(first.items[0].boughtAt, first.items[0].recognizedAt); assert.equal(first.items[0].term.endsAt, null); assert.equal(first.items[0].term.type, 'until_revoked');
  assert.deepEqual([first.rightsOnly, first.economicActivation, first.roiEnabled, first.commissionsEnabled], [true, false, false, false]); probes += 9;
  assert.equal(JSON.parse(exec(own(1), runtime)).totalCount, 0); probes++;
  deny(own(0, 'ref117-session-1'), /member_package_rights_forbidden/, runtime);
  deny(own(0, 'missing'), /member_package_rights_forbidden/, runtime);
  exec(recognize(run, 2)); exec(recognize(run, 3)); probes += 2;
  assert.equal(JSON.parse(exec(own(1), runtime)).activeCount, 1); equal('SELECT count(*)FROM mlm.affiliate WHERE person_id=11701;', '0'); probes++;
  equal('SELECT count(*)FROM identity.auth_binding WHERE person_id=18001;', '0'); equal('SELECT count(*)FROM payments.stripe_membership_entitlement WHERE person_id=18001;', '1');
  const event = randomUUID(), decision = `SELECT row_to_json(r)::text FROM payments.record_stripe_membership_rights_decision('${event}','${pi(1)}','revoked','synthetic-reviewed-operator','Scoped run rollback',repeat('d',64))r;`;
  assert.equal(JSON.parse(exec(decision)).created, true); assert.equal(JSON.parse(exec(decision)).created, false); probes += 2;
  const replay = JSON.parse(exec(recognize(run, 1))); assert.equal(replay.created, false); assert.equal(replay.state, 'revoked'); probes += 2;
  const revoked = JSON.parse(exec(own(0), runtime)); assert.equal(revoked.activeCount, 0); assert.equal(revoked.items[0].status, 'revoked'); probes += 2;
  deny(decision.replace('Scoped run rollback', 'changed reason'), /member_package_rights_conflict/);
  deny(decision.replace(event, randomUUID()).replace("'revoked'", "'suspended'"), /member_package_rights_revoked/);
  deny(decision.replace(event, randomUUID()).replace("'revoked'", "'active'"), /member_package_rights_invalid_decision/);
  const drift = JSON.parse(admin(`BEGIN;UPDATE payments.stripe_sale SET refunded_minor=1,source_eligible=false WHERE payment_intent_id='${pi(2)}';SET ROLE ${runtime};${own(1)}ROLLBACK;`));
  assert.equal(drift.items[0].status, 'review_required'); assert.equal(drift.activeCount, 0); probes += 2;
  for (const table of tables) {
    for (const role of [runtime, operator, 'referral117_default', 'mindbliss_go_payments_reader_v1']) equal(`SELECT has_table_privilege('${role}','${table}','SELECT,INSERT,UPDATE,DELETE');`, 'f');
    equal(`SELECT relrowsecurity FROM pg_class WHERE oid='${table}'::regclass;`, 't');
    deny(`UPDATE ${table} SET ${table.endsWith('_run') ? "actor='changed'" : table.endsWith('_event') ? "reason='changed'" : "package_name='changed'"};`, /member_package_rights_append_only/, owner);
  }
  const exposedNative = 'payments.read_member_package_rights(text,text)';
  const exposedOperator = new Set(signatures.slice(2, 5));
  const functions = signatures.map(signature => JSON.parse(admin(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),
   'owner',p.proowner,'securityDefiner',p.prosecdef,'proconfig',p.proconfig,'acl',p.proacl)::text FROM pg_proc p WHERE p.oid=${literal(signature)}::regprocedure;`)));
  for (const fn of functions) {
    assert.equal(fn.securityDefiner, true); probes++;
    equal(`SELECT has_function_privilege('${runtime}',${literal(fn.signature)},'EXECUTE');`, fn.signature === exposedNative ? 't' : 'f');
    equal(`SELECT has_function_privilege('${operator}',${literal(fn.signature)},'EXECUTE');`, exposedOperator.has(fn.signature) ? 't' : 'f');
    for (const role of ['referral117_default', 'mindbliss_go_payments_reader_v1']) equal(`SELECT has_function_privilege('${role}',${literal(fn.signature)},'EXECUTE');`, 'f');
  }
  equal(`SELECT (NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit)FROM pg_roles WHERE rolname='${operator}';`, 't');
  equal(`SELECT count(*)FROM pg_auth_members WHERE roleid='${operator}'::regrole OR member='${operator}'::regrole;`, '0');
  equal(`SELECT coalesce(bool_and(NOT has_table_privilege('${operator}',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')),true)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r'AND n.nspname IN('auth','identity','payments','mlm','recovery');`, 't');
  equal(rowsQuery, before.rows); equal(oldFunctions, before.functions);
  const tableManifest = tables.map(name => JSON.parse(admin(`SELECT jsonb_build_object('name',${literal(name)},'columns',
   (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid))ORDER BY a.attnum)
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=${literal(name)}::regclass AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid,true))ORDER BY c.conname)FROM pg_constraint c WHERE c.conrelid=${literal(name)}::regclass),
   'indexes',(SELECT jsonb_agg(indexname ORDER BY indexname)FROM pg_indexes WHERE schemaname='payments'AND tablename=split_part(${literal(name)},'.',2)))::text;`)));
  const triggers = JSON.parse(admin(`SELECT jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true))ORDER BY t.tgname)::text
   FROM pg_trigger t WHERE t.tgname IN('stripe_membership_rights_run_append_only','stripe_membership_entitlement_append_only','stripe_membership_rights_event_append_only');`));
  const report = { migrationSha256: createHash('sha256').update(migration).digest('hex'), syntheticPostgresPassed: true, probes,
    tables: tableManifest, functions: functions.map(fn => ({ ...fn, ownerReferenceSignature: 'identity.require_administrative_native_session(text,text)',
      runtimeExecute: fn.signature === exposedNative, operatorExecute: exposedOperator.has(fn.signature) })),
    addedTriggers: triggers, addedRole: { name: operator, login: false, inherit: false, superuser: false, createDb: false, createRole: false, replication: false, bypassRls: false,
      schemaUsage: ['payments'], members: [], tablePrivileges: [] }, constraints: [], changedFunctions: [],
    allOldRowsUnchanged: true, allOldFunctionsUnchanged: true, rightsUntilExplicitRevocation: true, replayDoesNotRegrant: true,
    historicalBoughtAtPreserved: true, currentProviderReadbackRequired: true, noNativeRegistrationRequiredToRecognize: true,
    pendingPersonAndAffiliateAllowed: true, sourceBatch: batch, sourceFileSha256: fileHash,
    productionConnections: 0, providerCalls: 0, charges: 0, transfers: 0, network: 'none' };
  await writeFile(new URL('../.wrangler/historical-membership-rights-118-manifest.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ historicalMembershipRights: 'passed', probes, newTables: tables.length, newFunctions: functions.length, newTriggers: triggers.length,
    syntheticOnly: true, allOldRowsUnchanged: true, providerCalls: 0, charges: 0, transfers: 0 }));
}
