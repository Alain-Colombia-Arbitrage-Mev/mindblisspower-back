// Explicit, offline acceptance test. This file is not included by *.test.mjs.
// No real key, .env, customer record, database or provider endpoint is loaded.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 3 || process.argv[2] !== '--local-only') {
  console.log(JSON.stringify({ error: 'explicit_local_only_required' })); process.exit(2);
}
const openssl = ['C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe']
  .find(path => existsSync(path)) ?? 'openssl';
const base = realpathSync(tmpdir());
const temporary = mkdtempSync(join(base, 'mindbliss-egress-tls-'));
const generate = args => execFileSync(openssl, args, { cwd: temporary, stdio: 'ignore', timeout: 10_000, windowsHide: true });
try {
  generate(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Mindbliss Synthetic Egress CA',
    '-keyout', 'ca.key', '-out', 'ca.pem', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  generate(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'extendedKeyUsage=serverAuth']);
  generate(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'server.pem', '-days', '1', '-copy_extensions', 'copy']);
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'http-egress-tls.synthetic.mjs');
  const result = execFileSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp',
    '--mount', `type=bind,source=${temporary},target=/certs,readonly`, '--mount', `type=bind,source=${fixture},target=/fixture.mjs,readonly`,
    '--entrypoint', 'bun', 'mindbliss/api-security-release-20261104', '--no-env-file', '/fixture.mjs'], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 128 * 1024,
  });
  const value = JSON.parse(result.trim());
  if (value.check !== 'local-bun-egress-tls' || value.pass !== true || value.providerTraffic !== false || value.databaseTraffic !== false) throw new Error();
  console.log(JSON.stringify(value));
} catch {
  console.log(JSON.stringify({ check: 'local-bun-egress-tls', pass: false, error: 'LOCAL_FIXTURE_UNAVAILABLE',
    providerTraffic: false, databaseTraffic: false, cloudflareCaInjectionVerified: false, productionActivationApproved: false }));
  process.exitCode = 1;
} finally {
  // Delete only this resolved, newly created temporary fixture directory.
  const target = resolve(temporary);
  if (dirname(target).toLowerCase() !== base.toLowerCase() || !target.toLowerCase().startsWith((base + sep + 'mindbliss-egress-tls-').toLowerCase())) {
    throw new Error('temporary_cleanup_target_invalid');
  }
  rmSync(target, { recursive: true, force: true });
}
