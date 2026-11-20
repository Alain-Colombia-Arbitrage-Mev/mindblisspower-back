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
const label = 'app-meld-settlement-138';
const image = 'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
const literal = value => value === null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
const hash = value => '0x' + value.repeat(64);
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
  const address = '0x' + (subject === 'alice' ? '7' : '2').repeat(40);
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
  console.log('App MELD settlement, package, and scheduled reconciliation SQL passed (isolated PostgreSQL, no provider or chain calls).');
} finally {
  const inspected = docker(['inspect', '--format', '{{ index .Config.Labels "mindbliss.synthetic" }} {{.HostConfig.NetworkMode}}', container]);
  if (inspected.status === 0 && inspected.stdout.trim() === label + ' none') {
    docker(['rm', '--force', '--volumes', container]);
  }
}
