/** Shared bounded JSON-RPC transport; it never logs URLs, headers, keys or raw provider errors. */
export async function solanaJsonRequest(url: string, body: unknown, { fetchImpl = fetch, signal: parent, headers = {}, timeoutMs = 12_000,
  unavailable = 'solana_payment_rpc_unavailable', maxBytes = 262_144,
}: { fetchImpl?: typeof fetch; signal?: AbortSignal; headers?: Record<string, string>; timeoutMs?: number; unavailable?: string; maxBytes?: number } = {}): Promise<unknown> {
  const controller = new AbortController(), abort = () => controller.abort();
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void } | undefined;
  const cancel = () => { try { void reader?.cancel().catch(() => {}); } catch { /* bounded cleanup */ } };
  controller.signal.addEventListener('abort', cancel, { once: true });
  async function guarded<T>(effect: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: (value: any) => void, value: unknown) => { if (settled) return; settled = true; controller.signal.removeEventListener('abort', stopped); fn(value); };
      const stopped = () => finish(reject, new Error(unavailable));
      if (controller.signal.aborted) return stopped();
      controller.signal.addEventListener('abort', stopped, { once: true });
      Promise.resolve().then(effect).then(value => finish(resolve, value), () => stopped());
    });
  }
  try {
    const response = await guarded(() => fetchImpl(url, { method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
      signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) }));
    const length = response.headers.get('content-length');
    if (!response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')
      || (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))) { void response.body?.cancel().catch(() => {}); throw new Error(unavailable); }
    reader = response.body?.getReader();
    if (!reader) throw new Error(unavailable);
    let raw = '', bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (;;) {
      const part = await guarded(() => reader!.read());
      if (part.done) break;
      if (!part.value) throw new Error(unavailable);
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error(unavailable);
      raw += decoder.decode(part.value, { stream: true });
    }
    if (controller.signal.aborted) throw new Error(unavailable);
    return JSON.parse(raw + decoder.decode());
  } catch { cancel(); if (parent?.aborted) throw new DOMException('Aborted', 'AbortError'); throw new Error(unavailable); }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancel); try { reader?.releaseLock(); } catch { /* settling cancellation */ } }
}
