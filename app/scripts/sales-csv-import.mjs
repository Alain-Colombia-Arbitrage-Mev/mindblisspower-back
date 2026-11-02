// Operator import library. This module never connects, sends messages, activates
// memberships or writes a ledger. Callers must supply a reviewed transaction.
import { createHash } from 'node:crypto';

const REQUIRED = ['id', 'Created date (UTC)', 'Amount', 'Amount Refunded', 'Currency', 'Captured', 'Description', 'Fee', 'Mode', 'PaymentIntent ID', 'Status', 'packmindbliss (metadata)', 'person_id (metadata)', 'package_id (metadata)', 'purchase_intent_id (metadata)'];
const fail = code => { throw new Error(code); };
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function tokenizeCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const finishCell = () => { row.push(cell); cell = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else cell += ch;
    } else if (ch === '"') {
      if (cell || closed) fail('CSV_QUOTING_INVALID');
      quoted = true;
    } else if (ch === ',') finishCell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      finishCell(); rows.push(row); row = [];
    } else {
      if (closed) fail('CSV_QUOTING_INVALID');
      cell += ch;
    }
    if (cell.length > 65536 || row.length > 512 || rows.length > 100025) fail('CSV_LIMIT_EXCEEDED');
  }
  if (quoted) fail('CSV_QUOTE_UNTERMINATED');
  if (cell || row.length || closed) { finishCell(); rows.push(row); }
  return rows;
}

export function usdMinor(value) {
  const raw = String(value).trim().replace(/^\$/, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) fail('CSV_USD_INVALID');
  const [integer, fraction = ''] = raw.replaceAll(',', '').split('.');
  const minor = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor > 99999999999999n) fail('CSV_USD_OUT_OF_RANGE');
  return minor.toString();
}

function utcDate(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) fail('CSV_DATE_INVALID');
  const iso = value.replace(' ', 'T') + 'Z';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== iso.slice(0, 19)) fail('CSV_DATE_INVALID');
  return date.toISOString();
}

function sourceStatement(preamble) {
  const amount = label => {
    const matches = preamble.filter(row => row[1] === label);
    if (matches.length !== 1) fail('CSV_STATEMENT_CONTROL_REQUIRED');
    return usdMinor(matches[0][4]);
  };
  const amounts = {
    declared_gross_minor: amount('TOTAL CONSOLIDADO'),
    declared_reserve_minor: amount('Reserva de riesgo'),
    declared_company_payout_minor: (BigInt(amount('Pagos wallet 1')) + BigInt(amount('Pagos wallet 2'))).toString(),
    declared_incoming_minor: amount('Entrante'),
    declared_review_minor: amount('Radar Review'),
  };
  return { schema_version: 1, kind: 'owner_supplied_csv_preamble', currency: 'usd',
    scope: 'source_file_all_rows_not_membership_or_cash', reconciled: false, amounts };
}

export function parseSalesCsv(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 32 * 1024 * 1024) fail('CSV_SIZE_INVALID');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { fail('CSV_ENCODING_INVALID'); }
  if (text.includes('\x00')) fail('CSV_NUL_INVALID');
  const raw = tokenizeCsv(text);
  const candidates = raw.map((row, index) => row[0] === 'id' && row[1] === 'Created date (UTC)' && row.includes('PaymentIntent ID') ? index : -1).filter(index => index >= 0);
  if (candidates.length !== 1) fail('CSV_HEADER_REQUIRED_UNIQUE');
  const headerIndex = candidates[0], header = raw[headerIndex];
  if (new Set(header).size !== header.length || !REQUIRED.every(key => header.includes(key))) fail('CSV_HEADERS_INVALID');
  const charges = new Set(), intents = new Set();
  const rows = raw.slice(headerIndex + 1).map((values, index) => ({ values, sourceRow: headerIndex + index + 2 })).filter(({ values }) => values.some(Boolean)).map(({ values, sourceRow }) => {
    if (values.length !== header.length) fail('CSV_ROW_WIDTH_INVALID');
    const row = Object.fromEntries(header.map((key, index) => [key, values[index]]));
    const charge = row.id, intent = row['PaymentIntent ID'];
    if (!/^(?:ch|py)_[A-Za-z0-9]{8,128}$/.test(charge) || !/^pi_[A-Za-z0-9]{8,128}$/.test(intent)) fail('CSV_PROVIDER_ID_INVALID');
    if (charges.has(charge) || intents.has(intent)) fail('CSV_DUPLICATE_PROVIDER_ID');
    charges.add(charge); intents.add(intent);
    if (row.Mode !== 'Live' || row.Currency !== 'usd' || row.Captured !== 'TRUE') fail('CSV_NOT_LIVE_CAPTURED_USD');
    if (!['Paid', 'En Revisión'].includes(row.Status)) fail('CSV_STATUS_UNREVIEWED');
    const gross = usdMinor(row.Amount), refunded = usdMinor(row['Amount Refunded']), fee = usdMinor(row.Fee);
    if (BigInt(gross) <= 0n || BigInt(refunded) > BigInt(gross) || BigInt(fee) + BigInt(refunded) > BigInt(gross)) fail('CSV_AMOUNTS_INVALID');
    const marker = row['packmindbliss (metadata)'];
    if (!['TRUE', 'true', ''].includes(marker)) fail('CSV_PRODUCT_MARKER_INVALID');
    const person = row['person_id (metadata)'], pack = row['package_id (metadata)'];
    if ((person && !/^[1-9]\d{0,17}$/.test(person)) || (pack && !/^[1-9]\d{0,17}$/.test(pack))) fail('CSV_METADATA_ID_INVALID');
    return { source_row: sourceRow, external_id: intent, provider_reference: charge,
      created_at: utcDate(row['Created date (UTC)']), currency: 'usd', gross_minor: gross,
      refunded_minor: refunded, fee_minor: fee, net_minor: (BigInt(gross) - BigInt(refunded) - BigInt(fee)).toString(),
      source_status: row.Status, display_status: row.Status === 'Paid' ? 'paid' : 'under_review',
      source_product_marked: marker.toLowerCase() === 'true', source_person_id: person || null,
      source_package_id: pack || null, source_purchase_intent_id: row['purchase_intent_id (metadata)'] || null };
  });
  if (!rows.length) fail('CSV_ROWS_REQUIRED');
  return { file_sha256: sha256(bytes), header_row: headerIndex + 1, columns: header.length,
    rows, statement: sourceStatement(raw.slice(0, headerIndex)) };
}

