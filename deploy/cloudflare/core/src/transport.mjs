// The gateway owns a wall-clock deadline even if a service-binding fetch or
// stream ignores abort. A timeout is ambiguous for writes: never retry here or
// report that an invoice, message or durable IPN was not created.
export const CORE_BODY_TIMEOUT_MS = 10_000;
export function coreOperationTimeoutMs(request) {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/payments/checkout') return 65_000;
  if (pathname === '/api/webhooks/nowpayments') return 30_000;
  if (pathname.startsWith('/api/auth/')) return 45_000;
  if (['/health', '/ready', '/api/payments/nowpayments/status'].includes(pathname)) return 10_000;
  return 65_000; // Go has a 60-second write timeout, including heavier reports.
}

function deadline(signal, timeoutMs) {
  const controller = new AbortController();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  void aborted.catch(() => {}); // Pre-aborted requests may fail before the race is installed.
  const stop = () => {
    if (!controller.signal.aborted) controller.abort(new Error('upstream_unavailable'));
    rejectAbort(new Error('upstream_unavailable'));
  };
  const timer = setTimeout(stop, timeoutMs);
  timer.unref?.(); // Node fixtures must not stay alive for unread response bodies.
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  return { signal: controller.signal, aborted, stop,
    close() { clearTimeout(timer); signal?.removeEventListener('abort', stop); } };
}

function cancelBody(body) { try { void body?.cancel().catch(() => {}); } catch { /* Already locked/cancelled. */ } }

/** One fetch, bounded through body EOF/cancel; no redirects or automatic retries. */
export async function fetchWithDeadline(request, fetchImpl, timeoutMs = coreOperationTimeoutMs(request)) {
  const scope = deadline(request.signal, timeoutMs);
  try {
    if (scope.signal.aborted) throw new Error('upstream_unavailable');
    const pending = Promise.resolve().then(() => fetchImpl(new Request(request, { signal: scope.signal, redirect: 'manual' })))
      .then(response => {
        if (scope.signal.aborted) { cancelBody(response.body); throw new Error('upstream_unavailable'); }
        return response;
      });
    const response = await Promise.race([pending, scope.aborted]);
    if (!response.body) { scope.close(); return response; }
    const reader = response.body.getReader();
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true; scope.close();
      try { reader.releaseLock(); } catch { /* Pending read is cancelled separately. */ }
    };
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const item = await Promise.race([reader.read(), scope.aborted]);
          if (item.done) { controller.close(); release(); }
          else controller.enqueue(item.value);
        } catch {
          try { void reader.cancel().catch(() => {}); } catch { /* Already released. */ }
          controller.error(new Error('upstream_unavailable')); release();
        }
      },
      cancel() {
        scope.stop();
        try { void reader.cancel().catch(() => {}); } catch { /* Already released. */ }
        release();
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    scope.stop(); scope.close(); throw new Error('upstream_unavailable');
  }
}

/** Bound streaming uploads before starting a Container; cancellation never waits. */
export async function boundedBody(request, limit, timeoutMs = CORE_BODY_TIMEOUT_MS) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('body_limit');
  if (!request.body) return undefined;
  const scope = deadline(request.signal, timeoutMs);
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), scope.aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('body_limit');
      parts.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
    return body;
  } catch (error) {
    try { void reader.cancel().catch(() => {}); } catch { /* Already released. */ }
    throw new Error(error?.message === 'body_limit' ? 'body_limit' : 'upstream_unavailable');
  } finally { scope.close(); reader.releaseLock(); }
}
