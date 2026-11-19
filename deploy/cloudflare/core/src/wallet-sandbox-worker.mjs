import { Container, getContainer } from '@cloudflare/containers';
import { walletSandboxEnvironment, walletSandboxRequestAllowed } from './wallet-sandbox-runtime.mjs';

export class WalletSandboxApi extends Container {
  constructor(ctx, env) {
    super(ctx, env, { defaultPort: 3000, sleepAfter: '10m', enableInternet: true,
      envVars: walletSandboxEnvironment(env) });
    this.pingEndpoint = 'localhost/health';
  }
  fetch(request) {
    if (!walletSandboxRequestAllowed(request)) return Response.json({ error: 'not_found' }, { status: 404 });
    const headers = new Headers(request.headers);
    headers.delete('cf-container-target-port');
    return this.containerFetch(new Request(request, { headers }), 3000);
  }
  onError() { throw Error('Wallet sandbox unavailable'); }
  onStop() {}
}

export default {
  async fetch(request, env) {
    if (!walletSandboxRequestAllowed(request)) return Response.json({ error: 'not_found' }, { status: 404 });
    // Production uses its own instance identity and starts from the current deployed image.
    const instance = env.WALLET_MELD_PRODUCTION_ENABLED === 'true' ? 'wallet-production-v5' : 'wallet-sandbox-v1';
    try { return await getContainer(env.WALLET_SANDBOX_CONTAINER, instance).fetch(request); }
    catch { return Response.json({ error: 'sandbox_wallet_unavailable' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } }); }
  },
};
