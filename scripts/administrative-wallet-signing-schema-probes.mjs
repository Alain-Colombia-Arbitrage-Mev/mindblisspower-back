import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export async function runAdministrativeWalletSigningProbes({ container, docker, psql, value, parallelPsql, role, database }) {
  let probes = 0;
  const eq = (q, expected, runtime = true) => { assert.equal(value(q, runtime), expected, q); probes++; };
  const deny = (q, code, runtime = true) => { const r = psql(`${runtime ? `SET ROLE ${role};` : ''}${q}`, true);
    assert.notEqual(r.status, 0, q); assert.match(r.stderr, new RegExp(code), q); probes++; };
  const lit = x => `'${String(x).replaceAll("'", "''")}'`;
  const hash = x => createHash('sha256').update(x).digest('hex');
  assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container]).stdout.trim(), 'none');
  assert.equal(database, 'mindbliss_curated_20261025'); assert.equal(role, 'mindbliss_auth_core_v1');
  eq("SELECT to_regclass('payments.meld_checkout_intent') IS NULL;", 't', false);
  // Synthetic-only native session mirror; actual migration verifies existing Better Auth columns.
  psql(`CREATE TABLE IF NOT EXISTS auth.session(id text PRIMARY KEY,user_id text NOT NULL REFERENCES auth."user"(id),expires_at timestamptz NOT NULL);
    GRANT USAGE ON SCHEMA identity TO ${role};`);
  const users = Array.from({ length: 7 }, (_, i) => ({ owner: `signing-fixture-${i}`, address: `0xfa${String(i + 1).padStart(2, '0')}${'74'.repeat(18)}`, ordinal: 91 + i,
    session: `native-signing-fixture-${i}`, alternate: `native-signing-alternate-${i}` }));
  psql(`INSERT INTO auth."user"(id,eligible,email,name) VALUES ${users.map(u => `('${u.owner}',true,'${u.owner}@example.invalid','Synthetic')`).join(',')};
    INSERT INTO identity.administrative_wallet_pool(ordinal,address) VALUES ${users.map(u => `(${u.ordinal},'${u.address}')`).join(',')};
    INSERT INTO identity.administrative_wallet_assignment(subject,pool_ordinal) VALUES ${users.map(u => `('${u.owner}',${u.ordinal})`).join(',')};
    INSERT INTO auth.session(id,user_id,expires_at) VALUES ${users.flatMap(u => [u.session, u.alternate].map(id => `('${id}','${u.owner}',clock_timestamp()+interval '2 days')`)).join(',')};
    INSERT INTO auth.session VALUES('native-expired','${users[0].owner}',clock_timestamp()-interval '1 minute');`);
  for (const u of users) u.customer = value(`SELECT checkout_reference FROM identity.administrative_wallet_assignment WHERE subject='${u.owner}';`, false);
  const sessionsBefore = value('SELECT jsonb_agg(to_jsonb(s) ORDER BY id)::text FROM auth.session s;', false);
  const functionNames = ['identity.require_administrative_native_session(text,text)', 'identity.require_administrative_wallet_binding(text,text)',
    'identity.read_administrative_wallet_signing_status(text,text)', 'identity.create_administrative_wallet_signing_challenge(text,text,uuid,text)',
    'identity.read_administrative_wallet_signing_challenge(text,text,uuid)', 'identity.consume_administrative_wallet_signing_challenge(text,text,uuid,text,text,text)',
    'payments.prepare_administrative_wallet_transfer(text,text,uuid,text,text,text,text)', 'payments.read_administrative_wallet_transfer_history(text,text)',
    'payments.create_administrative_offramp_intent(text,text,uuid,text,text,text,text,text,text)', 'payments.finish_administrative_offramp_intent(text,text,uuid,text,text,numeric)',
    'payments.read_administrative_offramp_intent(text,text,uuid)', 'payments.read_administrative_offramp_history(text,text)',
    'payments.read_administrative_offramp_webhook_context(uuid,uuid,text)', 'payments.record_administrative_offramp_proof(uuid,jsonb,text)'];
  const newNames = functionNames.map(n => lit(n.split('.')[1].split('(')[0])).join(',');
  const fnQ = `SELECT md5(coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl,'config',p.proconfig) ORDER BY p.oid)::text,''))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('payments','identity','mlm') AND p.proname NOT IN(${newNames});`;
  const rowQueries = JSON.parse(value(`SELECT jsonb_agg(format('SELECT %L AS name,count(*)::text AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n''ORDER BY to_jsonb(t)::text),'''')) AS digest FROM %I.%I t',n.nspname||'.'||c.relname,n.nspname,c.relname) ORDER BY n.nspname,c.relname)::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast';`, false));
  const rowsQ = `SELECT jsonb_object_agg(name,jsonb_build_object('count',count,'digest',digest) ORDER BY name)::text FROM(${rowQueries.join(' UNION ALL ')})s;`;
  const before = { rows: value(rowsQ, false), functions: value(fnQ, false), owner: value(`SELECT proowner FROM pg_proc WHERE oid='payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)'::regprocedure;`, false) };
  const migration = await readFile(new URL('../_meta/migration/114_administrative_wallet_signing_dry_run.sql', import.meta.url), 'utf8');
  psql(migration); eq(rowsQ, before.rows, false); eq(fnQ, before.functions, false);
  const tableNames = ['identity.administrative_wallet_challenge', 'identity.administrative_wallet_binding', 'payments.administrative_wallet_transfer_draft', 'payments.administrative_offramp_intent'];
  for (const table of tableNames) { eq(`SELECT count(*) FROM ${table};`, '0', false); deny(`SELECT * FROM ${table};`, 'permission denied'); deny(`SET ROLE sandbox_fixture_default;SELECT * FROM ${table};`, 'permission denied', false); }
  for (let i = 0; i < 2; i++) deny(`SELECT ${functionNames[i].replace(/\(.*$/, '')}('${users[0].owner}','${users[0].session}');`, 'permission denied');
  const status = (i = 0, session = users[i].session) => `SELECT verified::text FROM identity.read_administrative_wallet_signing_status('${users[i].owner}','${session}');`;
  eq(status(), 'false'); for (const session of [users[1].session, 'native-expired', 'missing-session']) deny(status(0, session), 'administrative_signing_forbidden');
  const create = (i = 0, id = randomUUID(), nonce = randomBytes(32).toString('hex'), session = users[i].session) =>
    `SELECT row_to_json(r)::text FROM identity.create_administrative_wallet_signing_challenge('${users[i].owner}','${session}','${id}','${nonce}') r;`;
  const getChallenge = (i = 0, session = users[i].session) => { const row = JSON.parse(value(create(i, randomUUID(), randomBytes(32).toString('hex'), session))); probes++; return row; };
  const consume = (c, i = 0, session = users[i].session, address = users[i].address, messageHash = c.message_hash, signatureHash = 'b'.repeat(64)) =>
    `SELECT verified::text FROM identity.consume_administrative_wallet_signing_challenge('${users[i].owner}','${session}','${c.id}','${address}','${messageHash}','${signatureHash}');`;
  const c = getChallenge();
  assert.equal(c.address, users[0].address); assert.equal(c.chain_id, 137); assert.equal(c.message_hash, hash(c.message));
  assert.equal(c.session_context_hash, hash(`${users[0].owner}\n${users[0].session}`));
  assert.equal(c.message, `wallet.mindblisspower.com wants you to verify control of this administrative wallet:\n${c.address}\n\nMindbliss administrative wallet ownership only. No transaction or transfer of funds.\nSession context: ${c.session_context_hash}\n\nURI: https://wallet.mindblisspower.com/dashboard/wallet-administrative\nVersion: 1\nChain ID: 137\nNonce: ${c.nonce}\nIssued At: ${new Date(c.issued_at).toISOString()}\nExpiration Time: ${new Date(c.expires_at).toISOString()}\nRequest ID: ${c.id}`); probes++;
  eq(create(0, c.id, c.nonce), JSON.stringify(c));
  deny(consume(c, 1), 'administrative_signing_invalid_challenge'); deny(consume(c, 0, users[0].alternate), 'administrative_signing_invalid_challenge');
  deny(consume(c, 0, users[0].session, users[1].address), 'administrative_signing_signature_invalid');
  deny(consume(c, 0, users[0].session, users[0].address, 'c'.repeat(64)), 'administrative_signing_signature_invalid');
  deny(consume(c, 0, users[0].session, users[0].address, c.message_hash, 'bad'), 'administrative_signing_signature_invalid');
  eq(consume(c), 'true'); deny(consume(c), 'administrative_signing_invalid_challenge'); eq(status(), 'true');
  eq(`SELECT binding_expires_at<=verified_at+interval '24 hours' AND binding_expires_at<=native_expires_at FROM identity.administrative_wallet_binding WHERE subject='${users[0].owner}';`, 't', false);
  const old = getChallenge(1), current = getChallenge(1); deny(consume(old, 1), 'administrative_signing_invalid_challenge'); eq(consume(current, 1), 'true');
  getChallenge(1); deny(create(1), 'administrative_signing_rate_limited');
  getChallenge(1, users[1].alternate); getChallenge(1, users[1].alternate); deny(create(1, randomUUID(), randomBytes(32).toString('hex'), users[1].alternate), 'administrative_signing_rate_limited');
  const concurrent = getChallenge(2), consumeRace = await Promise.all([parallelPsql(consume(concurrent, 2)), parallelPsql(consume(concurrent, 2))]);
  assert.equal(consumeRace.filter(x => x.status === 0).length, 1); assert.equal(consumeRace.filter(x => /administrative_signing_invalid_challenge/.test(x.stderr)).length, 1); probes++;
  for (const i of [3, 4, 5, 6]) eq(consume(getChallenge(i), i), 'true');
  const token = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', recipient = '0x1234123412341234123412341234123412341234';
  const snapshot = (i, amount = '1', target = recipient) => { const [whole, decimal = ''] = amount.split('.'); const atomic = BigInt(whole) * 1000000n + BigInt(decimal.padEnd(6, '0'));
    const data = `0xa9059cbb${target.slice(2).padStart(64, '0')}${atomic.toString(16).padStart(64, '0')}`;
    return { atomic, data, hash: hash(JSON.stringify({ version: 1, chainId: 137, from: users[i].address, to: token, recipient: target, amountUnits: atomic.toString(), data, value: '0x0' })) }; };
  const draft = (i = 0, id = randomUUID(), amount = '1', target = recipient, session = users[i].session, custom = snapshot(i, amount, target)) =>
    `SELECT id FROM payments.prepare_administrative_wallet_transfer('${users[i].owner}','${session}','${id}','${target}','${amount}','${custom.data}','${custom.hash}');`;
  const draftId = randomUUID(); eq(draft(0, draftId), draftId); eq(draft(0, draftId), draftId);
  eq(`SELECT status||'|'||execution_mode||'|'||(expires_at<=created_at+interval '5 minutes')::text FROM payments.administrative_wallet_transfer_draft WHERE id='${draftId}';`, 'prepared|dry_run|true', false);
  deny(draft(0, draftId, '2'), 'administrative_transfer_request_already_used'); deny(draft(1, draftId), 'administrative_transfer_request_already_used');
  for (const amount of ['0.000001', '1000000000']) { const id = randomUUID(); eq(draft(0, id, amount), id); }
  for (const amount of ['0', '1000000001', '1.0000001', '-1', 'NaN']) deny(draft(0, randomUUID(), amount, recipient, users[0].session, snapshot(0)), 'administrative_transfer_invalid_amount');
  for (const target of [`0x${'0'.repeat(40)}`, users[0].address, token]) deny(draft(0, randomUUID(), '1', target), 'administrative_transfer_invalid_recipient');
  deny(draft(0, randomUUID(), '1', recipient, users[0].session, { data: snapshot(0).data, hash: 'f'.repeat(64) }), 'administrative_transfer_invalid_request');
  deny(draft(0, randomUUID(), '1', recipient, users[0].alternate), 'administrative_transfer_binding_required');
  eq(`SELECT count(*) FROM payments.read_administrative_wallet_transfer_history('${users[0].owner}','${users[0].alternate}');`, '3');
  eq(`SELECT count(*) FROM payments.read_administrative_wallet_transfer_history('${users[1].owner}','${users[1].session}');`, '0');
  const raceId = randomUUID(), draftRace = await Promise.all([parallelPsql(draft(3, raceId)), parallelPsql(draft(3, raceId))]);
  assert.ok(draftRace.every(x => x.status === 0 && x.stdout.trim() === raceId)); probes++;
  for (let n = 0; n < 10; n++) { const id = randomUUID(); eq(draft(4, id), id); } deny(draft(4), 'administrative_transfer_rate_limited');
  const sell = (i = 0, id = randomUUID(), country = 'US', fiat = 'USD', amount = '100', provider = 'TRANSAK', method = 'PAYOUT_TO_CARD', account = 'sandbox-account', session = users[i].session) =>
    `SELECT id FROM payments.create_administrative_offramp_intent('${users[i].owner}','${session}','${id}','${country}','${fiat}','${amount}','${provider}','${method}','${account}');`;
  const sellId = randomUUID(); eq(sell(0, sellId), sellId); eq(sell(0, sellId), sellId);
  deny(sell(0, sellId, 'US', 'USD', '101'), 'administrative_offramp_request_already_used'); deny(sell(1, sellId), 'administrative_offramp_request_already_used');
  deny(sell(0, randomUUID(), 'US', 'USD', '100', 'TRANSAK', 'PAYOUT_TO_CARD', 'sandbox-account', users[0].alternate), 'administrative_transfer_binding_required');
  for (const [country, fiat, amount, provider, method] of [['MX','MXN','0.000001','BANXA','LOCAL_BANK_TRANSFER'], ['CO','COP','1000000000','OTHER_PROVIDER','BANK_TEST']]) { const id = randomUUID(); eq(sell(2, id, country, fiat, amount, provider, method), id); }
  for (const [country, fiat, amount, provider, method] of [['US','MXN','100','TRANSAK','PAYOUT_TO_CARD'], ['MX','COP','100','TRANSAK','PAYOUT_TO_CARD'], ['ES','USD','100','TRANSAK','PAYOUT_TO_CARD'], ['CO','COP','1.0000001','TRANSAK','PAYOUT_TO_CARD'], ['US','USD','0','TRANSAK','PAYOUT_TO_CARD'], ['US','USD','100','bad','PAYOUT_TO_CARD'], ['US','USD','100','TRANSAK','']]) deny(sell(2, randomUUID(), country, fiat, amount, provider, method), 'administrative_offramp_invalid_request');
  const finish = (id = sellId, i = 0, state = 'session_created', session = 'provider-session-fixture', quote = '95.01') =>
    `SELECT payments.finish_administrative_offramp_intent('${users[i].owner}','${users[i].session}','${id}','${state}',${session === null ? 'NULL' : lit(session)},${quote});`;
  eq(finish(), 't'); eq(finish(), 't'); eq(finish(sellId, 0, 'session_created', 'other-session'), 'f'); deny(finish(sellId, 1), 'administrative_signing_forbidden');
  eq(`SELECT count(*) FROM payments.read_administrative_offramp_intent('${users[0].owner}','${users[0].alternate}','${sellId}');`, '1');
  eq(`SELECT count(*) FROM payments.read_administrative_offramp_intent('${users[1].owner}','${users[1].session}','${sellId}');`, '0');
  eq(`SELECT count(*) FROM payments.read_administrative_offramp_webhook_context('${sellId}','${users[0].customer}','provider-session-fixture');`, '1');
  eq(`SELECT count(*) FROM payments.read_administrative_offramp_webhook_context('${sellId}','${users[1].customer}','provider-session-fixture');`, '0');
  const proof = { transactionId: 'offramp-transaction-fixture', accountId: 'sandbox-account', sessionId: 'provider-session-fixture', externalSessionId: sellId,
    externalCustomerId: users[0].customer, serviceProvider: 'TRANSAK', countryCode: 'US', destinationCurrencyCode: 'USD', sourceCurrencyCode: 'USDT_POLYGON', sourceAmount: '100',
    sourceWalletAddress: users[0].address, chainId: '137', paymentMethodType: 'PAYOUT_TO_CARD', providerStatus: 'PENDING', providerUpdatedAt: '2026-11-12T22:00:00.000Z', destinationAmount: '0' };
  const record = (p = proof, id = sellId) => `SELECT payments.record_administrative_offramp_proof('${id}',${lit(JSON.stringify(p))}::jsonb,'${hash(JSON.stringify(p))}')->>'providerStatus';`;
  psql(`DELETE FROM auth.session WHERE id='${users[0].session}';`); deny(status(), 'administrative_signing_forbidden'); deny(draft(), 'administrative_signing_forbidden');
  eq(record(), 'PENDING'); eq(record(), 'PENDING'); // Vendor facts remain valid after logout; no user signature or spend occurs.
  for (const change of [{ accountId: 'wrong' }, { sessionId: 'wrong' }, { externalSessionId: randomUUID() }, { externalCustomerId: users[1].customer }, { serviceProvider: 'BANXA' }, { countryCode: 'MX' }, { destinationCurrencyCode: 'MXN' }, { sourceCurrencyCode: 'USDT' }, { sourceAmount: '101' }, { sourceWalletAddress: users[1].address }, { chainId: '1' }, { paymentMethodType: 'OTHER_METHOD' }]) deny(record({ ...proof, ...change }), 'administrative_offramp_proof_context_mismatch');
  for (const change of [{ unexpected: 'private' }, { destinationAmount: '-1' }, { providerStatus: 'UNKNOWN' }, { providerStatus: 'SETTLED', destinationAmount: '0' }, { transactionId: '..' }, { providerUpdatedAt: 'not-a-date' }, { depositWalletAddress: `0x${'0'.repeat(40)}` }]) deny(record({ ...proof, ...change }), 'administrative_offramp_proof_invalid');
  const missing = { ...proof }; delete missing.accountId; deny(record(missing), 'administrative_offramp_proof_invalid');
  deny(record({ ...proof, depositWalletAddress: users[0].address }), 'administrative_offramp_proof_context_mismatch');
  const deposit = { ...proof, depositWalletAddress: recipient, providerUpdatedAt: '2026-11-12T22:01:00.000Z' }; eq(record(deposit), 'PENDING');
  deny(record({ ...deposit, depositWalletAddress: users[1].address, providerUpdatedAt: '2026-11-12T22:02:00.000Z' }), 'administrative_offramp_proof_deposit_conflict');
  deny(record({ ...proof, providerUpdatedAt: '2026-11-12T22:02:00.000Z' }), 'administrative_offramp_proof_deposit_conflict');
  const settled = { ...deposit, providerStatus: 'SETTLED', destinationAmount: '95.01', providerUpdatedAt: '2026-11-12T22:03:00.000Z' }; eq(record(settled), 'SETTLED');
  eq(record({ ...deposit, providerUpdatedAt: '2026-11-12T22:04:00.000Z' }), 'SETTLED');
  deny(record({ ...settled, destinationAmount: '96' }), 'administrative_offramp_proof_version_conflict');
  deny(record({ ...settled, transactionId: 'another-transaction', providerUpdatedAt: '2026-11-12T22:04:00.000Z' }), 'administrative_offramp_proof_transaction_conflict');
  eq(`SELECT count(*) FROM payments.read_administrative_offramp_history('${users[0].owner}','${users[0].alternate}');`, '1');
  for (let n = 0; n < 10; n++) { const id = randomUUID(); eq(sell(5, id), id); } deny(sell(5), 'administrative_offramp_rate_limited');
  psql(`UPDATE auth.session SET expires_at=clock_timestamp()+interval '10 minutes' WHERE id='${users[6].alternate}';`);
  const short = getChallenge(6, users[6].alternate); eq(consume(short, 6, users[6].alternate), 'true');
  eq(`SELECT b.binding_expires_at=s.expires_at FROM identity.administrative_wallet_binding b JOIN auth.session s ON s.id=b.native_session_id WHERE b.subject='${users[6].owner}' AND b.native_session_id='${users[6].alternate}';`, 't', false);
  const expiring = getChallenge(6); psql(`UPDATE identity.administrative_wallet_challenge SET issued_at=issued_at-interval '10 minutes',expires_at=expires_at-interval '10 minutes' WHERE id='${expiring.id}';`);
  deny(consume(expiring, 6), 'administrative_signing_invalid_challenge');
  eq(`SELECT count(*) FROM identity.read_administrative_wallet_signing_challenge('${users[6].owner}','${users[6].session}','${expiring.id}');`, '0');
  psql(`UPDATE auth.session SET expires_at=clock_timestamp()-interval '1 second' WHERE id='${users[6].alternate}';`);
  deny(status(6, users[6].alternate), 'administrative_signing_forbidden'); deny(sell(6, randomUUID(), 'US', 'USD', '100', 'TRANSAK', 'PAYOUT_TO_CARD', 'sandbox-account', users[6].alternate), 'administrative_signing_forbidden');
  // Restore only this synthetic auth fixture after revocation probes; every preexisting row digest must still match.
  psql(`TRUNCATE auth.session; INSERT INTO auth.session SELECT * FROM jsonb_populate_recordset(NULL::auth.session,${lit(sessionsBefore)}::jsonb);`);
  eq(rowsQ, before.rows, false); eq(fnQ, before.functions, false); deny(migration, 'administrative_signing_requires_fresh_review', false);
  const functions = functionNames.map((name, i) => JSON.parse(value(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'owner',p.proowner,'prosecdef',p.prosecdef,'proconfig',p.proconfig,'acl',p.proacl,'runtimeExecute',${i >= 2})::text FROM pg_proc p WHERE oid='${name}'::regprocedure;`, false)));
  for (const f of functions) { assert.equal(f.owner, before.owner); assert.equal(f.prosecdef, true); assert.deepEqual(f.proconfig, ['search_path=pg_catalog']); probes++; }
  for (const [i, name] of functionNames.entries()) { eq(`SELECT has_function_privilege('sandbox_fixture_default','${name}','EXECUTE');`, 'f', false); eq(`SELECT has_function_privilege('${role}','${name}','EXECUTE');`, i < 2 ? 'f' : 't', false); }
  const tables = tableNames.map(name => JSON.parse(value(`SELECT jsonb_build_object('name',${lit(name)},'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'kind',c.relkind,
    'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,true)) ORDER BY conname) FROM pg_constraint WHERE conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid) FROM pg_index WHERE indrelid=c.oid))::text FROM pg_class c WHERE c.oid='${name}'::regclass;`, false)));
  await writeFile(new URL('../.wrangler/administrative-wallet-signing-114-manifest.json', import.meta.url), JSON.stringify({ migrationSha256: hash(migration), syntheticPostgresPassed: true,
    functions: functions.map(f => ({ ...f, ownerReferenceSignature: 'payments.create_meld_sandbox_funding_attempt_v2(text,text,text,numeric,uuid,text,text,text)' })), tables,
    constraints: [], changedFunctions: [], probes, existingRowsUnchanged: true, oldFunctionsAndFinancialRowsUnchanged: true,
    productionConnections: 0, actualCharges: 0, broadcasts: 0, externalNetwork: 'disabled', independentOfMigration113: true }, null, 2));
  console.log(JSON.stringify({ administrativeSigningSchema: 'passed', probes, nativeSessionBound: true, ownerIsolation: true, dryRunOnly: true,
    vendorFactsAfterLogout: true, existingRowsAndFunctionsUnchanged: true, productionConnections: 0, actualCharges: 0, broadcasts: 0 }));
}
