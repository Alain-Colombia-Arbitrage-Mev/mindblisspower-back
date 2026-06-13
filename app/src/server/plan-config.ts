import { sql } from 'drizzle-orm';
import type { DB } from '../db/client';

type Executor = Pick<DB, 'execute'>;

// All plan params are editable EXCEPT these managed/structural columns.
export const NON_EDITABLE_FIELDS = [
  'id', 'version_label', 'effective_from', 'effective_to',
  'created_by_person_id', 'approval_request_id', 'created_at', 'notes',
] as const;

// Fields that are legitimately non-numeric text (everything else must be numeric).
const TEXT_FIELDS = new Set(['pause_mode']);

export type Overrides = Record<string, string>;

export function isEditable(field: string): boolean {
  return !(NON_EDITABLE_FIELDS as readonly string[]).includes(field);
}

/** Accept any editable key; values must be numeric unless the field is text. Throws otherwise. */
export function validateOverrides(o: Overrides): Overrides {
  const out: Overrides = {};
  for (const [k, v] of Object.entries(o)) {
    if (!isEditable(k)) throw new Error(`field_not_editable:${k}`);
    if (!TEXT_FIELDS.has(k) && (v === null || v === undefined || v === '' || Number.isNaN(Number(v)))) {
      throw new Error(`invalid_value:${k}`);
    }
    out[k] = String(v);
  }
  return out;
}

/** Merge validated overrides over the active row → full proposed config (strings). */
export function buildDraft(active: Record<string, unknown>, overrides: Overrides): Record<string, string> {
  const valid = validateOverrides(overrides);
  const draft: Record<string, string> = {};
  for (const [k, v] of Object.entries(active)) draft[k] = v === null ? '' : String(v);
  for (const [k, v] of Object.entries(valid)) draft[k] = v;
  return draft;
}

export type SimResult = { worst_theta: number; solvent: boolean; margin?: number };

/** Candados: a publish is only allowed if the sim is solvent and above the theta floor. */
export function candadosPass(sim: SimResult, thetaFloor: number): boolean {
  return sim.solvent === true && sim.worst_theta >= thetaFloor;
}

export const THETA_FLOOR = Number(process.env.PUBLISH_THETA_FLOOR ?? 0.85);

// ---------------------------------------------------------------------------
// DB functions — require an Executor (drizzle db or tx)
// ---------------------------------------------------------------------------

export async function getActivePlanConfig(q: Executor): Promise<Record<string, unknown> | null> {
  const rows = await q.execute<Record<string, unknown>>(sql`
    SELECT * FROM mlm.plan_config
     WHERE effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
     ORDER BY effective_from DESC LIMIT 1`);
  return rows[0] ?? null;
}

export async function listPlanConfigVersions(q: Executor) {
  return await q.execute(sql`
    SELECT id::text, version_label, effective_from::text, effective_to::text,
           created_by_person_id::text, approval_request_id::text
      FROM mlm.plan_config ORDER BY effective_from DESC`);
}

/** Create the four-eyes request. draft+sim live in payload. requires_n_approvers=2. */
export async function requestPublish(q: Executor, args: {
  draft: Record<string, string>; sim: SimResult; initiatorPersonId: bigint; reason: string; versionLabel: string;
}): Promise<string> {
  if (!candadosPass(args.sim, THETA_FLOOR)) throw new Error('candados_failed');
  if (args.reason.length < 10) throw new Error('reason_too_short');
  const payload = JSON.stringify({ draft: args.draft, sim: args.sim, version_label: args.versionLabel });
  const rows = await q.execute<{ id: string }>(sql`
    INSERT INTO mlm.approval_request
      (operation_type, payload, requires_n_approvers, status, initiator_person_id, initiator_reason)
    VALUES ('plan_config_publish', ${payload}::jsonb, 2, 'pending', ${args.initiatorPersonId}, ${args.reason})
    RETURNING id::text`);
  return rows[0]!.id;
}

