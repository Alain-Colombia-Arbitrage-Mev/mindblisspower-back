import { describe, expect, test } from 'bun:test';
import { databaseOptions } from './config';

const local = { DATABASE_URL: 'postgres://app:synthetic@postgres/mindbliss_staging?sslmode=disable' };
describe('PostgreSQL connection configuration', () => {
  test('keeps local connections and bounded default pool', () => {
    expect(databaseOptions(local)).toMatchObject({ max: 10, connect_timeout: 10, idle_timeout: 20 });
    expect(databaseOptions(local)).not.toHaveProperty('ssl');
  });
  test('RDS verifies certificates and reads a mounted CA', () => {
    const env = { DATABASE_URL: 'postgres://app:synthetic@db.example.invalid/mindbliss_staging?sslmode=verify-full', DATABASE_CA_FILE: '/run/db-ca/server-ca.pem' };
    const options = databaseOptions(env, file => { expect(file).toBe(env.DATABASE_CA_FILE); return 'synthetic-ca'; });
    expect(options.ssl).toEqual({ ca: 'synthetic-ca', rejectUnauthorized: true });
  });
  test('never silently disables certificate verification', () => {
    for (const mode of ['disable', 'require', 'prefer', 'verify-ca', '']) {
      expect(() => databaseOptions({ DATABASE_URL: `postgres://app:synthetic@db/test?sslmode=${mode}`, DATABASE_CA_FILE: '/ca' })).toThrow('verify-full');
    }
    expect(() => databaseOptions({ ...local, DATABASE_POOL_MAX: '1000' })).toThrow('DATABASE_POOL_MAX');
    expect(() => databaseOptions({ ...local, DATABASE_POOL_MAX: '1.5' })).toThrow('DATABASE_POOL_MAX');
    expect(() => databaseOptions({ ...local, DATABASE_POOL_MAX: '0' })).toThrow('DATABASE_POOL_MAX');
  });
  test('PgBouncer preparation is explicit and pool size can be budgeted', () => {
    expect(databaseOptions({ ...local, PGBOUNCER: 'true', DATABASE_POOL_MAX: '5' })).toMatchObject({ prepare: false, max: 5 });
  });
  test('App Platform accepts an inline CA without file mounts', () => {
    const env = { DATABASE_URL: 'postgres://app:synthetic@db/test?sslmode=verify-full', DATABASE_CA_PEM: 'synthetic-ca' };
    expect(databaseOptions(env).ssl).toEqual({ ca: 'synthetic-ca', rejectUnauthorized: true });
    expect(() => databaseOptions({ ...env, DATABASE_CA_FILE: '/ca' })).toThrow('not both');
  });
  test('errors do not reveal connection credentials', () => {
    expect(() => databaseOptions({ DATABASE_URL: 'invalid-secret-password' })).toThrow('DATABASE_URL is invalid');
    expect(() => databaseOptions({ DATABASE_URL: 'https://secret@db' })).toThrow('must use PostgreSQL');
    expect(() => databaseOptions({})).toThrow('DATABASE_URL not set');
  });
});
