// Explicit opt-in rehearsal: disposable PostgreSQL, synthetic accounts and
// in-process delivery only. No host/cloud DSN, published port or provider call.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

if (process.argv.slice(2).join(' ') !== '--synthetic-docker') throw new Error('Requires --synthetic-docker');
const name = `password-reset-pg-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const source = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, POSTGRES_PASSWORD: password,
  PASSWORD_RECOVERY_TEST_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:5432/password_recovery_synthetic`,
  PASSWORD_RECOVERY_AUTH_DATABASE_URL: `postgres://recovery_auth_fixture:${password}@127.0.0.1:5432/password_recovery_synthetic` };
function docker(args, input) {
  const result = spawnSync('docker', args, { env, input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 180_000 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Synthetic Docker command failed').replaceAll(password, '[redacted]'));
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}
let created = false;
try {
  docker(['run', '--pull=never', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=password_recovery_synthetic',
    'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'disposable PostgreSQL did not become ready');
  docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'password_recovery_synthetic', '-v', 'ON_ERROR_STOP=1'], `
    CREATE ROLE recovery_auth_fixture LOGIN PASSWORD '${password}';
    CREATE SCHEMA auth;
    CREATE TABLE auth."user"(id text PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,name text,image text,
      phone_number text UNIQUE,phone_number_verified boolean NOT NULL DEFAULT false,contact_phone_e164 text,contact_whatsapp_e164 text,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE auth.account(id text PRIMARY KEY,user_id text NOT NULL REFERENCES auth."user"(id),account_id text NOT NULL,provider_id text NOT NULL,
      password text,access_token text,refresh_token text,id_token text,access_token_expires_at timestamptz,refresh_token_expires_at timestamptz,scope text,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(provider_id,account_id));
    CREATE TABLE auth.session(id text PRIMARY KEY,user_id text NOT NULL REFERENCES auth."user"(id),token text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,
      ip_address text,user_agent text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE auth.verification(id text PRIMARY KEY,identifier text NOT NULL,value text NOT NULL,expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX verification_identifier_idx ON auth.verification(identifier);
    CREATE TABLE auth.rate_limit(id text PRIMARY KEY,key text NOT NULL UNIQUE,count integer NOT NULL,last_request bigint NOT NULL);
    CREATE TABLE auth.jwks(id text PRIMARY KEY,public_key text NOT NULL,private_key text NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz);
    CREATE TABLE auth.recovery_test_fault(user_id text PRIMARY KEY,mode text NOT NULL);
    CREATE FUNCTION auth.recovery_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME='session' THEN
        IF EXISTS(SELECT 1 FROM auth.recovery_test_fault WHERE user_id=OLD.user_id AND mode='session_delete') THEN
          RAISE EXCEPTION 'Synthetic private recovery session failure';
        END IF;
      ELSIF TG_TABLE_NAME='user' THEN
        IF EXISTS(SELECT 1 FROM auth.recovery_test_fault WHERE user_id=NEW.id AND mode='email_proof') THEN
          RAISE EXCEPTION 'Synthetic private recovery email proof failure';
        END IF;
      ELSIF TG_TABLE_NAME='account' THEN
        IF EXISTS(SELECT 1 FROM auth.recovery_test_fault WHERE user_id=NEW.user_id AND mode='commit') THEN
          RAISE EXCEPTION 'Synthetic private recovery deferred commit failure';
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $$;
    CREATE TRIGGER recovery_session_delete BEFORE DELETE ON auth.session FOR EACH ROW EXECUTE FUNCTION auth.recovery_test_reject();
    CREATE TRIGGER recovery_email_proof BEFORE UPDATE OF email_verified ON auth."user" FOR EACH ROW EXECUTE FUNCTION auth.recovery_test_reject();
    CREATE CONSTRAINT TRIGGER recovery_commit AFTER INSERT OR UPDATE ON auth.account DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION auth.recovery_test_reject();
    CREATE FUNCTION auth.session_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE fault_mode text;
    BEGIN
      SELECT mode INTO fault_mode FROM auth.recovery_test_fault WHERE user_id=NEW.user_id;
      IF TG_WHEN='BEFORE' AND fault_mode='session_insert' THEN
        RAISE EXCEPTION 'Synthetic private session insert failure';
      ELSIF TG_WHEN='AFTER' AND fault_mode='session_commit' THEN
        RAISE EXCEPTION 'Synthetic private session deferred commit failure';
      ELSIF TG_WHEN='BEFORE' AND fault_mode='session_hold' THEN
        PERFORM pg_advisory_xact_lock(704431,1);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER recovery_session_insert BEFORE INSERT ON auth.session FOR EACH ROW EXECUTE FUNCTION auth.session_test_reject();
    CREATE CONSTRAINT TRIGGER recovery_session_commit AFTER INSERT ON auth.session DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION auth.session_test_reject();
    GRANT USAGE ON SCHEMA auth TO recovery_auth_fixture;
    GRANT SELECT,INSERT,UPDATE,DELETE ON auth."user",auth.account,auth.session,auth.verification,auth.rate_limit,auth.jwks TO recovery_auth_fixture;
    GRANT SELECT ON auth.recovery_test_fault TO recovery_auth_fixture;
  `);
  const output = docker(['run', '--pull=never', '--rm', '--network', `container:${name}`, '--read-only', '--tmpfs', '/tmp',
    '--mount', `type=bind,source=${source},target=/app/src,readonly`,
    '-e', 'PASSWORD_RECOVERY_TEST_DATABASE_URL', '-e', 'PASSWORD_RECOVERY_AUTH_DATABASE_URL',
    '--entrypoint', 'bun', 'mindbliss/api-password-recovery-test-20261102:local', '--no-env-file', 'test',
    'src/auth/password-recovery-postgres.integration.test.ts', '--timeout', '20000']);
  console.log(output);
  console.log(JSON.stringify({ syntheticPostgres: '17.11', bun: '1.4.4', network: 'none', publishedPorts: 0,
    realMessages: 0, productionAccess: false, restrictedAuthRole: true, authPoolMax: 1 }));
} finally { if (created) docker(['rm', '-f', name]); }
