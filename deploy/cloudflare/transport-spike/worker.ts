import { Container, ContainerProxy } from '../core/node_modules/@cloudflare/containers/dist/index.js';
import { relayWebSocketToSocket } from './framed-relay.mjs';
export { ContainerProxy };

type Env = { ENGINE: DurableObjectNamespace<SyntheticEngine>; CLIENT: DurableObjectNamespace<SyntheticClient>; SYNTHETIC_PEMS: string };

export class SyntheticEngine extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = { SYNTHETIC_PEMS: env.SYNTHETIC_PEMS };
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.hostname === 'engine.synthetic.internal' && url.pathname === '/probe' && !url.search) return new Response('synthetic private outbound reached');
    if (url.hostname !== 'engine.synthetic.internal' || url.pathname !== '/tunnel' || url.search || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 });
    await this.startAndWaitForPorts(8080);
    const socket = this.ctx.container!.getTcpPort(50051).connect('engine.synthetic.internal:50051');
    const pair = new WebSocketPair();
    await Promise.race([socket.opened, new Promise((_, reject) => setTimeout(() => reject(new Error('TCP startup timeout')), 5000))]).catch(async () => { await socket.close(); throw new Error('Synthetic engine unavailable'); });
    pair[1].accept();
    const relay = relayWebSocketToSocket(pair[1], socket);
    this.ctx.waitUntil(relay.done);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

export class SyntheticClient extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = { SYNTHETIC_PEMS: env.SYNTHETIC_PEMS };
  }
}
// Assignment invokes the SDK's inherited setter and registers the handler.
// A static class field would shadow that setter and silently miss the registry.
SyntheticClient.outboundByHost = {
  'engine.synthetic.internal': (request: Request, env: Env) => env.ENGINE.getByName('synthetic').fetch(request),
};

// LOCAL-ONLY test driver: no deployment script, public engine routes, auth or DB.
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run' || request.method !== 'GET') return new Response('Not found', { status: 404 });
    return env.CLIENT.getByName('synthetic').fetch(new Request('http://client/run'));
  },
};
