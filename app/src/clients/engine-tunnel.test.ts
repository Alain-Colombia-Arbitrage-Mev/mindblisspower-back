import { describe, expect, test } from 'bun:test';
import net from 'node:net';
import { once } from 'node:events';
import { ENGINE_TUNNEL_URL, startEngineTunnel } from './engine-tunnel';
import { TUNNEL_PROTOCOL } from './opaque-tcp-relay.mjs';

describe('private engine loopback tunnel', () => {
  test('is opt-in and rejects alternate destinations or missing mandatory mTLS', async () => {
    expect(await startEngineTunnel({})).toBeUndefined();
    for (const values of [
      { VP_ENGINE_TUNNEL_ENABLED: 'yes' },
      { VP_ENGINE_TUNNEL_ENABLED: 'true', VP_ENGINE_TUNNEL_URL: 'ws://attacker.invalid/', ENGINE_MTLS_REQUIRED: 'true' },
      { VP_ENGINE_TUNNEL_ENABLED: 'true', VP_ENGINE_TUNNEL_URL: ENGINE_TUNNEL_URL },
    ]) await expect(startEngineTunnel(values)).rejects.toThrow('configuration');
  });
  test('binds loopback only, preserves opaque bytes and closes resources', async () => {
    const original = globalThis.WebSocket;
    let peer: FakeWebSocket | undefined;
    class FakeWebSocket extends EventTarget {
      protocol = TUNNEL_PROTOCOL;
      binaryType = 'arraybuffer';
      sent: Uint8Array[] = [];
      constructor(url: string, protocol: string) {
        super(); expect(url).toBe(ENGINE_TUNNEL_URL); expect(protocol).toBe(TUNNEL_PROTOCOL); peer = this;
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      send(bytes: Uint8Array) { this.sent.push(bytes.slice()); }
      close() {}
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    let tunnel;
    let socket: net.Socket | undefined;
    try {
      tunnel = await startEngineTunnel({ VP_ENGINE_TUNNEL_ENABLED: 'true', VP_ENGINE_TUNNEL_URL: ENGINE_TUNNEL_URL, ENGINE_MTLS_REQUIRED: 'true' });
      expect(tunnel?.address.host).toBe('127.0.0.1');
      socket = net.connect(tunnel!.address.port, tunnel!.address.host); await once(socket, 'connect');
      socket.write(Uint8Array.of(22, 3, 3, 0, 1));
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(peer?.sent[0]).toEqual(Uint8Array.of(0, 22, 3, 3, 0, 1));
      peer!.dispatchEvent(new MessageEvent('message', { data: Uint8Array.of(1) }));
      const incoming = once(socket, 'data');
      peer!.dispatchEvent(new MessageEvent('message', { data: Uint8Array.of(0, 9, 8) }));
      expect(new Uint8Array((await incoming)[0])).toEqual(Uint8Array.of(9, 8));
    } finally {
      socket?.destroy(); await tunnel?.close(); globalThis.WebSocket = original;
    }
  });
});
