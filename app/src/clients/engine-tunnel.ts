import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import { relayWebSocketToSocket, TUNNEL_PROTOCOL } from './opaque-tcp-relay.mjs';

type Environment = Record<string, string | undefined>;
export const ENGINE_TUNNEL_URL = 'ws://engine-grpc.core.internal/v1/engine-tunnel';
export type EngineTunnel = { address: { host: '127.0.0.1'; port: number }; close(): Promise<void> };

/** Only loopback is exposed; TLS is never terminated here or retried as HTTP. */
export async function startEngineTunnel(env: Environment): Promise<EngineTunnel | undefined> {
  const mode = env.VP_ENGINE_TUNNEL_ENABLED;
  if (mode === undefined || mode === 'false') return undefined;
  if (mode !== 'true' || env.VP_ENGINE_TUNNEL_URL !== ENGINE_TUNNEL_URL || env.ENGINE_MTLS_REQUIRED !== 'true') {
    throw new Error('Engine private tunnel configuration is invalid');
  }
  const active = new Set<{ close(): void }>();
  const sockets = new Set<net.Socket>();
  let closing = false;
  const server = net.createServer({ pauseOnConnect: true }, socket => {
    if (closing || sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('error', () => {});
    let relay: ReturnType<typeof relayWebSocketToSocket> | undefined;
    const ws = new WebSocket(ENGINE_TUNNEL_URL, TUNNEL_PROTOCOL);
    const stop = () => {
      clearTimeout(timer);
      relay?.close();
      try { ws.close(); } catch { /* Already disconnected. */ }
      socket.destroy();
      sockets.delete(socket);
    };
    const timer = setTimeout(stop, 8_000);
    ws.addEventListener('error', stop);
    ws.addEventListener('close', stop);
    socket.on('close', stop);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      if (closing || socket.destroyed || ws.protocol !== TUNNEL_PROTOCOL) { stop(); return; }
      relay = relayWebSocketToSocket(ws, {
        readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
        writable: Writable.toWeb(socket) as WritableStream<Uint8Array>,
        close: () => socket.destroy(),
      });
      active.add(relay);
      void relay.done.finally(() => { if (relay) active.delete(relay); });
      socket.resume();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('Engine private tunnel unavailable')));
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Engine private tunnel unavailable'); }
  return {
    address: { host: '127.0.0.1', port: address.port },
    async close() {
      if (closing) return;
      closing = true;
      for (const relay of active) relay.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
