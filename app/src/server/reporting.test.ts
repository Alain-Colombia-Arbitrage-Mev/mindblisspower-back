import { test, expect } from 'bun:test';
import { sql } from 'drizzle-orm';
import { withRollback } from './testdb';
import { getPeriodKpis, getRankAvalancheCount } from './reporting';

const RUN = !!process.env.TEST_DATABASE_URL;
const maybe = RUN ? test : test.skip;

maybe('getPeriodKpis aggregates inflows, bonus outflows and margin', async () => {
  await withRollback(async (tx) => {
    // Pick deterministically and respect the concept's factor sign (the real
    // package_purchase is factor +1). amount = factor*1000 satisfies the
    // sign-validation trigger; inflows uses ABS so it is 1000 either way.
    const pkg = await tx.execute<{ id: number; factor: number }>(sql`
      SELECT id, factor FROM mlm.concept WHERE kind = 'package_purchase' ORDER BY id LIMIT 1`);
    const conceptId = pkg[0]!.id;
    const factor = Number(pkg[0]!.factor);

    const per = await tx.execute<{ id: string }>(sql`
      INSERT INTO mlm.person (first_name, last_name, email, phone_number, status, kyc_status)
      VALUES ('Test', 'Kpi', 'kpi-test@example.com', '000', 'active', 'not_started') RETURNING id::text`);
    const personId = per[0]!.id;
    const aff = await tx.execute<{ id: string }>(sql`
      INSERT INTO mlm.affiliate (person_id, position, sponsor_id, path, depth, status)
      VALUES (${personId}, NULL, NULL, ''::ltree, 0, 'active') RETURNING id::text`);
    const affId = aff[0]!.id;
    const w = await tx.execute<{ id: string }>(sql`
      INSERT INTO mlm.wallet (affiliate_id, asset_id, address, balance)
      VALUES (${affId}, 1, 'x', 0) RETURNING id::text`);
    const walletId = w[0]!.id;
    const txn = await tx.execute<{ id: string }>(sql`
      INSERT INTO mlm.transaction (description, status) VALUES ('t','posted') RETURNING id::text`);
    const txnId = txn[0]!.id;

    await tx.execute(sql`
      INSERT INTO mlm.wallet_movement
        (transaction_id, wallet_id, affiliate_id, concept_id, amount, posted_at)
      VALUES (${txnId}, ${walletId}, ${affId}, ${conceptId}, ${factor * 1000}, '2026-06-03T12:00:00Z')`);

    await tx.execute(sql`
      INSERT INTO mlm.bonus_run (run_date, kind, total_paid_usd, total_fee_usd)
      VALUES ('2026-06-03', 'binary_bonus', 300, 60)`);

    const k = await getPeriodKpis(tx as any, '2026-06-01', '2026-06-08');
    expect(k.inflows).toBeCloseTo(1000, 2);
    expect(k.bonusOutflows).toBeCloseTo(300, 2);
    expect(k.margin).toBeCloseTo(700, 2);
    expect(k.byKind.find((r) => r.kind === 'binary_bonus')?.paid).toBeCloseTo(300, 2);
  });
});

maybe('getRankAvalancheCount counts affiliates near next rank', async () => {
  await withRollback(async (tx) => {
    await tx.execute(sql`
      INSERT INTO mlm.rank (id, code, name_es, name_en, required_points, display_order)
      VALUES (900, 'TST', 'Test', 'Test', 100, 900)
      ON CONFLICT (id) DO UPDATE SET required_points = EXCLUDED.required_points`);
    // affiliate.person_id is NOT NULL UNIQUE → create a person first.
    // Root nodes (parent_id NULL) require position NULL (check constraint). Both confirmed vs real PG17.
    const per = await tx.execute<{ id: string }>(sql`
      INSERT INTO mlm.person (first_name, last_name, email, phone_number, status, kyc_status)
      VALUES ('Av','Test','aval-s2@example.com','0','active','not_started') RETURNING id::text`);
    await tx.execute(sql`
      INSERT INTO mlm.affiliate (person_id, position, sponsor_id, path, depth, status,
                                 left_pv_lifetime, right_pv_lifetime, rank_points_baseline)
      VALUES (${per[0]!.id}, NULL, NULL, ''::ltree, 0, 'active', 120, 95, 0)`);
    const n = await getRankAvalancheCount(tx as any, 0.9);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});
