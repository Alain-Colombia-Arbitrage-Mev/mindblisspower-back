import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export async function runMeldSandboxReconciliationProbes({ container, docker, psql, value, parallelPsql, role, database }) {
  let probes = 0;
  const eq = (query, expected, runtime = true) => { assert.equal(value(query, runtime), expected); probes++; };
  const deny = (query, code, runtime = true) => { const r = psql(`${runtime ? `SET ROLE ${role};` : ''}${query}`, true);
    assert.notEqual(r.status, 0); assert.match(r.stderr, new RegExp(code)); probes++; };
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container]).stdout.trim(), 'none');
  assert.equal(database, 'mindbliss_curated_20261025'); assert.equal(role, 'mindbliss_auth_core_v1');
  // The 93..101 synthetic baseline intentionally predates the metadata column
  // that migration92 already creates in the real administrative assignment.
  if (value("SELECT count(*) FROM pg_attribute WHERE attrelid='identity.administrative_wallet_assignment'::regclass AND attname='checkout_reference' AND NOT attisdropped;", false) === '0') {
    psql('ALTER TABLE identity.administrative_wallet_assignment ADD COLUMN checkout_reference uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;');
  }
  psql('CREATE ROLE sandbox_fixture_default NOLOGIN; GRANT USAGE ON SCHEMA payments TO sandbox_fixture_default; ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT SELECT ON TABLES TO sandbox_fixture_default; ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT EXECUTE ON FUNCTIONS TO sandbox_fixture_default;');
  const users = Array.from({ length: 3 }, (_, i) => ({ owner: `reconciliation-${i}`,
    address: `0xf3${String(i + 1).padStart(2, '0')}${'91'.repeat(18)}`, ordinal: 71 + i, id: randomUUID() }));
  psql(`INSERT INTO auth."user"(id,eligible,email,name) VALUES ${users.map(u => `('${u.owner}',true,'${u.owner}@example.invalid','Synthetic')`).join(',')};
    INSERT INTO identity.administrative_wallet_pool(ordinal,address) VALUES ${users.map(u => `(${u.ordinal},'${u.address}')`).join(',')};
    INSERT INTO identity.administrative_wallet_assignment(subject,pool_ordinal) VALUES ${users.map(u => `('${u.owner}',${u.ordinal})`).join(',')};`);
  for (const u of users) {
    eq(`SELECT id FROM payments.create_meld_sandbox_funding_attempt_v2('${u.owner}','${u.address}','MX',650,'${u.id}','BANXA','CREDIT_DEBIT_CARD','MXN');`, u.id);
    eq(`SELECT payments.finish_meld_sandbox_funding_attempt('${u.owner}','${u.id}','session_created','session-${u.ordinal}');`, 't');
    u.customer = value(`SELECT checkout_reference FROM identity.administrative_wallet_assignment WHERE subject='${u.owner}';`, false);
  }
  const names = ['payments.read_meld_sandbox_reconciliation_context(text,uuid)', 'payments.read_meld_sandbox_webhook_context(uuid,uuid,text)',
    'payments.read_meld_sandbox_confirmations(text,uuid[])', 'payments.record_meld_sandbox_proof(text,uuid,jsonb,text)',
    'payments.record_meld_sandbox_webhook_receipt(text,text,timestamptz,text,text,text,uuid)'];
  const existingFunctions = `SELECT md5(coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),
    'owner',p.proowner,'acl',p.proacl,'config',p.proconfig) ORDER BY p.oid)::text,'')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN('payments','identity','mlm') AND p.proname NOT IN('read_meld_sandbox_reconciliation_context','read_meld_sandbox_webhook_context',
    'read_meld_sandbox_confirmations','record_meld_sandbox_proof','record_meld_sandbox_webhook_receipt');`;
  const rowQueries = JSON.parse(value(`SELECT jsonb_agg(format('SELECT %L AS name,count(*)::text AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n''ORDER BY to_jsonb(t)::text),'''')) AS digest FROM %I.%I t',n.nspname||'.'||c.relname,n.nspname,c.relname) ORDER BY n.nspname,c.relname)::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast';`, false));
  const rowsQ = `SELECT jsonb_object_agg(name,jsonb_build_object('count',count,'digest',digest) ORDER BY name)::text FROM(${rowQueries.join(' UNION ALL ')})s;`;
  const before = { functions: value(existingFunctions, false), rows: value(rowsQ, false),
    owner: value(`SELECT proowner FROM pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure;`, false) };
  const migration = await readFile(new URL('../_meta/migration/112_meld_sandbox_reconciliation.sql', import.meta.url), 'utf8');
  deny(`BEGIN;ALTER TABLE payments.meld_sandbox_funding_attempt DISABLE ROW LEVEL SECURITY;${migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')}`,
    'meld_sandbox_reconciliation_isolation_required', false);
  psql(migration);
  eq(rowsQ, before.rows, false); eq(existingFunctions, before.functions, false);
  for (const table of ['meld_sandbox_proof', 'meld_sandbox_webhook_receipt']) {
    eq(`SELECT count(*) FROM payments.${table};`, '0', false);
    deny(`SET ROLE sandbox_fixture_default;SELECT * FROM payments.${table};`, 'permission denied', false);
  }
  const u = users[0], other = users[1];
  const reader = (owner = u.owner, id = u.id) => `SELECT count(*) FROM payments.read_meld_sandbox_reconciliation_context('${owner}','${id}');`;
  eq(reader(), '1'); eq(reader(other.owner), '0'); deny(reader('blocked'), 'wallet_funding_forbidden');
  eq(`SELECT customer_reference||'|'||provider_session_id FROM payments.read_meld_sandbox_reconciliation_context('${u.owner}','${u.id}');`, `${u.customer}|session-${u.ordinal}`);
  const whReader = (id = u.id, customer = u.customer, session = `session-${u.ordinal}`) => `SELECT count(*) FROM payments.read_meld_sandbox_webhook_context('${id}','${customer}','${session}');`;
  eq(whReader(), '1'); eq(whReader(u.id, other.customer), '0'); eq(whReader(u.id, u.customer, 'wrong'), '0');
  const base = { transactionId: 'transaction-synthetic', accountId: 'account-synthetic', sessionId: `session-${u.ordinal}`,
    externalSessionId: u.id, externalCustomerId: u.customer, serviceProvider: 'BANXA', countryCode: 'MX', sourceCurrencyCode: 'MXN',
    sourceAmount: '650.00', destinationCurrencyCode: 'USDT_POLYGON', walletAddress: u.address, chainId: '137',
    paymentMethodType: 'CREDIT_DEBIT_CARD', providerStatus: 'PENDING', providerUpdatedAt: '2026-11-12T20:00:00.000Z', receivedAmount: '0' };
  const record = (proof = base, owner = u.owner, id = u.id) => `SELECT payments.record_meld_sandbox_proof('${owner}','${id}',${literal(JSON.stringify(proof))}::jsonb,'${createHash('sha256').update(JSON.stringify(proof)).digest('hex')}')->>'providerStatus';`;
  eq(record(), 'PENDING'); eq(record(), 'PENDING');
  deny(record(base, other.owner), 'wallet_funding_forbidden');
  for (const change of [{ externalSessionId: other.id }, { externalCustomerId: other.customer }, { sessionId: 'wrong' },
    { serviceProvider: 'TRANSAK' }, { countryCode: 'US' }, { sourceCurrencyCode: 'USD' }, { sourceAmount: '649.99' },
    { destinationCurrencyCode: 'USDT' }, { walletAddress: other.address }, { chainId: '1' }, { paymentMethodType: 'APPLE_PAY' }]) {
    deny(record({ ...base, ...change }), 'sandbox_proof_context_mismatch');
  }
  for (const change of [{ receivedAmount: '-1' }, { providerStatus: 'FAKE' }, { providerUpdatedAt: 'bad' },
    { providerStatus: 'SETTLED', receivedAmount: '0' }, { unexpected: 'private' }, { sourceAmount: null }, { receivedAmount: 'NaN' }]) {
    deny(record({ ...base, ...change }), 'sandbox_proof_invalid');
  }
  const settled = { ...base, providerStatus: 'SETTLED', providerUpdatedAt: '2026-11-12T20:01:00.000Z', receivedAmount: '31.123456' };
  eq(record(settled), 'SETTLED'); eq(record(base), 'SETTLED');
  eq(record({ ...base, providerUpdatedAt: '2026-11-12T20:02:00.000Z' }), 'SETTLED');
  deny(record({ ...settled, receivedAmount: '32' }), 'sandbox_proof_version_conflict');
  deny(record({ ...settled, transactionId: 'changed-transaction' }), 'sandbox_proof_transaction_conflict');
  deny(record({ ...settled, accountId: 'changed-account' }), 'sandbox_proof_transaction_conflict');
  const batch = `SELECT count(*) FROM payments.read_meld_sandbox_confirmations('${u.owner}',ARRAY['${u.id}','${other.id}']::uuid[]);`;
  eq(batch, '1'); eq(batch.replace(u.owner, other.owner), '0');
  deny(`SELECT * FROM payments.read_meld_sandbox_confirmations('${u.owner}',array_fill('${u.id}'::uuid,ARRAY[51]));`, 'wallet_funding_invalid_reference');
  deny(`SELECT * FROM payments.read_meld_sandbox_confirmations('${u.owner}',ARRAY[NULL]::uuid[]);`, 'wallet_funding_invalid_reference');
  const receipt = (event = 'event-test', hash = 'a'.repeat(64), type = 'WEBHOOK_TEST', attempt = 'NULL', profile = 'NULL') =>
    `SELECT payments.record_meld_sandbox_webhook_receipt('${event}','${type}','2026-11-12T20:00:00Z','account-synthetic',${profile},'${hash}',${attempt});`;
  eq(receipt(), 't'); eq(receipt(), 'f'); deny(receipt('event-test', 'b'.repeat(64)), 'sandbox_webhook_event_collision');
  eq(receipt('event-real', 'c'.repeat(64), 'TRANSACTION_CRYPTO_COMPLETE', `'${u.id}'`, "'profile-synthetic'"), 't');
  deny(receipt('event-invalid', 'd'.repeat(64), 'TRANSACTION_CRYPTO_COMPLETE'), 'sandbox_webhook_invalid');
  deny(receipt('event-test-bound', 'd'.repeat(64), 'WEBHOOK_TEST', `'${u.id}'`), 'sandbox_webhook_invalid');
  const parallel = await Promise.all([parallelPsql(receipt('event-race')), parallelPsql(receipt('event-race'))]);
  assert.ok(parallel.every(r => r.status === 0)); assert.deepEqual(parallel.map(r => r.stdout.trim()).sort(), ['f', 't']); probes++;
  for (const table of ['meld_sandbox_proof', 'meld_sandbox_webhook_receipt']) {
    deny(`SELECT * FROM payments.${table};`, 'permission denied');
    eq(`SELECT relrowsecurity::text||'|'||relowner::text FROM pg_class WHERE oid='payments.${table}'::regclass;`, `true|${before.owner}`, false);
  }
  eq(rowsQ, before.rows, false); eq(existingFunctions, before.functions, false);
  deny(migration, 'meld_sandbox_reconciliation_requires_fresh_review', false);
  const functions = names.map(name => JSON.parse(value(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),
    'prosecdef',p.prosecdef,'proconfig',p.proconfig,'owner',p.proowner,'acl',p.proacl)::text FROM pg_proc p WHERE oid='${name}'::regprocedure;`, false)));
  for (const f of functions) { assert.equal(f.prosecdef, true); assert.deepEqual(f.proconfig, ['search_path=pg_catalog']); assert.equal(f.owner, before.owner); probes++; }
  for (const name of names) eq(`SELECT has_function_privilege('sandbox_fixture_default','${name}','EXECUTE');`, 'f', false);
  const tables = ['payments.meld_sandbox_proof', 'payments.meld_sandbox_webhook_receipt'].map(name => JSON.parse(value(`SELECT jsonb_build_object('name',${literal(name)},
    'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'kind',c.relkind,'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,true)) ORDER BY conname) FROM pg_constraint WHERE conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid) FROM pg_index WHERE indrelid=c.oid))::text FROM pg_class c WHERE c.oid='${name}'::regclass;`, false)));
  await writeFile(new URL('../.wrangler/meld-sandbox-reconciliation-112-manifest.json', import.meta.url), JSON.stringify({
    migrationSha256: createHash('sha256').update(migration).digest('hex'), syntheticPostgresPassed: true,
    functions: functions.map(f => ({ ...f, ownerReferenceSignature: 'payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)' })),
    tables, constraints: [], changedFunctions: [], probes, oldRowsUnchangedByMigration: true,
    existingRowsUnchangedByAllReconciliationProbes: true, personalAndProductionFinancialRecordsUnchanged: true,
    productionConnections: 0, externalNetwork: 'disabled', actualCharges: 0 }, null, 2));
  console.log(JSON.stringify({ meldSandboxReconciliationSchema: 'passed', probes, ownerIsolation: true, monotonicProof: true,
    webhookTestReceiptOnly: true, actualCharges: 0, productionConnections: 0 }));
}
