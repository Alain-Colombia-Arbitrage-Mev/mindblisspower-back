/** Fixed-host, bounded transport for sandbox metadata. Never retries writes. */
export function sandboxOperation<T>(operation: () => Promise<T>, signal: AbortSignal, late?: (value: T) => void) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(Error('administrative_offramp_unavailable')); } };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw Error('administrative_offramp_unavailable'); return operation(); }).then(value => {
      if (settled) { late?.(value); return; } settled = true; signal.removeEventListener('abort', abort); resolve(value);
    }, error => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(error); } });
  });
}

export function sandboxOperationScope(parent?: AbortSignal, milliseconds = 15_000) {
  const controller = new AbortController(), abort = () => controller.abort();
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(Math.max(milliseconds, 1), 20_000));
  return { signal: controller.signal, close() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}

export async function sandboxMeldJson(path: string, { key, fetchImpl, signal, body }: {
  key: string; fetchImpl: typeof fetch; signal: AbortSignal; body?: unknown;
}): Promise<{ status: number; ok: boolean; data: unknown }> {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#\s]/.test(path)) throw Error('administrative_offramp_unavailable');
  const response = await sandboxOperation(() => fetchImpl(`https://api-sb.meld.io${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
    headers: { Authorization: `BASIC ${key}`, Accept: 'application/json', 'Meld-Version': '2026-02-03',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), signal, value => { void value.body?.cancel().catch(() => {}); });
  const length = response.headers.get('content-length');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body
    || (length !== null && (!/^\d+$/.test(length) || Number(length) > 131_072))) {
    void response.body?.cancel().catch(() => {}); throw Error('administrative_offramp_unavailable');
  }
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) { const chunk = await sandboxOperation(() => reader.read(), signal); if (chunk.done) break;
      size += chunk.value.length; if (size > 131_072) throw Error('administrative_offramp_unavailable'); parts.push(chunk.value); }
    try { return { status: response.status, ok: response.ok, data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as unknown }; }
    catch { throw Error('administrative_offramp_unavailable'); }
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
