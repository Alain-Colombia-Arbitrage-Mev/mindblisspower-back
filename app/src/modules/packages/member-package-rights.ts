import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';

type Database = Pick<IdentityDatabase, 'execute'>;
type Principal = { subject: string; nativeSessionId: string };
type Dependencies = { environment?: Record<string, string | undefined>; signal?: AbortSignal; timeoutMs?: number; now?: () => number };
const principal = z.object({ subject: z.string().min(1).max(255).regex(/^[^\u0000-\u0020\u007f]+$/),
  nativeSessionId: z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict();
const timestamp = z.string().datetime({ offset: true });
const item = z.object({ id: z.string().uuid(), packageName: z.string().min(1).max(240).regex(/^[^\u0000-\u001f\u007f]+$/),
  sourcePackageId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  packageBaseUsd: z.string().regex(/^(?:0|[1-9][0-9]{0,13})\.[0-9]{2}$/).refine(value => value !== '0.00'), boughtAt: timestamp, recognizedAt: timestamp,
  status: z.enum(['active', 'suspended', 'revoked', 'review_required']),
  term: z.object({ type: z.literal('until_revoked'), startsAt: timestamp, endsAt: z.null() }).strict(), source: z.literal('stripe_import'),
}).strict().refine(value => value.term.startsAt === value.recognizedAt);
const projection = z.object({ rightsOnly: z.literal(true), economicActivation: z.literal(false), roiEnabled: z.literal(false),
  commissionsEnabled: z.literal(false), policy: z.literal('historical_membership_access_until_revoked_v1'),
  totalCount: z.number().int().min(0).max(733), activeCount: z.number().int().min(0).max(733), items: z.array(item).max(100),
}).strict().refine(value => value.totalCount >= value.items.length && value.activeCount <= value.totalCount
  && value.activeCount >= value.items.filter(row => row.status === 'active').length
  && value.totalCount - value.activeCount >= value.items.filter(row => row.status !== 'active').length
  && new Set(value.items.map(row => row.id)).size === value.items.length);
const gates = new WeakMap<Database, Map<string, { count: number; active: number; reset: number }>>();
function acquire(database: Database, subject: string, now: number) {
  let map = gates.get(database); if (!map) { map = new Map(); gates.set(database, map); }
  for (const [key, value] of map) if (!value.active && value.reset <= now) map.delete(key);
  let entry = map.get(subject);
  if (!Number.isFinite(now) || (entry && (entry.active >= 4 || entry.count >= 60)) || (!entry && map.size >= 10000)) throw Error('member_package_rights_rate_limited');
  if (!entry) { entry = { count: 0, active: 0, reset: now + 60000 }; map.set(subject, entry); }
  entry.active++; entry.count++; let released = false;
  return () => { if (!released) { released = true; entry.active--; } };
}

/** A read-only rights projection. This module cannot recognize or revoke a sale,
 * create an operational package or make any money/commission available. */
export async function readMemberPackageRights(database: Database, input: Principal,
  { environment = process.env, signal, timeoutMs = 8000, now = Date.now }: Dependencies = {}) {
  if (environment.MEMBER_PACKAGE_RIGHTS_ENABLED !== 'true') throw Error('member_package_rights_unconfigured');
  const p = principal.parse(input), release = acquire(database, p.subject, now());
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(Math.max(timeoutMs, 1), 15000));
  try {
    const rows: unknown[] = await new Promise((resolve, reject) => {
      let settled = false;
      const cancelled = () => { if (settled) return; settled = true; reject(Error('member_package_rights_unavailable')); };
      if (controller.signal.aborted) { cancelled(); return; }
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw Error('member_package_rights_unavailable');
        return database.execute(sql`SELECT payments.read_member_package_rights(${p.subject},${p.nativeSessionId}) AS rights`);
      }).then(value => { if (settled) return; settled = true; controller.signal.removeEventListener('abort', cancelled); resolve(value); },
        error => { if (settled) return; settled = true; controller.signal.removeEventListener('abort', cancelled); reject(error); });
    });
    const parsed = projection.safeParse(rows.length === 1 && rows[0] && typeof rows[0] === 'object' ? (rows[0] as Record<string, unknown>).rights : null);
    if (!parsed.success) throw Error('member_package_rights_unavailable'); return parsed.data;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); release(); }
}
