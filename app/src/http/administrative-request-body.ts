/** New administrative writes never buffer an unbounded body before verifying its BFF signature. */
export async function readAdministrativeRequestBody(request: Request, timeoutMs = 10000) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > 2048)) throw new RangeError('request_too_large');
  const reader = request.body?.getReader(); if (!reader) throw new SyntaxError('missing_body');
  let timedOut = false, size = 0;
  const pieces: Uint8Array[] = [];
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* Already cancelled. */ } };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, Math.min(Math.max(timeoutMs, 1), 10000));
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (request.signal.aborted || timedOut) throw Error('administrative_request_body_unavailable');
      const chunk = await reader.read();
      if (request.signal.aborted || timedOut) throw Error('administrative_request_body_unavailable');
      if (chunk.done) break; size += chunk.value.byteLength;
      if (size > 2048) throw new RangeError('request_too_large'); pieces.push(chunk.value);
    }
    if (!size) throw new SyntaxError('missing_body');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces));
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