function totals(rows) {
  const sum = key => rows.reduce((value, row) => value + BigInt(row[key]), 0n).toString();
  return { rows: rows.length, gross_minor: sum('gross_minor'), refunded_minor: sum('refunded_minor'), fee_minor: sum('fee_minor'), net_minor: sum('net_minor') };
}

function statusTotals(rows) {
  return ['Paid', 'En Revisión'].map(status => {
    const group = rows.filter(row => row.source_status === status);
    return { source_status: status, display_status: status === 'Paid' ? 'paid' : 'under_review', ...totals(group) };
  });
}

// Evidence comes from an exact PI + charge join in a READ ONLY transaction.
// Email coincidence, price coincidence and CSV metadata alone never bind a user.
export function buildSalesImportPlan(source, evidence) {
  if (!Array.isArray(evidence) || new Set(evidence.map(row => row.external_id)).size !== evidence.length) fail('CANONICAL_EVIDENCE_INVALID');
  const byIntent = new Map(evidence.map(row => [row.external_id, row]));
  const imported = source.rows.map(row => {
    const e = byIntent.get(row.external_id);
    const canonical = Boolean(e?.canonical_pi && e?.canonical_charge && e.charge_pi_matches
      && e.livemode && e.payment_status === 'succeeded' && e.currency === 'usd'
      && e.product_marked && e.product_evidence && String(e.captured_minor) === row.gross_minor);
    if (e?.canonical_pi && String(e.captured_minor) !== row.gross_minor) fail('CANONICAL_GROSS_CONFLICT');
    if (e?.canonical_pi && String(e.refunded_minor) !== row.refunded_minor) fail('CANONICAL_REFUND_CONFLICT');
    if (row.source_product_marked && !canonical) fail('MARKED_PRODUCT_NOT_CORROBORATED');
    if (canonical && row.source_package_id && e.metadata_package_id !== row.source_package_id) fail('CANONICAL_PACKAGE_METADATA_CONFLICT');
    if (canonical && row.source_person_id && e.metadata_person_id !== row.source_person_id) fail('CANONICAL_PERSON_METADATA_CONFLICT');
    const verifiedFee = canonical && e.verified_fee_minor != null ? String(e.verified_fee_minor) : null;
    const risk = !canonical ? 'source_review' : BigInt(e.refunded_minor) > 0n ? 'refunded' : Number(e.dispute_count) > 0 ? 'disputed' : !e.source_eligible ? 'source_review' : 'none';
    const identityVerified = canonical && e.identity_verified;
    const catalogVerified = canonical && e.catalog_verified;
    const record = { ...row, product_scope: canonical ? 'mindbliss_membership' : 'unattributed',
      canonical_payment_intent_id: canonical ? row.external_id : null,
      person_id: identityVerified ? String(e.person_id) : null, affiliate_id: identityVerified ? String(e.affiliate_id) : null,
      buyer_email: identityVerified ? String(e.buyer_email || '') : '', buyer_name: identityVerified ? String(e.buyer_name || '') : '',
      package_id: catalogVerified ? String(e.catalog_package_id) : null,
      package_name: catalogVerified ? `Mindbliss · paquete ${e.catalog_package_id}` : 'Paquete pendiente de validación',
      base_minor: catalogVerified ? String(e.base_minor) : null,
      paid_at: canonical ? e.charged_at : null, verified_fee_minor: verifiedFee,
      fee_reconciliation_status: verifiedFee === null ? 'unavailable' : verifiedFee === row.fee_minor ? 'matched' : 'discrepancy',
      activation_status: 'not_inferred_from_import', risk_status: risk, provider_verified: false, commission_eligible: false,
      canonical_refunded_minor: canonical ? String(e.refunded_minor) : null,
      canonical_dispute_count: canonical ? Number(e.dispute_count) : null,
      canonical_source_eligible: canonical ? Boolean(e.source_eligible) : null };
    return { ...record, record_sha256: sha256(JSON.stringify(record)) };
  });
  const included = imported.filter(row => row.product_scope === 'mindbliss_membership');
  const excluded = imported.filter(row => row.product_scope === 'unattributed');
  const feeDiffs = included.filter(row => row.fee_reconciliation_status === 'discrepancy');
  const disputed = included.filter(row => row.risk_status === 'disputed');
  const reviewMinor = imported.filter(row => row.source_status === 'En Revisión').reduce((sum, row) => sum + BigInt(row.gross_minor), 0n);
  const controls = { schema_version: 1, source_totals: totals(imported), included_totals: totals(included),
    excluded_totals: { ...totals(excluded), reason: 'unattributed_product' }, source_status_totals: statusTotals(imported),
    membership_status_totals: statusTotals(included), canonical_evidence: {
      matched_rows: included.length, missing_rows: excluded.length, amount_conflicts: 0,
      disputed_rows: disputed.length, disputed_gross_minor: totals(disputed).gross_minor,
      fee_discrepancy_rows: feeDiffs.length,
      fee_discrepancy_minor: feeDiffs.reduce((sum, row) => sum + BigInt(row.fee_minor) - BigInt(row.verified_fee_minor), 0n).toString(),
      verified_fee_minor: included.reduce((sum, row) => sum + BigInt(row.verified_fee_minor || '0'), 0n).toString(),
    }, statement_reconciliation: {
      review_difference_minor: (reviewMinor - BigInt(source.statement.amounts.declared_review_minor)).toString(), reconciled: false,
    } };
  return { file_sha256: source.file_sha256, source_extracted_at: null, rows: imported, statement: source.statement, controls,
    plan_sha256: sha256(JSON.stringify({ file_sha256: source.file_sha256, rows: imported, statement: source.statement, controls })) };
}

