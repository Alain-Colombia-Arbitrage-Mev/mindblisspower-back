// Pseudonymous support telemetry only. No address, OTP, cookie, credential,
// provider ID, free text or client-selected destination is accepted here.
export const AUTH_TRACE_RETENTION_MS = 14 * 86400_000;
export const AUTH_TRACE_CAPACITY = 10_000;
export const AUTH_TRACE_LIMIT = 20;
export const AUTH_TRACE_STAGES = Object.freeze(['requested', 'blocked', 'throttled', 'registration_required',
  'send_accepted', 'send_rejected', 'send_unknown', 'validation_succeeded', 'validation_failed', 'request_failed']);
export const AUTH_TRACE_PURPOSES = Object.freeze(['sign-in', 'email-verification', 'password-reset']);
export const DELIVERY_EVENT_TYPES = Object.freeze(['email.sent', 'email.delivered', 'email.delivery_delayed',
  'email.bounced', 'email.complained', 'email.failed', 'email.suppressed']);
const PREFIX = 'auth-trace:v1:';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HMAC = /^[a-f0-9]{64}$/;
const validRef = value => typeof value === 'string' && HMAC.test(value);
const validId = value => typeof value === 'string' && UUID.test(value);
const iso = value => new Date(value).toISOString();
const numberKey = value => String(value).padStart(16, '0');
const reversed = value => numberKey(8640000000000000 - value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed, required) => record(value) && Object.keys(value).every(key => allowed.includes(key))
  && required.every(key => Object.hasOwn(value, key));
const time = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
  && iso(Date.parse(value)) === value ? Date.parse(value) : NaN;
const list = (storage, prefix, limit, end = `${prefix}\uffff`) => storage.list({ prefix, end, limit });
export const authTraceEnabled = env => ['production', 'staging'].includes(env.CORE_ENV) && env.CORE_AUTH_TRACE_ENABLED === 'true';

export function validAuthTrace(value, now = Date.now()) {
  return keys(value, ['version', 'id', 'request_id', 'occurred_at', 'recipient_ref', 'purpose', 'stage', 'message_ref', 'http_status'],
    ['version', 'id', 'request_id', 'occurred_at', 'recipient_ref', 'purpose', 'stage'])
    && value.version === 1 && validId(value.id) && validId(value.request_id) && validRef(value.recipient_ref)
    && AUTH_TRACE_PURPOSES.includes(value.purpose) && AUTH_TRACE_STAGES.includes(value.stage)
    && Math.abs(time(value.occurred_at) - now) <= 10 * 60_000
    && (value.message_ref === undefined || validRef(value.message_ref))
    && (value.http_status === undefined || (Number.isInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599));
}

export function validDeliveryTrace(value, now = Date.now()) {
  return keys(value, ['version', 'id', 'occurred_at', 'event_type', 'message_ref'], ['version', 'id', 'occurred_at', 'event_type', 'message_ref'])
    && value.version === 1 && validRef(value.id) && validRef(value.message_ref) && DELIVERY_EVENT_TYPES.includes(value.event_type)
    && time(value.occurred_at) > now - AUTH_TRACE_RETENTION_MS && time(value.occurred_at) <= now + 60_000;
}

export function validTraceSelector(value) {
  return keys(value, ['recipient_ref'], ['recipient_ref']) && validRef(value.recipient_ref);
}

export function emptyAuthTrace(enabled = false) {
  return { version: 1, enabled, coverage: { started_at: null, retained_since: null, retention_days: 14, limited: false }, events: [] };
}

async function removeEvent(tx, key, meta) {
  const value = await tx.get(key);
  if (!value) return;
  await tx.delete([key, ...value.indexes]);
  if (value.mapping_key) {
    const mapping = await tx.get(value.mapping_key);
    if (mapping?.source_key === key) await tx.delete(value.mapping_key);
  }
  meta.count = Math.max(0, meta.count - 1);
}

async function pruneInTransaction(tx, meta, now, limit = 32) {
  const prefix = `${PREFIX}event:`;
  const expired = await list(tx, prefix, limit, `${prefix}${numberKey(now)}:\uffff`);
  for (const key of expired.keys()) await removeEvent(tx, key, meta);
}

export async function pruneAuthTraces(storage, now = Date.now()) {
  await storage.transaction(async tx => {
    const meta = await tx.get(`${PREFIX}meta`);
    if (!meta) return;
    await pruneInTransaction(tx, meta, now);
    await tx.put(`${PREFIX}meta`, meta);
    for (const [prefix, cutoff] of [[`${PREFIX}delivery-count:day:`, iso(now - AUTH_TRACE_RETENTION_MS).slice(0, 10)],
      [`${PREFIX}delivery-count:month:`, iso(now - 62 * 86400_000).slice(0, 7)],
      [`${PREFIX}delivery-count:recent:`, String(Math.floor((now - 86400_000) / 300_000))],
      [`${PREFIX}auth-count:recent:`, String(Math.floor((now - 86400_000) / 300_000))]]) {
      const old = await list(tx, prefix, 32, `${prefix}${cutoff}`);
      if (old.size) await tx.delete([...old.keys()]);
    }
  });
}

