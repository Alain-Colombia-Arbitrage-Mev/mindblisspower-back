import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayWebSocketToSocket } from './framed-relay.mjs';

class FakeWebSocket extends EventTarget {
  sent = [];
  closed;
  send(data) { this.sent.push(data.slice()); }
  close(code, reason) { this.closed = { code, reason }; }
  message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
function fixture({ write = () => {}, idleMs = 2000 } = {}) {
  let source;
  let closed = 0;
  const ws = new FakeWebSocket();
  const socket = { readable: new ReadableStream({ start(controller) { source = controller; } }), writable: new WritableStream({ write }), close() { closed++; } };
  const relay = relayWebSocketToSocket(ws, socket, { frameBytes: 4, idleMs, lifetimeMs: 4000 });
  return { ws, relay, source, closed: () => closed };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('TCP output stops at one frame until peer acknowledgement, then preserves bytes', async () => {
  const f = fixture(); f.source.enqueue(Uint8Array.of(3, 4, 5, 6, 7, 8));
  await tick(); assert.deepEqual(f.ws.sent, [Uint8Array.of(0, 3, 4, 5, 6)]);
  await tick(); assert.equal(f.ws.sent.length, 1);
  f.ws.message(Uint8Array.of(1)); await tick();
  assert.deepEqual(f.ws.sent[1], Uint8Array.of(0, 7, 8));
  f.ws.message(Uint8Array.of(1)); f.relay.close();
  assert.equal(await f.relay.done, 'cancelled'); assert.equal(f.closed(), 1);
});

test('ACK only follows completed TCP write, cancelling closes the socket once', async () => {
  let release; const writes = [];
  const f = fixture({ write(bytes) { writes.push(bytes.slice()); return new Promise(resolve => { release = resolve; }); } });
  f.ws.message(Uint8Array.of(0, 5, 6)); await tick();
  assert.equal(f.ws.sent.length, 0); release(); await tick();
  assert.deepEqual(writes, [Uint8Array.of(5, 6)]); assert.deepEqual(f.ws.sent, [Uint8Array.of(1)]);
  f.relay.close(); f.relay.close(); await f.relay.done; assert.equal(f.closed(), 1);
});

for (const [name, payload] of [['text', 'secret'], ['oversized', Uint8Array.of(0, 1, 2, 3, 4, 5)], ['unsolicited ack', Uint8Array.of(1)], ['invalid type', Uint8Array.of(2, 4)]]) {
  test(`rejects ${name} without buffering or writing`, async () => {
    let written = false; const f = fixture({ write() { written = true; } });
    f.ws.message(payload); await f.relay.done;
    assert.equal(f.ws.closed.code, 1008); assert.equal(written, false); assert.equal(f.closed(), 1);
  });
}

test('rejects pipelined DATA while TCP consumer is blocked', async () => {
  let release; const f = fixture({ write() { return new Promise(resolve => { release = resolve; }); } });
  f.ws.message(Uint8Array.of(0, 1)); await tick(); f.ws.message(Uint8Array.of(0, 2));
  await f.relay.done; assert.equal(f.ws.closed.code, 1008); release();
});

test('idle deadline closes both sides without requiring another incoming event', async () => {
  const f = fixture({ idleMs: 20 });
  assert.equal(await f.relay.done, 'relay idle timeout'); assert.equal(f.closed(), 1);
});

test('WebSocket cancellation aborts an unacknowledged TCP frame', async () => {
  const f = fixture(); f.source.enqueue(Uint8Array.of(9)); await tick();
  f.ws.dispatchEvent(new Event('close'));
  assert.equal(await f.relay.done, 'peer closed'); assert.equal(f.closed(), 1);
});

test('hard lifetime closes an active relay even if peer traffic refreshes idle timer', async () => {
  let source; const ws = new FakeWebSocket();
  const relay = relayWebSocketToSocket(ws, { readable: new ReadableStream({ start(controller) { source = controller; } }), writable: new WritableStream(), close() {} }, { frameBytes: 4, idleMs: 100, lifetimeMs: 25 });
  source.enqueue(Uint8Array.of(2)); await tick(); ws.message(Uint8Array.of(1));
  assert.equal(await relay.done, 'relay lifetime exceeded');
});
