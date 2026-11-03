// Operator-only library: importing does not connect, read files or mutate data.
// The caller must pin the target, lock the reviewed tables, persist and verify
// its external backup BEFORE calling reconcileBlacklist inside that transaction.
// Only mlm.blacklist and mlm.person.blacklisted are mutation targets here.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tokenizeCsv } from './sales-csv-import.mjs';

const fail = code => { throw new Error(code); };
const canonicalEmail = z.string().max(254).pipe(z.email());
const rowShape = z.strictObject({ email: canonicalEmail, fullname: z.string().max(1000), username: z.string().max(255) });
const parsedShape = z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/), rows: z.array(rowShape).min(1).max(100000),
  emails: z.array(canonicalEmail).min(1).max(100000) });

function validateParsed(input) {
  const result = parsedShape.safeParse(input);
  if (!result.success) fail('BLACKLIST_PARSED_INVALID');
  const { rows, emails } = result.data;
  if (rows.some(row => row.email !== row.email.trim().toLowerCase()) || new Set(rows.map(row => row.email)).size !== rows.length)
    fail('BLACKLIST_DUPLICATE_OR_NONCANONICAL_EMAIL');
  if (JSON.stringify(emails) !== JSON.stringify(rows.map(row => row.email).sort())) fail('BLACKLIST_EMAIL_SET_MISMATCH');
  return result.data;
}

/** Strict reviewed Google Sheets export; no inferred email or identity repair. */
export function parseBlacklistCsv(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024) fail('BLACKLIST_CSV_SIZE_INVALID');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { fail('BLACKLIST_CSV_ENCODING_INVALID'); }
  if (text.includes('\0')) fail('BLACKLIST_CSV_NUL_INVALID');
  const records = tokenizeCsv(text);
  if (JSON.stringify(records[0]) !== JSON.stringify(['Nombre', 'username', 'email'])) fail('BLACKLIST_CSV_HEADERS_INVALID');
  const rows = records.slice(1).map(values => {
    if (values.length !== 3) fail('BLACKLIST_CSV_ROW_WIDTH_INVALID');
    const result = rowShape.safeParse({ fullname: values[0].trim(), username: values[1].trim(), email: values[2].trim().toLowerCase() });
    if (!result.success) fail('BLACKLIST_CSV_ROW_INVALID');
    return Object.freeze(result.data);
  });
  if (!rows.length) fail('BLACKLIST_CSV_ROWS_REQUIRED');
  if (new Set(rows.map(row => row.email)).size !== rows.length) fail('BLACKLIST_CSV_DUPLICATE_EMAIL');
  return Object.freeze({ sha256: createHash('sha256').update(bytes).digest('hex'), rows: Object.freeze(rows),
    emails: Object.freeze(rows.map(row => row.email).sort()) });
}

/** Caller-owned PostgreSQL transaction; never commits, backs up, or repairs
 * other restrictions. It MUST be rolled back if this function throws.
 */
export async function reconcileBlacklist(tx, parsed, source) {
  const input = validateParsed(parsed);
  if (!tx || typeof tx.unsafe !== 'function' || typeof tx.savepoint !== 'function' || typeof tx.json !== 'function') fail('BLACKLIST_TRANSACTION_REQUIRED');
  if (typeof source !== 'string' || !source || source.length > 256 || source !== source.trim() || /[\u0000-\u001f\u007f]/.test(source))
    fail('BLACKLIST_SOURCE_INVALID');
  const [before] = await tx.unsafe('SELECT count(*) FILTER (WHERE blacklisted IS TRUE)::int AS flagged FROM mlm.person');
  const [deleted] = await tx.unsafe('WITH removed AS (DELETE FROM mlm.blacklist RETURNING 1) SELECT count(*)::int AS n FROM removed');
  const [inserted] = await tx.unsafe(`WITH inserted AS (
    INSERT INTO mlm.blacklist(fullname,username,email,email_norm,phone,phone_last10,name_norm,birthdate,motive,source)
    SELECT x.fullname,x.username,x.email,x.email,NULL,NULL,NULL,NULL,NULL,$2
    FROM jsonb_to_recordset($1::jsonb) AS x(email text,fullname text,username text)
    RETURNING 1) SELECT count(*)::int AS n FROM inserted`, [tx.json(input.rows), source]);
  if (inserted?.n !== input.rows.length) fail('BLACKLIST_INSERT_COUNT_MISMATCH');
  const [changed] = await tx.unsafe(`WITH desired AS (
    SELECT p.id,EXISTS(SELECT 1 FROM mlm.blacklist b WHERE b.email_norm=lower(btrim(p.email::text))) AS listed
    FROM mlm.person p
  ), changed AS (
    UPDATE mlm.person p SET blacklisted=d.listed FROM desired d
    WHERE p.id=d.id AND p.blacklisted IS DISTINCT FROM d.listed RETURNING d.listed
  ) SELECT count(*)::int AS n,count(*) FILTER(WHERE listed)::int AS flags_set,
    count(*) FILTER(WHERE NOT listed)::int AS flags_cleared FROM changed`);
  const [control] = await tx.unsafe(`SELECT
    (SELECT count(*)::int FROM mlm.blacklist) AS rows,
    (SELECT count(DISTINCT email_norm)::int FROM mlm.blacklist) AS unique_emails,
    (SELECT count(*)::int FROM mlm.blacklist WHERE email IS DISTINCT FROM email_norm
      OR email_norm IS NULL OR NOT(email_norm=ANY($1::text[])) OR source IS DISTINCT FROM $2
      OR phone IS NOT NULL OR phone_last10 IS NOT NULL OR name_norm IS NOT NULL OR birthdate IS NOT NULL) AS invalid_rows,
    (SELECT count(*) FILTER(WHERE p.blacklisted IS TRUE)::int FROM mlm.person p) AS flagged,
    (SELECT count(*)::int FROM mlm.person p WHERE p.blacklisted IS DISTINCT FROM
      EXISTS(SELECT 1 FROM mlm.blacklist b WHERE b.email_norm=lower(btrim(p.email::text)))) AS mismatches`, [input.emails, source]);
  if (control?.rows !== input.rows.length || control.unique_emails !== input.rows.length || control.invalid_rows !== 0 || control.mismatches !== 0)
    fail('BLACKLIST_RECONCILIATION_MISMATCH');
  return { source, sha256: input.sha256, deleted: deleted.n, inserted: inserted.n, changed_flags: changed.n,
    flags_set: changed.flags_set, flags_cleared: changed.flags_cleared, blacklisted_before: before.flagged, blacklisted_after: control.flagged };
}
