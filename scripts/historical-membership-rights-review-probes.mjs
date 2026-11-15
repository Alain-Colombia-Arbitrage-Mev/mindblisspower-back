import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export async function runHistoricalMembershipRightsReviewProbes({ psql, value, concurrent, owner, runtime }) {
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
  const correction = pi(6), csv = pi(5), actualPin = 'd418b4ac8574307fbad5c9ae52bd9157259e4055eb723d2703c0b2b25b9bd72a';
  const syntheticPin = createHash('sha256').update(correction).digest('hex');
  psql(`ALTER TABLE recovery.stripe_sale_identity ADD COLUMN IF NOT EXISTS match_status text NOT NULL DEFAULT 'matched_email_and_id',
   ADD COLUMN IF NOT EXISTS review_reasons jsonb NOT NULL DEFAULT '[]'::jsonb;
   INSERT INTO auth."user"(id,eligible,email,email_verified,name)VALUES
    ('rights120-correct',true,'rights-correct@example.invalid',true,'Synthetic Correct'),
    ('rights120-wrong',true,'rights-wrong@example.invalid',true,'Synthetic Wrong');
   INSERT INTO auth.session(id,user_id,expires_at)VALUES('rights120-correct-session','rights120-correct',clock_timestamp()+interval '2 days'),
    ('rights120-wrong-session','rights120-wrong',clock_timestamp()+interval '2 days');
   INSERT INTO mlm.person(id,public_id,user_id,email,status,first_name,last_name,phone_number)VALUES
    (15451,gen_random_uuid(),'rights120-correct','rights-correct@example.invalid','active','Synthetic','Correct',''),
    (15450,gen_random_uuid(),'rights120-wrong','rights-wrong@example.invalid','active','Synthetic','Wrong','');
   INSERT INTO identity.auth_binding(subject,provider,person_id)VALUES('rights120-correct','better_auth',15451),('rights120-wrong','better_auth',15450);
   INSERT INTO mlm.affiliate(id,person_id,status,invitation_link)VALUES(115533,15451,'active','RIGHTS120-CORRECT'),(88610,15450,'active','RIGHTS120-WRONG');
   UPDATE payments.stripe_sale SET source_eligible=true,metadata=jsonb_build_object('packmindbliss','true','package_id','1001','person_id','11702','email','ref117-owner-2@example.invalid') WHERE payment_intent_id='${csv}';
   UPDATE recovery.stripe_sale_identity SET person_id=11702,affiliate_id=NULL,identity_verified=true,catalog_verified=true WHERE payment_intent_id='${csv}';
   UPDATE payments.sales_import_row SET person_id=11702,affiliate_id=NULL,risk_status='none',canonical_source_eligible=true WHERE external_id='${csv}';
   UPDATE payments.stripe_sale SET source_eligible=true,metadata=jsonb_build_object('packmindbliss','true','package_id','1001','person_id','15451','email','rights-correct@example.invalid') WHERE payment_intent_id IN('${correction}','${pi(8)}');
   UPDATE recovery.stripe_sale_identity SET person_id=15450,affiliate_id=88610,identity_verified=false,catalog_verified=true,
    match_status='id_email_conflict',review_reasons='["id_email_conflict"]'::jsonb WHERE payment_intent_id IN('${correction}','${pi(8)}');
   UPDATE payments.sales_import_row SET person_id=NULL,affiliate_id=NULL,risk_status='none',canonical_source_eligible=true,display_status='paid',source_status='Paid'
    WHERE external_id IN('${correction}','${pi(8)}');`);
  const reviewTable = 'payments.stripe_membership_rights_review_decision';
  const newSignatures = ['payments.stripe_membership_rights_review_source_context(text,text)', 'payments.stripe_membership_rights_review_evidence_snapshot(text)',
    'payments.approve_stripe_membership_rights_review(uuid,text,text,text,text,jsonb,jsonb,jsonb,text,text)'];
  const altered = 'payments.stripe_membership_rights_evidence_snapshot(text)';
  const schema = await readFile(new URL('../_meta/migration/120_historical_membership_rights_review.sql', import.meta.url), 'utf8');
  assert.equal(schema.split(actualPin).length - 1, 1, 'exactly_one_reviewed_private_pin_substitution');
  const testedSchema = schema.replace(actualPin, syntheticPin);
  const otherFns = `SELECT md5(coalesce(string_agg(pg_get_functiondef(p.oid)||p.proowner::text||coalesce(p.proacl::text,'')||coalesce(p.proconfig::text,''),E'\n'ORDER BY p.oid),''))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('identity','payments','mlm','recovery')AND p.oid NOT IN(${[altered, ...newSignatures].map(s => `coalesce(to_regprocedure(${literal(s)})::oid,0)`).join(',')});`;
  const nonJournalRows = rowsQuery.replace(`AND n.nspname||'.'||c.relname NOT IN(${tables.map(literal).join(',')})`,
    `AND n.nspname||'.'||c.relname NOT IN(${[...tables, reviewTable].map(literal).join(',')})`);
  const oldAllRows = rowsQuery.replace(`AND n.nspname||'.'||c.relname NOT IN(${tables.map(literal).join(',')})`,
    `AND n.nspname||'.'||c.relname<>${literal(reviewTable)}`);
  const previous = { rows: admin(oldAllRows), nonJournal: admin(nonJournalRows), functions: admin(otherFns), evidence: functionInfo(altered),
    snapshots: [1, 2, 3].map(snapshot), journal: Object.fromEntries(tables.map(t => [t, JSON.parse(admin(`SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)::text FROM ${t} x;`))])) };
  psql(testedSchema);
  equal(oldAllRows, previous.rows); equal(otherFns, previous.functions);
  const sourceContext = (intent, mode) => JSON.parse(admin(`SELECT payments.stripe_membership_rights_review_source_context(${literal(intent)},${literal(mode)})::text;`));
  const contexts = { csv: sourceContext(csv, 'csv_review'), correction: sourceContext(correction, 'identity_correction') };
  const readback = (intent, context) => ({ paymentIntentId: intent, chargeReference: context.approved.chargeReference, livemode: true, status: 'succeeded', currency: 'usd',
    capturedMinor: context.approved.capturedMinor, refundedMinor: '0', disputeCount: 0, packmindbliss: true, paid: true, captured: true, sourceMetadataMatches: true,
    verifiedAt: new Date().toISOString(), proofSha256: 'f'.repeat(64) });
  const identityProof = context => ({ emailNormalizedSha256: context.original.canonicalEmailSha256, metadataPersonId: context.original.metadataPersonId,
    metadataPackageId: context.original.metadataPackageId });
  const radar = { state: 'none', reviewReference: null, open: false, closedReason: null, proofSha256: null };
  const approvals = {
    csv: { id: randomUUID(), pi: csv, mode: 'csv_review', context: contexts.csv, provider: readback(csv, contexts.csv), identity: identityProof(contexts.csv), radar },
    correction: { id: randomUUID(), pi: correction, mode: 'identity_correction', context: contexts.correction, provider: readback(correction, contexts.correction), identity: identityProof(contexts.correction), radar },
  };
  const approve = a => `SELECT row_to_json(r)::text FROM payments.approve_stripe_membership_rights_review(${literal(a.id)}::uuid,${literal(a.pi)},${literal(a.mode)},
   ${literal(canonicalHash(a.context.original))},${literal(canonicalHash(a.context.approved))},${json(a.provider)},${json(a.identity)},${json(a.radar)},'synthetic-review-operator','Reviewed synthetic access only')r;`;
  for (const key of Object.keys(approvals.csv.provider)) { const a = structuredClone(approvals.csv); a.provider[key] = null; deny(approve(a), /member_package_rights_review_provider_proof_required/); }
  for (const key of Object.keys(approvals.csv.identity)) { const a = structuredClone(approvals.csv); a.identity[key] = null; deny(approve(a), /member_package_rights_review_identity_proof_required/); }
  for (const patch of [{ state: null }, { open: null }, { open: true }, { reviewReference: 'prv_synthetic' }, { state: 'approved', closedReason: 'approved', proofSha256: 'a'.repeat(64) }]) {
    const a = structuredClone(approvals.csv); a.radar = { ...a.radar, ...patch }; deny(approve(a), /member_package_rights_review_radar_hold/);
  }
  for (const patch of [{ refundedMinor: '1' }, { disputeCount: 1 }, { paid: false }, { captured: false }, { sourceMetadataMatches: false },
    { capturedMinor: '10101' }, { verifiedAt: '2020-01-01T00:00:00Z' }, { currency: 'eur' }, { paymentIntentId: pi(1) }]) {
    const a = structuredClone(approvals.csv); a.provider = { ...a.provider, ...patch }; deny(approve(a), /member_package_rights_review_provider_proof_required/);
  }
  const wrongIdentity = structuredClone(approvals.csv); wrongIdentity.identity.emailNormalizedSha256 = '0'.repeat(64); deny(approve(wrongIdentity), /member_package_rights_review_identity_proof_required/);
  equal(`SELECT payments.stripe_membership_rights_review_source_context('${pi(8)}','identity_correction')IS NULL;`, 't');
  equal(`SELECT payments.stripe_membership_rights_review_source_context('${pi(1)}','csv_review')IS NULL;`, 't');
  for (const [table, condition, patch] of [
    ['mlm.person', 'id=15451', "email='wrong-owner@example.invalid'"],
    ['auth."user"', "id='rights120-correct'", 'email_verified=false'],
    ['auth."user"', "id='rights120-correct'", "email='wrong-owner@example.invalid'"],
    ['mlm.affiliate', 'id=115533', 'person_id=15450'],
    ['payments.stripe_sale', `payment_intent_id='${correction}'`, "metadata=jsonb_set(metadata,'{person_id}','\"15450\"'::jsonb)"],
    ['payments.stripe_sale', `payment_intent_id='${correction}'`, 'dispute_count=1,source_eligible=false'],
  ]) {
    const result = psql(`BEGIN;UPDATE ${table} SET ${patch} WHERE ${condition};SET ROLE ${operator};${approve(approvals.correction)}ROLLBACK;`, true);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /member_package_rights_review_(identity_proof_required|source_changed)/); probes++;
  }
  for (const patch of [
    "INSERT INTO mlm.person(id,public_id,email,status,first_name,last_name,phone_number)VALUES(120999,gen_random_uuid(),'RIGHTS-CORRECT@example.invalid','active','Synthetic','Duplicate','');",
    "INSERT INTO auth.\"user\"(id,eligible,email,email_verified,name)VALUES('rights120-duplicate',true,'RIGHTS-CORRECT@example.invalid',true,'Synthetic Duplicate');",
    "INSERT INTO auth.\"user\"(id,eligible,email,email_verified,name)VALUES('rights120-second',true,'second@example.invalid',true,'Synthetic Second');INSERT INTO identity.auth_binding(subject,provider,person_id)VALUES('rights120-second','better_auth',15451);",
  ]) {
    const result = psql(`BEGIN;${patch}SET ROLE ${operator};${approve(approvals.correction)}ROLLBACK;`, true);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /member_package_rights_review_identity_proof_required/); probes++;
  }
  equal(`SELECT count(*)FROM ${reviewTable};`, '0');
  deny(approve(approvals.csv), /permission denied/, runtime);
  const racing = await Promise.all([concurrent(`SET ROLE ${operator};${approve(approvals.csv)}`).complete, concurrent(`SET ROLE ${operator};${approve(approvals.csv)}`).complete]);
  assert.ok(racing.every(x => x.status === 0), JSON.stringify(racing)); assert.deepEqual(racing.map(x => JSON.parse(x.stdout.trim()).created).sort(), [false, true]); probes += 2;
  assert.equal(JSON.parse(exec(approve(approvals.correction))).created, true); assert.equal(JSON.parse(exec(approve(approvals.correction))).created, false); probes += 2;
  const conflict = structuredClone(approvals.correction); conflict.id = randomUUID(); deny(approve(conflict), /member_package_rights_review_conflict/);
  const changedProof = structuredClone(approvals.correction); changedProof.provider.proofSha256 = 'c'.repeat(64); deny(approve(changedProof), /member_package_rights_review_conflict/);
  for (const [i, a] of [[5, approvals.csv], [6, approvals.correction]]) { assert.deepEqual(snapshot(i), a.context.approved); probes++; }
  const newRun = randomUUID(), newManifest = createManifest([5, 6]); exec(register(newManifest, newRun));
  exec(recognize(newRun, 5)); exec(recognize(newRun, 6)); probes += 3;
  const correct = JSON.parse(exec("SELECT payments.read_member_package_rights('rights120-correct','rights120-correct-session')::text;", runtime));
  const wrong = JSON.parse(exec("SELECT payments.read_member_package_rights('rights120-wrong','rights120-wrong-session')::text;", runtime));
  assert.equal(correct.activeCount, 1); assert.equal(correct.items[0].packageBaseUsd, '100.00'); assert.equal(wrong.totalCount, 0); probes += 3;
  const currentIdentity = JSON.parse(admin(`SELECT jsonb_build_object('person',person_id,'affiliate',affiliate_id,'verified',identity_verified)::text FROM recovery.stripe_sale_identity WHERE payment_intent_id='${correction}';`));
  assert.deepEqual(currentIdentity, { person: 15450, affiliate: 88610, verified: false }); probes++;
  for (const i of [1, 2, 3]) { assert.deepEqual(snapshot(i), previous.snapshots[i - 1]); probes++; }
  // Later report choices/manual orders do not revoke the reviewed right either.
  const retained = JSON.parse(admin(`BEGIN;UPDATE payments.admin_sales_source SET active_batch_id=gen_random_uuid()WHERE provider='stripe';
   INSERT INTO payments.manual_membership_order(person_id,state)VALUES(15451,'activated');SET ROLE ${runtime};
   SELECT payments.read_member_package_rights('rights120-correct','rights120-correct-session')::text;ROLLBACK;`));
  assert.equal(retained.activeCount, 1); probes++;
  const changedContact = JSON.parse(admin(`BEGIN;UPDATE mlm.person SET email='later-contact@example.invalid'WHERE id=15451;
   UPDATE auth."user" SET email='later-contact@example.invalid'WHERE id='rights120-correct';SET ROLE ${runtime};
   SELECT payments.read_member_package_rights('rights120-correct','rights120-correct-session')::text;ROLLBACK;`));
  assert.equal(changedContact.activeCount, 1); probes++;
  const risk = JSON.parse(admin(`BEGIN;UPDATE payments.stripe_sale SET refunded_minor=1,source_eligible=false WHERE payment_intent_id='${correction}';SET ROLE ${runtime};
   SELECT payments.read_member_package_rights('rights120-correct','rights120-correct-session')::text;ROLLBACK;`));
  assert.equal(risk.activeCount, 0); assert.equal(risk.items[0].status, 'review_required'); probes += 2;
  exec(`SELECT *FROM payments.record_stripe_membership_rights_decision('${randomUUID()}','${csv}','revoked','synthetic-review-operator','Explicit synthetic revocation',repeat('c',64));`);
  assert.equal(JSON.parse(exec(approve(approvals.csv))).created, false);
  const replay = JSON.parse(exec(recognize(newRun, 5))); assert.equal(replay.created, false); assert.equal(replay.state, 'revoked'); probes += 3;
  equal(nonJournalRows, previous.nonJournal); equal(otherFns, previous.functions);
  for (const [table, originals] of Object.entries(previous.journal)) {
    const current = JSON.parse(admin(`SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb)::text FROM ${table} x;`));
    for (const row of originals) { assert.deepEqual(current.find(item => item.id === row.id), row); probes++; }
  }
  for (const role of [runtime, operator, 'referral117_default', 'mindbliss_go_payments_reader_v1']) equal(`SELECT has_table_privilege('${role}','${reviewTable}','SELECT,INSERT,UPDATE,DELETE');`, 'f');
  equal(`SELECT relrowsecurity FROM pg_class WHERE oid='${reviewTable}'::regclass;`, 't');
  deny(`UPDATE ${reviewTable} SET reason='changed';`, /member_package_rights_append_only/, owner);
  const functionManifest = [...newSignatures, altered].map(signature => {
    const result = JSON.parse(admin(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'owner',p.proowner,
     'securityDefiner',p.prosecdef,'proconfig',p.proconfig,'acl',p.proacl,'volatility',p.provolatile)::text FROM pg_proc p WHERE p.oid=${literal(signature)}::regprocedure;`));
    const count = result.definition.split(syntheticPin).length - 1;
    assert.equal(count, signature === newSignatures[0] ? 1 : 0); probes++;
    const canonicalDefinition = result.definition.replace(syntheticPin, actualPin);
    const { definition, ...metadata } = result;
    return { ...metadata, md5: createHash('md5').update(canonicalDefinition).digest('hex'),
      testedMd5: createHash('md5').update(definition).digest('hex'), ownerReferenceSignature: 'identity.require_administrative_native_session(text,text)',
      runtimeExecute: false, operatorExecute: signature === newSignatures[2] };
  });
  for (const fn of functionManifest) {
    equal(`SELECT has_function_privilege('${runtime}',${literal(fn.signature)},'EXECUTE');`, 'f');
    equal(`SELECT has_function_privilege('${operator}',${literal(fn.signature)},'EXECUTE');`, fn.operatorExecute ? 't' : 'f');
    equal(`SELECT has_function_privilege('referral117_default',${literal(fn.signature)},'EXECUTE');`, 'f');
  }
  const afterEvidence = functionManifest.find(fn => fn.signature === altered);
  assert.deepEqual({ owner: afterEvidence.owner, acl: afterEvidence.acl, config: afterEvidence.proconfig, definer: afterEvidence.securityDefiner, volatility: afterEvidence.volatility },
    { owner: previous.evidence.owner, acl: previous.evidence.acl, config: previous.evidence.proconfig, definer: previous.evidence.securityDefiner, volatility: previous.evidence.volatility }); probes++;
  const tableManifest = JSON.parse(admin(`SELECT jsonb_build_object('name','${reviewTable}','columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
   'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid))ORDER BY a.attnum)FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid='${reviewTable}'::regclass AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid,true))ORDER BY c.conname)
   FROM pg_constraint c WHERE c.conrelid='${reviewTable}'::regclass),'indexes',(SELECT jsonb_agg(indexname ORDER BY indexname)FROM pg_indexes WHERE schemaname='payments'AND tablename='stripe_membership_rights_review_decision'))::text;`));
  const triggers = JSON.parse(admin(`SELECT jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true)))::text
   FROM pg_trigger t WHERE t.tgname='stripe_membership_rights_review_append_only';`));
  const report = { migrationSha256: createHash('sha256').update(schema).digest('hex'), syntheticPostgresPassed: true, probes,
    syntheticPinSubstitution: true, syntheticPin: { occurrences: 1, actualSha256: actualPin, syntheticSha256: syntheticPin, functionMd5Normalization: 'Only the one asserted synthetic guard literal is replaced by the reviewed real guard hash before md5.' },
    tables: [tableManifest], functions: functionManifest, addedFunctions: newSignatures,
    changedFunctions: [ { ...afterEvidence, beforeMd5: previous.evidence.md5 } ], addedTriggers: triggers, constraints: [],
    originalRightsAndRunsAndEventsUnchanged: true, allNonRightsRowsUnchanged: true, allOtherFunctionsUnchanged: true, allExistingFunctionPermissionsUnchanged: true,
    correctionOnlyForPinnedPi: true, correctionDoesNotChangeCanonicalIdentity: true, strictEmailMetadataNativeCorroboration: true,
    radarNoneOnly: true, noAutomaticRegrantAfterRevocation: true, productionConnections: 0, providerCalls: 0, charges: 0, transfers: 0, network: 'none' };
  await writeFile(new URL('../.wrangler/historical-membership-rights-120-manifest.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ historicalMembershipRightsReview: 'passed', probes, newTables: 1, newFunctions: 3, changedFunctions: 1,
    syntheticPinSubstitution: true, canonicalIdentityUnchanged: true, priorRightsUnchanged: true, productionConnections: 0, providerCalls: 0 }));
}
