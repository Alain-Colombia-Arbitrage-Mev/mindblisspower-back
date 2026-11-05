import { Container, ContainerProxy, getContainer } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { coreReady, dispatchCore, dispatchContainerOutbound, isGrpcTunnelRequest, TUNNEL_PROTOCOL } from './routing.mjs';
import { containerEnvironment } from './runtime-env.mjs';
import { privateReadiness } from './private-probe.mjs';
import { captureConfiguration } from './capture-configuration.mjs';
import { runNOWPaymentsScheduled } from './nowpayments-scheduled.mjs';
import { privateNOWPaymentsReadiness, privateNOWPaymentsDiagnostics } from './nowpayments-readiness.mjs';
import { handleOperationalStorage, observationRequest, operationalMonitoringEnabled } from './observability-store.mjs';
import { privateOperationalSnapshot, runOperationalMonitoring } from './observability-monitor.mjs';
import { relayWebSocketToSocket } from '../../../../app/src/clients/opaque-tcp-relay.mjs';
import { CONTAINER_HTTP_HOSTS, containerHttpOutbound, strictHttpEgressEnabled, assertHttpEgressActivationSafe } from './http-egress.mjs';
import { authTraceEnabled } from './auth-trace-store.mjs';
import { recordDeliveryTelemetry, privateAuthTrace, prunePrivateAuthTraces, authTraceTransportReadiness, authTraceReadinessDiagnostics } from './email-telemetry.mjs';
export { ContainerProxy };

// Each class receives only its own mapped runtime secrets. No .env is uploaded.
function coreContainer(service, port, healthPath) {
  return class extends Container {
    constructor(ctx, env) {
      assertHttpEgressActivationSafe(env);
      super(ctx, env, { defaultPort: port, sleepAfter: '10m', enableInternet: true,
        envVars: containerEnvironment(service, env) });
      this.interceptHttps = strictHttpEgressEnabled(env);
      // No catch-all installation until the SDK offers a verified public rollback.
      // Disabled mode leaves existing per-host networking and storage unchanged.
      this.httpEgressPolicyReady = Promise.resolve();
      void this.httpEgressPolicyReady.catch(() => {}); // fetch propagates a generic failure.
      this.pingEndpoint = `localhost${healthPath}`;
    }
    async fetch(request) {
      await this.httpEgressPolicyReady;
      const headers = new Headers(request.headers);
      headers.delete('cf-container-target-port');
      return this.containerFetch(new Request(request, { headers }), port);
    }
    onError() { throw new Error('Core container unavailable'); }
    onStop() { /* Intentionally no stderr, runtime env or provider exception logs. */ }
  };
}

export class CoreApi extends coreContainer('api', 3000, '/health') {
  constructor(ctx, env) { super(ctx, env); this.interceptHttps = strictHttpEgressEnabled(env) || operationalMonitoringEnabled(env) || authTraceEnabled(env); }
  fetch(request) {
    if (observationRequest(request)) return handleOperationalStorage(request, this.ctx.storage, this.env);
    return super.fetch(request);
  }
}
export class CoreEngine extends coreContainer('engine', 9090, '/ready') {
  activeTunnels = 0;
  async fetch(request) {
    await this.httpEgressPolicyReady;
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
// Only the portal receives this named RPC binding. It has no HTTP fetch method,
// arbitrary target, trace read, provider call or administrator capability.
export class PrivateEmailTelemetry extends WorkerEntrypoint {
  recordDelivery(event) {
    if (arguments.length !== 1) throw new Error('Delivery telemetry accepts one event');
    return recordDeliveryTelemetry(this.env, resolveFor(this.env), event);
  }
}
// Named service-binding RPC only. No HTTP fetch handler, arbitrary target,
// request forwarding or public route is added to the default Worker.
export class PrivateCoreProbe extends WorkerEntrypoint {
  authTrace(selector) {
    if (arguments.length !== 1) throw new Error('Auth trace accepts one selector');
    return privateAuthTrace(this.env, resolveFor(this.env), selector);
  }
  authTraceTransportReadiness() {
    if (arguments.length !== 0) throw new Error('Auth trace readiness accepts no arguments');
    return authTraceTransportReadiness(this.env, resolveFor(this.env));
  }
  authTraceReadinessDiagnostics() {
    if (arguments.length !== 0) throw new Error('Auth trace readiness diagnostics accepts no arguments');
    return authTraceReadinessDiagnostics(this.env, resolveFor(this.env));
  }
  operationalSnapshot() {
    if (arguments.length !== 0) throw new Error('Operational snapshot accepts no arguments');
    return privateOperationalSnapshot(this.env, resolveFor(this.env));
  }
  nowpaymentsDiagnostics() {
    if (arguments.length !== 0) throw new Error('NOWPayments diagnosis accepts no arguments');
    return privateNOWPaymentsDiagnostics(this.env, resolveFor(this.env));
  }
  nowpaymentsReadiness() {
    if (arguments.length !== 0) throw new Error('NOWPayments readiness accepts no arguments');
    return privateNOWPaymentsReadiness(this.env, resolveFor(this.env));
  }
  readiness() {
    if (arguments.length !== 0) throw new Error('Readiness probe accepts no arguments');
    return privateReadiness(this.env, resolveFor(this.env));
  }
  captureConfiguration() {
    if (arguments.length !== 0) throw new Error('Capture configuration probe accepts no arguments');
    return captureConfiguration(this.env);
  }
}
for (const [source, Class] of [
  ['api', CoreApi], ['engine', CoreEngine], ['payments', CorePayments], ['withdrawals', CoreWithdrawals],
]) {
  // Assignment is required: static fields would shadow the SDK's registry setter.
  Class.outboundByHost = Object.fromEntries(CONTAINER_HTTP_HOSTS[source].map(host => [host, (request, env) => dispatchContainerOutbound(source, request, env, resolveFor(env))]));
  Class.outboundHandlers = { strictHttp: (request, env) => containerHttpOutbound(source, request, env, resolveFor(env)) };
}

export default {
  fetch(request, env) {
    return dispatchCore(request, env, resolveFor(env));
  },
  scheduled(controller, env, ctx) {
    if (controller.cron !== '*/5 * * * *') throw new Error('Unknown scheduled operation');
    ctx.waitUntil(runNOWPaymentsScheduled(env, resolveFor(env)));
    if (operationalMonitoringEnabled(env)) ctx.waitUntil(runOperationalMonitoring(env, resolveFor(env)));
    if (authTraceEnabled(env)) ctx.waitUntil(prunePrivateAuthTraces(env, resolveFor(env)));
  },
};