function recipientIndex(ref, at, kind, id) {
  return `${PREFIX}recipient:${ref}:${reversed(at)}:${kind}:${id}`;
}

async function attachPendingDeliveries(tx, mapping, messageRef, now) {
  // Only the newest twenty can enter a twenty-item support timeline. Older
  // unmatched callbacks remain counted but are never scanned without a bound.
  const pending = await list(tx, `${PREFIX}message-events:${messageRef}:`, AUTH_TRACE_LIMIT);
  for (const key of pending.values()) {
    const row = await tx.get(key);
    if (!row || row.expires_at <= now || row.recipient_ref) continue;
    const index = recipientIndex(mapping.recipient_ref, time(row.event.occurred_at), 'delivery', row.event.id);
    row.recipient_ref = mapping.recipient_ref;
    row.indexes.push(index);
    await tx.put(index, key);
    await tx.put(key, row);
  }
}

const countFields = { 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.delivery_delayed': 'delayed',
  'email.failed': 'failed', 'email.complained': 'complained', 'email.suppressed': 'suppressed' };
const zeroDelivery = () => ({ delivered: 0, bounced: 0, delayed: 0, failed: 0, complained: 0, suppressed: 0 });

async function countAuth(tx, row, key) {
  const event = row.event;
  const countKey = `${PREFIX}auth-count:recent:${Math.floor(time(event.occurred_at) / 300_000)}`;
  const count = await tx.get(countKey) || { attempted: 0, accepted: 0, failed: 0, unknown: 0, throttled: 0 };
  if (event.stage === 'requested') count.attempted++;
  if (event.stage === 'send_accepted') count.accepted = (count.accepted || 0) + 1;
  const failure = ['send_rejected', 'send_unknown', 'request_failed', 'throttled'].includes(event.stage);
  if (failure) {
    const marker = `${PREFIX}auth-failure:${event.request_id}`;
    const prior = await tx.get(marker);
    const throttled = event.stage === 'throttled' || event.http_status === 429;
    if (!prior) {
      count[event.stage === 'send_unknown' ? 'unknown' : 'failed']++;
      row.indexes.push(marker);
    }
    if (throttled && !prior?.throttled) count.throttled++;
    await tx.put(marker, { throttled: Boolean(throttled || prior?.throttled) });
  }
  await tx.put(countKey, count);
}

async function countDelivery(tx, row, key, now) {
  const event = row.event;
  // A provider may issue more than one notification ID for the same message
  // state. Count the state only once; arrival order never decreases a counter.
  const marker = `${PREFIX}delivery-state:${event.message_ref}:${event.event_type}`;
  if (await tx.get(marker)) return;
  row.indexes.push(marker);
  await tx.put(marker, key);
  if (!await tx.get(`${PREFIX}delivery-start`)) await tx.put(`${PREFIX}delivery-start`, iso(now));
  const day = event.occurred_at.slice(0, 10);
  const field = countFields[event.event_type];
  if (!field) return;
  for (const period of [`day:${day}`, `month:${day.slice(0, 7)}`, `recent:${Math.floor(time(event.occurred_at) / 300_000)}`]) {
    const countKey = `${PREFIX}delivery-count:${period}`;
    const count = await tx.get(countKey) || zeroDelivery();
    count[field]++;
    await tx.put(countKey, count);
  }
}

