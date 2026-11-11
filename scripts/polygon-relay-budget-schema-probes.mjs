import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Uses only synthetic SQL proofs in a labelled PostgreSQL fixture with no
 * network. Never loads credentials, calls providers, signs or sends funds. */
export async function runPolygonRelayBudgetProbes({container,docker,psql,value,parallelPsql,role,database}) {
 let probes=0;
 const eq=(source,expected,runtime=true)=>{assert.equal(value(source,runtime),expected);probes++;};
 const deny=(source,pattern,runtime=true)=>{const result=psql(`${runtime?`SET ROLE ${role};`:''}${source}`,true);
  assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(pattern));probes++;};
 assert.equal(docker(['inspect','--format','{{.HostConfig.NetworkMode}}',container]).stdout.trim(),'none');
 assert.match(container,/^mb-(polygon-relay|wallet-funding)-test-[a-f0-9-]{36}$/);
 assert.equal(database,'mindbliss_curated_20261025');assert.equal(role,'mindbliss_auth_core_v1');
 const migration=await readFile(new URL('../_meta/migration/107_personal_polygon_actual_gas_budget.sql',import.meta.url),'utf8');
 const users=Array.from({length:8},(_,index)=>({subject:`budget-synthetic-${index}`,address:`0x89${(index+1).toString(16).padStart(2,'0')}${'71'.repeat(18)}`,
  relay:`0x88${(index+1).toString(16).padStart(2,'0')}${'72'.repeat(18)}`}));
 psql(`INSERT INTO auth."user"(id,eligible,email,name) VALUES ${users.map(user=>`('${user.subject}',true,'${user.subject}@example.invalid','Synthetic budget fixture')`).join(',')};
  INSERT INTO identity.wallet_binding(subject,address) VALUES ${users.map(user=>`('${user.subject}','${user.address}')`).join(',')};`);
 const hash=text=>`0x${createHash('sha256').update(`synthetic-budget:${text}`).digest('hex')}`;
 const cipher=`v1.${'a'.repeat(16)}.${'b'.repeat(64)}.${'c'.repeat(22)}`;
 const entry='0x0000000071727de22e5e9d8baf0edac6f37da032',implementation='0x90040487a6c9f949c4f07cadcfb0f3b8eeab4229';
 const budget=index=>`SELECT payments.polygon_relay_budget_total(${index===null?'NULL':`'${users[index].subject}'`})::text;`;
 const prepare=(index,id,nonce='0',caps={})=>`SELECT status FROM payments.prepare_personal_polygon_relay('${users[index].subject}',
  '${users[index].address}','30000000','${id}','${nonce}','${hash(id)}','${users[index].relay}','${entry}','${hash('domain')}','${implementation}',
  '100','${caps.owner||'200'}','${caps.global||'10000000000000000000'}');`;
 const authorize=(index,id)=>`SELECT status FROM payments.authorize_personal_polygon_relay('${users[index].subject}','${id}','${hash(id)}','${cipher}','v1');`;
 const begin=(index,id,attempt,nonce)=>`SELECT should_prepare FROM payments.begin_personal_polygon_relay('${users[index].subject}','${id}','${attempt}','${nonce}');`;
 const lease=(index,id)=>value(`SELECT lease_token FROM payments.read_personal_polygon_relay('${users[index].subject}','${id}');`);
 const persist=(index,id,attempt,nonce,until=Math.floor(Date.now()/1000)+300)=>{
  const token=lease(index,id),op=hash(attempt);
  eq(`SELECT should_send FROM payments.persist_personal_polygon_relay_operation('${users[index].subject}','${id}','${attempt}','${token}',
   '${op}','${cipher}','v1',0,${until},'80');`,'t');
  return {op,token,until,nonce};
 };
 const confirm=(index,id,attempt,cost)=>`SELECT status FROM payments.confirm_personal_polygon_relay('${users[index].subject}','${id}','${attempt}',
  '${hash(attempt)}','${hash('tx:'+attempt)}','140000001','${hash('block')}',12,'${cost}');`;
 const completed=[];
 function successful(index,nonce,cost) {
  const id=randomUUID(),attempt=randomUUID();eq(prepare(index,id,nonce),'prepared');eq(authorize(index,id),'authorized');
  eq(begin(index,id,attempt,nonce),'t');persist(index,id,attempt,nonce);eq(confirm(index,id,attempt,cost),'confirmed');
  completed.push({index,id,attempt,cost});return {id,attempt};
 }
 // Reproduce the live bug: two tiny completed costs exhausted a 2-reservation
 // allowance because both completions still counted their worst-case 100.
 successful(0,'0','3');successful(0,'1','5');eq(budget(0),'200',false);
 const third=randomUUID();deny(prepare(0,third,'2'),'polygon_relay_budget_exceeded');
 const rows=`SELECT md5(jsonb_build_object(
  'relay',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments.personal_polygon_relay p),
  'reservations',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments.personal_polygon_sponsor_reservation p),
  'outcomes',(SELECT jsonb_agg(to_jsonb(p) ORDER BY attempt_id) FROM payments.personal_polygon_relay_outcome p),
  'ledger',(SELECT jsonb_agg(m ORDER BY id) FROM mlm.wallet_movement m),
  'funding',(SELECT jsonb_agg(m ORDER BY id) FROM payments.reown_funding_intent m),
  'admin',(SELECT jsonb_agg(m ORDER BY id) FROM payments.meld_sandbox_funding_attempt m),
  'catalogue',(SELECT jsonb_agg(m ORDER BY id) FROM mlm.package m))::text);`;
 const oldRows=value(rows,false);
 const functionMeta=`SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'securityDefiner',prosecdef,'config',proconfig)::text
  FROM pg_proc WHERE oid='payments.polygon_relay_budget_total(text)'::regprocedure;`;
 const oldMeta=value(functionMeta,false);
 const otherFunctions=`SELECT md5(jsonb_agg(jsonb_build_array(p.oid,pg_get_functiondef(p.oid),p.proacl::text) ORDER BY p.oid)::text)
  FROM pg_proc p WHERE p.pronamespace='payments'::regnamespace AND p.proname<>'polygon_relay_budget_total';`;
 const oldFunctions=value(otherFunctions,false);
 psql(migration);
 eq(rows,oldRows,false);eq(functionMeta,oldMeta,false);eq(otherFunctions,oldFunctions,false);
 eq(budget(0),'8',false);eq(prepare(0,third,'2'),'prepared');eq(budget(0),'108',false);
 eq(`SELECT status FROM payments.abandon_personal_polygon_relay('${users[0].subject}','${third}');`,'expired');eq(budget(0),'8',false);
 deny(migration,'polygon_relay_actual_budget_requires_fresh_review',false);
 deny(budget(0),'permission denied');
 deny('SELECT * FROM payments.personal_polygon_relay_outcome;','permission denied');
 deny('UPDATE payments.personal_polygon_sponsor_reservation SET max_fee_wei=\'1\';','permission denied');
 for(const record of completed) {
  eq(confirm(record.index,record.id,record.attempt,record.cost),'confirmed');
  deny(confirm(record.index,record.id,record.attempt,'1'),'polygon_relay_receipt_conflict');
 }
 eq(budget(0),'8',false);
 // Native authorization remains nonexpiring, so pending work always retains
 // the complete reservation, including an ambiguous external send.
 const held=randomUUID(),heldAttempt=randomUUID();
 eq(prepare(1,held),'prepared');eq(budget(1),'100',false);
 eq(authorize(1,held),'authorized');eq(budget(1),'100',false);
 eq(begin(1,held,heldAttempt,'0'),'t');persist(1,held,heldAttempt,'0');
 eq(`SELECT status FROM payments.mark_personal_polygon_relay_ambiguous('${users[1].subject}','${held}','${heldAttempt}');`,'ambiguous');
 eq(budget(1),'100',false);deny(`SELECT status FROM payments.abandon_personal_polygon_relay('${users[1].subject}','${held}');`,'polygon_relay_operation_locked');
 // A reverted operation followed by a successful retry must charge both
 // distinct receipts, not repeat the mutable payment's final actual cost.
 const retried=randomUUID(),revertedAttempt=randomUUID(),retryAttempt=randomUUID();
 eq(prepare(2,retried),'prepared');eq(authorize(2,retried),'authorized');eq(begin(2,retried,revertedAttempt,'0'),'t');persist(2,retried,revertedAttempt,'0');
 eq(`SELECT status FROM payments.reject_personal_polygon_relay('${users[2].subject}','${retried}','${revertedAttempt}',
  '${hash(revertedAttempt)}','${hash('revert:'+revertedAttempt)}','140000002','${hash('block')}',12,'5','user_operation_reverted','0');`,'authorized');
 eq(budget(2),'5',false);eq(begin(2,retried,retryAttempt,'1'),'t');eq(budget(2),'105',false);persist(2,retried,retryAttempt,'1');
 eq(confirm(2,retried,retryAttempt,'7'),'confirmed');eq(budget(2),'12',false);
 // The SQL receipt contract historically allows zero; the chain verifier does
 // not. Such an outcome is not proof of real gas and keeps the full reserve.
 successful(3,'0','0');eq(budget(3),'100',false);
 // Only the disposable fixture owner can insert a deliberately corrupt outcome.
 // Roll back every case; production/runtime cannot insert or rewrite receipts.
 const malformed=randomUUID(),malformedAttempt=randomUUID();
 eq(prepare(7,malformed),'prepared');eq(authorize(7,malformed),'authorized');eq(begin(7,malformed,malformedAttempt,'0'),'t');
 persist(7,malformed,malformedAttempt,'0');
 for(const cost of ['-1','nonsense','99999999999999999999','101','01']) {
  eq(`BEGIN;INSERT INTO payments.personal_polygon_relay_outcome(attempt_id,payment_id,result,user_operation_hash,transaction_hash,
   block_number,block_hash,confirmations,actual_gas_cost_wei) VALUES('${malformedAttempt}','${malformed}','confirmed','${hash(malformedAttempt)}',
   '${hash('tx:'+malformedAttempt)}','140000004','${hash('block')}',12,'${cost}');
   SELECT payments.polygon_relay_close_dispatch('${malformed}','${malformedAttempt}','confirmed');${budget(7)}ROLLBACK;`,'100',false);
 }
 eq(`SELECT count(*) FROM payments.personal_polygon_relay_outcome WHERE attempt_id='${malformedAttempt}';`,'0',false);
 eq(`SELECT state FROM payments.personal_polygon_sponsor_reservation WHERE attempt_id='${malformedAttempt}';`,'held',false);
 // An expired operation has no gas receipt. Even with canonical nonexecution
 // evidence this minimal fix conservatively keeps its full unknown-cost spend.
 const expired=randomUUID(),expiredAttempt=randomUUID();
 eq(prepare(4,expired),'prepared');eq(authorize(4,expired),'authorized');eq(begin(4,expired,expiredAttempt,'0'),'t');
 const expiry=Math.floor(Date.now()/1000)+5;
 persist(4,expired,expiredAttempt,'0',expiry);
 while(Math.floor(Date.now()/1000)<=expiry)await delay(100);
 eq(`SELECT status FROM payments.expire_personal_polygon_relay_operation('${users[4].subject}','${expired}','${expiredAttempt}',
  '${hash(expiredAttempt)}','140000003','${hash('block')}',${Math.floor(Date.now()/1000)},'0',12,'0');`,'authorized');
 eq(budget(4),'100',false);
 eq(`SELECT count(*) FROM payments.personal_polygon_relay_outcome WHERE attempt_id='${expiredAttempt}';`,'0',false);
 // Real PostgreSQL sessions must still serialize the global allowance. The
 // smaller actual-spend calculation must not turn into a check/insert race.
 const before=BigInt(value(budget(null),false)),cap=(before+150n).toString(),races=[randomUUID(),randomUUID()];
 const race=await Promise.all(races.map((id,index)=>parallelPsql(prepare(5+index,id,'0',{global:cap}))));
 assert.equal(race.filter(result=>result.status===0).length,1);probes++;
 assert.equal(race.filter(result=>result.status!==0&&/polygon_relay_budget_exceeded/.test(result.stderr)).length,1);probes++;
 eq(budget(null),(before+100n).toString(),false);
 const count=value(budget(null),false);
 eq(`SET TIME ZONE 'Pacific/Honolulu';${budget(null)}`,count,false);
 eq(`SET TIME ZONE 'Asia/Tokyo';${budget(null)}`,count,false);
 const newFingerprint=value("SELECT md5(pg_get_functiondef('payments.polygon_relay_budget_total(text)'::regprocedure));",false);
 await writeFile(new URL('../.wrangler/polygon-relay-schema/manifest-107.json',import.meta.url),JSON.stringify({
  migrationSha256:createHash('sha256').update(migration).digest('hex'),budgetFunctionMd5:newFingerprint,probes,
  accounting:'per-attempt canonical actual cost; held and unknown spent retain full reserve',
  oidOwnerAclUnchanged:true,otherFinancialRowsUnchangedByMigration:true,otherFunctionsUnchanged:true,
  externalNetwork:'disabled',productionConnections:0,realTransfers:0,actualCharges:0},null,2));
 console.log(JSON.stringify({polygonRelayActualBudgetSql:'passed',probes,budgetFunctionMd5:newFingerprint,
  twoSmallPaymentsDoNotExhaustReservedMaximum:true,confirmedAndRevertedAttemptsCountSeparately:true,
  heldAndUnknownRemainConservative:true,globalBudgetRaceSerialized:true,externalNetwork:'disabled',productionConnections:0,realTransfers:0,actualCharges:0}));
}
