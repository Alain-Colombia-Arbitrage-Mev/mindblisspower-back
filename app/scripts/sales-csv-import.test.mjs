import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeCsv, usdMinor, parseSalesCsv, buildSalesImportPlan } from './sales-csv-import.mjs';

const header = ['id', 'Created date (UTC)', 'Amount', 'Amount Refunded', 'Currency', 'Captured', 'Description', 'Fee', 'Mode', 'PaymentIntent ID', 'Status', 'packmindbliss (metadata)', 'person_id (metadata)', 'package_id (metadata)', 'purchase_intent_id (metadata)'];
const row = (override = {}) => ({ id: 'ch_synthetic0001', 'Created date (UTC)': '2026-09-21 02:00:19', Amount: '101.00', 'Amount Refunded': '0.00', Currency: 'usd', Captured: 'TRUE', Description: '=HYPERLINK("https://invalid.example", "not executed")', Fee: '3.23', Mode: 'Live', 'PaymentIntent ID': 'pi_synthetic0001', Status: 'Paid', 'packmindbliss (metadata)': 'TRUE', 'person_id (metadata)': '22', 'package_id (metadata)': '3', 'purchase_intent_id (metadata)': '11111111-1111-4111-8111-111111111111', ...override });
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
function csv(records = [row()], customHeader = header) {
  const preamble = [
    ['', 'TOTAL CONSOLIDADO', '', '', '$101.00'], ['', 'Reserva de riesgo', '', '', '$30.30'],
    ['', 'Pagos wallet 1', '', '', '$17.00'], ['', 'Pagos wallet 2', '', '', '$14.00'],
    ['', 'Entrante', '', '', '$6.70'], ['', 'Radar Review', '', '', '$33.00'],
  ];
  return Buffer.from([...preamble, customHeader, ...records.map(record => customHeader.map(key => record[key] || ''))].map(values => values.map(quote).join(',')).join('\r\n'));
}
const evidence = (override = {}) => ({ external_id: 'pi_synthetic0001', canonical_pi: true, canonical_charge: true,
  charge_pi_matches: true, livemode: true, payment_status: 'succeeded', currency: 'usd', product_marked: true,
  product_evidence: true, captured_minor: '10100', refunded_minor: '0', dispute_count: 0, source_eligible: true,
  charged_at: '2026-09-21T02:00:19.000Z', metadata_package_id: '3', metadata_person_id: '22', verified_fee_minor: '323',
  identity_verified: true, catalog_verified: true, person_id: '22', affiliate_id: '33', buyer_email: 'synthetic@example.invalid',
  buyer_name: 'Synthetic Member', catalog_package_id: '3', base_minor: '10000', ...override });