export async function readCanonicalSalesEvidence(tx, source) {
  const input = tx.json(source.rows.map(row => ({ external_id: row.external_id, provider_reference: row.provider_reference })));
  return tx`WITH input AS(SELECT * FROM jsonb_to_recordset(${input}::jsonb) AS x(external_id text,provider_reference text))
    SELECT x.external_id,s.payment_intent_id IS NOT NULL AS canonical_pi,z.charge_id IS NOT NULL AS canonical_charge,
      z.payment_intent_id=x.external_id AS charge_pi_matches,s.livemode,s.payment_status,s.currency,
      s.metadata->>'packmindbliss'='true' AS product_marked,jsonb_array_length(s.product_evidence)>0 AS product_evidence,
      s.captured_minor::text,s.refunded_minor::text,s.dispute_count,s.source_eligible,s.charged_at::text,
      s.metadata->>'package_id' AS metadata_package_id,s.metadata->>'person_id' AS metadata_person_id,
      z.fee_minor::text AS verified_fee_minor,i.identity_verified,i.catalog_verified,i.person_id::text,i.affiliate_id::text,
      CASE WHEN i.identity_verified THEN p.email::text ELSE '' END AS buyer_email,
      CASE WHEN i.identity_verified THEN trim(p.first_name||' '||p.last_name) ELSE '' END AS buyer_name,
      c.source_package_id::text AS catalog_package_id,c.base_minor::text
    FROM input x LEFT JOIN payments.stripe_sale s ON s.payment_intent_id=x.external_id
    LEFT JOIN payments.stripe_charge_settlement z ON z.charge_id=x.provider_reference AND z.payment_intent_id=x.external_id
    LEFT JOIN recovery.stripe_sale_identity i ON i.payment_intent_id=s.payment_intent_id
    LEFT JOIN mlm.person p ON p.id=i.person_id AND i.identity_verified
    LEFT JOIN recovery.package_catalog_snapshot c ON i.catalog_verified AND c.source_package_id::text=s.metadata->>'package_id'
      AND c.currency=s.currency AND c.base_minor+c.fee_minor=s.captured_minor ORDER BY x.external_id`;
}

