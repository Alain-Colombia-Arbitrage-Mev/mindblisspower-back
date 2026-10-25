import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// An internal-only network and empty app environment prevent access to real APIs.
const tag = process.env.MINDBLISS_TEST_IMAGE_TAG ?? 'professional-20261025';
assert.match(tag, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/);
const prefix = `mindbliss-web-smoke-${randomBytes(6).toString('hex')}`;
const containers = [];
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
docker(['network', 'create', '--internal', prefix]);
try {
  for (const service of ['client', 'admin']) {
    const name = `${prefix}-${service}`;
    const image = `mindbliss/${service}:${tag}`;
    const spec = JSON.parse(docker(['image', 'inspect', image]))[0];
    assert.equal(spec.Config.User, '65532:65532');
    assert.ok(spec.Config.Healthcheck?.Test?.length > 0);
    assert.ok(!(spec.Config.Env ?? []).some(value => /^(STRIPE_SECRET_KEY|DATABASE_URL|MEMBER_DATABASE_URL|PAYMENTS_SERVICE_TOKEN)=/.test(value)));
    docker(['run', '-d', '--name', name, '--network', prefix, '--read-only', '--tmpfs', '/tmp',
      '--tmpfs', '/app/.next/cache:uid=65532,gid=65532,mode=0700,size=128m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '512m', '--cpus', '1',
      '-e', 'NODE_OPTIONS=--max-old-space-size=384', '-e', 'DEMO_LOGIN_ENABLED=0', image]);
    containers.push(name);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const check = spawnSync('docker', ['exec', name, '/nodejs/bin/node', '-e',
        "fetch('http://127.0.0.1:3000/login',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { encoding: 'utf8' });
      if (check.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(ready, true, `${service} login did not become healthy`);
    // Exercise native Sharp/libvips in the new distroless runtime and the writable cache.
    const verify = docker(['exec', name, '/nodejs/bin/node', '-e', `
      const fs = require('node:fs');
      (async () => {
        const health = await fetch('http://127.0.0.1:3000/health');
        if (!health.ok) throw Error('health unavailable');
        const image = await fetch('http://127.0.0.1:3000/_next/image?url=%2Fmindbliss%2Fmindbliss-symbol.png&w=64&q=75');
        if (!image.ok || !(image.headers.get('content-type') || '').startsWith('image/')) throw Error('image optimization failed');
        if (fs.existsSync('/bin/sh') || fs.existsSync('/usr/bin/npm')) throw Error('runtime contains shell/npm');
        fs.writeFileSync('/app/.next/cache/smoke', 'regenerable');
        if (process.getuid() === 0) throw Error('runtime is root');
        console.log(JSON.stringify({ uid: process.getuid(), health: health.status, imageOptimization: image.status, readOnly: true }));
      })().catch(e => { console.error(e.message); process.exit(1); });`]);
    console.log(`PASS ${service}: ${verify}`);
  }
} finally {
  for (const name of containers.reverse()) {
    assert.ok(name.startsWith(`${prefix}-`));
    docker(['rm', '-f', name]);
  }
  docker(['network', 'rm', prefix]);
}
