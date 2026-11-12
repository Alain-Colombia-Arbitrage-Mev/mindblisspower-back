import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

export async function runPersonalColombiaPseProbes({ container, docker, psql, value, parallelPsql, role, database }) {
  let probes = 0;
  const eq = (sql, expected, runtime = true) => { assert.equal(value(sql, runtime), expected); probes++; };
  const deny = (sql, code, runtime = true) => {
    const result = psql(`${runtime ? `SET ROLE ${role};` : ''}${sql}`, true);
    assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(code)); probes++;
  };
  assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container]).stdout.trim(), 'none');
  assert.match(container, /^mb-(polygon-relay|wallet-funding)-test-[a-f0-9-]{36}$/);
  assert.equal(database, 'mindbliss_curated_20261025'); assert.equal(role, 'mindbliss_auth_core_v1');
  const users = Array.from({ length: 5 }, (_, i) => ({ owner: `cop-pse-${i}`, address: `0xc0${(i + 1).toString(16).padStart(2, '0')}${'78'.repeat(18)}` }));
  psql(`INSERT INTO auth."user"(id,eligible,email,name) VALUES ${users.map(v => `('${v.owner}',true,'${v.owner}@example.invalid','Synthetic')`).join(',')};
    INSERT INTO identity.wallet_binding(subject,address) VALUES ${users.map(v => `('${v.owner}','${v.address}')`).join(',')};`);
  const tableQueries = JSON.parse(value(`SELECT jsonb_agg(format('SELECT %L AS name,count(*)::text AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),'''')) AS digest FROM %I.%I t',n.nspname||'.'||c.relname,n.nspname,c.relname) ORDER BY n.nspname,c.relname)::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast';`, false));
  const rowsQuery = `SELECT jsonb_object_agg(name,jsonb_build_object('count',count,'digest',digest) ORDER BY name)::text FROM (${tableQueries.join(' UNION ALL ')}) s;`;
  const functionsQuery = `SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl) ORDER BY p.oid)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('payments','identity','mlm') AND p.proname<>'create_reown_funding_intent_v5';`;
  const constraintQuery = `SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,true),'validated',convalidated) ORDER BY conname)::text
    FROM pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass AND conname IN('reown_funding_intent_source_currency_check','reown_funding_intent_requested_amount_check');`;
  const rowsBefore = value(rowsQuery, false), functionsBefore = value(functionsQuery, false), constraintsBefore = JSON.parse(value(constraintQuery, false));
  const otherFinanceQuery = `SELECT md5(jsonb_build_object('admin',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payments.meld_sandbox_funding_attempt t),
    'meld',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payments.meld_onramp_attempt t),
    'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM mlm.wallet_movement t),
    'catalogue',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM mlm.package t))::text);`;
  const otherFinanceBefore = value(otherFinanceQuery, false);
  const migration = await readFile(new URL('../_meta/migration/108_personal_colombia_cop_pse.sql', import.meta.url), 'utf8');
  deny(`BEGIN;ALTER TABLE payments.reown_funding_intent DISABLE ROW LEVEL SECURITY;${migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')}`, 'personal_cop_pse_runtime_isolation_required', false);
  eq(rowsQuery, rowsBefore, false); eq(functionsQuery, functionsBefore, false);
  psql(migration);
  eq(rowsQuery, rowsBefore, false); eq(functionsQuery, functionsBefore, false);
  const intent = (id = randomUUID(), i = 0, amount = '42300', country = 'CO', currency = 'COP', method = 'PSE', version = 5) =>
    `SELECT id FROM payments.create_reown_funding_intent_v${version}('${users[i].owner}','${users[i].address}','${country}',${amount},'${id}','${method}','${currency}');`;
  const id = randomUUID(); eq(intent(id), id); eq(intent(id), id);
  eq(`SELECT count(*) FROM payments.reown_funding_intent WHERE id='${id}';`, '1', false);
  eq(`SELECT source_currency||'|'||payment_method||'|'||country_code||'|'||destination_currency||'|'||requested_amount::text
    FROM payments.read_wallet_funding_status_v3('${users[0].owner}','personal','${id}');`, 'COP|PSE|CO|USDT_POLYGON|42300.00');
  eq(`SELECT count(*) FROM payments.read_wallet_funding_status_v3('${users[1].owner}','personal','${id}');`, '0');
  eq(`SELECT count(*) FROM payments.read_wallet_funding_status_v3('${users[0].owner}','administrative','${id}');`, '0');
  eq(`SELECT count(*) FROM payments.read_wallet_funding_history('${users[0].owner}','personal');`, '0');
  eq(`SELECT source_currency FROM payments.read_wallet_funding_history_v3('${users[0].owner}','personal');`, 'COP');
  deny(intent(id, 0, '42301'), 'wallet_funding_request_already_used');
  deny(intent(id, 0, '100', 'CO', 'USD', 'CREDIT_DEBIT_CARD'), 'wallet_funding_request_already_used');
  deny(intent(id, 1), 'wallet_funding_request_already_used');
  deny(intent(randomUUID(), 1).replace(users[1].address, users[0].address), 'wallet_funding_wallet_not_linked');
  deny(intent(randomUUID(), 1).replace(users[1].owner, 'blocked'), 'wallet_funding_forbidden');
  for (const [amount, country, currency, method] of [['0', 'CO', 'COP', 'PSE'], ['1000000000.01', 'CO', 'COP', 'PSE'],
    ['42300.001', 'CO', 'COP', 'PSE'], ["'NaN'::numeric", 'CO', 'COP', 'PSE'], ['42300', 'US', 'COP', 'PSE'],
    ['42300', 'MX', 'COP', 'PSE'], ['42300', 'CO', 'COP', 'SPEI'], ['42300', 'CO', 'COP', 'CREDIT_DEBIT_CARD'],
    ['42300', 'CO', 'COP', 'LOCAL_BANK_TRANSFER']]) deny(intent(randomUUID(), 1, amount, country, currency, method), 'wallet_funding_invalid_request');
  deny(`BEGIN ISOLATION LEVEL REPEATABLE READ;SET ROLE ${role};${intent(randomUUID(), 1)}`, 'wallet_funding_unavailable', false);
  deny(intent(randomUUID(), 1, '42300', 'CO', 'COP', 'PSE', 4), 'wallet_funding_invalid_request');
  const usd = randomUUID(), mxn = randomUUID();
  eq(intent(usd, 1, '50', 'CO', 'USD', 'CREDIT_DEBIT_CARD'), usd);
  eq(intent(mxn, 1, '931', 'MX', 'MXN', 'SPEI'), mxn);
  eq(intent(usd, 1, '50', 'CO', 'USD', 'CREDIT_DEBIT_CARD', 4), usd);
  eq(intent(mxn, 1, '931', 'MX', 'MXN', 'SPEI', 4), mxn);
  for (const [amount, country, currency, method] of [['29.99', 'US', 'USD', 'CREDIT_DEBIT_CARD'], ['15000.01', 'CO', 'USD', 'CREDIT_DEBIT_CARD'],
    ['930.99', 'MX', 'MXN', 'SPEI'], ['931', 'CO', 'MXN', 'SPEI'], ['50', 'CO', 'USD', 'PSE']]) deny(intent(randomUUID(), 1, amount, country, currency, method), 'wallet_funding_invalid_request');
  const racedId = randomUUID(), raced = await Promise.all([parallelPsql(intent(racedId, 2)), parallelPsql(intent(racedId, 2))]);
  assert.ok(raced.every(r => r.status === 0 && r.stdout.trim() === racedId)); probes++;
  eq(`SELECT count(*) FROM payments.reown_funding_intent WHERE id='${racedId}';`, '1', false);
  for (let i = 0; i < 10; i++) { const cappedId = randomUUID(); eq(intent(cappedId, 3), cappedId); }
  deny(intent(randomUUID(), 3), 'wallet_funding_rate_limited');
  deny('SELECT * FROM payments.reown_funding_intent;', 'permission denied');
  eq(`SELECT has_function_privilege('${role}','payments.create_reown_funding_intent_v5(text,text,text,numeric,uuid,text,text)','EXECUTE');`, 't', false);
  const newFunction = JSON.parse(value(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),
    'securityDefiner',p.prosecdef,'owner',pg_get_userbyid(p.proowner),'config',p.proconfig,'acl',p.proacl)::text
    FROM pg_proc p WHERE p.oid='payments.create_reown_funding_intent_v5(text,text,text,numeric,uuid,text,text)'::regprocedure;`, false));
  assert.equal(newFunction.securityDefiner, true); assert.deepEqual(newFunction.config, ['search_path=pg_catalog']); probes++;
  const constraintsAfter = JSON.parse(value(constraintQuery, false));
  eq(functionsQuery, functionsBefore, false);
  eq(otherFinanceQuery, otherFinanceBefore, false);
  deny(migration, 'personal_cop_pse_requires_fresh_review', false);
  const output = new URL('../.wrangler/colombia-pse-108-manifest.json', import.meta.url);
  await mkdir(new URL('../.wrangler/', import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify({ migrationSha256: createHash('sha256').update(migration).digest('hex'), syntheticPostgresPassed: true,
    function: { signature: newFunction.signature, md5: newFunction.md5 },
    constraints: constraintsBefore.map(before => ({ name: before.name, before: before.definition,
      after: constraintsAfter.find(after => after.name === before.name).definition })), newFunction,
    constraintsBefore, constraintsAfter, probes, oldRowsUnchangedByMigration: true, oldFunctionsUnchanged: true, productionConnections: 0,
    externalNetwork: 'disabled', actualCharges: 0 }, null, 2));
  console.log(JSON.stringify({ personalColombiaPseSchema: 'passed', probes, productionConnections: 0, externalNetwork: 'disabled', actualCharges: 0,
    ownerIsolation: true, immutableRequestReplay: true, unchangedUsdMxn: true, administrativeProviderUnchanged: true, manifest: '.wrangler/colombia-pse-108-manifest.json' }));
}
