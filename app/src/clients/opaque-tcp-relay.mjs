// Bounded, protocol-independent transport. TLS stays with the original endpoints.
export const DEFAULT_LIMITS = Object.freeze({ frameBytes: 16 * 1024, idleMs: 30_000, lifetimeMs: 240_000 });
export const TUNNEL_PROTOCOL = 'mindbliss-opaque-tcp-v1';

export function relayWebSocketToSocket(ws, socket, limits = DEFAULT_LIMITS) {
  const { frameBytes, idleMs, lifetimeMs } = { ...DEFAULT_LIMITS, ...limits };
  if (![frameBytes, idleMs, lifetimeMs].every(Number.isSafeInteger) || frameBytes < 1 || frameBytes > 65536 || idleMs < 1 || lifetimeMs < 1) throw new Error('Invalid relay limits');
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let stopped = false;
  let receiving = false;
  let pendingAck;
  let idleTimer;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const fail = (reason = 'relay closed', code = 1011) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(idleTimer);
    clearTimeout(lifetimeTimer);
    if (pendingAck) { pendingAck.reject(new Error('Relay closed')); pendingAck = undefined; }
    try { ws.close(code, reason); } catch { /* Already disconnected. */ }
    void reader.cancel().catch(() => {});
    void writer.abort().catch(() => {});
    try { void Promise.resolve(socket.close()).catch(() => {}); } catch { /* Already disconnected. */ }
    resolveDone(reason);
  };
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => fail('relay idle timeout'), idleMs); };
  const lifetimeTimer = setTimeout(() => fail('relay lifetime exceeded'), lifetimeMs);
  touch();
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('close', () => fail('peer closed', 1000));
  ws.addEventListener('error', () => fail('peer failed'));
  ws.addEventListener('message', async event => {
    if (stopped) return;
    const data = event.data;
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return fail('binary frames required', 1008);
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length === 1 && bytes[0] === 1) {
      if (!pendingAck) return fail('unexpected acknowledgement', 1008);
      const ack = pendingAck; pendingAck = undefined; touch(); ack.resolve(); return;
    }
    if (bytes.length < 2 || bytes.length > frameBytes + 1 || bytes[0] !== 0 || receiving) return fail('invalid or unbounded frame', 1008);
    receiving = true;
    try {
      await writer.write(bytes.subarray(1));
      if (!stopped) { ws.send(Uint8Array.of(1)); touch(); }
    } catch { fail('tcp write failed'); }
    finally { receiving = false; }
  });
  const send = bytes => new Promise((resolve, reject) => {
    pendingAck = { resolve, reject };
    const frame = new Uint8Array(bytes.length + 1); frame.set(bytes, 1);
    try { ws.send(frame); } catch { pendingAck = undefined; reject(new Error('WebSocket send failed')); }
  });
  void (async () => {
    try {
      while (!stopped) {
        const next = await reader.read();
        if (next.done) { fail('tcp ended', 1000); return; }
        for (let offset = 0; offset < next.value.length && !stopped; offset += frameBytes) {
          await send(next.value.subarray(offset, offset + frameBytes));
        }
      }
    } catch { fail('tcp read failed'); }
  })();
  void socket.closed?.catch(() => fail('tcp closed'));
  return { done, close: () => fail('cancelled', 1000) };
}
