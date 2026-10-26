import { Container, ContainerProxy, getContainer } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { coreReady, dispatchCore, dispatchContainerOutbound, isGrpcTunnelRequest, TUNNEL_PROTOCOL } from './routing.mjs';
import { containerEnvironment } from './runtime-env.mjs';
import { privateReadiness } from './private-probe.mjs';
import { relayWebSocketToSocket } from '../../../../app/src/clients/opaque-tcp-relay.mjs';
export { ContainerProxy };

// Each class receives only its own mapped runtime secrets. No .env is uploaded.
function coreContainer(service, port, healthPath) {
  return class extends Container {
    constructor(ctx, env) {
      super(ctx, env, { defaultPort: port, sleepAfter: '10m', enableInternet: true,
        envVars: containerEnvironment(service, env) });
      this.pingEndpoint = `localhost${healthPath}`;
    }
    fetch(request) {
      const headers = new Headers(request.headers);
      headers.delete('cf-container-target-port');
      return this.containerFetch(new Request(request, { headers }), port);
    }
    onError() { throw new Error('Core container unavailable'); }
    onStop() { /* Intentionally no stderr, runtime env or provider exception logs. */ }
  };
}

export class CoreApi extends coreContainer('api', 3000, '/health') {}
export class CoreEngine extends coreContainer('engine', 9090, '/ready') {
  activeTunnels = 0;
  async fetch(request) {
    if (!isGrpcTunnelRequest(request)) {
      // Never expose a raw Engine port through an arbitrary DO fetch.
      const url = new URL(request.url);
      if (request.headers.has('upgrade') || url.hostname !== 'engine.core.internal'
        || !['GET', 'HEAD'].includes(request.method) || !['/health', '/ready', '/metrics'].includes(url.pathname)
        || url.search || url.port || url.username || url.password) return new Response('Not found', { status: 404 });
      return super.fetch(request);
    }
    if (!coreReady(this.env) || this.activeTunnels >= 16) return new Response('Engine unavailable', { status: 503 });
    this.activeTunnels++;
    let socket;
    let timer;
    try {
      await this.startAndWaitForPorts(9090);
      const ready = await this.ctx.container.getTcpPort(9090).fetch('http://engine/ready', { signal: AbortSignal.timeout(3000) });
      const readyOk = ready.ok; await ready.body?.cancel();
      if (!readyOk) throw new Error('Engine unavailable');
      socket = this.ctx.container.getTcpPort(50051).connect('engine.core.internal:50051');
      await Promise.race([socket.opened, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Engine unavailable')), 5000); })]);
      clearTimeout(timer);
      const pair = new WebSocketPair();
      pair[1].accept();
      const relay = relayWebSocketToSocket(pair[1], socket);
      this.ctx.waitUntil(relay.done.finally(() => { this.activeTunnels--; }));
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'sec-websocket-protocol': TUNNEL_PROTOCOL } });
    } catch {
      clearTimeout(timer); this.activeTunnels--;
      try { await socket?.close(); } catch { /* Already disconnected. */ }
      return new Response('Engine unavailable', { status: 503 });
    }
  }
}
// Go trusts the private HTTPS interception CA through SSL_CERT_DIR, while
// retaining system roots. Class constructor must set the SDK instance property.
export class CorePayments extends coreContainer('payments', 9095, '/health') {
  constructor(ctx, env) { super(ctx, env); this.interceptHttps = true; }
}
export class CoreWithdrawals extends coreContainer('withdrawals', 9097, '/health') {
  constructor(ctx, env) { super(ctx, env); this.interceptHttps = true; }
}

const BINDINGS = { api: 'API_CONTAINER', engine: 'ENGINE_CONTAINER', payments: 'PAYMENTS_CONTAINER', withdrawals: 'WITHDRAWALS_CONTAINER' };
const resolveFor = env => (service, instance) => getContainer(env[BINDINGS[service]], instance);
// Named service-binding RPC only. No HTTP fetch handler, arbitrary target,
// request forwarding or public route is added to the default Worker.
export class PrivateCoreProbe extends WorkerEntrypoint {
  readiness() {
    if (arguments.length !== 0) throw new Error('Readiness probe accepts no arguments');
    return privateReadiness(this.env, resolveFor(this.env));
  }
}
for (const [source, Class, hosts] of [
  ['api', CoreApi, ['engine-grpc.core.internal', 'engine.core.internal']],
  ['payments', CorePayments, ['engine.core.internal', 'auth.core.internal']],
  ['withdrawals', CoreWithdrawals, ['auth.core.internal']],
]) {
  // Assignment is required: static fields would shadow the SDK's registry setter.
  Class.outboundByHost = Object.fromEntries(hosts.map(host => [host, (request, env) => dispatchContainerOutbound(source, request, env, resolveFor(env))]));
}

export default {
  fetch(request, env) {
    return dispatchCore(request, env, resolveFor(env));
  },
};
