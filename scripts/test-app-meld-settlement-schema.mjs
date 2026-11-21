import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.argv.length, 2);
const container = 'mb-meld-settlement-test-' + randomUUID();
const database = 'mindbliss_curated_20261025';
const runtime = 'mindbliss_auth_core_v1';
const owner = 'meld_settlement_test_owner';
const observer = 'meld_settlement_observer';
const relayOwner = 'meld_settlement_relay_owner';
const label = 'app-meld-settlement-138';
const image = 'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
const literal = value => value === null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
const hash = value => '0x' + value.repeat(64);
const wallet = user => '0x' + ({ alice: '7', bob: '2', carol: '8', dave: '9' })[user].repeat(40);
const usdc = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const usdt = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
const databaseArgs = ['exec', '-i', container, 'psql', '-X', '-w', '-qAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'];
const as = (role, query) => (role ? 'SET ROLE ' + role + ';' : '') + query;
function query(source, role = '') {
  const result = docker(databaseArgs, as(role, source));
  if (result.status !== 0) throw Error(result.stderr || result.error?.message || 'synthetic SQL failed');
  return result.stdout.trim();
}
function reject(source, expected, role = runtime) {
  const result = docker(databaseArgs, as(role, source));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, expected);
}
function read(subject = 'alice', session = 'alice-new', id = null) {
  return 'SELECT row_to_json(s) FROM payments.read_app_meld_settlement_v1(' + [subject, session, id].map(literal).join(',') + ') s;';
}
function packageView(subject = 'alice', session = 'alice-new') {
  return "SELECT concat_ws('|',level,ceiling_usd_minor,gross_usd_minor) FROM payments.read_app_recharge_package_v1(" +
    [subject, session].map(literal).join(',') + ');';
}
const receipts = { transaction: 'meld-proof-a', tx: hash('1'), block: 97670000,
  log: 42, blockHash: hash('2'), gross: 10000, fee: 359, received: 96410000 };
