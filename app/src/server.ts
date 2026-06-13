import { Hono } from 'hono';
import { auth } from './auth';
import { autoPlaceAffiliate, placeAffiliate, postTransaction } from './server/affiliate';
import { requireAdmin } from './server/admin-gate';
import { commandCenterSummary, commandCenterHealth, commandCenterAlerts, commandCenterAckAlert } from './server/command-center';

type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

type Variables = {
  session: Session;
  personIsAdmin?: boolean;
};

const app = new Hono<{ Variables: Variables }>();

// Mount Better Auth — handles /api/auth/* (signup, signin, signout, callbacks)
app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Session middleware
app.use('/api/*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session && !c.req.path.startsWith('/api/auth')) {
    return c.json({ error: 'unauthenticated' }, 401);
  }
  c.set('session', session);
  await next();
});

app.post('/api/affiliate/auto-place', async (c) => {
  const body = await c.req.json();
  const result = await autoPlaceAffiliate({
    personId:           BigInt(body.personId),
    sponsorAffiliateId: BigInt(body.sponsorAffiliateId),
    preferredSide:      body.preferredSide,
  });
  return c.json(result);
});

app.post('/api/affiliate/place', async (c) => {
  const body = await c.req.json();
  const result = await placeAffiliate({
    personId:           BigInt(body.personId),
    parentAffiliateId:  BigInt(body.parentAffiliateId),
    position:           body.position,
    sponsorAffiliateId: BigInt(body.sponsorAffiliateId),
  });
  return c.json(result);
});

app.post('/api/transaction/post', async (c) => {
  const body = await c.req.json();
  const session = c.get('session');
  const result = await postTransaction({
    externalRef: body.externalRef,
    description: body.description,
    initiatedByPersonId: BigInt(body.initiatedByPersonId),
    actor: {
      userId:    session?.user.id,
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? '',
      userAgent: c.req.header('user-agent') ?? '',
    },
    movements: body.movements.map((m: any) => ({
      walletId:    BigInt(m.walletId),
      affiliateId: BigInt(m.affiliateId),
      conceptId:   Number(m.conceptId),
      amount:      String(m.amount),
      reference:   m.reference,
      postedAt:    new Date(m.postedAt),
      availableAt: m.availableAt ? new Date(m.availableAt) : undefined,
    })),
  });
  return c.json({
    txnId: result.txnId,
    wasIdempotentReplay: result.wasIdempotentReplay,
    postedAt: result.postedAt?.toISOString() ?? null,
  });
});

app.get('/api/admin/command-center/summary', requireAdmin, async (c) => {
  const to = c.req.query('to') ?? new Date().toISOString().slice(0, 10);
  const from = c.req.query('from') ?? '2026-01-01';
  return c.json(await commandCenterSummary(from, to));
});

app.get('/api/admin/command-center/health', requireAdmin, async (c) => {
  return c.json(await commandCenterHealth());
});

app.get('/api/admin/command-center/alerts', requireAdmin, async (c) => {
  return c.json(await commandCenterAlerts());
});

app.post('/api/admin/command-center/alerts/:id/ack', requireAdmin, async (c) => {
  const id = c.req.param('id') ?? '';
  const session = c.get('session');
  const { db } = await import('./db/client');
  const { sql } = await import('drizzle-orm');
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id::text FROM mlm.person WHERE user_id = ${session?.user?.id ?? ''} LIMIT 1`);
  if (rows.length === 0) return c.json({ error: 'person_not_found' }, 404);
  return c.json(await commandCenterAckAlert(id, BigInt(String(rows[0]!.id))));
});

app.get('/health', (c) => c.text('ok'));

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
