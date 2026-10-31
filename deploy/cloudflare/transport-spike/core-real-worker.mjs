import core, { CoreApi, CoreEngine, CorePayments, ContainerProxy } from '../core/src/worker.mjs';
export { ContainerProxy };
export class FixtureApi extends CoreApi {
  constructor(ctx, env) { super(ctx, env); Object.assign(this.envVars, { FIXTURE_JWKS: env.SYNTHETIC_JWKS, FIXTURE_NEGATIVE_PEMS: env.SYNTHETIC_NEGATIVE_PEMS }); }
}
export class FixtureEngine extends CoreEngine {
  constructor(ctx, env) { super(ctx, env); this.envVars.DATABASE_CA_PEM = env.SYNTHETIC_DATABASE_CA; }
}
export class FixtureProbe extends CorePayments {
  constructor(ctx, env) { super(ctx, env); Object.assign(this.envVars, { PORT: '9095', FIXTURE_PROBE_ONLY: 'true', FIXTURE_JWT: env.SYNTHETIC_JWT }); }
}
FixtureApi.outboundByHost = CoreApi.outboundByHost;
FixtureProbe.outboundByHost = CorePayments.outboundByHost;
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/public-tunnel-rejection') return core.fetch(new Request('http://engine-grpc.core.internal/v1/engine-tunnel', { headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'mindbliss-opaque-tcp-v1' } }), env);
    if (path === '/run') {
      const api = await env.API_CONTAINER.getByName('singleton').fetch(new Request('http://core.internal/run'));
      const apiBody = await api.json();
      if (!api.ok) return Response.json({ api: apiBody }, { status: 500 });
      const probe = await env.PAYMENTS_CONTAINER.getByName('singleton').fetch(new Request('http://payments.core.internal/run'));
      return Response.json({ api: apiBody, jwks: await probe.json() }, { status: probe.status });
    }
    if (path === '/new-channel') return env.API_CONTAINER.getByName('singleton').fetch(new Request('http://core.internal/new-channel'));
    // Exercise the actual public/service-binding dispatcher for negative routes.
    return core.fetch(request, env);
  },
};