/** Called only after envelope authentication and strict schema validation. */
export async function recordAuthTelemetry(storage, kind, event, now = Date.now(), capacity = AUTH_TRACE_CAPACITY) {
  if (!['auth', 'delivery'].includes(kind) || !(kind === 'auth' ? validAuthTrace(event, now) : validDeliveryTrace(event, now))
    || !Number.isInteger(capacity) || capacity < 1 || capacity > AUTH_TRACE_CAPACITY) throw new Error('invalid_auth_telemetry');
  await storage.transaction(async tx => {
    const seen = `${PREFIX}seen:${kind}:${event.id}`;
    const existing = await tx.get(seen);
    if (existing) return;
    const meta = await tx.get(`${PREFIX}meta`) || { started_at: iso(now), count: 0, limited_until: 0 };
    await pruneInTransaction(tx, meta, now);
    if (meta.count >= capacity) {
      const oldest = await list(tx, `${PREFIX}event:`, 1);
      for (const key of oldest.keys()) await removeEvent(tx, key, meta);
      // Once deduplication history is truncated, aggregate counts no longer
      // claim completeness. This prevents a replay after eviction inflating a
      // supposedly authoritative local delivery count.
      meta.limited_until = now + AUTH_TRACE_RETENTION_MS;
    }
    const occurred = time(event.occurred_at);
    const key = `${PREFIX}event:${numberKey(occurred + AUTH_TRACE_RETENTION_MS)}:${kind}:${event.id}`;
    const row = { kind, event: structuredClone(event), expires_at: occurred + AUTH_TRACE_RETENTION_MS, indexes: [seen] };
    await tx.put(seen, key);
    if (kind === 'auth') {
      row.recipient_ref = event.recipient_ref;
      const index = recipientIndex(event.recipient_ref, occurred, kind, event.id);
      row.indexes.push(index); await tx.put(index, key);
      await countAuth(tx, row, key);
      if (event.message_ref) {
        const mappingKey = `${PREFIX}mapping:${event.message_ref}`;
        const prior = await tx.get(mappingKey);
        if (prior && prior.expires_at > now && (prior.recipient_ref !== event.recipient_ref || prior.request_id !== event.request_id)) {
          throw new Error('auth_trace_mapping_collision');
        }
        const mapping = prior?.expires_at > now ? prior : { recipient_ref: event.recipient_ref,
          request_id: event.request_id, purpose: event.purpose, expires_at: row.expires_at, source_key: key };
        if (!prior || prior.expires_at <= now) {
          row.mapping_key = mappingKey;
          await tx.put(mappingKey, mapping);
        }
        await attachPendingDeliveries(tx, mapping, event.message_ref, now);
      }
    } else {
      const mapping = await tx.get(`${PREFIX}mapping:${event.message_ref}`);
      if (mapping?.expires_at > now) {
        row.recipient_ref = mapping.recipient_ref;
        const index = recipientIndex(mapping.recipient_ref, occurred, kind, event.id);
        row.indexes.push(index); await tx.put(index, key);
      }
      const index = `${PREFIX}message-events:${event.message_ref}:${reversed(occurred)}:${event.id}`;
      row.indexes.push(index); await tx.put(index, key);
      await countDelivery(tx, row, key, now);
    }
    await tx.put(key, row);
    meta.count++;
    await tx.put(`${PREFIX}meta`, meta);
  });
}

export async function readAuthTrace(storage, selector, now = Date.now()) {
  if (!validTraceSelector(selector)) throw new Error('invalid_trace_selector');
  await pruneAuthTraces(storage, now);
  const meta = await storage.get(`${PREFIX}meta`);
  const result = emptyAuthTrace(true);
  if (!meta) return result;
  result.coverage = { started_at: meta.started_at,
    retained_since: iso(Math.max(Date.parse(meta.started_at), now - AUTH_TRACE_RETENTION_MS)), retention_days: 14,
    limited: meta.limited_until > now };
  const entries = await list(storage, `${PREFIX}recipient:${selector.recipient_ref}:`, AUTH_TRACE_LIMIT);
  for (const key of entries.values()) {
    const row = await storage.get(key);
    if (!row || row.expires_at <= now || row.recipient_ref !== selector.recipient_ref) continue;
    const event = row.event;
    result.events.push(row.kind === 'auth' ? { kind: 'auth', occurred_at: event.occurred_at, purpose: event.purpose,
      stage: event.stage, ...(event.http_status === undefined ? {} : { http_status: event.http_status }) }
      : { kind: 'delivery', occurred_at: event.occurred_at, event_type: event.event_type });
  }
  return result;
}

export async function localDeliveryCounts(storage, period, now = Date.now()) {
  const started = await storage.get(`${PREFIX}delivery-start`);
  const meta = await storage.get(`${PREFIX}meta`);
  const available = Boolean(started) && !(meta?.limited_until > now);
  const key = period === 'day' ? `day:${iso(now).slice(0, 10)}` : `month:${iso(now).slice(0, 7)}`;
  const count = available ? await storage.get(`${PREFIX}delivery-count:${key}`) || zeroDelivery() : null;
  return { delivered: count?.delivered ?? null, bounced: count?.bounced ?? null,
    delayed: count?.delayed ?? null, failed: count?.failed ?? null,
    delivery_tracking_started_at: started || null, delivery_coverage_limited: meta?.limited_until > now };
}

export async function localAuthFailures(storage, now = Date.now()) {
  const meta = await storage.get(`${PREFIX}meta`);
  const result = { available: Boolean(meta) && !(meta.limited_until > now), attempted: 0, accepted: 0, failed: 0, unknown: 0,
    throttled: 0, delivery_failures: 0 };
  if (!result.available) return result;
  const bucket = Math.floor(now / 300_000);
  for (let offset = 0; offset < 3; offset++) {
    const count = await storage.get(`${PREFIX}auth-count:recent:${bucket - offset}`);
    for (const field of ['attempted', 'accepted', 'failed', 'unknown', 'throttled']) result[field] += count?.[field] || 0;
    const callbacks = await storage.get(`${PREFIX}delivery-count:recent:${bucket - offset}`);
    result.delivery_failures += (callbacks?.bounced || 0) + (callbacks?.failed || 0) + (callbacks?.suppressed || 0) + (callbacks?.complained || 0);
  }
  return result;
}
