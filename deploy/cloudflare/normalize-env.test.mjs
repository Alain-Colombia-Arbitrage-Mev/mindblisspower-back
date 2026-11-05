import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { normalizePlanetScaleEnv } from './normalize-env.mjs';

function uri(port = 5432) {
  const url = new URL(`postgresql://fixture@fixture.pg.psdb.cloud:${port}/postgres?sslmode=verify-full&sslrootcert=system`);
  url.password = 'synthetic:with@symbols';
  return url.href;
}

test('converts one bare URL and preserves unrelated configuration', () => {
  const result = normalizePlanetScaleEnv(`# Private fixture\r\nOTHER=preserved\r\n${uri()}\r\nPGBOUNCER=true\r\n`);
  const env = parseEnv(result.contents);
  const url = new URL(env.DATABASE_URL);
  assert.equal(url.password, new URL(uri()).password);
  assert.equal(url.searchParams.get('sslmode'), 'verify-full');
  assert.equal(url.searchParams.has('sslrootcert'), false);
  assert.equal(env.PGBOUNCER, 'false');
  assert.equal(env.DATABASE_POOL_MAX, '5');
  assert.equal(env.OTHER, 'preserved');
  assert.ok(result.contents.includes('# Private fixture\r\n'));
  assert.ok(!result.contents.replaceAll('\r\n', '').includes('\n'));
});

test('preserves pooled port, limits and is idempotent', () => {
  const once = normalizePlanetScaleEnv(`DATABASE_URL="${uri(6432)}"\nDATABASE_POOL_MAX=3\n`);
  assert.equal(once.pgbouncer, true);
  assert.equal(parseEnv(once.contents).DATABASE_POOL_MAX, '3');
  assert.equal(normalizePlanetScaleEnv(once.contents).changed, false);
});

for (const [name, text] of [
  ['missing URL', 'OTHER=preserved\n'],
  ['two bare URLs', `${uri()}\n${uri()}\n`],
  ['assignment and bare URL', `DATABASE_URL="${uri()}"\n${uri()}\n`],
  ['duplicate assignment', `DATABASE_URL="${uri()}"\nDATABASE_URL="${uri()}"\n`],
  ['non PlanetScale host', uri().replace('fixture.pg.psdb.cloud', 'example.invalid')],
  ['unverified TLS', uri().replace('verify-full', 'require')],
  ['custom CA in URI', uri().replace('sslrootcert=system', 'sslrootcert=private.pem')],
  ['custom CA setting', `${uri()}\nDATABASE_CA_FILE=private.pem\n`],
  ['unknown URI option', `${uri()}&options=unreviewed`],
  ['duplicated URI option', `${uri()}&sslmode=disable`],
  ['excessive pool limit', `${uri()}\nDATABASE_POOL_MAX=6\n`],
  ['duplicate pool setting', `${uri()}\nDATABASE_POOL_MAX=3\nDATABASE_POOL_MAX=4\n`],
  ['duplicate pooler setting', `${uri()}\nPGBOUNCER=true\nPGBOUNCER=false\n`],
  ['wrong database', uri().replace('/postgres?', '/other?')],
  ['wrong port', uri().replace(':5432/', ':5433/')],
]) test(`blocks ${name} without echoing credentials`, () => {
  assert.throws(() => normalizePlanetScaleEnv(text), error => /^[A-Z_]+$/.test(error.message));
});
