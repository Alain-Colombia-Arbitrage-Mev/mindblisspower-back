import { z } from 'zod';
import { readAdministrativeWallet } from '../modules/identity/administrative-wallet';
import { readAdministrativeOfframpOptions } from '../modules/payments/administrative-offramp-discovery';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiApplication } from './types';

const path = '/api/member/wallet-funding/administrative/offramp/options';
const noStore = { 'Cache-Control': 'private, no-store' };
const queryInput = z.object({ country: z.enum(['US', 'MX', 'CO']), destinationCurrencyCode: z.enum(['USD', 'MXN', 'COP']) }).strict()
  .refine(value => value.destinationCurrencyCode === 'USD' || (value.country === 'MX' && value.destinationCurrencyCode === 'MXN')
    || (value.country === 'CO' && value.destinationCurrencyCode === 'COP'));

/** Catalog reads never grant permission to spend from an assigned address. */
export function registerAdministrativeOfframpRoutes(app: ApiApplication, { database, environment = process.env, fetchImpl = fetch }: {
  database: Pick<IdentityDatabase, 'execute'>; environment?: Record<string, string | undefined>; fetchImpl?: typeof fetch;
}) {
  const budgets = new Map<string, { count: number; reset: number; active: boolean }>();
  app.get(path, async context => {
    const subject = context.get('session')?.user.id;
    if (!subject) return context.json({ error: 'unauthenticated' }, 401, noStore);
    if (context.req.raw.headers.has('x-vp-act-as')) return context.json({ error: 'invalid_request' }, 403, noStore);
    if (context.req.header('origin') !== 'https://wallet.mindblisspower.com') return context.json({ error: 'invalid_origin' }, 403, noStore);
    if (environment.MELD_ADMIN_SANDBOX_ENABLED !== 'true') return context.json({ error: 'offramp_unconfigured' }, 503, noStore);
    let input: z.infer<typeof queryInput>;
    try {
      const query = new URL(context.req.url).searchParams;
      if (query.getAll('country').length !== 1 || query.getAll('destinationCurrencyCode').length !== 1
        || [...query.keys()].some(name => !['country', 'destinationCurrencyCode'].includes(name))) throw Error('invalid_request');
      input = queryInput.parse(Object.fromEntries(query));
    } catch { return context.json({ error: 'invalid_request' }, 400, noStore); }
    const now = Date.now();
    for (const [key, budget] of budgets) if (!budget.active && budget.reset <= now) budgets.delete(key);
    let budget = budgets.get(subject);
    if (budget?.active || (budget && budget.count >= 30) || (!budget && budgets.size >= 10_000)) {
      return context.json({ error: 'offramp_rate_limited' }, 429, noStore);
    }
    if (!budget) { budget = { count: 0, reset: now + 600_000, active: false }; budgets.set(subject, budget); }
    budget.active = true; budget.count++;
    try {
      const wallet = await readAdministrativeWallet(database, { userId: subject });
      if (wallet.status !== 'assigned') return context.json({ error: 'administrative_wallet_unavailable' }, 409, noStore);
      return context.json(await readAdministrativeOfframpOptions(input, { environment, fetchImpl, signal: context.req.raw.signal }), 200, noStore);
    } catch (error) {
      if (error instanceof z.ZodError) return context.json({ error: 'invalid_request' }, 400, noStore);
      return context.json({ error: error instanceof Error && error.message === 'offramp_unconfigured' ? 'offramp_unconfigured' : 'offramp_provider_unavailable' }, 503, noStore);
    } finally { budget.active = false; }
  });
}