/** Second signer. On the 2nd DISTINCT approval, publish atomically. */
export async function approveAndMaybePublish(q: Executor, args: {
  approvalId: string; approverPersonId: bigint; reason: string;
}): Promise<{ executed: boolean }> {
  const reqRows = await q.execute<{
    id: string; status: string; initiator_person_id: string;
    approver_1_person_id: string | null; payload: { draft: Record<string, string>; version_label: string };
  }>(sql`
    SELECT id::text, status, initiator_person_id::text, approver_1_person_id::text, payload
      FROM mlm.approval_request WHERE id = ${args.approvalId} FOR UPDATE`);
  const req = reqRows[0];
  if (!req) throw new Error('approval_not_found');
  if (req.status !== 'pending') throw new Error('approval_not_pending');
  if (String(args.approverPersonId) === req.initiator_person_id) throw new Error('approver_is_initiator');

  if (!req.approver_1_person_id) {
    await q.execute(sql`
      UPDATE mlm.approval_request
         SET approver_1_person_id=${args.approverPersonId}, approver_1_at=now(), approver_1_reason=${args.reason}
       WHERE id=${args.approvalId}`);
    return { executed: false };
  }
  if (req.approver_1_person_id === String(args.approverPersonId)) throw new Error('duplicate_approver');

  // 2nd distinct approval. Set status='approved' FIRST: the DB trigger
  // mlm.fn_enforce_plan_config_approval() (ADR-0010 defense-in-depth) rejects a
  // plan_config insert unless its approval_request is in status='approved'.
  await q.execute(sql`
    UPDATE mlm.approval_request
       SET approver_2_person_id=${args.approverPersonId}, approver_2_at=now(), approver_2_reason=${args.reason},
           status='approved'
     WHERE id=${args.approvalId}`);

  const draft = req.payload.draft;
  const label = req.payload.version_label;

  // The DB trigger trg_enforce_plan_config_approval fires BEFORE INSERT OR UPDATE.
  // Closing the previous (possibly genesis) row — whose approval_request_id is
  // legitimately NULL — would trip it. vp-api IS the four-eyes authority here
  // (two distinct approvers verified above), so use the trigger's documented
  // bypass for these app-authorized writes. REQUIRES q to be a transaction
  // (SET LOCAL is txn-scoped) — the endpoint wraps this call in db.transaction.
  await q.execute(sql`SET LOCAL app.bypass_approval = 'on'`);
  await q.execute(sql`
    UPDATE mlm.plan_config SET effective_to = now()
     WHERE effective_from <= now() AND (effective_to IS NULL OR effective_to > now())`);
  await insertPlanConfigRow(q, draft, label, args.approverPersonId, args.approvalId);
  await q.execute(sql`SET LOCAL app.bypass_approval = 'off'`);

  // Mark the request carried out (distinct from merely approved).
  await q.execute(sql`UPDATE mlm.approval_request SET status='executed' WHERE id=${args.approvalId}`);
  return { executed: true };
}

// Columns that insertPlanConfigRow always handles explicitly; never taken from draft.
const MANAGED = new Set([
  'id', 'created_at', 'effective_from', 'effective_to',
  'version_label', 'created_by_person_id', 'approval_request_id', 'notes',
]);

async function insertPlanConfigRow(
  q: Executor,
  draft: Record<string, string>,
  label: string,
  personId: bigint,
  approvalId: string,
): Promise<void> {
  const dataKeys = Object.keys(draft).filter((k) => !MANAGED.has(k));

  // Sanitize identifiers: strip any double-quote characters (column names come
  // from the DB itself so this is defence-in-depth only — no user input reaches here).
  const cols = dataKeys.map((k) => sql.raw(`"${k.replace(/"/g, '')}"`));

  // Parameterise values; treat empty-string / null / undefined as SQL NULL so
  // nullable columns (text, numeric) don't receive a spurious empty string.
  const vals = dataKeys.map((k) => {
    const v = draft[k];
    return v === '' || v === undefined || v === null ? sql`NULL` : sql`${v}`;
  });

  // Append the four managed columns explicitly.
  const allCols = sql.join(
    [
      ...cols,
      sql.raw('version_label'),
      sql.raw('effective_from'),
      sql.raw('created_by_person_id'),
      sql.raw('approval_request_id'),
    ],
    sql`, `,
  );

  // approval_request_id is a bigint FK to mlm.approval_request(id).
  const allVals = sql.join(
    [
      ...vals,
      sql`${label}`,
      sql`now()`,
      sql`${personId}`,
      sql`${approvalId}::bigint`,
    ],
    sql`, `,
  );

  await q.execute(sql`INSERT INTO mlm.plan_config (${allCols}) VALUES (${allVals})`);
}
