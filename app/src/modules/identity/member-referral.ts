import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from './model';

type Database = Pick<IdentityDatabase, 'execute'>;
type Environment = Record<string, string | undefined>;
type Principal = { subject: string; nativeSessionId: string };
type Dependencies = { environment?: Environment; signal?: AbortSignal; timeoutMs?: number; now?: () => number };
const identifier = z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/);
const code = z.string().min(1).max(64).regex(/^[^\s\u0000-\u001f\u007f]+$/u);
const cleanText = (maximum: number) => z.string().max(maximum).regex(/^[^\u0000-\u001f\u007f]*$/);
export const memberReferralCaptureInput = z.object({ ref: z.string().max(64).regex(/^[^\s\u0000-\u001f\u007f]*$/u) }).strict();
const contextInput = z.object({ positioned: z.boolean(), code, name: cleanText(480), placement: z.literal('automatic'), generated: z.boolean(),
  metrics: z.object({ total: z.number().int().min(0).max(1000000000), active: z.number().int().min(0).max(1000000000), pending: z.number().int().min(0).max(1000000000) }).strict(),
  referrals: z.array(z.object({ id: z.string().regex(/^person:[0-9a-f-]{36}$/), name: cleanText(480), status: z.enum(['activo', 'registrado']),
    date: z.string().datetime({ offset: true }) }).strict()).max(50),
  sponsor_name: cleanText(480), sponsor_referral_code: cleanText(64), attribution_source: z.enum(['unassigned', 'existing_affiliate', 'referral', 'company']),
}).strict().refine(value => value.metrics.total >= value.referrals.length && value.metrics.active + value.metrics.pending === value.metrics.total
  && value.referrals.filter(item => item.status === 'activo').length <= value.metrics.active
  && value.referrals.filter(item => item.status === 'registrado').length <= value.metrics.pending
  && new Set(value.referrals.map(item => item.id)).size === value.referrals.length);
const attributionInput = z.object({ ok: z.literal(true), ref: z.union([code, z.literal('')]), preferred_side: z.literal(''),
  positioned: z.boolean(), immutable: z.literal(true) }).strict();
function configuration(environment: Environment) {
  if (environment.MEMBER_REFERRAL_ENABLED !== 'true') throw Error('member_referral_unconfigured');
}
function companyRoot(environment: Environment) {
  const value = environment.REFERRAL_COMPANY_ROOT_AFFILIATE_ID;
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error('member_referral_unconfigured');
  return value;
}
function principal(input: Principal) {
  return { subject: identifier.parse(input.subject), nativeSessionId: identifier.parse(input.nativeSessionId) };
}
async function execute(database: Database, query: SQL, signal?: AbortSignal, timeoutMs = 8000): Promise<unknown[]> {
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(Math.max(timeoutMs, 1), 15000));
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const cancelled = () => { if (settled) return; settled = true; reject(Error('member_referral_unavailable')); };
      if (controller.signal.aborted) { cancelled(); return; }
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => { if (controller.signal.aborted) throw Error('member_referral_unavailable'); return database.execute(query); })
        .then(rows => { if (settled) return; settled = true; controller.signal.removeEventListener('abort', cancelled); resolve(rows); },
          error => { if (settled) return; settled = true; controller.signal.removeEventListener('abort', cancelled); reject(error); });
    });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
const gates = new WeakMap<Database, Map<string, { count: number; reset: number; active: number }>>();
function acquire(database: Database, subject: string, write: boolean, now: number) {
  let entries = gates.get(database); if (!entries) { entries = new Map(); gates.set(database, entries); }
  for (const [key, item] of entries) if (!item.active && item.reset <= now) entries.delete(key);
  const key = `${write ? 'capture' : 'read'}\0${subject}`; let item = entries.get(key);
  if (!Number.isFinite(now) || (item && item.active >= (write ? 1 : 4)) || (item && item.count >= (write ? 10 : 60)) || (!item && entries.size >= 10000)) throw Error('member_referral_rate_limited');
  if (!item) { item = { count: 0, reset: now + (write ? 600000 : 60000), active: 0 }; entries.set(key, item); }
  item.count++; item.active++; let released = false;
  return () => { if (!released) { released = true; item.active--; } };
}
function output<T>(rows: unknown[], schema: z.ZodType<T>, key: string): T {
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') throw Error('member_referral_unavailable');
  const parsed = schema.safeParse((rows[0] as Record<string, unknown>)[key]);
  if (!parsed.success) throw Error('member_referral_unavailable'); return parsed.data;
}
export async function readMemberReferral(database: Database, input: Principal,
  { environment = process.env, signal, timeoutMs, now = Date.now }: Dependencies = {}) {
  configuration(environment); const p = principal(input), release = acquire(database, p.subject, false, now());
  try { return output(await execute(database, sql`SELECT identity.read_member_referral(${p.subject},${p.nativeSessionId}) AS context`, signal, timeoutMs), contextInput, 'context'); }
  finally { release(); }
}
export async function captureMemberReferral(database: Database, raw: unknown, input: Principal,
  { environment = process.env, signal, timeoutMs, now = Date.now }: Dependencies = {}) {
  configuration(environment); const value = memberReferralCaptureInput.parse(raw), root = companyRoot(environment), p = principal(input);
  const release = acquire(database, p.subject, true, now());
  try { return output(await execute(database, sql`SELECT identity.capture_member_referral(
    ${p.subject},${p.nativeSessionId},${value.ref},${root}::bigint) AS attribution`, signal, timeoutMs), attributionInput, 'attribution'); }
  finally { release(); }
}
