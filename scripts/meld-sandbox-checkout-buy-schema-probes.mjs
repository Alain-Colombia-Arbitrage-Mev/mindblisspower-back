import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
export async function runMeldSandboxCheckoutBuyProbes({ container, docker, psql, value, parallelPsql, role, database }) {
  let probes = 0;
  const eq = (q, expected, runtime = true) => { assert.equal(value(q, runtime), expected); probes++; };
  const deny = (q, code, runtime = true) => { const r = psql(`${runtime ? `SET ROLE ${role};` : ''}${q}`, true);
    assert.notEqual(r.status, 0); assert.match(r.stderr, new RegExp(code)); probes++; };
  const lit = v => `'${String(v).replaceAll("'", "''")}'`;
  assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container]).stdout.trim(), 'none');
  assert.equal(database, 'mindbliss_curated_20261025'); assert.equal(role, 'mindbliss_auth_core_v1');
  const users = Array.from({ length: 5 }, (_, i) => ({ owner: `mint-checkout-${i}`, address: `0xfd${String(i + 1).padStart(2, '0')}${'81'.repeat(18)}`, ordinal: 81 + i }));
  psql(`INSERT INTO auth."user"(id,eligible,email,name) VALUES ${users.map(u => `('${u.owner}',true,'${u.owner}@example.invalid','Synthetic')`).join(',')};
    INSERT INTO identity.administrative_wallet_pool(ordinal,address) VALUES ${users.map(u => `(${u.ordinal},'${u.address}')`).join(',')};
    INSERT INTO identity.administrative_wallet_assignment(subject,pool_ordinal) VALUES ${users.map(u => `('${u.owner}',${u.ordinal})`).join(',')};`);
  for (const u of users) u.customer = value(`SELECT checkout_reference FROM identity.administrative_wallet_assignment WHERE subject='${u.owner}';`, false);
  const functionNames = ['payments.create_meld_sandbox_checkout_intent(text,text,text,numeric,uuid,text,text)',
    'payments.finish_meld_sandbox_checkout_mint(text,uuid,text,text)', 'payments.read_meld_checkout_context(text,uuid)',
    'payments.read_meld_checkout_history(text)', 'payments.read_meld_checkout_webhook_context(uuid,uuid)',
    'payments.record_meld_checkout_proof(text,uuid,jsonb,text)', 'payments.record_meld_checkout_webhook_receipt(text,text,timestamptz,text,text,text,uuid)'];
  const fnQ = `SELECT md5(coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl,'config',p.proconfig) ORDER BY p.oid)::text,''))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('payments','identity','mlm') AND p.proname NOT IN(
    'create_meld_sandbox_checkout_intent','finish_meld_sandbox_checkout_mint','read_meld_checkout_context','read_meld_checkout_history','read_meld_checkout_webhook_context','record_meld_checkout_proof','record_meld_checkout_webhook_receipt');`;
  const rowQueries = JSON.parse(value(`SELECT jsonb_agg(format('SELECT %L AS name,count(*)::text AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n''ORDER BY to_jsonb(t)::text),'''')) AS digest FROM %I.%I t',n.nspname||'.'||c.relname,n.nspname,c.relname) ORDER BY n.nspname,c.relname)::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast';`, false));
  const rowsQ = `SELECT jsonb_object_agg(name,jsonb_build_object('count',count,'digest',digest) ORDER BY name)::text FROM(${rowQueries.join(' UNION ALL ')})s;`;
  const before = { rows: value(rowsQ, false), functions: value(fnQ, false), owner: value(`SELECT proowner FROM pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure;`, false) };
  const migration = await readFile(new URL('../_meta/migration/113_meld_sandbox_checkout_buy.sql', import.meta.url), 'utf8');
  deny(`BEGIN;ALTER TABLE payments.meld_sandbox_proof DISABLE ROW LEVEL SECURITY;${migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')}`, 'meld_checkout_isolation_required', false);
  psql(migration); eq(rowsQ, before.rows, false); eq(fnQ, before.functions, false);
  for (const table of ['meld_checkout_intent', 'meld_checkout_webhook_receipt']) {
    eq(`SELECT count(*) FROM payments.${table};`, '0', false);
    deny(`SELECT * FROM payments.${table};`, 'permission denied');
    deny(`SET ROLE sandbox_fixture_default; SELECT * FROM payments.${table};`, 'permission denied', false);
  }
  const create = (id = randomUUID(), i = 0, amount = 650, country = 'MX', currency = 'MXN', account = 'checkout-account') =>
    `SELECT id FROM payments.create_meld_sandbox_checkout_intent('${users[i].owner}','${users[i].address}','${country}',${amount},'${id}','${currency}','${account}');`;
  const id = randomUUID(); eq(create(id), id); eq(create(id), id);
  eq(`SELECT status||'|'||(provider_session_id IS NULL)::text||'|'||(transaction_id IS NULL)::text||'|'||(proof IS NULL)::text FROM payments.read_meld_checkout_context('${users[0].owner}','${id}');`, 'initiated|true|true|true');
  eq(`SELECT count(*) FROM payments.read_meld_checkout_context('${users[1].owner}','${id}');`, '0');
  for (const query of [create(id, 1), create(id, 0, 651), create(id, 0, 650, 'US', 'USD'), create(id, 0, 650, 'MX', 'MXN', 'another-account')]) deny(query, 'wallet_funding_request_already_used');
  deny(create(randomUUID(), 1).replace(users[1].address, users[0].address), 'wallet_funding_wallet_not_assigned');
  deny(create(randomUUID(), 1).replace(users[1].owner, 'blocked'), 'wallet_funding_forbidden');
  for (const [country, currency, amount] of [['US', 'USD', 50], ['CO', 'USD', 25000], ['MX', 'USD', 100], ['MX', 'MXN', 1], ['MX', 'MXN', 10000000]]) { const ref = randomUUID(); eq(create(ref, 2, amount, country, currency), ref); }
  for (const [country, currency, amount] of [['US', 'MXN', 650], ['CO', 'COP', 170000], ['ES', 'USD', 100], ['US', 'USD', 49.99], ['US', 'USD', 25000.01], ['MX', 'MXN', 0.99], ['MX', 'MXN', 10000000.01], ['MX', 'MXN', 650.001], ['MX', 'MXN', "'NaN'::numeric"]]) deny(create(randomUUID(), 1, amount, country, currency), 'wallet_funding_invalid_request');
  const oldRef = value('SELECT id FROM payments.meld_sandbox_funding_attempt LIMIT 1;', false);
  deny(create(oldRef, 1), 'wallet_funding_request_already_used');
  const hash = 'a'.repeat(64), finish = (owner = users[0].owner, ref = id, status = 'minted', urlHash = hash) =>
    `SELECT payments.finish_meld_sandbox_checkout_mint('${owner}','${ref}','${status}',${urlHash === null ? 'NULL' : lit(urlHash)});`;
  deny(finish(users[1].owner), 'wallet_funding_forbidden');
  deny(finish(users[0].owner, id, 'minted', 'bad'), 'wallet_funding_invalid_request');
  eq(finish(), 't'); eq(finish(), 't'); eq(finish(users[0].owner, id, 'minted', 'b'.repeat(64)), 'f');
  eq(`SELECT count(*) FROM payments.read_meld_checkout_webhook_context('${id}','${users[0].customer}');`, '1');
  eq(`SELECT count(*) FROM payments.read_meld_checkout_webhook_context('${id}','${users[1].customer}');`, '0');
  const proof = { transactionId: 'generic-transaction', accountId: 'checkout-account', sessionId: 'generic-session', externalSessionId: id,
    externalCustomerId: users[0].customer, serviceProvider: 'BANXA', countryCode: 'MX', sourceCurrencyCode: 'MXN', sourceAmount: '650.00',
    destinationCurrencyCode: 'USDT_POLYGON', walletAddress: users[0].address, chainId: '137', paymentMethodType: 'CREDIT_DEBIT_CARD',
    providerStatus: 'PENDING', providerUpdatedAt: '2026-11-12T22:00:00.000Z', receivedAmount: '0' };
  const record = (p = proof, owner = users[0].owner, ref = id) => `SELECT payments.record_meld_checkout_proof('${owner}','${ref}',${lit(JSON.stringify(p))}::jsonb,'${hash}')->>'providerStatus';`;
  eq(record(), 'PENDING'); eq(record(), 'PENDING'); deny(record(proof, users[1].owner), 'wallet_funding_forbidden');
  for (const change of [{ accountId: 'other' }, { externalSessionId: randomUUID() }, { externalCustomerId: users[1].customer }, { countryCode: 'US' }, { sourceCurrencyCode: 'USD' }, { sourceAmount: '651.00' }, { destinationCurrencyCode: 'USDT' }, { walletAddress: users[1].address }, { chainId: '1' }]) deny(record({ ...proof, ...change }), 'meld_checkout_proof_context_mismatch');
  for (const change of [{ serviceProvider: 'BINANCECONNECT' }, { sessionId: '..' }, { transactionId: '.' }, { receivedAmount: '-1' }, { providerStatus: 'SETTLED', receivedAmount: '0' }, { unexpected: 'private' }, { receivedAmount: 'NaN' }]) deny(record({ ...proof, ...change }), 'meld_checkout_proof_invalid');
  for (const change of [{ serviceProvider: 'TRANSAK' }, { paymentMethodType: 'APPLE_PAY' }, { sessionId: 'different-session' }, { transactionId: 'different-transaction' }]) deny(record({ ...proof, ...change, providerUpdatedAt: '2026-11-12T22:01:00.000Z' }), 'meld_checkout_proof_session_conflict');
  const settled = { ...proof, providerStatus: 'SETTLED', providerUpdatedAt: '2026-11-12T22:02:00.000Z', receivedAmount: '31.123456' };
  eq(record(settled), 'SETTLED'); eq(record(proof), 'SETTLED'); eq(record({ ...proof, providerUpdatedAt: '2026-11-12T22:03:00.000Z' }), 'SETTLED');
  deny(record({ ...settled, receivedAmount: '32' }), 'meld_checkout_proof_version_conflict');
  eq(`SELECT count(*) FROM payments.read_meld_checkout_history('${users[0].owner}');`, '1');
  eq(`SELECT count(*) FROM payments.read_meld_checkout_history('${users[1].owner}');`, '0');
  const event = (hash = 'c'.repeat(64)) => `SELECT payments.record_meld_checkout_webhook_receipt('generic-event','TRANSACTION_CRYPTO_COMPLETE','2026-11-12T22:03:00Z','checkout-account','profile-fixture','${hash}','${id}');`;
  eq(event(), 't'); eq(event(), 'f'); deny(event('d'.repeat(64)), 'meld_checkout_receipt_collision');
  deny(event().replace('checkout-account', 'other-account').replace('generic-event', 'another-event'), 'meld_checkout_receipt_invalid');
  const race = randomUUID(), results = await Promise.all([parallelPsql(create(race, 3)), parallelPsql(create(race, 3))]);
  assert.ok(results.every(r => r.status === 0 && r.stdout.trim() === race)); probes++;
  for (let i = 0; i < 10; i++) { const ref = randomUUID(); eq(create(ref, 4), ref); } deny(create(randomUUID(), 4), 'wallet_funding_rate_limited');
  eq(rowsQ, before.rows, false); eq(fnQ, before.functions, false); deny(migration, 'meld_checkout_requires_fresh_review', false);
  const functions = functionNames.map(name => JSON.parse(value(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'owner',p.proowner,'prosecdef',p.prosecdef,'proconfig',p.proconfig,'acl',p.proacl)::text FROM pg_proc p WHERE oid='${name}'::regprocedure;`, false)));
  for (const f of functions) { assert.equal(f.owner, before.owner); assert.equal(f.prosecdef, true); assert.deepEqual(f.proconfig, ['search_path=pg_catalog']); probes++; }
  for (const name of functionNames) eq(`SELECT has_function_privilege('sandbox_fixture_default','${name}','EXECUTE');`, 'f', false);
  const tables = ['payments.meld_checkout_intent', 'payments.meld_checkout_webhook_receipt'].map(name => JSON.parse(value(`SELECT jsonb_build_object('name',${lit(name)},'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'kind',c.relkind,
    'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,true)) ORDER BY conname) FROM pg_constraint WHERE conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid) FROM pg_index WHERE indrelid=c.oid))::text FROM pg_class c WHERE c.oid='${name}'::regclass;`, false)));
  await writeFile(new URL('../.wrangler/meld-sandbox-checkout-113-manifest.json', import.meta.url), JSON.stringify({ migrationSha256: createHash('sha256').update(migration).digest('hex'), syntheticPostgresPassed: true,
    functions: functions.map(f => ({ ...f, ownerReferenceSignature: 'payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)' })), tables,
    constraints: [], changedFunctions: [], probes, existingRowsUnchanged: true, oldFunctionsAndFinancialRowsUnchanged: true,
    productionConnections: 0, actualCharges: 0, externalNetwork: 'disabled', deployableWithoutPublicKey: false }, null, 2));
  console.log(JSON.stringify({ meldSandboxCheckoutBuySchema: 'passed', probes, noBootstrapProviderSession: true, ownerIsolation: true,
    actualProviderPinnedAfterApi: true, existingRowsAndFunctionsUnchanged: true, productionConnections: 0, actualCharges: 0 }));
}
