import { describe, expect, test } from 'bun:test';
import { authDatabaseConfig } from './auth-config';

const reader = 'postgres://business_reader:synthetic@db.example.invalid/mindbliss?sslmode=verify-full';
const writer = 'postgres://auth_runtime:synthetic@db.example.invalid:5432/mindbliss?sslmode=verify-full';
const production = { DATABASE_URL: reader, NODE_ENV: 'production', BETTER_AUTH_EMAIL_OTP_ENABLED: 'true' };

describe('separate authentication database connection', () => {
  test('requires an explicit writer for every production auth capability', () => {
    for (const flag of ['BETTER_AUTH_EMAIL_OTP_ENABLED', 'BETTER_AUTH_PHONE_OTP_ENABLED', 'BETTER_AUTH_JWT_ENABLED']) {
      expect(() => authDatabaseConfig({ DATABASE_URL: reader, NODE_ENV: 'production', [flag]: 'true' })).toThrow('AUTH_DATABASE_URL required');
    }
    expect(() => authDatabaseConfig({ ...production, AUTH_DATABASE_URL: '   ' })).toThrow('AUTH_DATABASE_URL required');
  });
  test('legacy and local development retain the existing URL without changing the business pool', () => {
    const local = { DATABASE_URL: reader, NODE_ENV: 'development', BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', DATABASE_POOL_MAX: '37' };
    expect(authDatabaseConfig(local)).toMatchObject({ url: reader, options: { max: 4 } });
    expect(local.DATABASE_POOL_MAX).toBe('37');
    expect(authDatabaseConfig({ DATABASE_URL: reader, NODE_ENV: 'production' }).url).toBe(reader);
  });
  test('uses a distinct credential in the same canonical database with a small independent pool', () => {
    const env = { ...production, AUTH_DATABASE_URL: writer, DATABASE_POOL_MAX: '30', AUTH_DATABASE_POOL_MAX: '3', PGBOUNCER: 'true' };
    expect(authDatabaseConfig(env)).toMatchObject({ url: writer, options: { max: 3, prepare: false, connect_timeout: 10 } });
    expect(env.DATABASE_URL).toBe(reader);
    expect(env.DATABASE_POOL_MAX).toBe('30');
  });
  test('rejects a second database, host, port, reused reader or known administrator', () => {
    for (const url of [writer.replace('mindbliss?', 'different?'), writer.replace('db.example.invalid', 'other.example.invalid'),
      writer.replace(':5432/', ':6432/'), writer.replace('auth_runtime:', 'business_reader:'),
      writer.replace('auth_runtime:', 'postgres:'), writer.replace('auth_runtime:', 'app_admin.branch_id:')]) {
      expect(() => authDatabaseConfig({ ...production, AUTH_DATABASE_URL: url })).toThrow();
    }
  });
  test('PlanetScale roles keep the same routing branch instead of silently authenticating against a clone', () => {
    const env = { ...production,
      DATABASE_URL: 'postgres://business_reader.canonical:synthetic@aws.example.psdb.cloud/mindbliss?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://auth_runtime.canonical:synthetic@aws.example.psdb.cloud/mindbliss?sslmode=verify-full' };
    expect(authDatabaseConfig(env).url).toBe(env.AUTH_DATABASE_URL);
    expect(() => authDatabaseConfig({ ...env, AUTH_DATABASE_URL: env.AUTH_DATABASE_URL.replace('auth_runtime.canonical:', 'auth_runtime.clone:') })).toThrow('same PlanetScale branch');
    expect(() => authDatabaseConfig({ ...env, AUTH_DATABASE_URL: env.AUTH_DATABASE_URL.replace('auth_runtime.canonical:', 'auth_runtime:') })).toThrow('same PlanetScale branch');
    expect(() => authDatabaseConfig({ ...env, DATABASE_URL: env.DATABASE_URL.replace('aws.example.psdb.cloud', 'AWS.EXAMPLE.PSDB.CLOUD.'),
      AUTH_DATABASE_URL: env.AUTH_DATABASE_URL.replace('auth_runtime.canonical:', 'auth_runtime.clone:') })).toThrow('same PlanetScale branch');
  });
  test('inherits a verified CA only for the matching database host', () => {
    const env = { ...production, AUTH_DATABASE_URL: writer, DATABASE_CA_FILE: '/run/auth-ca.pem' };
    expect(authDatabaseConfig(env, file => { expect(file).toBe('/run/auth-ca.pem'); return 'synthetic-ca'; }).options.ssl)
      .toEqual({ ca: 'synthetic-ca', rejectUnauthorized: true });
    let reads = 0;
    expect(() => authDatabaseConfig({ ...env, AUTH_DATABASE_URL: writer.replace('db.example.invalid', 'other.example.invalid') }, () => { reads++; return 'unused'; })).toThrow();
    expect(reads).toBe(0);
    expect(() => authDatabaseConfig({ ...env, DATABASE_CA_PEM: 'synthetic-ca' })).toThrow('not both');
  });
  test('production never disables peer or hostname verification', () => {
    for (const mode of ['disable', 'require', 'prefer', 'verify-ca', '']) {
      expect(() => authDatabaseConfig({ ...production, AUTH_DATABASE_URL: writer.replace('verify-full', mode) })).toThrow('sslmode=verify-full');
    }
  });
  test('query-string startup identities and duplicate TLS values cannot bypass validation', () => {
    for (const query of ['user=postgres', 'database=other', 'host=other.example.invalid', 'options=-c%20role%3Dapp_admin',
      'sslmode=disable', 'ssl=false', 'debug=true']) {
      expect(() => authDatabaseConfig({ ...production, AUTH_DATABASE_URL: `${writer}&${query}` })).toThrow('ambiguous connection parameters');
    }
    expect(() => authDatabaseConfig({ ...production, DATABASE_URL: `${reader}&database=other`, AUTH_DATABASE_URL: writer })).toThrow('ambiguous connection parameters');
  });
  test('rejects invalid URLs and out-of-budget auth pools without disclosing credentials', () => {
    for (const value of ['invalid-secret-password', 'https://auth_runtime:synthetic@db.example.invalid/mindbliss',
      'postgres://auth_runtime:synthetic@db.example.invalid', 'postgres://auth_runtime:synthetic@db.example.invalid/mindbliss#secret']) {
      expect(() => authDatabaseConfig({ ...production, AUTH_DATABASE_URL: value })).toThrow();
      try { authDatabaseConfig({ ...production, AUTH_DATABASE_URL: value }); }
      catch (error) { expect(String(error)).not.toContain('synthetic'); expect(String(error)).not.toContain('secret-password'); }
    }
    for (const max of ['0', '11', '1.5', 'NaN', '']) {
      expect(() => authDatabaseConfig({ ...production, AUTH_DATABASE_URL: writer, AUTH_DATABASE_POOL_MAX: max })).toThrow('AUTH_DATABASE_POOL_MAX');
    }
    expect(() => authDatabaseConfig({})).toThrow('DATABASE_URL not set');
  });
});
