import assert from 'node:assert/strict';

let probes = 0;
async function probe(port, path, expected, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  assert.ok([expected].flat().includes(response.status), `${port}${path}: HTTP ${response.status}, expected ${expected}`);
  probes++;
  return response;
}

for (const port of [3300, 3301]) {
  const html = await (await probe(port, '/login', 200)).text();
  const cssPaths = [...new Set([...html.matchAll(/href="([^" ]+\.css(?:\?[^" ]*)?)"/g)].map(match => match[1]))];
  assert.ok(cssPaths.length, `${port}: stylesheet absent from login`);
  for (const path of cssPaths) {
    assert.ok(path.startsWith('/_next/'), 'Only local Next assets are permitted');
    const css = await probe(port, path, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.ok((await css.text()).length > 1000, `${port}: empty stylesheet`);
  }
  await probe(port, '/dashboard', [307, 308]);
  await probe(port, '/api/admin/finance', 401);
}

for (const origin of ['http://foreign.invalid', 'null']) {
  const response = await probe(3301, '/api/admin/blacklist/remove', 403, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
  });
  assert.match(response.headers.get('cache-control'), /no-store/);
}
await probe(3301, '/api/admin/blacklist/remove', 403, { method: 'POST', body: '{}' });
await probe(3301, '/api/admin/blacklist/remove', 401, {
  method: 'POST', headers: { origin: 'http://127.0.0.1:3301' }, body: '{}',
});

await probe(3302, '/health', 200);
await probe(3302, '/api/auth/sign-in/email', 401, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3302' },
  body: JSON.stringify({ email: 'nobody@example.invalid', password: 'invalid-password' }),
});
await probe(3302, '/api/affiliate/place', 401, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
});
for (const port of [3305, 3307]) await probe(port, '/health', 200);
await probe(3305, '/api/admin/finance?email=admin@example.invalid', 401);
await probe(3307, '/api/admin/withdrawals?email=admin@example.invalid', 401);

// The only accepted credential is deliberately invalid outside this isolated QA stack.
const headers = { 'X-VP-Service-Token': 'synthetic-qa-only-not-for-production' };
for (const path of ['/api/admin/finance', '/api/admin/tree/roots', '/api/admin/network/health']) {
  const response = await probe(3305, `${path}?email=admin@example.invalid`, 200, { headers });
  await response.json();
}
await probe(3307, '/api/admin/withdrawals?email=admin@example.invalid', 200, { headers });
console.log(`PASS: ${probes} HTTP probes against the isolated Docker stack`);
