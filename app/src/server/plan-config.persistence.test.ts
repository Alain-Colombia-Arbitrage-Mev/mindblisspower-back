import { test, expect } from 'bun:test';
import { sql } from 'drizzle-orm';
import { withRollback } from './testdb';
import { getActivePlanConfig, buildDraft, requestPublish, approveAndMaybePublish } from './plan-config';

const RUN = !!process.env.TEST_DATABASE_URL;
const maybe = RUN ? test : test.skip;

maybe('four-eyes publish inserts a new active plan_config version', async () => {
  await withRollback(async (tx) => {
    const active = await getActivePlanConfig(tx as any);
    expect(active).not.toBeNull();

    // two distinct admins
    const a = await tx.execute<{ id: string }>(sql`SELECT id::text FROM mlm.person WHERE is_admin ORDER BY id LIMIT 2`);
    const initiator = BigInt(a[0]!.id);
    const approver = BigInt(a[1]!.id);

    const draft = buildDraft(active as any, { treasury_alpha: '0.47' });
    const sim = { worst_theta: 0.9, solvent: true };
    const approvalId = await requestPublish(tx as any, {
      draft, sim, initiatorPersonId: initiator, reason: 'subir alpha de prueba', versionLabel: 'v2-test',
    });

    // initiator cannot approve own request (try/catch — bun's expect().rejects
    // can stall when the rejecting fn has already awaited a DB query in a txn).
    let threw = false;
    try {
      await approveAndMaybePublish(tx as any, { approvalId, approverPersonId: initiator, reason: 'razon valida' });
    } catch { threw = true; }
    expect(threw).toBe(true);

    // first approval — not executed yet
    const r1 = await approveAndMaybePublish(tx as any, { approvalId, approverPersonId: approver, reason: 'ok firma 1' });
    expect(r1.executed).toBe(false);

    // a third distinct admin as approver 2
    const p2 = await tx.execute<{ id: string }>(sql`
      INSERT INTO mlm.person (first_name,last_name,email,phone_number,status,kyc_status,is_admin)
      VALUES ('Admin','Three','admin3-test@example.com','0','active','not_started',true) RETURNING id::text`);
    const r2 = await approveAndMaybePublish(tx as any, { approvalId, approverPersonId: BigInt(p2[0]!.id), reason: 'ok firma 2' });
    expect(r2.executed).toBe(true);

    const newActive = await getActivePlanConfig(tx as any);
    expect(String((newActive as any).treasury_alpha)).toMatch(/^0\.47/);
    expect((newActive as any).approval_request_id).not.toBeNull();
  });
});