test('RFC4180 tokenizer preserves quoted commas, escaped quotes and embedded CRLF without executing formulas', () => {
  assert.deepEqual(tokenizeCsv('"a,b","c""d","line\r\nnext"\r\n'), [['a,b', 'c"d', 'line\r\nnext']]);
  const parsed = parseSalesCsv(csv());
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0].gross_minor, '10100');
  assert.equal(Object.hasOwn(parsed.rows[0], 'Description'), false);
});
test('strict quote handling rejects trailing characters and unterminated cells', () => {
  for (const value of ['"closed"extra,cell', 'prefix"quoted",cell', '"unterminated']) assert.throws(() => tokenizeCsv(value));
});
test('money uses exact cents, validates grouping and rejects signs, exponents, excess precision or nonfinite values', () => {
  assert.equal(usdMinor('$88,588.00'), '8858800'); assert.equal(usdMinor('0.5'), '50');
  for (const value of ['1,23.00', '-1.00', '1e3', '1.001', 'NaN', 'Infinity', '']) assert.throws(() => usdMinor(value));
});
test('source byte hash, header offset and two source statuses are kept separate from provider confirmation', () => {
  const source = parseSalesCsv(csv());
  assert.match(source.file_sha256, /^[a-f0-9]{64}$/); assert.equal(source.header_row, 7);
  assert.equal(source.rows[0].source_status, 'Paid'); assert.equal(source.rows[0].display_status, 'paid');
  assert.equal(source.statement.reconciled, false); assert.equal(source.statement.amounts.declared_company_payout_minor, '3100');
});
test('invalid UTF-8 and NUL inputs are rejected without exposing data', () => {
  assert.throws(() => parseSalesCsv(Uint8Array.from([0xc3, 0x28])), /CSV_ENCODING_INVALID/);
  assert.throws(() => parseSalesCsv(Buffer.from('id\x00')), /CSV_NUL_INVALID/);
});
test('headers and row widths must be unique and exact', () => {
  assert.throws(() => parseSalesCsv(csv([row()], [...header, 'Status'])), /CSV_HEADERS_INVALID/);
  assert.throws(() => parseSalesCsv(Buffer.concat([csv(), Buffer.from(',extra')])), /CSV_ROW_WIDTH_INVALID/);
  assert.throws(() => parseSalesCsv(csv([row()], header.filter(key => key !== 'Fee'))), /CSV_HEADERS_INVALID/);
});
test('duplicate charge or PaymentIntent cannot double count a sale', () => {
  assert.throws(() => parseSalesCsv(csv([row(), row({ id: 'ch_synthetic0002' })])), /CSV_DUPLICATE_PROVIDER_ID/);
  assert.throws(() => parseSalesCsv(csv([row(), row({ 'PaymentIntent ID': 'pi_synthetic0002' })])), /CSV_DUPLICATE_PROVIDER_ID/);
});
test('Cash App py_ charge identifiers remain valid exact provider references', () => {
  const source = parseSalesCsv(csv([row({ id: 'py_synthetic0001' })]));
  assert.equal(source.rows[0].provider_reference, 'py_synthetic0001');
});
test('test mode, nonUSD, uncaptured and unreviewed status cannot become imported captures', () => {
  for (const change of [{ Mode: 'Test' }, { Currency: 'eur' }, { Captured: 'FALSE' }]) assert.throws(() => parseSalesCsv(csv([row(change)])), /CSV_NOT_LIVE_CAPTURED_USD/);
  assert.throws(() => parseSalesCsv(csv([row({ Status: 'succeeded' })])), /CSV_STATUS_UNREVIEWED/);
});
test('provider ID, UTC date rollover and amount limits are validated', () => {
  for (const change of [{ id: 'ch_bad' }, { 'PaymentIntent ID': 'pi_bad' }, { 'Created date (UTC)': '2026-02-30 02:00:19' }, { Amount: '0' }, { 'Amount Refunded': '102' }]) assert.throws(() => parseSalesCsv(csv([row(change)])));
});
test('canonical product evidence, exact charge pair and captured amount are required for marked membership', () => {
  const source = parseSalesCsv(csv());
  for (const change of [{ canonical_charge: false }, { charge_pi_matches: false }, { product_evidence: false }, { livemode: false }, { currency: 'eur' }]) assert.throws(() => buildSalesImportPlan(source, [evidence(change)]), /MARKED_PRODUCT_NOT_CORROBORATED/);
  assert.throws(() => buildSalesImportPlan(source, [evidence({ captured_minor: '9999' })]), /CANONICAL_GROSS_CONFLICT/);
});
test('unattributed product rows are preserved privately but excluded from membership totals and all identity linkage', () => {
  const source = parseSalesCsv(csv([row({ 'packmindbliss (metadata)': '', 'person_id (metadata)': '', 'package_id (metadata)': '' })]));
  const plan = buildSalesImportPlan(source, [evidence({ canonical_pi: false, canonical_charge: false, captured_minor: null })]);
  assert.equal(plan.controls.source_totals.rows, 1); assert.equal(plan.controls.included_totals.rows, 0);
  assert.equal(plan.controls.excluded_totals.gross_minor, '10100');
  assert.equal(plan.rows[0].product_scope, 'unattributed'); assert.equal(plan.rows[0].person_id, null);
  assert.equal(plan.rows[0].buyer_email, ''); assert.equal(plan.rows[0].package_id, null);
});
test('source Paid never erases canonical dispute, refund or source eligibility evidence', () => {
  const source = parseSalesCsv(csv());
  const plan = buildSalesImportPlan(source, [evidence({ dispute_count: 1, source_eligible: false })]);
  assert.equal(plan.rows[0].display_status, 'paid'); assert.equal(plan.rows[0].risk_status, 'disputed');
  assert.equal(plan.controls.canonical_evidence.disputed_gross_minor, '10100');
  assert.throws(() => buildSalesImportPlan(source, [evidence({ refunded_minor: '10100' })]), /CANONICAL_REFUND_CONFLICT/);
});
test('reported fees do not overwrite verified settlement fees and discrepancy remains explicit', () => {
  const source = parseSalesCsv(csv([row({ Fee: '18.23' })]));
  const plan = buildSalesImportPlan(source, [evidence()]);
  assert.equal(plan.rows[0].fee_minor, '1823'); assert.equal(plan.rows[0].verified_fee_minor, '323');
  assert.equal(plan.rows[0].fee_reconciliation_status, 'discrepancy');
  assert.equal(plan.controls.canonical_evidence.fee_discrepancy_minor, '1500');
});
test('unverified identity and unverified catalog do not infer user or plan from matching emails/prices', () => {
  const source = parseSalesCsv(csv());
  const plan = buildSalesImportPlan(source, [evidence({ identity_verified: false, catalog_verified: false })]);
  assert.equal(plan.rows[0].person_id, null); assert.equal(plan.rows[0].affiliate_id, null);
  assert.equal(plan.rows[0].buyer_email, ''); assert.equal(plan.rows[0].base_minor, null);
});
test('CSV source is report-only and cannot confirm a provider status or replay compensation', () => {
  const plan = buildSalesImportPlan(parseSalesCsv(csv()), [evidence()]);
  assert.equal(plan.rows[0].commission_eligible, false); assert.equal(plan.rows[0].provider_verified, false);
  assert.equal(plan.rows[0].activation_status, 'not_inferred_from_import');
  assert.match(plan.plan_sha256, /^[a-f0-9]{64}$/); assert.match(plan.rows[0].record_sha256, /^[a-f0-9]{64}$/);
});
test('source statement and detail review discrepancy is explicit, never reconciled as current cash', () => {
  const source = parseSalesCsv(csv([row({ Status: 'En Revisión', Amount: '33.24' })]));
  const plan = buildSalesImportPlan(source, [evidence({ captured_minor: '3324', catalog_verified: false })]);
  assert.equal(plan.controls.statement_reconciliation.review_difference_minor, '24');
  assert.equal(plan.controls.statement_reconciliation.reconciled, false); assert.equal(plan.statement.reconciled, false);
});
test('conflicting source metadata cannot silently reattribute a corroborated sale', () => {
  const source = parseSalesCsv(csv());
  assert.throws(() => buildSalesImportPlan(source, [evidence({ metadata_package_id: '9' })]), /CANONICAL_PACKAGE_METADATA_CONFLICT/);
  assert.throws(() => buildSalesImportPlan(source, [evidence({ metadata_person_id: '99' })]), /CANONICAL_PERSON_METADATA_CONFLICT/);
});
