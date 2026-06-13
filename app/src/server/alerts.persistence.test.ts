import { test, expect } from 'bun:test';
import { sql } from 'drizzle-orm';
import { withRollback } from './testdb';
import { runAlertEvaluation, listOpenAlerts, DEFAULT_THRESHOLDS } from './alerts';

const RUN = !!process.env.TEST_DATABASE_URL;
const maybe = RUN ? test : test.skip;

maybe('runAlertEvaluation persists an alert and lists it', async () => {
  await withRollback(async (tx) => {
    // Recent bonus_run with large payout and ~zero fund → theta/outflows fire.
    await tx.execute(sql`
      INSERT INTO mlm.bonus_run (run_date, kind, total_paid_usd, total_fee_usd)
      VALUES ('2026-06-07', 'binary_bonus', 100000, 0)`);
    const detected = await runAlertEvaluation(tx as any, DEFAULT_THRESHOLDS);
    expect(detected.some((d) => d.signal === 'theta' || d.signal === 'outflows_vs_fund')).toBe(true);
    const open = await listOpenAlerts(tx as any);
    expect(open.length).toBeGreaterThanOrEqual(1);
  });
});
