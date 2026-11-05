// Launched only inside the pinned Bun runtime with Docker --network none.
// The local CA/certificates are generated specifically for this disposable run.
const server = Bun.serve({ hostname: '0.0.0.0', port: 0,
  tls: { key: Bun.file('/certs/server.key'), cert: Bun.file('/certs/server.pem') },
  fetch: () => new Response('synthetic-tls-only'),
});
const run = async (code, withCA) => {
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', code], {
    env: { ...(withCA ? { NODE_EXTRA_CA_CERTS: '/certs/ca.pem' } : {}) }, stdout: 'pipe', stderr: 'pipe',
  });
  const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error('synthetic_tls_fixture_failed');
  return JSON.parse(stdout);
};
const http = host => `try { const response = await fetch('https://${host}:${server.port}/', {signal:AbortSignal.timeout(2500)});
  console.log(JSON.stringify({ok:response.ok && await response.text()==='synthetic-tls-only'})); }
  catch { console.log(JSON.stringify({ok:false})); }`;
try {
  const missing = await run(http('127.0.0.1'), false);
  const trusted = await run(http('127.0.0.1'), true);
  const mismatch = await run(http('127.0.0.2'), true);
  const tcp = await run(`import tls from 'node:tls';
    const socket=tls.connect({host:'127.0.0.1',port:${server.port},servername:'localhost',rejectUnauthorized:true});
    const ok=await new Promise(resolve=>{socket.once('secureConnect',()=>resolve(socket.authorized===true));socket.once('error',()=>resolve(false));socket.setTimeout(2500,()=>resolve(false));});
    socket.destroy();console.log(JSON.stringify({ok}));`, true);
  const pass = !missing.ok && trusted.ok && !mismatch.ok && tcp.ok;
  console.log(JSON.stringify({ check: 'local-bun-egress-tls', bun: Bun.version, pass,
    missingCaRejected: !missing.ok, additionalCaTrusted: trusted.ok, hostnameMismatchRejected: !mismatch.ok, rawTlsTrusted: tcp.ok,
    providerTraffic: false, databaseTraffic: false, cloudflareCaInjectionVerified: false, productionActivationApproved: false }));
  if (!pass) process.exitCode = 1;
} finally { server.stop(true); }