export async function writeReviewedSalesImport(tx, plan, { batchId, sourceName }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(batchId)
    || sourceName !== 'unified_payments(1) - Stripe Dashboard.csv') fail('IMPORT_METADATA_REVIEW_REQUIRED');
  const existing = await tx`SELECT id::text,file_sha256,controls FROM payments.sales_import_batch WHERE file_sha256=${plan.file_sha256}`;
  if (existing.length) {
    if (JSON.stringify(existing[0].controls) !== JSON.stringify(JSON.parse(JSON.stringify(plan.controls)))) {
      // JSONB key order is unspecified; compare canonical aggregate values below.
      if (JSON.stringify(stable(existing[0].controls)) !== JSON.stringify(stable(plan.controls))) fail('EXISTING_BATCH_CONTROL_MISMATCH');
    }
    const [count] = await tx`SELECT count(*)::int AS rows FROM payments.sales_import_row WHERE batch_id=${existing[0].id}::uuid`;
    if (count.rows !== plan.rows.length) fail('EXISTING_BATCH_ROW_COUNT_MISMATCH');
    const [active] = await tx`SELECT active_batch_id::text FROM payments.admin_sales_source WHERE provider='stripe'`;
    if (active?.active_batch_id !== existing[0].id) fail('EXISTING_BATCH_NOT_ACTIVE_REVIEW_REQUIRED');
    return { batchId: existing[0].id, inserted: 0, idempotent: true };
  }
  const sum = plan.controls.source_totals;
  await tx`INSERT INTO payments.sales_import_batch(id,file_sha256,source_name,source_extracted_at,row_count,gross_minor,refunded_minor,fee_minor,statement,controls,status)
    VALUES(${batchId}::uuid,${plan.file_sha256},${sourceName},NULL,${plan.rows.length},${sum.gross_minor}::bigint,${sum.refunded_minor}::bigint,${sum.fee_minor}::bigint,${tx.json(plan.statement)},${tx.json(plan.controls)},'reviewed')`;
  await tx`INSERT INTO payments.sales_import_row(batch_id,source_row,external_id,provider_reference,created_at,paid_at,currency,person_id,affiliate_id,buyer_email,buyer_name,package_id,package_name,base_minor,gross_minor,refunded_minor,fee_minor,net_minor,verified_fee_minor,display_status,source_status,activation_status,risk_status,product_scope,provider_verified,commission_eligible,fee_reconciliation_status,canonical_payment_intent_id,canonical_refunded_minor,canonical_dispute_count,canonical_source_eligible,record_sha256)
    SELECT ${batchId}::uuid,x.source_row,x.external_id,x.provider_reference,x.created_at,x.paid_at,x.currency,x.person_id,x.affiliate_id,x.buyer_email,x.buyer_name,x.package_id,x.package_name,x.base_minor,x.gross_minor,x.refunded_minor,x.fee_minor,x.net_minor,x.verified_fee_minor,x.display_status,x.source_status,x.activation_status,x.risk_status,x.product_scope,x.provider_verified,x.commission_eligible,x.fee_reconciliation_status,x.canonical_payment_intent_id,x.canonical_refunded_minor,x.canonical_dispute_count,x.canonical_source_eligible,x.record_sha256
    FROM jsonb_to_recordset(${tx.json(plan.rows)}::jsonb) AS x(source_row integer,external_id text,provider_reference text,created_at timestamptz,paid_at timestamptz,currency text,person_id bigint,affiliate_id bigint,buyer_email text,buyer_name text,package_id bigint,package_name text,base_minor bigint,gross_minor bigint,refunded_minor bigint,fee_minor bigint,net_minor bigint,verified_fee_minor bigint,display_status text,source_status text,activation_status text,risk_status text,product_scope text,provider_verified boolean,commission_eligible boolean,fee_reconciliation_status text,canonical_payment_intent_id text,canonical_refunded_minor bigint,canonical_dispute_count integer,canonical_source_eligible boolean,record_sha256 text)`;
  const [actual] = await tx`SELECT count(*)::int AS rows,coalesce(sum(gross_minor),0)::text AS gross FROM payments.sales_import_row WHERE batch_id=${batchId}::uuid`;
  if (actual.rows !== plan.rows.length || actual.gross !== sum.gross_minor) fail('IMPORTED_CONTROL_MISMATCH');
  await tx`INSERT INTO payments.admin_sales_source(provider,active_batch_id,activated_at) VALUES('stripe',${batchId}::uuid,now())
    ON CONFLICT(provider) DO UPDATE SET active_batch_id=excluded.active_batch_id,activated_at=excluded.activated_at`;
  return { batchId, inserted: plan.rows.length, idempotent: false };
}

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