const attempts = new Map();
function proofArguments(proof) {
  return [proof.transaction, proof.tx, proof.log, proof.block, proof.blockHash].map(literal).join(',') +
    ',' + (proof.time ?? 'pg_catalog.clock_timestamp()') + ',' + [proof.gross, proof.fee, proof.received].map(literal).join(',');
}
function record(id, values = {}) {
  const r = { subject: attempts.get(id) ?? 'alice', session: 'alice-new', ...receipts, ...values };
  return 'SELECT payments.record_app_meld_settlement_v1(' +
    [r.subject, r.session, id].map(literal).join(',') + ',' + proofArguments(r) + ');';
}
const claim = 'SELECT coalesce(jsonb_agg(to_jsonb(c)),\'[]\') FROM payments.claim_app_meld_reconciliation_v1() c;';
function finishSchedule(id, lease, outcome) {
  return 'SELECT payments.finish_app_meld_reconciliation_v1(' + [id, lease, outcome].map(literal).join(',') + ');';
}
function recordSchedule(id, lease, values) {
  return 'SELECT payments.record_app_meld_scheduled_settlement_v1(' +
    [id, lease].map(literal).join(',') + ',' + proofArguments({ ...receipts, ...values }) + ');';
}
function parallel(source) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', databaseArgs, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', status => status === 0 ? resolve(stdout.trim()) : reject(Error(stderr)));
    child.stdin.end(as(runtime, source));
  });
}
function createAttempt({ subject = 'alice', currency = 'USD', amount, finish = true } = {}) {
  const id = randomUUID(), session = subject + '-old', usd = currency === 'USD';
  const address = wallet(subject);
  const args = [subject, session, id, address, 'MX', currency, amount ?? (usd ? 100 : 931),
    usd ? 'CREDIT_DEBIT_CARD' : 'SPEI', usd ? 'MERCURYO' : 'ONRAMPMONEY', 'merchant-test', 'USDC_POLYGON'];
  assert.equal(query('SELECT created FROM payments.reserve_app_meld_funding_v3(' + args.map(literal).join(',') + ');', runtime), 't');
  if (finish) {
    const finishArgs = [subject, session, id, 'session_created', id, 'merchant-customer'];
    assert.equal(query('SELECT payments.finish_app_meld_funding(' + finishArgs.map(literal).join(',') + ');', runtime), 't');
  }
  attempts.set(id, subject);
  return id;
}
function readOne(id) {
  return JSON.parse(query(read('alice', 'alice-new', id), runtime));
}
function pagarRegistration(id, subject = 'carol') {
  return 'SELECT payments.register_app_pagar_intent_v1(' + [subject, id].map(literal).join(',') + ');';
}
function pagarPrepare(id, { subject = 'carol', amount = 143000000, asset = usdc, app = true } = {}) {
  const sql = 'SELECT * FROM payments.prepare_synthetic_pagar(' +
    [id, subject, wallet(subject), amount, asset].map(literal).join(',') + ')';
  if (!app) return sql + ';';
  return 'WITH draft AS MATERIALIZED(' + sql + ') SELECT payments.register_app_pagar_intent_v1(' +
    literal(subject) + ',d.id) FROM draft d;';
}
function pagarConfirm(id, { block = 97670050, confirmations = 12 } = {}) {
  query("UPDATE payments.personal_polygon_relay SET status='confirmed',confirmed_at=clock_timestamp(),confirmations=" +
    confirmations + ',block_number=' + literal(block) + ',block_hash=' + literal(hash('a')) +
    ",user_operation_hash='0x'||replace(id::text,'-','')||repeat('2',32)" +
    ",transaction_hash='0x'||replace(id::text,'-','')||repeat('1',32) WHERE id=" + literal(id) + ';');
}
const pendingPagar = "SELECT coalesce(jsonb_agg(to_jsonb(i)),'[]') FROM payments.read_app_pagar_pending_v1() i;";
function pagarCandidates(id, subject = 'carol') {
  return "SELECT coalesce(jsonb_agg(to_jsonb(i)),'[]') FROM payments.read_app_pagar_candidates_v1(" +
    [subject, id].map(literal).join(',') + ') i;';
}
function pagarAllocate(id, ids, { subject = 'carol', finalized = 97670060 } = {}) {
  return "SELECT coalesce(jsonb_agg(to_jsonb(i)),'[]') FROM payments.allocate_app_pagar_basis_v1(" +
    [subject, id, finalized].map(literal).join(',') + ',ARRAY[' + ids.map(literal).join(',') + ']::uuid[]) i;';
}
function pagarAccounting(id, ids, { subject = 'carol', finalized = 97670060 } = {}) {
  return 'SELECT payments.record_app_pagar_accounting_v1(' +
    [subject, id, finalized].map(literal).join(',') + ',ARRAY[' + ids.map(literal).join(',') + ']::uuid[]);';
}
const syntheticRelay = [
  'CREATE ROLE ' + relayOwner + ' NOLOGIN NOSUPERUSER NOBYPASSRLS;',
  'GRANT USAGE ON SCHEMA auth,identity,payments TO ' + relayOwner + ';',
  'GRANT SELECT ON identity.wallet_binding TO ' + relayOwner + ';',
  "INSERT INTO auth.\"user\"(id) VALUES ('carol'),('dave');",
  "INSERT INTO identity.wallet_binding(subject,address) VALUES ('carol'," + literal(wallet('carol')) +
    "),('dave'," + literal(wallet('dave')) + ');',
  "INSERT INTO auth.session(id,user_id,expires_at) VALUES ('carol-old','carol',now()+interval '1 hour'),('carol-new','carol',now()+interval '1 hour')," +
    "('dave-old','dave',now()+interval '1 hour'),('dave-new','dave',now()+interval '1 hour');",
  'CREATE TABLE payments.personal_polygon_relay(' +
    'id uuid PRIMARY KEY,subject text NOT NULL,wallet_address text NOT NULL,token_address text NOT NULL,amount_atomic text NOT NULL,' +
    "chain_id integer NOT NULL DEFAULT 137,token_decimals smallint NOT NULL DEFAULT 6,recipient_address text NOT NULL DEFAULT '0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'," +
    "status text NOT NULL DEFAULT 'prepared',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'," +
    'confirmed_at timestamptz,confirmations integer NOT NULL DEFAULT 0,block_number text,block_hash text,user_operation_hash text,transaction_hash text);',
  'ALTER TABLE payments.personal_polygon_relay ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE payments.personal_polygon_relay OWNER TO ' + relayOwner + ';',
  'CREATE VIEW payments.personal_polygon_relay_internal AS SELECT * FROM payments.personal_polygon_relay;',
  'ALTER VIEW payments.personal_polygon_relay_internal OWNER TO ' + relayOwner + ';',
  'CREATE FUNCTION payments.read_personal_polygon_relay(p_subject text,p_payment uuid)' +
    ' RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$' +
    ' BEGIN RETURN QUERY SELECT r.* FROM payments.personal_polygon_relay_internal r' +
    ' JOIN identity.wallet_binding b ON b.subject=r.subject AND b.address=r.wallet_address' +
    " WHERE r.id=p_payment AND r.subject=p_subject; IF NOT FOUND THEN RAISE SQLSTATE 'P0002'; END IF; END $$;",
  'ALTER FUNCTION payments.read_personal_polygon_relay(text,uuid) OWNER TO ' + relayOwner + ';',
  'REVOKE ALL ON FUNCTION payments.read_personal_polygon_relay(text,uuid) FROM PUBLIC,' + observer + ';',
  'CREATE FUNCTION payments.prepare_synthetic_pagar(uuid,text,text,text,text) RETURNS SETOF payments.personal_polygon_relay' +
    ' LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ INSERT INTO payments.personal_polygon_relay(id,subject,wallet_address,amount_atomic,token_address)' +
    ' VALUES($1,$2,$3,$4,$5) RETURNING * $$;',
  'ALTER FUNCTION payments.prepare_synthetic_pagar(uuid,text,text,text,text) OWNER TO ' + relayOwner + ';',
  'REVOKE ALL ON FUNCTION payments.prepare_synthetic_pagar(uuid,text,text,text,text) FROM PUBLIC,' + observer + ';',
  'GRANT EXECUTE ON FUNCTION payments.prepare_synthetic_pagar(uuid,text,text,text,text) TO ' + runtime + ';',
].join('\n');
const legacyFingerprint = "SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY id)::text,'[]')) FROM payments.app_meld_funding_attempt a;";
const prerequisites = [
  'CREATE ROLE ' + runtime + ' NOLOGIN;',
  'CREATE ROLE ' + owner + ' NOLOGIN NOSUPERUSER NOBYPASSRLS;',
  'CREATE SCHEMA auth; CREATE SCHEMA identity; CREATE SCHEMA payments;',
  'GRANT USAGE ON SCHEMA auth,identity,payments TO ' + owner + ';',
  'GRANT CREATE ON SCHEMA payments TO ' + owner + ';',
  'GRANT USAGE ON SCHEMA payments TO ' + runtime + ';',
  'CREATE TABLE auth."user"(id text PRIMARY KEY);',
  'CREATE TABLE auth.session(id text PRIMARY KEY,user_id text NOT NULL REFERENCES auth."user"(id),expires_at timestamptz NOT NULL);',
  'CREATE TABLE identity.wallet_binding(subject text PRIMARY KEY REFERENCES auth."user"(id),address text NOT NULL UNIQUE);',
  "INSERT INTO auth.\"user\"(id) VALUES ('alice'),('bob');",
  "INSERT INTO identity.wallet_binding(subject,address) VALUES ('alice','0x" + '7'.repeat(40) + "'),('bob','0x" + '2'.repeat(40) + "');",
  'GRANT SELECT ON TABLE auth."user",identity.wallet_binding TO ' + owner + ';',
  'GRANT SELECT,UPDATE ON TABLE auth.session TO ' + owner + ';',
  "CREATE FUNCTION identity.administrative_wallet_person(p_subject text) RETURNS bigint LANGUAGE plpgsql SET search_path=pg_catalog AS $$ " +
    "BEGIN IF NOT EXISTS(SELECT FROM auth.\"user\" u WHERE u.id=p_subject) THEN RAISE SQLSTATE '28000'; END IF; RETURN 1; END $$;",
].join('\n');
try {
  const started = docker(['run', '--detach', '--pull', 'never', '--name', container, '--label', 'mindbliss.synthetic=' + label,
    '--network', 'none', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=' + database, image]);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container]).stdout.trim(), 'none');
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', database]).status === 0) {
      ready = true;
      break;
    }
    await delay(100);
  }
  assert.ok(ready);
  query(prerequisites);
  const authMigration = await readFile(new URL('../_meta/migration/114_administrative_wallet_signing_dry_run.sql', import.meta.url), 'utf8');
  const authGuard = authMigration.match(/^CREATE FUNCTION identity\.require_administrative_native_session\([\s\S]*?^END \$function\$;/m);
  assert.ok(authGuard, 'missing native session guard in the previous migration');
  query(authGuard[0] + 'ALTER FUNCTION identity.require_administrative_native_session(text,text) OWNER TO ' + owner + ';');
  for (const migration of [
    '129_app_meld_production_funding', '130_app_meld_production_coverage', '132_app_meld_brazil_arbitrum',
    '134_app_meld_additional_markets', '135_app_meld_wallet_parity', '137_app_meld_us_mercuryo',
  ]) {
    query(await readFile(new URL('../_meta/migration/' + migration + '.sql', import.meta.url), 'utf8'));
  }
  query("INSERT INTO auth.session(id,user_id,expires_at) VALUES " +
    "('alice-old','alice',now()+interval '1 hour'),('alice-new','alice',now()+interval '1 hour')," +
    "('bob-old','bob',now()+interval '1 hour'),('bob-new','bob',now()+interval '1 hour')," +
    "('alice-expired','alice',now()-interval '1 hour');");
  const usd = createAttempt();
  const mxn = createAttempt({ currency: 'MXN' });
  const pending = createAttempt({ finish: false });
  const bob = createAttempt({ subject: 'bob' });
  const third = createAttempt();
  const before = query(legacyFingerprint);
  query('CREATE ROLE ' + observer + '; GRANT USAGE ON SCHEMA payments TO ' + observer +
    '; ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT EXECUTE ON FUNCTIONS TO ' + observer +
    '; ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT SELECT ON TABLES TO ' + observer + ';');
  for (const migration of ['138_app_meld_settlement', '139_app_recharge_packages', '140_app_meld_reconciliation']) {
    query(await readFile(new URL('../_meta/migration/' + migration + '.sql', import.meta.url), 'utf8'));
  }

  assert.equal(query(read(), runtime), '');
  assert.equal(query(packageView(), runtime), '');
  reject(packageView('alice', 'bob-new'), /administrative_signing_forbidden/);
  reject(packageView(), /permission denied/, observer);
  reject(record(usd, { session: 'bob-new' }), /wallet_funding_forbidden/);
  reject(record(usd, { session: 'alice-expired' }), /wallet_funding_forbidden/);
  reject(record(usd, { subject: 'bob', session: 'bob-new' }), /wallet_funding_forbidden/);
  reject(record(pending), /wallet_funding_forbidden/);
  reject(record(usd, { gross: 9900 }), /wallet_funding_invalid_request/);
  reject(record(usd, { gross: null }), /wallet_funding_invalid_request/);
  reject(record(usd, { received: 0 }), /wallet_funding_invalid_request/);
  reject(record(usd, { log: -1 }), /wallet_funding_invalid_request/);
  reject(record(usd, { tx: '0xnot-a-hash' }), /wallet_funding_invalid_request/);
  reject(record(usd, { time: "pg_catalog.clock_timestamp()+interval '1 hour'" }), /wallet_funding_invalid_request/);
  assert.equal(query(record(usd), runtime), 't');
  assert.equal(query(packageView(), runtime), '2|10000|10000');
  assert.equal(query(packageView('bob', 'bob-new'), runtime), '');
  const original = readOne(usd);
  assert.equal(original.attempt_id, usd);
  assert.equal(original.wallet_address, '0x' + '7'.repeat(40));
  assert.equal(original.source_currency, 'USD');
  assert.equal(original.source_amount, '100.00');
  assert.equal(original.gross_usd_minor, '10000');
  assert.equal(original.total_fee_usd_minor, '359');
  assert.equal(original.received_atomic, '96410000');
  assert.equal(original.chain_id, 137);
  assert.equal(original.transfer_log_index, 42);
  assert.equal(original.block_number, '97670000');
  assert.equal(original.block_hash, receipts.blockHash);
  assert.equal(original.blockchain_tx_hash, receipts.tx);
  assert.equal(query(record(usd, { time: "pg_catalog.clock_timestamp()+interval '1 minute'", fee: null }), runtime), 't');
  assert.deepEqual(readOne(usd), original);
  assert.equal(query(read('bob', 'bob-new', usd), runtime), '');
  reject(read('alice', 'bob-new', usd), /wallet_funding_forbidden/);

  const bobReceipt = { subject: 'bob', session: 'bob-new', transaction: 'meld-proof-b' };
  reject(record(bob, bobReceipt), /wallet_funding_settlement_conflict/);
  reject(record(bob, { ...bobReceipt, transaction: receipts.transaction, tx: hash('3') }), /wallet_funding_settlement_conflict/);
  reject(record(usd, { received: receipts.received + 1 }), /wallet_funding_settlement_conflict/);
  reject(record(usd, { fee: receipts.fee + 1 }), /wallet_funding_settlement_conflict/);
  reject(record(usd, { blockHash: hash('3') }), /wallet_funding_settlement_conflict/);

  const fxReceipt = { transaction: 'meld-proof-c', log: receipts.log + 1, gross: null, fee: null, received: 48540000 };
  assert.equal(query(record(mxn, fxReceipt), runtime), 't');
  assert.equal(query(packageView(), runtime), '2|10000|10000');
  const originalFx = readOne(mxn);
  assert.equal(originalFx.source_currency, 'MXN');
  assert.equal(originalFx.source_amount, '931.00');
  assert.equal(originalFx.gross_usd_minor, null);
  assert.equal(originalFx.total_fee_usd_minor, null);
  assert.equal(query(record(mxn, { ...fxReceipt, gross: 5050 }), runtime), 't');
  assert.equal(query(record(mxn, { ...fxReceipt, fee: 196 }), runtime), 't');
  assert.equal(query(record(mxn, fxReceipt), runtime), 't');
  assert.deepEqual(readOne(mxn), { ...originalFx, gross_usd_minor: '5050', total_fee_usd_minor: '196' });
  assert.equal(query(packageView(), runtime), '3|25000|15050');
  reject(record(mxn, { ...fxReceipt, gross: 5051 }), /wallet_funding_settlement_conflict/);

  const concurrent = record(third, { transaction: 'meld-proof-d', tx: hash('4') });
  assert.deepEqual(await Promise.all([parallel(concurrent), parallel(concurrent)]), ['t', 't']);
  assert.equal(query('SELECT count(*) FROM payments.app_meld_settlement;'), '3');
  assert.equal(query(packageView(), runtime), '4|50000|25050');
  reject('SELECT count(*) FROM payments.app_meld_settlement;', /permission denied/);
  reject('SELECT count(*) FROM payments.app_meld_settlement;', /permission denied/, observer);
  reject(record(usd), /permission denied/, observer);
  reject(read(), /permission denied/, observer);
  reject('DELETE FROM payments.app_meld_settlement;', /app_meld_settlement_retained/, '');
  reject('UPDATE payments.app_meld_settlement SET received_atomic=1;', /app_meld_settlement_immutable/, '');
  reject('UPDATE payments.app_meld_settlement SET gross_usd_minor=1;', /app_meld_settlement_immutable/, '');
  assert.equal(query(legacyFingerprint), before);

  let gross = 0;
  const ceilings = [5000,10000,25000,50000,100000,250000,1000000,2500000];
  for (const [index, amount] of [50,50,150,250,500,1500,7500,15000,50].entries()) {
    const current = createAttempt({ subject: 'bob', amount });
    const tx = '0x' + (100 + index).toString(16).padStart(64, '0');
    assert.equal(query(record(current, { session: 'bob-new', transaction: 'package-proof-' + index, tx, gross: amount * 100,
      fee: 100, received: (amount - 1) * 1000000 }), runtime), 't');
    gross += amount * 100;
    const level = Math.min(index + 1, ceilings.length);
    assert.equal(query(packageView('bob', 'bob-new'), runtime), [level, ceilings[level - 1], gross].join('|'));
  }
  assert.equal(query(packageView(), runtime), '4|50000|25050');

  // A deliberately old fixture stays visible to its owner but must not be leased.
  query('ALTER TABLE payments.app_meld_funding_attempt DISABLE TRIGGER app_meld_funding_snapshot_immutable;' +
    "UPDATE payments.app_meld_funding_attempt SET created_at=clock_timestamp()-interval '31 days' WHERE id=" + literal(bob) + ';' +
    'ALTER TABLE payments.app_meld_funding_attempt ENABLE TRIGGER app_meld_funding_snapshot_immutable;');
  assert.equal(query('SELECT count(*) FROM payments.read_app_meld_funding_v3(\'bob\',' + literal(bob) + ');', runtime), '1');
  const pendingFxId = createAttempt({ currency: 'MXN' });
  const due = [pendingFxId, ...Array.from({ length: 5 }, () => createAttempt())];
  const attemptsBeforeSchedule = query(legacyFingerprint);
  const claimed = (await Promise.all([parallel(claim), parallel(claim)])).map(JSON.parse);
  assert.equal(claimed[0].length <= 5 && claimed[1].length <= 5, true);
  const leased = claimed.flat();
  assert.deepEqual(new Set(leased.map(row => row.id)), new Set(due));
  assert.equal(new Set(leased.map(row => row.lease_id)).size, due.length);
  assert.equal(leased.every(row => row.subject === 'alice' && row.wallet_address === '0x' + '7'.repeat(40)
    && row.status === 'session_created' && !('native_session_id' in row)), true);
  assert.equal(query(claim, runtime), '[]');
  reject(claim, /permission denied/, observer);
  reject('SELECT * FROM payments.app_meld_reconciliation;', /permission denied/);
  reject('SELECT * FROM payments.app_meld_reconciliation;', /permission denied/, observer);
  reject('SELECT payments.save_app_meld_settlement_v1(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);', /permission denied/);

  const fxLease = leased.find(row => row.id === pendingFxId).lease_id;
  const unknownFx = { transaction: 'scheduled-fx', tx: hash('e'), gross: null, fee: null, received: 48540000 };
  const wrongLease = randomUUID();
  assert.equal(query(finishSchedule(pendingFxId, wrongLease, 'pending'), runtime), 'f');
  reject(recordSchedule(pendingFxId, wrongLease, unknownFx), /wallet_funding_forbidden/);
  reject(finishSchedule(pendingFxId, fxLease, 'confirmed'), /wallet_funding_settlement_missing/);
  reject(finishSchedule(pendingFxId, fxLease, 'forged'), /wallet_funding_invalid_request/);
  query("DELETE FROM identity.wallet_binding WHERE subject='alice';");
  reject(recordSchedule(pendingFxId, fxLease, unknownFx), /wallet_funding_forbidden/);
  query("INSERT INTO identity.wallet_binding(subject,address) VALUES ('alice'," + literal('0x' + '7'.repeat(40)) + ');');
  assert.equal(query(recordSchedule(pendingFxId, fxLease, unknownFx), runtime), 't');
  assert.equal(query(record(pendingFxId, unknownFx), runtime), 't');
  assert.equal(query(finishSchedule(pendingFxId, fxLease, 'confirmed'), runtime), 't');
  assert.equal(query(packageView(), runtime), '4|50000|25050');
  assert.equal(query('SELECT next_check_at>clock_timestamp()+interval \'4 minutes 55 seconds\' FROM payments.app_meld_reconciliation WHERE attempt_id=' +
    literal(pendingFxId) + ';'), 't');
  query("UPDATE payments.app_meld_reconciliation SET next_check_at=clock_timestamp()-interval '1 second' WHERE attempt_id=" + literal(pendingFxId) + ';');
  const [later] = JSON.parse(query(claim, runtime));
  assert.equal(later.id, pendingFxId);
  assert.notEqual(later.lease_id, fxLease);
  assert.equal(query(recordSchedule(pendingFxId, later.lease_id, { ...unknownFx, gross: 5050, fee: 196 }), runtime), 't');
  assert.equal(query(finishSchedule(pendingFxId, later.lease_id, 'confirmed'), runtime), 't');
  assert.equal(query(packageView(), runtime), '4|50000|30100');
  assert.equal(readOne(pendingFxId).gross_usd_minor, '5050');

  const expired = leased.find(row => row.id === due[1]);
  const failed = leased.find(row => row.id === due[2]);
  assert.equal(query(finishSchedule(failed.id, failed.lease_id, 'failed'), runtime), 't');
  query("UPDATE payments.app_meld_reconciliation SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE attempt_id=" + literal(expired.id) + ';' +
    "UPDATE payments.app_meld_reconciliation SET next_check_at=clock_timestamp()-interval '1 second' WHERE attempt_id=" + literal(failed.id) + ';');
  reject(recordSchedule(expired.id, expired.lease_id, receipts), /wallet_funding_forbidden/);
  assert.equal(query(finishSchedule(expired.id, expired.lease_id, 'pending'), runtime), 'f');
  assert.equal(query(claim, runtime), '[]');
  query("UPDATE payments.app_meld_reconciliation SET next_check_at=clock_timestamp()-interval '1 second' WHERE attempt_id=" + literal(expired.id) + ';');
  const [renewed] = JSON.parse(query(claim, runtime));
  assert.equal(renewed.id, expired.id);
  assert.notEqual(renewed.lease_id, expired.lease_id);
  assert.equal(query(finishSchedule(expired.id, expired.lease_id, 'pending'), runtime), 'f');
  assert.equal(query(finishSchedule(renewed.id, renewed.lease_id, 'pending'), runtime), 't');
  assert.equal(query(legacyFingerprint), attemptsBeforeSchedule);

  query(syntheticRelay);
  query(await readFile(new URL('../_meta/migration/141_app_pagar_allocation.sql', import.meta.url), 'utf8'));
  const carolFirst = createAttempt({ subject: 'carol' });
  const carolSecond = createAttempt({ subject: 'carol', amount: 50 });
  const carolReceipt = { session: 'carol-new', transaction: 'carol-first', tx: hash('f'), gross: 10000, fee: 500, received: 95000000 };
  assert.equal(query(record(carolFirst, carolReceipt), runtime), 't');
  assert.equal(query(record(carolSecond, { ...carolReceipt, transaction: 'carol-second', log: 43, gross: 5000, fee: 200, received: 48000000 }), runtime), 't');

  const payment = randomUUID(), retryPayment = randomUUID(), historical = randomUUID(), insufficient = randomUUID(), wrongAsset = randomUUID();
  query(pagarPrepare(historical, { app: false }), runtime);
  assert.equal(query(pagarRegistration(historical), runtime), 'f');
  pagarConfirm(historical);
  assert.equal(query(pagarRegistration(historical), runtime), 'f');
  assert.equal(query(pagarAllocate(historical, [carolFirst, carolSecond]), runtime), '[]');

  assert.equal(query(pagarPrepare(insufficient, { amount: 94999999 }), runtime), 't');
  assert.equal(query(pagarCandidates(insufficient), runtime), '[]');
  assert.equal(query(pagarPrepare(wrongAsset, { asset: usdt }), runtime), 't');
  assert.equal(query(pagarCandidates(wrongAsset), runtime), '[]');
  assert.equal(query(pagarPrepare(payment), runtime), 't');
  assert.equal(query(pagarPrepare(retryPayment), runtime), 't');
  assert.equal(query(pagarCandidates(retryPayment), runtime), '[]');
  assert.equal(query(pagarRegistration(payment), runtime), 't');
  assert.deepEqual(JSON.parse(query(pagarCandidates(payment), runtime)), [
    { attempt_id: carolFirst, meld_transaction_id: 'carol-first', gross_usd_minor: 10000, received_atomic: 95000000,
      blockchain_tx_hash: hash('f'), block_number: receipts.block, block_hash: receipts.blockHash, transfer_log_index: receipts.log },
    { attempt_id: carolSecond, meld_transaction_id: 'carol-second', gross_usd_minor: 5000, received_atomic: 48000000,
      blockchain_tx_hash: hash('f'), block_number: receipts.block, block_hash: receipts.blockHash, transfer_log_index: 43 },
  ]);
  assert.equal(query(pagarCandidates(payment, 'bob'), runtime), '[]');
  assert.equal(query(pagarAllocate(payment, [carolFirst, carolSecond]), runtime), '[]');
  const carolLate = createAttempt({ subject: 'carol', amount: 50 });
  assert.equal(query(record(carolLate, { ...carolReceipt, transaction: 'carol-late', log: 44, gross: 5000, fee: 100, received: 49000000 }), runtime), 't');

  pagarConfirm(payment, { confirmations: 11 });
  assert.equal(query(pagarAllocate(payment, [carolFirst, carolSecond]), runtime), '[]');
  pagarConfirm(payment, { block: receipts.block });
  assert.equal(query(pagarAllocate(payment, [carolFirst, carolSecond]), runtime), '[]');
  pagarConfirm(payment);
  const latePayment = randomUUID(), recycledPayment = randomUUID();
  assert.equal(query(pagarPrepare(latePayment, { amount: 49000000 }), runtime), 't');
  assert.deepEqual(JSON.parse(query(pagarCandidates(latePayment), runtime)).map(row => row.attempt_id), [carolLate]);
  query("UPDATE payments.personal_polygon_relay SET status='expired' WHERE id=" + literal(latePayment) + ';');
  assert.equal(query(pagarPrepare(recycledPayment, { amount: 49000000 }), runtime), 't');
  assert.deepEqual(JSON.parse(query(pagarCandidates(recycledPayment), runtime)).map(row => row.attempt_id), [carolLate]);
  query("UPDATE payments.personal_polygon_relay SET status='submitted',user_operation_hash=" + literal(hash('c'))
    + ' WHERE id=' + literal(recycledPayment) + ';');
  assert.equal(query(pagarAllocate(payment, [carolFirst, carolSecond], { finalized: 97670049 }), runtime), '[]');
  assert.equal(query(pagarAllocate(payment, [carolFirst]), runtime), '[]');
  assert.equal(query(pagarAllocate(payment, [carolFirst, carolFirst]), runtime), '[]');
  assert.equal(query(pagarAllocate(payment, [carolFirst, carolLate]), runtime), '[]');
  assert.equal(query(pagarAllocate(payment, [carolFirst, carolSecond], { subject: 'bob' }), runtime), '[]');
  assert.deepEqual(JSON.parse(query(pendingPagar, runtime)), [
    { subject: 'carol', payment_id: payment }, { subject: 'carol', payment_id: recycledPayment },
  ]);
  assert.equal(query(pendingPagar, runtime), '[]');

  const applied = (await Promise.all([
    parallel(pagarAllocate(payment, [carolFirst, carolSecond])),
    parallel(pagarAllocate(payment, [carolSecond, carolFirst])),
  ])).map(JSON.parse);
  assert.deepEqual(applied[0], applied[1]);
  assert.deepEqual(new Set(applied[0].map(row => row.attempt_id)), new Set([carolFirst, carolSecond]));
  assert.equal(applied[0].reduce((gross, row) => gross + row.gross_usd_minor, 0), 15000);
  assert.equal(applied[0].reduce((net, row) => net + row.received_atomic, 0), 143000000);
  pagarConfirm(retryPayment);
  assert.equal(query(pagarAllocate(retryPayment, [carolFirst, carolSecond]), runtime), '[]');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_allocation;'), '2');
  reject('DELETE FROM payments.app_pagar_allocation;', /app_pagar_evidence_retained/, '');
  reject('TRUNCATE payments.app_pagar_candidate CASCADE;', /app_pagar_evidence_retained/, '');
  reject('SELECT * FROM payments.app_pagar_allocation;', /permission denied/);
  reject(pendingPagar, /permission denied/, observer);
  reject(pagarCandidates(payment), /permission denied/, observer);

  query(await readFile(new URL('../_meta/migration/142_app_pagar_accounting.sql', import.meta.url), 'utf8'));
  reject(pagarAllocate(payment, [carolFirst, carolSecond]), /permission denied/);
  assert.equal(query(pagarAccounting(recycledPayment, [carolLate]), runtime), 'f');
  assert.equal(query(pagarAccounting(payment, [carolFirst, carolSecond]), runtime), 't');
  assert.equal(query(pagarAccounting(payment, [carolSecond, carolFirst]), runtime), 't');
  pagarConfirm(recycledPayment);
  assert.equal(query(pagarAccounting(recycledPayment, [carolLate]), runtime), 't');
  assert.equal(query(pagarAccounting(recycledPayment, [carolLate]), runtime), 't');
  assert.deepEqual(query(
    "SELECT concat_ws('|',gross_usd_minor,treasury_received_atomic,allocated_received_atomic,cumulative_gross_usd_minor,pv_delta) " +
    "FROM payments.app_pagar_accounting_receipt WHERE subject='carol' ORDER BY cumulative_gross_usd_minor;",
  ).split(/\r?\n/), ['15000|143000000|143000000|15000|150','5000|49000000|49000000|20000|50']);
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_allocation;'), '3');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_accounting_receipt;'), '2');

  const unmatchedReceipt = createAttempt({ subject: 'carol', amount: 50 });
  assert.equal(query(record(unmatchedReceipt, { ...carolReceipt, transaction: 'carol-reused-chain-proof', log: 45,
    gross: 5000, fee: 100, received: 49000000 }), runtime), 't');
  const reusedProof = randomUUID();
  assert.equal(query(pagarPrepare(reusedProof, { amount: 49000000 }), runtime), 't');
  pagarConfirm(reusedProof);
  query('UPDATE payments.personal_polygon_relay SET user_operation_hash=(SELECT user_operation_hash FROM payments.personal_polygon_relay WHERE id=' +
    literal(payment) + ') WHERE id=' + literal(reusedProof) + ';');
  reject(pagarAccounting(reusedProof, [unmatchedReceipt]), /duplicate key.*user_operation_hash/);
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_allocation WHERE attempt_id=' + literal(unmatchedReceipt) + ';'), '0');

  // A sole established provider checkout can be frozen before its successful
  // delivery is recorded, and cannot be shared with another live draft.
  const oldCheckout = createAttempt({ subject: 'dave' });
  const firstDeferred = randomUUID(), competingDeferred = randomUUID();
  assert.equal(query(pagarPrepare(firstDeferred, { subject: 'dave', amount: 95000000 }), runtime), 't');
  assert.equal(query(pagarCandidates(firstDeferred, 'dave'), runtime), '[]');
  assert.equal(query('SELECT concat_ws(\'|\',attempt_id,deferred) FROM payments.app_pagar_candidate WHERE payment_id=' +
    literal(firstDeferred) + ';'), oldCheckout + '|t');
  assert.equal(query(pagarPrepare(competingDeferred, { subject: 'dave', amount: 95000000 }), runtime), 't');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_candidate WHERE payment_id=' + literal(competingDeferred) + ';'), '0');
  const newCheckout = createAttempt({ subject: 'dave' });
  const newProof = { ...receipts, session: 'dave-new', gross: 10000, fee: 500, received: 95000000 };
  assert.equal(query(record(newCheckout, { ...newProof, transaction: 'dave-new', tx: hash('8') }), runtime), 't');
  assert.equal(query(pagarCandidates(firstDeferred, 'dave'), runtime), '[]');
  pagarConfirm(firstDeferred, { block: receipts.block });
  assert.equal(query(pagarAccounting(firstDeferred, [newCheckout], { subject: 'dave' }), runtime), 'f');
  assert.equal(query(record(oldCheckout, { ...newProof, transaction: 'dave-old', tx: hash('9') }), runtime), 't');
  assert.deepEqual(JSON.parse(query(pagarCandidates(firstDeferred, 'dave'), runtime)).map(row => row.attempt_id), [oldCheckout]);
  assert.equal(query(pagarAccounting(firstDeferred, [oldCheckout], { subject: 'dave' }), runtime), 'f');
  pagarConfirm(firstDeferred);
  pagarConfirm(competingDeferred);
  assert.equal(query(pagarAccounting(firstDeferred, [newCheckout], { subject: 'dave' }), runtime), 'f');
  assert.equal(query(pagarAccounting(firstDeferred, [oldCheckout], { subject: 'dave' }), runtime), 't');
  assert.equal(query(pagarAccounting(competingDeferred, [oldCheckout], { subject: 'dave' }), runtime), 'f');
  assert.equal(query(pagarAccounting(firstDeferred, [oldCheckout], { subject: 'dave' }), runtime), 't');
  assert.equal(query("SELECT count(*) FROM payments.app_pagar_allocation WHERE attempt_id=" + literal(oldCheckout) + ';'), '1');
  assert.equal(query("SELECT gross_usd_minor FROM payments.app_pagar_accounting_receipt WHERE subject='dave';"), '10000');

  // Known outstanding lots must all fit before signing. An older draft with
  // only the first whole lot frozen cannot post a partial package after 150.
  const knownSecond = createAttempt({ subject: 'dave', amount: 50 });
  assert.equal(query(record(knownSecond, { ...newProof, transaction: 'dave-second-known', tx: hash('d'), log: 51,
    gross: 5000, fee: 100, received: 49000000 }), runtime), 't');
  const oldPartial = randomUUID();
  assert.equal(query(pagarPrepare(oldPartial, { subject: 'dave', amount: 95000000 }), runtime), 't');
  assert.deepEqual(JSON.parse(query(pagarCandidates(oldPartial, 'dave'), runtime)).map(row => row.attempt_id), [newCheckout]);
  query("UPDATE payments.personal_polygon_relay SET status='expired' WHERE id=" + literal(oldPartial) + ';');
  query(await readFile(new URL('../_meta/migration/150_app_pagar_full_payment.sql', import.meta.url), 'utf8'));

  const short = randomUUID(), otherToken = randomUUID(), exact = randomUUID();
  reject(pagarPrepare(short, { subject: 'dave', amount: 143999999 }), /polygon_relay_full_payment_required/);
  assert.equal(query('SELECT count(*) FROM payments.personal_polygon_relay WHERE id=' + literal(short) + ';'), '0');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_intent WHERE payment_id=' + literal(short) + ';'), '0');
  assert.equal(query(pagarPrepare(otherToken, { subject: 'dave', amount: 1, asset: usdt }), runtime), 't');
  assert.equal(query(pagarCandidates(otherToken, 'dave'), runtime), '[]');

  pagarConfirm(oldPartial);
  reject(pagarAccounting(oldPartial, [newCheckout], { subject: 'dave' }), /polygon_relay_full_payment_required/);
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_allocation WHERE payment_id=' + literal(oldPartial) + ';'), '0');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_accounting_receipt WHERE payment_id=' + literal(oldPartial) + ';'), '0');
  assert.equal(query(pagarAccounting(firstDeferred, [oldCheckout], { subject: 'dave' }), runtime), 't');

  // Simulate expiring the old reservation before a new full payment can be
  // prepared. Its previously posted unrelated accounting receipt still stands.
  query("UPDATE payments.personal_polygon_relay SET status='expired' WHERE id=" + literal(oldPartial) + ';');
  assert.equal(query(pagarPrepare(exact, { subject: 'dave', amount: 144000000 }), runtime), 't');
  assert.deepEqual(new Set(JSON.parse(query(pagarCandidates(exact, 'dave'), runtime)).map(row => row.attempt_id)),
    new Set([newCheckout, knownSecond]));
  pagarConfirm(exact);
  assert.equal(query(pagarAccounting(exact, [newCheckout, knownSecond], { subject: 'dave' }), runtime), 't');
  assert.equal(query(pagarAccounting(exact, [knownSecond, newCheckout], { subject: 'dave' }), runtime), 't');
  assert.equal(query('SELECT concat_ws(\'|\',gross_usd_minor,treasury_received_atomic,allocated_received_atomic) ' +
    'FROM payments.app_pagar_accounting_receipt WHERE payment_id=' + literal(exact) + ';'), '15000|144000000|144000000');

  const extraLot = createAttempt({ subject: 'dave', amount: 50 });
  assert.equal(query(record(extraLot, { ...newProof, transaction: 'dave-after-full', tx: hash('e'), log: 52,
    gross: 5000, fee: 100, received: 49000000 }), runtime), 't');
  const excess = randomUUID();
  assert.equal(query(pagarPrepare(excess, { subject: 'dave', amount: 60000000 }), runtime), 't');
  pagarConfirm(excess);
  assert.equal(query(pagarAccounting(excess, [extraLot], { subject: 'dave' }), runtime), 't');
  assert.equal(query('SELECT concat_ws(\'|\',gross_usd_minor,treasury_received_atomic,allocated_received_atomic) ' +
    'FROM payments.app_pagar_accounting_receipt WHERE payment_id=' + literal(excess) + ';'), '5000|60000000|49000000');
  const privateLots = 'SELECT * FROM payments.read_app_pagar_required_lots_v1(\'dave\',' + literal(excess) + ');';
  reject(privateLots, /permission denied/, runtime);
  reject(privateLots, /permission denied/, observer);
  console.log('App MELD settlement, package, scheduled reconciliation, Pagar allocation and accounting SQL passed (isolated PostgreSQL, no provider or chain calls).');
} finally {
  const inspected = docker(['inspect', '--format', '{{ index .Config.Labels "mindbliss.synthetic" }} {{.HostConfig.NetworkMode}}', container]);
  if (inspected.status === 0 && inspected.stdout.trim() === label + ' none') {
    docker(['rm', '--force', '--volumes', container]);
  }
}
