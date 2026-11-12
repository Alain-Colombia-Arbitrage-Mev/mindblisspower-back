import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

export async function runPersonalColombiaBankProbes({ container, docker, psql, value, parallelPsql, role, database }) {
  let probes = 0;
  const eq = (sql, expected, runtime = true) => { assert.equal(value(sql, runtime), expected); probes++; };
  const deny = (sql, code, runtime = true) => {
    const result = psql(`${runtime ? `SET ROLE ${role};` : ''}${sql}`, true);
    assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(code)); probes++;
  };
  assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container]).stdout.trim(), 'none');
  assert.match(container, /^mb-(polygon-relay|wallet-funding)-test-[a-f0-9-]{36}$/);
  assert.equal(database, 'mindbliss_curated_20261025'); assert.equal(role, 'mindbliss_auth_core_v1');
  const users = Array.from({ length: 6 }, (_, i) => ({ owner: `cop-bank-${i}`, address: `0xc1${(i + 1).toString(16).padStart(2, '0')}${'79'.repeat(18)}` }));
  psql(`INSERT INTO auth."user"(id,eligible,email,name) VALUES ${users.map(v => `('${v.owner}',true,'${v.owner}@example.invalid','Synthetic')`).join(',')};
    INSERT INTO identity.wallet_binding(subject,address) VALUES ${users.map(v => `('${v.owner}','${v.address}')`).join(',')};`);
  const intent = (id = randomUUID(), i = 0, amount = '170000', country = 'CO', currency = 'COP', method = 'PSE', version = 6) =>
    `SELECT id FROM payments.create_reown_funding_intent_v${version}('${users[i].owner}','${users[i].address}','${country}',${amount},'${id}','${method}','${currency}');`;
  const oldPse = [randomUUID(), randomUUID()];
  eq(intent(oldPse[0], 0, '42300', 'CO', 'COP', 'PSE', 5), oldPse[0]);
  eq(intent(oldPse[1], 0, '100000', 'CO', 'COP', 'PSE', 5), oldPse[1]);
  const tableQueries = JSON.parse(value(`SELECT jsonb_agg(format('SELECT %L AS name,count(*)::text AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),'''')) AS digest FROM %I.%I t',n.nspname||'.'||c.relname,n.nspname,c.relname) ORDER BY n.nspname,c.relname)::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast';`, false));
  const rowsQuery = `SELECT jsonb_object_agg(name,jsonb_build_object('count',count,'digest',digest) ORDER BY name)::text FROM (${tableQueries.join(' UNION ALL ')}) s;`;
  const functionsQuery = `SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl) ORDER BY p.oid)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('payments','identity','mlm') AND p.proname<>'create_reown_funding_intent_v6';`;
  const constraintsQuery = `SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,true),'validated',convalidated) ORDER BY conname)::text
    FROM pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass AND conname='reown_funding_intent_requested_amount_check';`;
  const otherFinanceQuery = `SELECT md5(jsonb_build_object('admin',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payments.meld_sandbox_funding_attempt t),
    'meld',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payments.meld_onramp_attempt t),'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM mlm.wallet_movement t),
    'catalogue',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM mlm.package t))::text);`;
  const rowsBefore = value(rowsQuery, false), functionsBefore = value(functionsQuery, false), otherFinanceBefore = value(otherFinanceQuery, false);
  const constraintsBefore = JSON.parse(value(constraintsQuery, false));
  const migration = await readFile(new URL('../_meta/migration/109_personal_colombia_bank_bounds.sql', import.meta.url), 'utf8');
  deny(`BEGIN;ALTER TABLE payments.reown_funding_intent DISABLE ROW LEVEL SECURITY;${migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')}`, 'personal_cop_bank_runtime_isolation_required', false);
  psql(migration); eq(rowsQuery, rowsBefore, false); eq(functionsQuery, functionsBefore, false);
  for (let i = 0; i < oldPse.length; i++) {
    eq(`SELECT requested_amount::text||'|'||source_currency||'|'||payment_method||'|'||status FROM payments.read_wallet_funding_status_v3('${users[0].owner}','personal','${oldPse[i]}');`, `${i === 0 ? '42300' : '100000'}.00|COP|PSE|initiated`);
    deny(intent(oldPse[i], 0, i === 0 ? '42300' : '100000'), 'wallet_funding_invalid_request');
  }
  const pse = randomUUID(), local = randomUUID(), maximum = randomUUID();
  eq(intent(pse), pse); eq(intent(pse), pse);
  eq(intent(local, 0, '170000', 'CO', 'COP', 'LOCAL_BANK_TRANSFER'), local);
  eq(intent(local, 0, '170000', 'CO', 'COP', 'LOCAL_BANK_TRANSFER'), local);
  eq(intent(maximum, 0, '4000000', 'CO', 'COP', 'LOCAL_BANK_TRANSFER'), maximum);
  eq(`SELECT count(*) FROM payments.reown_funding_intent WHERE id IN('${pse}','${local}','${maximum}');`, '3', false);
  eq(`SELECT source_currency||'|'||payment_method||'|'||destination_currency FROM payments.read_wallet_funding_status_v3('${users[0].owner}','personal','${local}');`, 'COP|LOCAL_BANK_TRANSFER|USDT_POLYGON');
  eq(`SELECT count(*) FROM payments.read_wallet_funding_status_v3('${users[1].owner}','personal','${local}');`, '0');
  eq(`SELECT count(*) FROM payments.read_wallet_funding_status_v3('${users[0].owner}','administrative','${local}');`, '0');
  deny(intent(local), 'wallet_funding_request_already_used');
  deny(intent(pse, 0, '170000', 'CO', 'COP', 'LOCAL_BANK_TRANSFER'), 'wallet_funding_request_already_used');
  deny(intent(local, 0, '170001', 'CO', 'COP', 'LOCAL_BANK_TRANSFER'), 'wallet_funding_request_already_used');
  deny(intent(local, 0, '100', 'CO', 'USD', 'CREDIT_DEBIT_CARD'), 'wallet_funding_request_already_used');
  deny(intent(local, 1, '170000', 'CO', 'COP', 'LOCAL_BANK_TRANSFER'), 'wallet_funding_request_already_used');
  deny(intent(randomUUID(), 1).replace(users[1].address, users[0].address), 'wallet_funding_wallet_not_linked');
  deny(intent(randomUUID(), 1).replace(users[1].owner, 'blocked'), 'wallet_funding_forbidden');
  for (const method of ['PSE', 'LOCAL_BANK_TRANSFER']) for (const amount of ['169999.99', '4000000.01', '0', '170000.001', "'NaN'::numeric"]) {
    deny(intent(randomUUID(), 1, amount, 'CO', 'COP', method), 'wallet_funding_invalid_request');
  }
  for (const [country, currency, method, amount] of [['MX', 'COP', 'PSE', '170000'], ['US', 'COP', 'LOCAL_BANK_TRANSFER', '170000'],
    ['CO', 'COP', 'SPEI', '170000'], ['CO', 'COP', 'CREDIT_DEBIT_CARD', '170000'], ['CO', 'COP', 'BREB', '170000'],
    ['CO', 'USD', 'PSE', '100'], ['MX', 'USD', 'SPEI', '100'], ['US', 'USD', 'LOCAL_BANK_TRANSFER', '100']]) {
    deny(intent(randomUUID(), 1, amount, country, currency, method), 'wallet_funding_invalid_request');
  }
  deny(`BEGIN ISOLATION LEVEL REPEATABLE READ;SET ROLE ${role};${intent(randomUUID(), 1)}`, 'wallet_funding_unavailable', false);
  const usd = randomUUID(), mxn = randomUUID();
  eq(intent(usd, 1, '50', 'CO', 'USD', 'CREDIT_DEBIT_CARD'), usd); eq(intent(usd, 1, '50', 'CO', 'USD', 'CREDIT_DEBIT_CARD', 5), usd);
  eq(intent(mxn, 1, '931', 'MX', 'MXN', 'SPEI'), mxn); eq(intent(mxn, 1, '931', 'MX', 'MXN', 'SPEI', 5), mxn);
  const racedId = randomUUID(), raced = await Promise.all([parallelPsql(intent(racedId, 2, '170000', 'CO', 'COP', 'LOCAL_BANK_TRANSFER')),
    parallelPsql(intent(racedId, 2, '170000', 'CO', 'COP', 'LOCAL_BANK_TRANSFER'))]);
  assert.ok(raced.every(r => r.status === 0 && r.stdout.trim() === racedId)); probes++;
  eq(`SELECT count(*) FROM payments.reown_funding_intent WHERE id='${racedId}';`, '1', false);
  for (let i = 0; i < 10; i++) { const id = randomUUID(); eq(intent(id, 3, '170000', 'CO', 'COP', i % 2 ? 'PSE' : 'LOCAL_BANK_TRANSFER'), id); }
  deny(intent(randomUUID(), 3), 'wallet_funding_rate_limited');
  const directInsert = (method = "'PSE'", country = 'CO') => `INSERT INTO payments.reown_funding_intent(id,subject,wallet_address,country_code,requested_amount,payment_method,source_currency,destination_currency)
    VALUES('${randomUUID()}','${users[5].owner}','${users[5].address}','${country}',170000,${method},'COP','USDT_POLYGON');`;
  deny(directInsert('NULL'), 'reown_funding_intent_requested_amount_check', false);
  deny(directInsert("'SPEI'"), 'reown_funding_intent_requested_amount_check', false);
  deny(directInsert("'LOCAL_BANK_TRANSFER'", 'MX'), 'reown_funding_intent_requested_amount_check', false);
  deny('SELECT * FROM payments.reown_funding_intent;', 'permission denied');
  eq(otherFinanceQuery, otherFinanceBefore, false); eq(functionsQuery, functionsBefore, false);
  const newFunction = JSON.parse(value(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),
    'securityDefiner',p.prosecdef,'owner',pg_get_userbyid(p.proowner),'config',p.proconfig,'acl',p.proacl)::text
    FROM pg_proc p WHERE p.oid='payments.create_reown_funding_intent_v6(text,text,text,numeric,uuid,text,text)'::regprocedure;`, false));
  assert.equal(newFunction.securityDefiner, true); assert.deepEqual(newFunction.config, ['search_path=pg_catalog']); probes++;
  const constraintsAfter = JSON.parse(value(constraintsQuery, false));
  deny(migration, 'personal_cop_bank_requires_fresh_review', false);
  await mkdir(new URL('../.wrangler/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.wrangler/colombia-banks-109-manifest.json', import.meta.url), JSON.stringify({
    migrationSha256: createHash('sha256').update(migration).digest('hex'), syntheticPostgresPassed: true,
    function: { signature: newFunction.signature, md5: newFunction.md5 }, newFunction,
    constraints: constraintsBefore.map(before => ({ name: before.name, before: before.definition, after: constraintsAfter.find(after => after.name === before.name).definition })),
    probes, oldRowsUnchangedByMigration: true, oldFunctionsUnchanged: true, historicalPseAmountsPreserved: true,
    productionConnections: 0, externalNetwork: 'disabled', actualCharges: 0 }, null, 2));
  console.log(JSON.stringify({ personalColombiaBankSchema: 'passed', probes, productionConnections: 0, actualCharges: 0,
    ownerIsolation: true, immutableDistinctRails: true, bounds: [170000, 4000000], historicalPseAmountsPreserved: true,
    administrativeUnchanged: true, manifest: '.wrangler/colombia-banks-109-manifest.json' }));
}
