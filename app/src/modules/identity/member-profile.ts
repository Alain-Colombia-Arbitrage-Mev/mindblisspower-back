import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from './model';

type Database = Pick<IdentityDatabase, 'execute'>;
type Environment = Record<string, string | undefined>;
type Principal = { subject: string; nativeSessionId: string };
type Dependencies = { environment?: Environment; signal?: AbortSignal; timeoutMs?: number; now?: () => number };
const identifier = z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/);
const controls = /[\u0000-\u001f\u007f]/;
const cleanName = (value: string) => value.normalize('NFC').trim().replace(/\s+/gu, ' ');
export const memberProfileUpdateInput = z.object({
  name: z.string().max(240).refine(value => !controls.test(value)).transform(cleanName)
    .pipe(z.string().min(1).max(160).regex(/^[\p{L}\p{M} .’'-]+$/u).regex(/\p{L}/u)),
  phone: z.string().max(32).refine(value => !controls.test(value)).transform(value => value.trim())
    .pipe(z.string().regex(/^(?:\+[1-9][0-9]{6,14})?$/)),
  country: z.string().max(2).regex(/^(?:[A-Z]{2})?$/).optional(),
}).strict();
const profileInput = z.object({ first_name: z.string().max(240), last_name: z.string().max(240),
  phone: z.string().max(64), country: z.string().max(120), payout_wallet_usdc: z.string().max(128),
  sponsor_name: z.string().max(480), sponsor_referral_code: z.string().max(128), referral_code: z.string().max(128) });
function configuration(environment: Environment) {
  if (environment.MEMBER_PROFILE_ENABLED !== 'true') throw Error('member_profile_unconfigured');
}
function principal(input: Principal) {
  return { subject: identifier.parse(input.subject), nativeSessionId: identifier.parse(input.nativeSessionId) };
}
function profile(rows: unknown[]) {
  if (rows.length === 0) throw Error('member_profile_not_found');
  const parsed = profileInput.safeParse(rows[0]);
  if (rows.length !== 1 || !parsed.success || Object.values(parsed.data).some(value => controls.test(value))) throw Error('member_profile_unavailable');
  return parsed.data;
}

// A bounded response deadline does not retry an ambiguous write. SQL115 also
// checks the live native session and locks the authoritative owner binding.
async function execute(database: Database, query: SQL, signal?: AbortSignal, timeoutMs = 8000): Promise<unknown[]> {
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(Math.max(timeoutMs, 1), 15000));
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const cancelled = () => { if (settled) return; settled = true; reject(Error('member_profile_unavailable')); };
      if (controller.signal.aborted) { cancelled(); return; }
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw Error('member_profile_unavailable');
        return database.execute(query);
      }).then(rows => { if (settled) return; settled = true; controller.signal.removeEventListener('abort', cancelled); resolve(rows); },
        error => { if (settled) return; settled = true; controller.signal.removeEventListener('abort', cancelled); reject(error); });
    });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
const gates = new WeakMap<Database, Map<string, { count: number; reset: number; active: boolean }>>();
function acquire(database: Database, subject: string, write: boolean, now: number) {
  let map = gates.get(database); if (!map) { map = new Map(); gates.set(database, map); }
  for (const [key, value] of map) if (!value.active && value.reset <= now) map.delete(key);
  const key = `${write ? 'write' : 'read'}\0${subject}`;
  let value = map.get(key);
  if (!Number.isFinite(now) || value?.active || (value && value.count >= (write ? 20 : 60)) || (!value && map.size >= 10000)) throw Error('member_profile_rate_limited');
  if (!value) { value = { count: 0, reset: now + (write ? 600000 : 60000), active: false }; map.set(key, value); }
  value.count++; value.active = true;
  return () => { value.active = false; };
}
export async function readMemberProfile(database: Database, input: Principal,
  { environment = process.env, signal, timeoutMs, now = Date.now }: Dependencies = {}) {
  configuration(environment); const p = principal(input), release = acquire(database, p.subject, false, now());
  try { return profile(await execute(database, sql`SELECT * FROM identity.read_member_profile(${p.subject},${p.nativeSessionId})`, signal, timeoutMs)); }
  finally { release(); }
}
export async function updateMemberProfile(database: Database, raw: unknown, input: Principal,
  { environment = process.env, signal, timeoutMs, now = Date.now }: Dependencies = {}) {
  configuration(environment); const value = memberProfileUpdateInput.parse(raw), p = principal(input);
  const release = acquire(database, p.subject, true, now());
  try {
    const saved = profile(await execute(database, sql`SELECT * FROM identity.update_member_profile(
      ${p.subject},${p.nativeSessionId},${value.name},${value.phone},${value.country ?? null})`, signal, timeoutMs));
    if (cleanName([saved.first_name, saved.last_name].filter(Boolean).join(' ')) !== value.name
      || saved.phone !== value.phone || (value.country !== undefined && saved.country !== value.country)) throw Error('member_profile_outcome_unconfirmed');
    return { ok: true as const, profile: saved };
  } finally { release(); }
}
