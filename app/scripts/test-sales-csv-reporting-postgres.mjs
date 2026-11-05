// Entirely synthetic Docker PostgreSQL validation. No production environment,
// source CSV, network provider, message recipient or credentials are read.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { parseSalesCsv, readCanonicalSalesEvidence, buildSalesImportPlan, writeReviewedSalesImport } from './sales-csv-import.mjs';

const container = `mindbliss-sales-report-test-${randomUUID()}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
 let sql, started = false, assertions = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
const migration = await readFile(new URL('../../_meta/migration/87_admin_sales_reporting.sql', import.meta.url), 'utf8');
const roles = await readFile(new URL('../../_meta/roles/admin_sales_reporting.sql', import.meta.url), 'utf8');
const header = ['id','Created date (UTC)','Amount','Amount Refunded','Currency','Captured','Description','Fee','Mode','PaymentIntent ID','Status','packmindbliss (metadata)','person_id (metadata)','package_id (metadata)','purchase_intent_id (metadata)'];
const quote = value => '"' + String(value).replaceAll('"','""') + '"';
const rawRows = [
 ['ch_synthetic0001','2026-09-21 02:00:19','101.00','0','usd','TRUE','synthetic','18.23','Live','pi_synthetic0001','Paid','TRUE','1','3','synthetic'],
 ['py_synthetic0002','2026-09-20 02:00:19','101.00','0','usd','TRUE','synthetic','3.23','Live','pi_synthetic0002','En Revisión','TRUE','1','3','synthetic'],
 ['ch_synthetic0003','2026-09-19 02:00:19','230.00','0','usd','TRUE','synthetic','6.97','Live','pi_synthetic0003','Paid','','','',''],
];
const preamble = [['','TOTAL CONSOLIDADO','','','$432.00'],['','Reserva de riesgo','','','$30.30'],['','Pagos wallet 1','','','$17.00'],['','Pagos wallet 2','','','$14.00'],['','Entrante','','','$6.70'],['','Radar Review','','','$100.00']];
const bytes = Buffer.from([...preamble,header,...rawRows].map(row => row.map(quote).join(',')).join('\r\n'));
try {
 docker(['run','--detach','--name',container,'--env','POSTGRES_PASSWORD=synthetic-only','--env','POSTGRES_DB=sales_reporting_test','--publish','127.0.0.1::5432','postgres:18.6-alpine3.23']); started = true;
 const inspected = JSON.parse(docker(['inspect',container]));
 const port = Number(inspected[0].NetworkSettings.Ports['5432/tcp'][0].HostPort);
 assert(Number.isSafeInteger(port) && port > 0);
 for (let attempt = 0; attempt < 60; attempt++) {
  try { docker(['exec',container,'pg_isready','--username','postgres','--dbname','sales_reporting_test']); break; }
  catch { if (attempt === 59) throw Error('SYNTHETIC_DATABASE_START_FAILED'); await new Promise(resolve => setTimeout(resolve,250)); }
 }
 sql = postgres({ host:'127.0.0.1',port,username:'postgres',password:'synthetic-only',database:'sales_reporting_test',max:1,prepare:false,onnotice:()=>{} });
 await sql.unsafe(`CREATE ROLE sales_report_operator NOLOGIN INHERIT NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS;
 GRANT CREATE ON DATABASE sales_reporting_test TO sales_report_operator;
 SET ROLE sales_report_operator;`);
 await sql.unsafe(`
 CREATE SCHEMA payments;CREATE SCHEMA recovery;CREATE SCHEMA mlm;
 CREATE ROLE mindbliss_go_payments_reader_v1 NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 GRANT USAGE ON SCHEMA payments TO mindbliss_go_payments_reader_v1;
 CREATE TABLE mlm.person(id bigint PRIMARY KEY,email text,first_name text,last_name text);
 CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY);
 CREATE TABLE payments.stripe_sale(payment_intent_id text PRIMARY KEY,livemode boolean,payment_status text,currency text,metadata jsonb,product_evidence jsonb,captured_minor bigint,refunded_minor bigint,dispute_count integer,source_eligible boolean,charged_at timestamptz);
 CREATE TABLE payments.stripe_charge_settlement(charge_id text PRIMARY KEY,payment_intent_id text,fee_minor bigint);
 CREATE TABLE recovery.stripe_sale_identity(payment_intent_id text PRIMARY KEY,person_id bigint,affiliate_id bigint,identity_verified boolean,catalog_verified boolean);
 CREATE TABLE recovery.package_catalog_snapshot(source_package_id bigint,currency text,base_minor bigint,fee_minor bigint);
 CREATE TABLE payments.nowpayments_membership_attempt(id uuid PRIMARY KEY,provider text,purpose text,environment text,person_id bigint,affiliate_id bigint,package_id integer,package_name text,amount_usd numeric,total_cents bigint,currency text,state text,payment_id text,invoice_id text,created_at timestamptz,private_payload jsonb);
 CREATE TABLE payments.nowpayments_operational_order(attempt_id uuid PRIMARY KEY,affiliate_id bigint,activated_at timestamptz,state text,inflow_id bigint);
 CREATE TABLE payments.nowpayments_operational_inflow(id bigint PRIMARY KEY,attempt_id uuid,gross_usd numeric,provider_cost_usd numeric,net_usd numeric,payment_ref text);
 CREATE TABLE payments.nowpayments_membership_receipt(attempt_id uuid,environment text,payment_id text,finished_verified boolean,multiple_payments boolean,received_at timestamptz,signed_evidence jsonb);
 CREATE TABLE payments.nowpayments_webhook_capture(environment text,payment_id text,matched_attempt_id uuid,disposition text,risk_detected boolean,order_id text,invoice_id text,signed_evidence jsonb);
 INSERT INTO mlm.person VALUES(1,'synthetic@example.invalid','Synthetic','Member');INSERT INTO mlm.affiliate VALUES(1);
 INSERT INTO recovery.package_catalog_snapshot VALUES(3,'usd',10000,100);
 INSERT INTO payments.stripe_sale VALUES('pi_synthetic0001',true,'succeeded','usd','{"packmindbliss":"true","package_id":"3","person_id":"1"}','[{}]',10100,0,1,false,'2026-09-21T02:00:19Z'),('pi_synthetic0002',true,'succeeded','usd','{"packmindbliss":"true","package_id":"3","person_id":"1"}','[{}]',10100,0,0,true,'2026-09-20T02:00:19Z');
 INSERT INTO payments.stripe_charge_settlement VALUES('ch_synthetic0001','pi_synthetic0001',323),('py_synthetic0002','pi_synthetic0002',323);
 INSERT INTO recovery.stripe_sale_identity VALUES('pi_synthetic0001',1,1,true,true),('pi_synthetic0002',1,1,true,true);
 INSERT INTO payments.nowpayments_membership_attempt VALUES('11111111-1111-4111-8111-111111111111','nowpayments','membership','production',1,1,50,'USD 50',50,5000,'usd','pending_review','123','456',now(),'{"secret":"not available to reporter"}');
 INSERT INTO payments.nowpayments_operational_order VALUES('11111111-1111-4111-8111-111111111111',1,now(),'activated',1);
 INSERT INTO payments.nowpayments_operational_inflow VALUES(1,'11111111-1111-4111-8111-111111111111',50,.5,49.5,'nowpayments:production:123');
 INSERT INTO payments.nowpayments_membership_receipt VALUES('11111111-1111-4111-8111-111111111111','production','123',true,false,now(),'{"secret":"not available to reporter"}');
 -- Open invoice is deliberately large: must never inflate captured revenue.
 INSERT INTO payments.nowpayments_membership_attempt SELECT '22222222-2222-4222-8222-222222222222','nowpayments','membership','production',1,1,5000,'USD 5000',5000,500000,'usd','invoice_created',NULL,'789',now(),'{}';
 INSERT INTO payments.nowpayments_operational_order VALUES('22222222-2222-4222-8222-222222222222',1,NULL,'awaiting_payment',NULL);
 `);
 await sql.unsafe(migration);
 await sql.unsafe(roles);
 const source = parseSalesCsv(bytes);
 const plan = await sql.begin('read only', async tx => buildSalesImportPlan(source,await readCanonicalSalesEvidence(tx,source)));
 check(plan.controls.included_totals.rows,2); check(plan.controls.excluded_totals.rows,1);
 check(plan.controls.canonical_evidence.fee_discrepancy_minor,'1500');
 const batchId = randomUUID();
 const first = await sql.begin(async tx => writeReviewedSalesImport(tx,plan,{batchId,sourceName:'unified_payments(1) - Stripe Dashboard.csv'}));
 check(first.inserted,3); check(first.idempotent,false);
 const repeat = await sql.begin(async tx => writeReviewedSalesImport(tx,plan,{batchId:randomUUID(),sourceName:'unified_payments(1) - Stripe Dashboard.csv'}));
 check(repeat.inserted,0); check(repeat.idempotent,true); check(repeat.batchId,batchId);
 const [summary] = await sql`SELECT count(*)::int AS sales,sum(gross_minor)::text AS gross,sum(fee_minor)::text AS fees,count(*) FILTER(WHERE risk_status='disputed')::int AS disputed FROM payments.v_admin_sales`;
 check(summary,{sales:3,gross:'25200',fees:'2196',disputed:1});
 const nowRows = await sql`SELECT display_status,source_status,fee_minor::text,verified_fee_minor,fee_reconciliation_status FROM payments.v_admin_sales WHERE provider='nowpayments'`;
 check(nowRows.map(row=>({...row})),[{display_status:'activated',source_status:'finished',fee_minor:'50',verified_fee_minor:null,fee_reconciliation_status:'unavailable'}]);
 for (const [invalid,restore] of [
  ["UPDATE payments.nowpayments_membership_attempt SET environment='sandbox' WHERE payment_id='123'","UPDATE payments.nowpayments_membership_attempt SET environment='production' WHERE payment_id='123'"],
  ["UPDATE payments.nowpayments_membership_attempt SET purpose='wallet_topup' WHERE payment_id='123'","UPDATE payments.nowpayments_membership_attempt SET purpose='membership' WHERE payment_id='123'"],
  ["UPDATE payments.nowpayments_membership_attempt SET total_cents=9999 WHERE payment_id='123'","UPDATE payments.nowpayments_membership_attempt SET total_cents=5000 WHERE payment_id='123'"],
  ["UPDATE payments.nowpayments_operational_inflow SET payment_ref='wrong-reference' WHERE id=1","UPDATE payments.nowpayments_operational_inflow SET payment_ref='nowpayments:production:123' WHERE id=1"],
  ["UPDATE payments.nowpayments_membership_receipt SET payment_id='wrong-payment'","UPDATE payments.nowpayments_membership_receipt SET payment_id='123'"],
  ["UPDATE payments.nowpayments_membership_receipt SET finished_verified=false","UPDATE payments.nowpayments_membership_receipt SET finished_verified=true"],
  ["UPDATE payments.nowpayments_operational_order SET activated_at=NULL WHERE inflow_id=1","UPDATE payments.nowpayments_operational_order SET activated_at=now() WHERE inflow_id=1"],
 ]) {
  await sql.unsafe(invalid);
  const [rejected] = await sql`SELECT count(*)::int AS rows FROM payments.v_admin_sales WHERE provider='nowpayments'`;
  check(rejected.rows,0);
  await sql.unsafe(restore);
 }
 // Authenticated evidence for a different environment/payment/order/invoice
 // cannot contaminate this capture. No raw payload is needed by the view.
 await sql.unsafe(`INSERT INTO payments.nowpayments_webhook_capture VALUES
  ('sandbox','123','11111111-1111-4111-8111-111111111111','matched',true,'11111111-1111-4111-8111-111111111111','456','{}'),
  ('production','999','11111111-1111-4111-8111-111111111111','matched',true,'11111111-1111-4111-8111-111111111111','456','{}'),
  ('production','123',NULL,'quarantined',true,'22222222-2222-4222-8222-222222222222','456','{}'),
  ('production','123',NULL,'quarantined',true,'11111111-1111-4111-8111-111111111111','999','{}');`);
 const [unrelatedRisk] = await sql`SELECT risk_status,commission_eligible FROM payments.v_admin_sales WHERE provider='nowpayments'`;
 check(unrelatedRisk,{risk_status:'none',commission_eligible:true});
 await sql.unsafe(`INSERT INTO payments.nowpayments_webhook_capture VALUES('production','123','11111111-1111-4111-8111-111111111111','matched',true,'11111111-1111-4111-8111-111111111111','456','{}')`);
 const [matchedRisk] = await sql`SELECT display_status,risk_status,commission_eligible,gross_minor::text FROM payments.v_admin_sales WHERE provider='nowpayments'`;
 check(matchedRisk,{display_status:'under_review',risk_status:'source_review',commission_eligible:false,gross_minor:'5000'});
 await sql`DELETE FROM payments.nowpayments_webhook_capture`;
 await sql.unsafe(`INSERT INTO payments.nowpayments_webhook_capture VALUES('production','123',NULL,'quarantined',false,'11111111-1111-4111-8111-111111111111','456','{}')`);
 const [quarantinedRisk] = await sql`SELECT display_status,risk_status,commission_eligible,gross_minor::text FROM payments.v_admin_sales WHERE provider='nowpayments'`;
 check(quarantinedRisk,{display_status:'under_review',risk_status:'source_review',commission_eligible:false,gross_minor:'5000'});
 await sql`DELETE FROM payments.nowpayments_webhook_capture`;
 await sql`UPDATE payments.nowpayments_operational_order SET state='risk_review' WHERE inflow_id=1`;
 const [held] = await sql`SELECT display_status,risk_status,commission_eligible FROM payments.v_admin_sales WHERE provider='nowpayments'`;
 check(held,{display_status:'under_review',risk_status:'source_review',commission_eligible:false});
 // Receipt duplicates cannot multiply rows or previously received money.
 await sql`INSERT INTO payments.nowpayments_membership_receipt SELECT attempt_id,environment,payment_id,finished_verified,multiple_payments,received_at,signed_evidence FROM payments.nowpayments_membership_receipt`;
 const [dedup] = await sql`SELECT count(*)::int AS sales,sum(gross_minor)::text AS gross FROM payments.v_admin_sales`;
 check(dedup,{sales:3,gross:'25200'});
 const [owner] = await sql`SELECT rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,has_schema_privilege(oid,'payments','CREATE') AS schema_create FROM pg_roles WHERE rolname='mindbliss_sales_report_owner_20261102'`;
 check(Object.values(owner).every(value=>value===false),true);
 const [columnAcl] = await sql`SELECT has_column_privilege('mindbliss_sales_report_owner_20261102','payments.nowpayments_membership_receipt','signed_evidence','SELECT') AS raw_ipn,has_column_privilege('mindbliss_sales_report_owner_20261102','payments.nowpayments_membership_attempt','private_payload','SELECT') AS private_attempt,has_table_privilege('mindbliss_go_payments_reader_v1','payments.sales_import_row','SELECT') AS base_rows,has_table_privilege('mindbliss_go_payments_reader_v1','payments.nowpayments_operational_inflow','SELECT') AS base_now`;
 check(Object.values(columnAcl).every(value=>value===false),true);
 const [operatorAcl] = await sql`SELECT current_user='sales_report_operator' AS operator_restored,
  NOT pg_has_role(current_user,'mindbliss_sales_report_owner_20261102','SET') AS owner_set_revoked,
  NOT pg_has_role(current_user,'mindbliss_sales_report_owner_20261102','USAGE') AS owner_inherit_revoked,
  has_table_privilege(current_user,'payments.v_admin_sales','SELECT') AS explicit_read`;
 check(Object.values(operatorAcl).every(value=>value===true),true);
 const [operatorMembership] = await sql`SELECT coalesce(bool_and(NOT m.set_option AND NOT m.inherit_option),false) AS restored,
  bool_or(m.admin_option) AS administrative_only FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
  WHERE r.rolname='mindbliss_sales_report_owner_20261102' AND m.member=(SELECT oid FROM pg_roles WHERE rolname='sales_report_operator')`;
 check(operatorMembership,{restored:true,administrative_only:true});
 await sql`SET ROLE mindbliss_go_payments_reader_v1`;
 const [visible] = await sql`SELECT count(*)::int AS rows FROM payments.v_admin_sales`;
 check(visible.rows,3);
 const [metadata] = await sql`SELECT count(*)::int AS batches FROM payments.v_admin_sales_import_batch b JOIN payments.v_admin_sales_source s ON s.active_batch_id=b.id WHERE s.provider='stripe'`;
 check(metadata.batches,1);
 await sql`RESET ROLE`;
 for (const query of ['UPDATE payments.sales_import_row SET fee_minor=0','DELETE FROM payments.sales_import_batch','TRUNCATE payments.sales_import_row']) {
  await assert.rejects(sql.unsafe(query), error => error.code==='23514'); assertions++;
 }
 const [original] = await sql`SELECT (SELECT count(*)::int FROM payments.stripe_sale) AS sales,(SELECT sum(fee_minor)::text FROM payments.stripe_charge_settlement) AS verified_fee`;
 check(original,{sales:2,verified_fee:'646'});
 console.log(JSON.stringify({event:'synthetic-sales-import-postgres-pass',assertions,productionWrites:0,providerCalls:0,unpaidInvoicesExcluded:true,quarantinedRowsExcluded:true,duplicateReceiptsDeduplicated:true,sourceDisputeAndFeeEvidencePreserved:true,leastPrivilegeViews:true}));
} catch (error) {
 console.log(JSON.stringify({event:'synthetic-sales-import-postgres-failed',code:error?.code || (/^[A-Z_]+$/.test(error?.message||'') ? error.message : 'REDACTED'),assertions,productionWrites:0}));
 if(error instanceof assert.AssertionError) console.log(JSON.stringify({assertion:error.message}));
 process.exitCode=1;
} finally {
 if(sql) await sql.end({timeout:2});
 if(started) docker(['rm','--force',container]);
}
