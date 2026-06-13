import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

/** Open a test DB, run `fn` inside a transaction, then ALWAYS roll back. */
export async function withRollback(
  fn: (tx: ReturnType<typeof drizzle>) => Promise<void>,
): Promise<void> {
  const url = process.env.TEST_DATABASE_URL!;
  const client = postgres(url, { max: 1 });
  const tdb = drizzle(client);
  try {
    await tdb.transaction(async (tx) => {
      await fn(tx as unknown as ReturnType<typeof drizzle>);
      await tx.execute(sql`SELECT 1`); // ensure tx alive
      throw new RollbackSignal();
    });
  } catch (e) {
    if (!(e instanceof RollbackSignal)) throw e;
  } finally {
    await client.end({ timeout: 5 });
  }
}
class RollbackSignal extends Error {}
