/**
 * Affiliate placement & tree mutations.
 *
 * Two distinct concerns:
 *   1. createPersonFromUser  — runs on Better Auth signup. Creates the legal
 *      identity row. Does NOT place the user in the tree.
 *   2. placeAffiliate        — runs when the user accepts sponsorship and
 *      a tree position is chosen. Inserts mlm.affiliate + emits enrollment
 *      event. Lock-ordered by parent path to avoid concurrent placement
 *      races (two recruits placed at the same empty leg simultaneously).
 * Financial commands are owned by modules/ledger and re-exported below for
 * compatibility with existing internal callers.
 */
import { db } from '../db/client';
import { provisionAuthPerson } from '../modules/identity';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
export { postTransaction, registerPvCredit } from '../modules/ledger';

export async function createPersonFromUser(input: {
  userId: string;
  email: string;
  name: string;
}): Promise<void> {
  // Compatibility entry point: authoritative verification and binding come from
  // PostgreSQL, never the email/name supplied by an internal caller.
  await provisionAuthPerson(db, { userId: input.userId });
}

const PlacementSchema = z.object({
  personId: z.bigint(),
  parentAffiliateId: z.bigint(),
  position: z.enum(['L', 'R']),
  sponsorAffiliateId: z.bigint(),
});

/**
 * Place an affiliate under (parent, position). Race-safe: takes a row lock
 * on the parent first, then re-reads to verify the leg is still empty.
 */
export async function placeAffiliate(input: z.infer<typeof PlacementSchema>) {
  const v = PlacementSchema.parse(input);

  return await db.transaction(async (tx) => {
    // Lock the parent row to serialize concurrent placements under the same parent.
    const parent = await tx.execute(sql`
      SELECT id, path, depth FROM mlm.affiliate
       WHERE id = ${v.parentAffiliateId}
       FOR UPDATE
    `);
    if (parent.length === 0) throw new Error('parent_not_found');

    // Verify leg still empty.
    const occupied = await tx.execute(sql`
      SELECT 1 FROM mlm.affiliate
       WHERE parent_id = ${v.parentAffiliateId} AND position = ${v.position}
       LIMIT 1
    `);
    if (occupied.length > 0) throw new Error('leg_already_occupied');

    // Insert affiliate. The fn_compute_affiliate_path trigger fills path/depth.
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO mlm.affiliate (
        person_id, parent_id, position, sponsor_id, path, depth, status
      ) VALUES (
        ${v.personId}, ${v.parentAffiliateId}, ${v.position}, ${v.sponsorAffiliateId},
        ''::ltree, 0, 'active'
      ) RETURNING id
    `);
    const affiliateId = inserted[0]!.id;

    // Emit enrollment event — trigger fan-out to ancestors.
    await tx.execute(sql`
      INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id, occurred_at)
      VALUES (${'enroll:' + affiliateId}, 'enrollment', ${affiliateId}, now())
    `);

    return { affiliateId };
  });
}

const AutoPlacementSchema = z.object({
  personId: z.bigint(),
  sponsorAffiliateId: z.bigint(),
  /** Tie-break side when both legs have equal PV. Defaults to 'L'. */
  preferredSide: z.enum(['L', 'R']).optional(),
});

type AffiliateRow = {
  id: string;
  left_pv_current: string;
  right_pv_current: string;
  left_count: string;
  right_count: string;
  [key: string]: unknown;
};

/**
 * Find the next empty leg under sponsor following the weak-leg rule, then
 * insert the new affiliate there. Race-safe via pg_advisory_xact_lock on the
 * sponsor: two concurrent auto-placements under the same sponsor serialize.
 *
 * Algorithm:
 *   - sponsor.weakLeg() is the side with lower PV (tie → preferredSide ?? 'L').
 *   - Walk down that side. At each node, again pick its own weakLeg until we
 *     find a node where the chosen side is empty; place there.
 *
 * This is the "weak-leg auto-placement" pattern: it tends to balance the tree
 * and gives downlines to the under-developed leg, which is desirable both for
 * affiliate fairness and for the binary plan's matching mechanics.
 */
export async function autoPlaceAffiliate(input: z.infer<typeof AutoPlacementSchema>) {
  const v = AutoPlacementSchema.parse(input);
  const preferred = v.preferredSide ?? 'L';

  return await db.transaction(async (tx) => {
    // Advisory lock per-sponsor: prevents two concurrent placements from
    // descending the same subtree and colliding on the same empty leaf.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${v.sponsorAffiliateId})`);

    const weakerOf = (n: AffiliateRow): 'L' | 'R' => {
      const lp = Number(n.left_pv_current);
      const rp = Number(n.right_pv_current);
      if (lp < rp) return 'L';
      if (rp < lp) return 'R';
      // Tie-break on count then on preferred.
      const lc = BigInt(n.left_count);
      const rc = BigInt(n.right_count);
      if (lc < rc) return 'L';
      if (rc < lc) return 'R';
      return preferred;
    };

    // Walk: start at sponsor, descend via weak leg until we find an empty slot.
    let currentId = v.sponsorAffiliateId;
    let chosenSide: 'L' | 'R' = preferred;
    let safety = 64; // depth-cap guard

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (safety-- <= 0) throw new Error('auto_place_depth_exceeded');

      const rows = await tx.execute<AffiliateRow>(sql`
        SELECT id::text,
               left_pv_current::text,
               right_pv_current::text,
               left_count::text,
               right_count::text
          FROM mlm.affiliate
         WHERE id = ${currentId}
         FOR UPDATE
      `);
      if (rows.length === 0) throw new Error('node_not_found');
      const node = rows[0]!;

      chosenSide = weakerOf(node);

      // Is the chosen leg of `current` occupied?
      const child = await tx.execute<{ id: string }>(sql`
        SELECT id::text
          FROM mlm.affiliate
         WHERE parent_id = ${currentId} AND position = ${chosenSide}
         LIMIT 1
      `);

      if (child.length === 0) break;       // found empty slot
      currentId = BigInt(child[0]!.id);    // descend
    }

    // Insert at (currentId, chosenSide). The fn_compute_affiliate_path trigger
    // fills path/depth from parent.
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO mlm.affiliate (
        person_id, parent_id, position, sponsor_id, path, depth, status
      ) VALUES (
        ${v.personId}, ${currentId}, ${chosenSide}, ${v.sponsorAffiliateId},
        ''::ltree, 0, 'active'
      ) RETURNING id::text
    `);
    const affiliateId = inserted[0]!.id;

    await tx.execute(sql`
      INSERT INTO mlm.tree_event (external_ref, kind, affiliate_id, occurred_at)
      VALUES (${'enroll:' + affiliateId}, 'enrollment', ${affiliateId}, now())
    `);

    return { affiliateId, parentAffiliateId: currentId.toString(), position: chosenSide };
  });
}
