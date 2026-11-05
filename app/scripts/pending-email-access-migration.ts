/** Operator-only, explicit cohort migration. Never imported by the HTTP app.
 * Creates unverified auth principals, NOT MLM identities or permission grants.
 * No env file is loaded here. Run with `bun --no-env-file ...`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { z } from 'zod';

class OperatorError extends Error {}
const fail = (code: string): never => { throw new OperatorError(code); };
const requireCondition: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) fail(code); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.uuid();
export const VERSION = 'pending-email-access-v1';
export type Source = { id: string; email: string; status: string; userId: string | null; blocked: boolean };
export type Existing = { id: string; email: string };
export type Snapshot = { source: Source[]; existing: Existing[]; schemaDigest: string };
type Candidate = { sourceId: string; emailDigest: string; authId: string };
export type Plan = { format: typeof VERSION; runId: string; target: string; createdAt: string;
  snapshotDigest: string; schemaDigest: string; candidates: Candidate[]; counts: Record<string, number>; digest: string };
const candidateSchema = z.object({ sourceId: z.string().regex(/^[1-9][0-9]*$/), emailDigest: sha, authId: id }).strict();
const planSchema = z.object({ format: z.literal(VERSION), runId: id, target: sha, createdAt: z.iso.datetime(),
  snapshotDigest: sha, schemaDigest: sha, candidates: z.array(candidateSchema).max(150_000),
  counts: z.record(z.string(), z.number().int().min(0)), digest: sha }).strict();
export function targetConfiguration(raw: string | undefined) {
  let url: URL; try { url = new URL(raw || ''); } catch { return fail('TARGET_CONFIGURATION_REQUIRED'); }
  requireCondition(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname && url.username && url.password
    && url.pathname.length > 1 && !url.hash, 'TARGET_CONFIGURATION_INVALID');
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
  requireCondition(local ? ['disable', 'verify-full'].includes(url.searchParams.get('sslmode') || '')
    : url.searchParams.get('sslmode') === 'verify-full', 'VERIFIED_TLS_REQUIRED');
  requireCondition([...url.searchParams.keys()].every(key => ['sslmode', 'sslrootcert'].includes(key))
    && ['sslmode', 'sslrootcert'].every(key => url.searchParams.getAll(key).length <= 1)
    && (!url.searchParams.has('sslrootcert') || url.searchParams.get('sslrootcert') === 'system'), 'TARGET_PARAMETERS_INVALID');
  const database = decodeURIComponent(url.pathname.slice(1));
  const target = hash([url.hostname.toLowerCase(), String(url.port || '5432'), database]);
  return { url, database, target, local };
}
export function connectTarget(raw: string | undefined, expectedTarget: string) {
  const config = targetConfiguration(raw);
  requireCondition(sha.safeParse(expectedTarget).success && config.target === expectedTarget, 'TARGET_PIN_MISMATCH');
  return { ...config, sql: postgres({ host: config.url.hostname, port: Number(config.url.port || 5432),
    database: config.database, username: decodeURIComponent(config.url.username), password: decodeURIComponent(config.url.password),
    ssl: config.local && config.url.searchParams.get('sslmode') === 'disable' ? false : { rejectUnauthorized: true },
    max: 1, prepare: false, connect_timeout: 10, idle_timeout: 10, onnotice: () => {},
    connection: { application_name: 'mindbliss-pending-email-access', TimeZone: 'UTC' } }) };
}

/** The exact same z.email validator family used by the pinned Better Auth. */
export function classify(snapshot: Snapshot) {
  requireCondition(snapshot.source.length <= 150_000, 'SOURCE_LIMIT_EXCEEDED');
  requireCondition(snapshot.source.every(row => /^[1-9][0-9]*$/.test(row.id) && typeof row.email === 'string'
    && ['pending', 'active', 'suspended', 'banned', 'deleted'].includes(row.status)
    && (row.userId === null || typeof row.userId === 'string') && typeof row.blocked === 'boolean')
    && new Set(snapshot.source.map(row => row.id)).size === snapshot.source.length, 'SOURCE_STATE_REQUIRES_REVIEW');
  const normalized = (email: string) => email.trim().toLowerCase();
  const groups = new Map<string, number>();
  for (const row of snapshot.source) groups.set(normalized(row.email), (groups.get(normalized(row.email)) || 0) + 1);
  const existing = new Set(snapshot.existing.map(row => normalized(row.email)));
  const counts: Record<string, number> = { source: snapshot.source.length, existingAuth: snapshot.existing.length,
    invalidEmail: 0, whitespaceEmail: 0, duplicateNormalizedEmail: 0, unavailable: 0, legacyLinked: 0, alreadyPresent: 0, eligible: 0 };
  const eligible: { sourceId: string; email: string; emailDigest: string }[] = [];
  for (const row of [...snapshot.source].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)) {
    const email = normalized(row.email);
    // Portal/admin HTTP boundaries cap addresses at 254; a validator-only
    // principal with a longer address would never be able to request its OTP.
    if (!z.email().safeParse(email).success || email.length > 254) { counts.invalidEmail!++; continue; }
    if ((groups.get(email) || 0) !== 1) { counts.duplicateNormalizedEmail!++; continue; }
    if (row.email !== row.email.trim()) { counts.whitespaceEmail!++; continue; }
    if (row.blocked || !['pending', 'active'].includes(row.status)) { counts.unavailable!++; continue; }
    if (row.userId !== null) { counts.legacyLinked!++; continue; }
    if (existing.has(email)) { counts.alreadyPresent!++; continue; }
    eligible.push({ sourceId: row.id, email, emailDigest: hash(email) });
  }
  counts.eligible = eligible.length;
  return { eligible, counts };
}
function snapshotDigest(snapshot: Snapshot) {
  return hash({ schemaDigest: snapshot.schemaDigest,
    source: [...snapshot.source].sort((a, b) => a.id.localeCompare(b.id)),
    existing: [...snapshot.existing].sort((a, b) => a.id.localeCompare(b.id)) });
}
export function createPlan(snapshot: Snapshot, target: string, runId = randomUUID()): Plan {
  requireCondition(sha.safeParse(target).success && id.safeParse(runId).success, 'PLAN_IDENTIFIERS_INVALID');
  const { eligible, counts } = classify(snapshot);
  const body = { format: VERSION as typeof VERSION, runId, target, createdAt: new Date().toISOString(), snapshotDigest: snapshotDigest(snapshot),
    schemaDigest: snapshot.schemaDigest, candidates: eligible.map(row => ({ sourceId: row.sourceId, emailDigest: row.emailDigest, authId: randomUUID() })), counts };
  return { ...body, digest: hash(body) };
}
export function validatePlan(value: unknown, expectedDigest: string, target: string): Plan {
  const parsed = planSchema.safeParse(value);
  requireCondition(parsed.success, 'PLAN_INVALID');
  const { digest, ...body } = parsed.data;
  requireCondition(digest === expectedDigest && digest === hash(body) && parsed.data.target === target, 'PLAN_PIN_MISMATCH');
  requireCondition(new Set(parsed.data.candidates.map(row => row.authId)).size === parsed.data.candidates.length
    && new Set(parsed.data.candidates.map(row => row.sourceId)).size === parsed.data.candidates.length
    && new Set(parsed.data.candidates.map(row => row.emailDigest)).size === parsed.data.candidates.length, 'PLAN_DUPLICATES');
  return parsed.data as Plan;
}
export async function fileHash(file: string) {
  const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
export async function verifyBackup(manifestPath: string, target: string) {
  const schema = z.object({ format: z.literal('pending-access-backup-v1'), target: sha, archivePath: z.string().min(1),
    archiveSha256: sha, completedAt: z.iso.datetime(), restoreVerified: z.literal(true) }).strict();
  let value: unknown; try { value = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { return fail('BACKUP_MANIFEST_REQUIRED'); }
  const proof = schema.safeParse(value); requireCondition(proof.success && proof.data.target === target, 'BACKUP_PIN_MISMATCH');
  const age = Date.now() - Date.parse(proof.data.completedAt);
  requireCondition(age >= 0 && age <= 24 * 60 * 60 * 1000, 'RECENT_VERIFIED_BACKUP_REQUIRED');
  const file = resolve(proof.data.archivePath); const info = await stat(file).catch(() => null);
  requireCondition(info?.isFile() && info.size > 0 && await fileHash(file) === proof.data.archiveSha256, 'BACKUP_ARCHIVE_MISMATCH');
  return { archiveSha256: proof.data.archiveSha256, completedAt: proof.data.completedAt };
}

const expectedColumns: Record<string, string> = { id: 'text', email: 'text', email_verified: 'boolean', name: 'text', image: 'text',
  phone_number: 'text', phone_number_verified: 'boolean', contact_phone_e164: 'text', contact_whatsapp_e164: 'text',
  created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone' };
type Query = postgres.Sql | postgres.TransactionSql;
export async function inspectSchema(sql: Query, database: string) {
  const [meta] = await sql.unsafe(`SELECT current_database() AS database, pg_is_in_recovery() AS replica,
    c.relkind, c.relrowsecurity AS rls,
    (SELECT count(*)::int FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) AS triggers,
    (SELECT count(*)::int FROM pg_rewrite WHERE ev_class=c.oid AND rulename <> '_RETURN') AS rules
    FROM pg_class c WHERE c.oid=to_regclass('auth.user')`);
  requireCondition(meta && meta.database === database && !meta.replica && meta.relkind === 'r' && !meta.rls
    && meta.triggers === 0 && meta.rules === 0, 'AUTH_USER_SHAPE_OR_SIDE_EFFECT_REQUIRES_REVIEW');
  const columns = await sql.unsafe(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='auth' AND table_name='user' ORDER BY column_name`);
  requireCondition(columns.length === Object.keys(expectedColumns).length && columns.every(row => expectedColumns[row.column_name] === row.data_type), 'AUTH_USER_COLUMNS_REQUIRE_REVIEW');
  return hash({ meta: { database: meta.database, relkind: meta.relkind, rls: meta.rls, triggers: meta.triggers, rules: meta.rules }, columns });
}
export async function readSnapshot(sql: Query, database: string): Promise<Snapshot> {
  const schemaDigest = await inspectSchema(sql, database);
  const source = await sql.unsafe(`SELECT p.id::text AS id,p.email::text AS email,p.status::text AS status,p.user_id AS "userId",
    (COALESCE(p.blacklisted,false)
     OR EXISTS(SELECT 1 FROM mlm.affiliate a WHERE a.person_id=p.id AND a.status::text IN('suspended','banned','deleted'))
     OR EXISTS(SELECT 1 FROM mlm.blacklist b
       WHERE (b.email_norm IS NOT NULL AND b.email_norm=mlm.norm_email(p.email))
          OR (b.phone_last10 IS NOT NULL AND b.phone_last10=mlm.norm_phone10(p.phone_number))
          OR (b.name_norm IS NOT NULL AND b.name_norm=mlm.norm_name(p.first_name||' '||p.last_name)
              AND (b.birthdate IS NULL OR (p.birthday IS NOT NULL AND b.birthdate=p.birthday))))) AS blocked
    FROM mlm.person p ORDER BY p.id`);
  const existing = await sql.unsafe(`SELECT id,email FROM auth."user" ORDER BY id`);
  return { source: source as unknown as Source[], existing: existing as unknown as Existing[], schemaDigest };
}
export async function planMigration(sql: postgres.Sql, database: string, target: string, runId = randomUUID()) {
  return await sql.begin('isolation level repeatable read read only', async tx => {
    await tx.unsafe("SET LOCAL statement_timeout='60s'");
    return createPlan(await readSnapshot(tx, database), target, runId);
  });
}
export async function applyMigration(sql: postgres.Sql, database: string, plan: Plan) {
  // Caller must validate the plan, persist the prepared receipt, verify backup
  // and explicitly authorize apply. This function has no provider dependency.
  return await sql.begin('isolation level serializable', async tx => {
    await tx.unsafe("SET LOCAL lock_timeout='5s'"); await tx.unsafe("SET LOCAL statement_timeout='60s'");
    // Lock before the first snapshot-taking SELECT. Otherwise a waiting
    // advisory lock can freeze SERIALIZABLE eligibility before a ban commits.
    await tx.unsafe('LOCK TABLE auth."user" IN SHARE ROW EXCLUSIVE MODE');
    await tx.unsafe('LOCK TABLE mlm.person,mlm.affiliate,mlm.blacklist IN SHARE MODE');
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended('pending-email-access-v1',0))");
    const snapshot = await readSnapshot(tx, database);
    const byId = new Map(snapshot.existing.map(row => [row.id, row]));
    const prior = plan.candidates.filter(row => byId.has(row.authId));
    if (prior.length) {
      requireCondition(prior.length === plan.candidates.length && prior.every(row => hash(byId.get(row.authId)!.email) === row.emailDigest), 'PARTIAL_OR_CONFLICTING_APPLY_REQUIRES_REVIEW');
      return { status: 'already-applied', inserted: 0, total: prior.length };
    }
    requireCondition(snapshotDigest(snapshot) === plan.snapshotDigest && snapshot.schemaDigest === plan.schemaDigest, 'SOURCE_CHANGED_REPLAN_REQUIRED');
    const { eligible } = classify(snapshot);
    requireCondition(eligible.length === plan.candidates.length && eligible.every((row, i) => row.sourceId === plan.candidates[i]!.sourceId
      && row.emailDigest === plan.candidates[i]!.emailDigest), 'COHORT_CHANGED_REPLAN_REQUIRED');
    let inserted = 0;
    for (let offset = 0; offset < eligible.length; offset += 1000) {
      const batch = eligible.slice(offset, offset + 1000).map((row, i) => ({ id: plan.candidates[offset + i]!.authId, email: row.email }));
      const rows = await tx.unsafe(`INSERT INTO auth."user"(id,email,email_verified,name,image,phone_number,phone_number_verified,
        contact_phone_e164,contact_whatsapp_e164,created_at,updated_at)
        SELECT x.id,x.email,false,'Cuenta pendiente',NULL,NULL,false,NULL,NULL,now(),now()
        FROM jsonb_to_recordset($1::text::jsonb) AS x(id text,email text) RETURNING id`, [JSON.stringify(batch)]);
      requireCondition(rows.length === batch.length, 'INSERT_COUNT_MISMATCH'); inserted += rows.length;
    }
    const ids = JSON.stringify(plan.candidates.map(row => row.authId));
    const [check] = await tx.unsafe(`WITH cohort AS(SELECT value AS id FROM jsonb_array_elements_text($1::text::jsonb))
      SELECT (SELECT count(*)::int FROM auth."user" u JOIN cohort c USING(id)
        WHERE u.email_verified=false AND u.phone_number_verified=false AND u.name='Cuenta pendiente'
          AND u.image IS NULL AND u.phone_number IS NULL AND u.contact_phone_e164 IS NULL AND u.contact_whatsapp_e164 IS NULL) AS pending,
      (SELECT count(*)::int FROM auth.account a JOIN cohort c ON c.id=a.user_id) AS accounts,
      (SELECT count(*)::int FROM auth.session s JOIN cohort c ON c.id=s.user_id) AS sessions,
      (SELECT count(*)::int FROM identity.auth_binding b JOIN cohort c ON c.id=b.subject) AS bindings,
      (SELECT count(*)::int FROM mlm.person p JOIN cohort c ON c.id=p.user_id) AS people`, [ids]);
    requireCondition(check?.pending === inserted && check.accounts === 0 && check.sessions === 0 && check.bindings === 0 && check.people === 0, 'POSTCONDITIONS_FAILED_ROLLBACK');
    return { status: 'applied', inserted, total: inserted };
  });
}

async function main(args: string[]) {
  const allowed = new Set(['--apply', '--plan-file', '--target', '--expected-digest', '--backup-manifest']);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!; requireCondition(allowed.has(key) && !options.has(key), 'ARGUMENTS_INVALID');
    if (key === '--apply') options.set(key, 'true');
    else { const value = args[++i]; requireCondition(value && !value.startsWith('--'), 'ARGUMENT_VALUE_REQUIRED'); options.set(key, value); }
  }
  const apply = options.has('--apply'); const planPath = options.get('--plan-file');
  requireCondition(planPath && options.get('--target'), 'PLAN_FILE_AND_TARGET_REQUIRED');
  if (!apply) requireCondition(!options.has('--expected-digest') && !options.has('--backup-manifest'), 'APPLY_ONLY_ARGUMENTS');
  const connection = connectTarget(process.env.PENDING_ACCESS_DATABASE_URL, options.get('--target')!);
  try {
    if (!apply) {
      const plan = await planMigration(connection.sql, connection.database, connection.target);
      await writeFile(planPath, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ event: 'pending-access-plan', runId: plan.runId, target: plan.target, digest: plan.digest, counts: plan.counts, writes: 0 })); return;
    }
    requireCondition(options.get('--expected-digest') && options.get('--backup-manifest'), 'EXPLICIT_APPLY_PINS_REQUIRED');
    const plan = validatePlan(JSON.parse(await readFile(planPath, 'utf8')), options.get('--expected-digest')!, connection.target);
    const backup = await verifyBackup(options.get('--backup-manifest')!, connection.target);
    const receipt = { format: VERSION, runId: plan.runId, target: plan.target, digest: plan.digest, backup,
      insertedIds: plan.candidates.map(row => row.authId), status: 'prepared' };
    const receiptPath = `${planPath}.receipt.json`;
    try { await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      requireCondition((error as NodeJS.ErrnoException).code === 'EEXIST', 'PRIVATE_AUDIT_PREPARE_FAILED');
      const previous = JSON.parse(await readFile(receiptPath, 'utf8'));
      requireCondition(previous.runId === receipt.runId && previous.target === receipt.target && previous.digest === receipt.digest
        && hash(previous.insertedIds) === hash(receipt.insertedIds), 'PRIVATE_AUDIT_CONFLICT');
    }
    const result = await applyMigration(connection.sql, connection.database, plan);
    await writeFile(receiptPath, JSON.stringify({ ...receipt, ...result, committedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ event: 'pending-access-result', runId: plan.runId, target: plan.target, digest: plan.digest, ...result,
      verified: false, accountsCreated: 0, bindingsCreated: 0, messagesSent: 0 }));
  } finally { await connection.sql.end({ timeout: 5 }); }
}
if (import.meta.main) main(process.argv.slice(2)).catch(error => {
  console.log(JSON.stringify({ event: 'pending-access-blocked', code: error instanceof OperatorError ? error.message : 'REDACTED_OPERATOR_FAILURE' })); process.exitCode = 1;
});
