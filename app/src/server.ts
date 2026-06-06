import { Hono } from 'hono';
import { auth } from './auth';
import { autoPlaceAffiliate, placeAffiliate, postTransaction } from './server/affiliate';

type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

type Variables = {
  session: Session;
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

app.get('/health', (c) => c.text('ok'));

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
