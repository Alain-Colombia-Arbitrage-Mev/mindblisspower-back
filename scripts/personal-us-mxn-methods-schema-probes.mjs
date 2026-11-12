import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

export async function runPersonalUsMxnMethodsProbes({ container, docker, psql, value, parallelPsql, role, database }) {
  let probes = 0;
  const eq = (sql, expected, runtime = true) => { assert.equal(value(sql, runtime), expected); probes++; };
  const deny = (sql, code, runtime = true) => { const result = psql(`${runtime ? `SET ROLE ${role};` : ''}${sql}`, true); assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(code)); probes++; };
  assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container]).stdout.trim(), 'none');
  assert.match(container, /^mb-(polygon-relay|wallet-funding)-test-[a-f0-9-]{36}$/);
  assert.equal(database, 'mindbliss_curated_20261025'); assert.equal(role, 'mindbliss_auth_core_v1');
  const users = Array.from({ length: 6 }, (_, i) => ({ owner: `us-mxn-${i}`, address: `0xc2${(i + 1).toString(16).padStart(2, '0')}${'80'.repeat(18)}` }));
  psql(`INSERT INTO auth."user"(id,eligible,email,name) VALUES ${users.map(v => `('${v.owner}',true,'${v.owner}@example.invalid','Synthetic')`).join(',')};
    INSERT INTO identity.wallet_binding(subject,address) VALUES ${users.map(v => `('${v.owner}','${v.address}')`).join(',')};`);
  const intent = (id = randomUUID(), i = 0, amount = '931', country = 'MX', currency = 'MXN', method = 'CREDIT_DEBIT_CARD', version = 7) =>
    `SELECT id FROM payments.create_reown_funding_intent_v${version}('${users[i].owner}','${users[i].address}','${country}',${amount},'${id}','${method}','${currency}');`;
  const oldSpei = randomUUID(), oldCop = randomUUID();
  eq(intent(oldSpei, 0, '931', 'MX', 'MXN', 'SPEI', 6), oldSpei);
  eq(intent(oldCop, 4, '100000', 'CO', 'COP', 'PSE', 5), oldCop);
  const tableQueries = JSON.parse(value(`SELECT jsonb_agg(format('SELECT %L AS name,count(*)::text AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),'''')) AS digest FROM %I.%I t',n.nspname||'.'||c.relname,n.nspname,c.relname) ORDER BY n.nspname,c.relname)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast';`, false));
  const rowsQuery = `SELECT jsonb_object_agg(name,jsonb_build_object('count',count,'digest',digest) ORDER BY name)::text FROM (${tableQueries.join(' UNION ALL ')}) s;`;
  const functionsQuery = `SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl) ORDER BY p.oid)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('payments','identity','mlm') AND p.proname<>'create_reown_funding_intent_v7';`;
  const constraintsQuery = `SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,true),'validated',convalidated) ORDER BY conname)::text FROM pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass AND conname='reown_funding_intent_requested_amount_check';`;
  const otherFinanceQuery = `SELECT md5(jsonb_build_object('admin',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payments.meld_sandbox_funding_attempt t),'meld',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payments.meld_onramp_attempt t),'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM mlm.wallet_movement t),'catalogue',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM mlm.package t))::text);`;
  const before = { rows: value(rowsQuery, false), functions: value(functionsQuery, false), otherFinance: value(otherFinanceQuery, false), constraints: JSON.parse(value(constraintsQuery, false)) };
  const migration = await readFile(new URL('../_meta/migration/110_personal_us_venmo_mxn_cards.sql', import.meta.url), 'utf8');
  deny(`BEGIN;ALTER TABLE payments.reown_funding_intent DISABLE ROW LEVEL SECURITY;${migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')}`, 'personal_us_mxn_runtime_isolation_required', false);
  psql(migration); eq(rowsQuery, before.rows, false); eq(functionsQuery, before.functions, false);
  eq(intent(oldSpei, 0, '931', 'MX', 'MXN', 'SPEI'), oldSpei);
  for (const method of ['SPEI', 'CREDIT_DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY']) {
    const id = randomUUID(); eq(intent(id, 0, '931', 'MX', 'MXN', method), id); eq(intent(id, 0, '931', 'MX', 'MXN', method), id);
    eq(`SELECT source_currency||'|'||payment_method||'|'||destination_currency FROM payments.read_wallet_funding_status_v3('${users[0].owner}','personal','${id}');`, `MXN|${method}|USDT_POLYGON`);
    for (const amount of ['930.99', '1000000000.01', '931.001', "'NaN'::numeric"]) deny(intent(randomUUID(), 1, amount, 'MX', 'MXN', method), 'wallet_funding_invalid_request');
  }
  const id = randomUUID(); eq(intent(id, 0), id);
  deny(intent(id, 0, '932'), 'wallet_funding_request_already_used'); deny(intent(id, 0, '931', 'MX', 'MXN', 'APPLE_PAY'), 'wallet_funding_request_already_used');
  deny(intent(id, 1), 'wallet_funding_request_already_used'); deny(intent(randomUUID(), 1).replace(users[1].address, users[0].address), 'wallet_funding_wallet_not_linked');
  deny(intent(randomUUID(), 1).replace(users[1].owner, 'blocked'), 'wallet_funding_forbidden');
  const venmo = randomUUID(); eq(intent(venmo, 1, '100', 'US', 'USD', 'VENMO'), venmo);
  eq(`SELECT country_code||'|'||source_currency||'|'||payment_method FROM payments.read_wallet_funding_status_v3('${users[1].owner}','personal','${venmo}');`, 'US|USD|VENMO');
  eq(`SELECT count(*) FROM payments.read_wallet_funding_status_v3('${users[0].owner}','personal','${venmo}');`, '0');
  const paypal = randomUUID(); eq(intent(paypal, 1, '100', 'US', 'USD', 'PAYPAL'), paypal);
  for (const method of ['VENMO', 'PAYPAL']) for (const [country, currency, amount] of [['MX', 'USD', '100'], ['CO', 'USD', '100'], ['US', 'MXN', '931'], ['CO', 'COP', '170000']]) deny(intent(randomUUID(), 1, amount, country, currency, method), 'wallet_funding_invalid_request');
  for (const [country, method] of [['US', 'CREDIT_DEBIT_CARD'], ['CO', 'APPLE_PAY'], ['MX', 'PSE'], ['MX', 'LOCAL_BANK_TRANSFER']]) deny(intent(randomUUID(), 1, '931', country, 'MXN', method), 'wallet_funding_invalid_request');
  for (const method of ['PSE', 'LOCAL_BANK_TRANSFER']) deny(intent(randomUUID(), 4, '170000', 'CO', 'COP', method), 'wallet_funding_invalid_request');
  eq(`SELECT requested_amount::text||'|'||source_currency||'|'||status FROM payments.read_wallet_funding_status_v3('${users[4].owner}','personal','${oldCop}');`, '100000.00|COP|initiated');
  deny(intent(randomUUID(), 4, '169999.99', 'CO', 'COP', 'PSE'), 'wallet_funding_invalid_request');
  const racedId = randomUUID(), raced = await Promise.all([parallelPsql(intent(racedId, 2, '931', 'MX', 'MXN', 'GOOGLE_PAY')), parallelPsql(intent(racedId, 2, '931', 'MX', 'MXN', 'GOOGLE_PAY'))]);
  assert.ok(raced.every(r => r.status === 0 && r.stdout.trim() === racedId)); probes++;
  eq(`SELECT count(*) FROM payments.reown_funding_intent WHERE id='${racedId}';`, '1', false);
  for (let i = 0; i < 10; i++) { const id = randomUUID(); eq(intent(id, 3, '931', 'MX', 'MXN', i % 2 ? 'APPLE_PAY' : 'SPEI'), id); }
  deny(intent(randomUUID(), 3), 'wallet_funding_rate_limited');
  const insert = method => `INSERT INTO payments.reown_funding_intent(id,subject,wallet_address,country_code,requested_amount,payment_method,source_currency,destination_currency) VALUES('${randomUUID()}','${users[5].owner}','${users[5].address}','MX',931,${method},'MXN','USDT_POLYGON');`;
  deny(insert('NULL'), 'reown_funding_intent_requested_amount_check', false); deny(insert("'VENMO'"), 'reown_funding_intent_requested_amount_check', false);
  deny('SELECT * FROM payments.reown_funding_intent;', 'permission denied');
  eq(otherFinanceQuery, before.otherFinance, false); eq(functionsQuery, before.functions, false);
  const newFunction = JSON.parse(value(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'securityDefiner',p.prosecdef,'owner',pg_get_userbyid(p.proowner),'config',p.proconfig,'acl',p.proacl)::text FROM pg_proc p WHERE p.oid='payments.create_reown_funding_intent_v7(text,text,text,numeric,uuid,text,text)'::regprocedure;`, false));
  assert.equal(newFunction.securityDefiner, true); assert.deepEqual(newFunction.config, ['search_path=pg_catalog']); probes++;
  const after = JSON.parse(value(constraintsQuery, false)); deny(migration, 'personal_us_mxn_requires_fresh_review', false);
  await mkdir(new URL('../.wrangler/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.wrangler/us-venmo-mxn-110-manifest.json', import.meta.url), JSON.stringify({ migrationSha256: createHash('sha256').update(migration).digest('hex'), syntheticPostgresPassed: true, function: { signature: newFunction.signature, md5: newFunction.md5 }, newFunction, constraints: before.constraints.map(c => ({ name: c.name, before: c.definition, after: after.find(a => a.name === c.name).definition })), probes, oldRowsUnchangedByMigration: true, oldFunctionsUnchanged: true, productionConnections: 0, externalNetwork: 'disabled', actualCharges: 0 }, null, 2));
  console.log(JSON.stringify({ personalUsMxnMethodsSchema: 'passed', probes, productionConnections: 0, actualCharges: 0, venmoPaypalUsUsdOnly: true, mxnFloor: 931, ownerIsolation: true, immutableDistinctRails: true, copHistoryAndAdministrativeUnchanged: true, newCopDisabled: true, manifest: '.wrangler/us-venmo-mxn-110-manifest.json' }));
}
