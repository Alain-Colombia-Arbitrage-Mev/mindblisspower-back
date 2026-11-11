import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function saveSyntheticBaseline({container,docker,database,inputHash,directory}){
 const check=docker(['inspect','--format','{{ index .Config.Labels "mindbliss.synthetic" }}',container]);
 assert.equal(check.stdout.trim(),'wallet-funding-schema');assert.match(container,/^mb-wallet-funding-test-[a-f0-9-]{36}$/);
 const output=docker(['exec',container,'pg_dump','-U','postgres','-d',database,'--no-owner']);assert.equal(output.status,0);
 const source=output.stdout;
 await writeFile(new URL('synthetic-baseline.sql',directory),source);
 await writeFile(new URL('synthetic-baseline.json',directory),JSON.stringify({synthetic:'wallet-funding-schema-v1',inputHash,
  sha256:createHash('sha256').update(source).digest('hex'),network:'none',hostPorts:0,productionConnections:0}));
}

export async function runPolygonRelayProbes(context){
 const {container,docker,psql,value,role,database}=context;let probes=0;
 const ownership=docker(['inspect','--format','{{ index .Config.Labels "mindbliss.synthetic" }} {{ .HostConfig.NetworkMode }}',container]);
 assert.ok(['wallet-funding-schema none','polygon-relay-schema none'].includes(ownership.stdout.trim()));
 assert.match(container,/^mb-(wallet-funding|polygon-relay)-test-[a-f0-9-]{36}$/);
 assert.equal(database,'mindbliss_curated_20261025');assert.equal(role,'mindbliss_auth_core_v1');
 const eq=(source,expected,runtime=true)=>{assert.equal(value(source,runtime),expected);probes++;};
 const reject=(source,pattern,runtime=true)=>{const result=psql(`${runtime?`SET ROLE ${role};`:''}${source}`,true);
  assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(pattern));probes++;};
 const relayMigration=await readFile(new URL('../_meta/migration/105_personal_polygon_sponsored_relay.sql',import.meta.url),'utf8');
 const bindingMigration=await readFile(new URL('../_meta/migration/103_solana_wallet_binding.sql',import.meta.url),'utf8');
 const owners=[['relay-success','0x1563915e194d8cfba1943570603f7606a3115508'],
  ['relay-ack-loss','0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb'],['relay-concurrent','0x7564105e977516c53be337314c7e53838967bdac']];
 const extra=Array.from({length:24},(_,index)=>[`relay-sql-${index}`,`0x95${(index+1).toString(16).padStart(2,'0')}${'9a'.repeat(18)}`]);
 psql(`ALTER TABLE auth."user" ADD COLUMN email text,ADD COLUMN email_verified boolean NOT NULL DEFAULT true,ADD COLUMN name text;
  ALTER TABLE identity.wallet_binding ADD COLUMN person_id bigint,ADD COLUMN chain_id integer NOT NULL DEFAULT 1,
   ADD COLUMN verified_at timestamptz NOT NULL DEFAULT now(),ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  GRANT INSERT ON identity.wallet_binding TO ${role};
  CREATE TABLE identity.auth_binding(subject text PRIMARY KEY,provider text NOT NULL,person_id bigint NOT NULL);
  CREATE TABLE mlm.person(id bigint PRIMARY KEY,public_id bigint NOT NULL,email text,status text,blacklisted boolean,user_id text,is_admin boolean,
   phone_number text,first_name text,last_name text,birthday date);
  CREATE TABLE mlm.affiliate(person_id bigint,status text);CREATE TABLE mlm.blacklist(email_norm text,phone_last10 text,name_norm text,birthdate date);
  CREATE FUNCTION mlm.norm_email(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT lower(trim($1))';
  CREATE FUNCTION mlm.norm_phone10(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT right($1,10)';
  CREATE FUNCTION mlm.norm_name(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT lower(trim($1))';
  INSERT INTO auth."user"(id,eligible,email,name) VALUES ${[...owners,...extra].map(([owner])=>`('${owner}',true,'${owner}@example.invalid','Synthetic')`).join(',')};
  INSERT INTO identity.wallet_binding(subject,address) VALUES ${[...owners,...extra].map(([owner,address])=>`('${owner}','${address}')`).join(',')};
  INSERT INTO identity.auth_binding VALUES ${owners.map(([owner],index)=>`('${owner}','better_auth',${2001+index})`).join(',')};
  INSERT INTO mlm.person(id,public_id,email,status,blacklisted,user_id,is_admin,first_name,last_name) VALUES
   ${owners.map(([owner],index)=>`(${2001+index},${2001+index},'${owner}@example.invalid','active',false,'${owner}',false,'Synthetic','Relay')`).join(',')};
  CREATE ROLE personal_flow_fixture LOGIN INHERIT;GRANT ${role} TO personal_flow_fixture;
  GRANT USAGE ON SCHEMA auth,identity,mlm,payments TO personal_flow_fixture;
  GRANT SELECT ON auth."user",identity.wallet_binding,identity.auth_binding,mlm.person,mlm.affiliate,mlm.blacklist TO personal_flow_fixture;
  ALTER DATABASE ${database} SET mindbliss.personal_wallet_flow_fixture='isolated-v1';`);
 psql(bindingMigration);
 const originalIds=JSON.parse(value('SELECT jsonb_agg(id)::text FROM payments.personal_company_payment;',false));
 const originalSnapshot=`SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM payments.personal_company_payment p WHERE id IN(${originalIds.map(id=>`'${id}'`).join(',')});`;
 const originalRows=value(originalSnapshot,false);
 const otherFinancial=`SELECT md5(jsonb_build_object('ledger',(SELECT jsonb_agg(m ORDER BY id) FROM mlm.wallet_movement m),
  'meld',(SELECT jsonb_agg(m ORDER BY id) FROM payments.meld_onramp_attempt m),
  'admin',(SELECT jsonb_agg(m ORDER BY id) FROM payments.meld_sandbox_funding_attempt m),
  'funding',(SELECT jsonb_agg(m ORDER BY id) FROM payments.reown_funding_intent m),
  'catalogue',(SELECT jsonb_agg(m ORDER BY id) FROM mlm.package m))::text);`;
 const otherRows=value(otherFinancial,false);
 const oldFunctions=`SELECT md5(jsonb_agg(jsonb_build_array(p.oid,pg_get_functiondef(p.oid),p.proacl::text) ORDER BY p.oid)::text)
  FROM pg_proc p WHERE p.pronamespace='payments'::regnamespace AND p.proname NOT IN(
   'guard_polygon_relay_append_only','guard_personal_transfer_request','guard_polygon_relay_attempt','guard_polygon_relay_reservation',
   'guard_polygon_relay_account','personal_transfer_creation_guard','personal_transfer_status_mirror','polygon_relay_budget_total',
   'polygon_relay_lock','polygon_relay_dispatch_result','polygon_relay_append_event','capture_polygon_relay_event','guard_personal_polygon_relay',
   'read_personal_polygon_relay','read_personal_polygon_relay_history','prepare_personal_polygon_relay','authorize_personal_polygon_relay',
   'begin_personal_polygon_relay','persist_personal_polygon_relay_operation','release_personal_polygon_relay_attempt',
   'mark_personal_polygon_relay_submitted','mark_personal_polygon_relay_ambiguous','expire_personal_polygon_relay','abandon_personal_polygon_relay',
   'polygon_relay_uint256','polygon_relay_receipt_input','polygon_relay_close_dispatch','confirm_personal_polygon_relay','reject_personal_polygon_relay',
   'expire_personal_polygon_relay_operation','retire_native_polygon_relay_authorization','read_personal_polygon_relay_activity');`;
 const oldFunctionRows=value(oldFunctions,false);
 const beforeFunctionOids=JSON.parse(value(`SELECT jsonb_agg(oid::text)::text FROM pg_proc WHERE pronamespace='payments'::regnamespace;`,false));
 const beforeRelationOids=JSON.parse(value(`SELECT jsonb_agg(c.oid::text)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema';`,false));
 // Prove the operator-snapshot gap with actual concurrent PostgreSQL sessions:
 // an existing legacy payment confirms, and a later one appears/submits, after
 // the DDL transaction fixes its RR snapshot but before trigger installation.
 const oldLegacyId=randomUUID(),lateLegacyId=randomUUID(),oldHash=`0x${'a951'.repeat(16)}`,lateHash=`0x${'a952'.repeat(16)}`;
 const legacyBlockHash=`0x${'a953'.repeat(16)}`;
 const legacyPrepare=(index,id)=>`SELECT id FROM payments.prepare_personal_company_payment_v3('${extra[index][0]}','${extra[index][1]}','30000000','${id}',137);`;
 const legacySubmit=(index,id,hash)=>`SELECT status FROM payments.submit_personal_company_payment('${extra[index][0]}','${id}','${hash}');`;
 const legacyVerify=(index,id,hash)=>`SELECT status FROM payments.verify_personal_company_payment('${extra[index][0]}','${id}','${hash}','80000999','${legacyBlockHash}',12);`;
 value(legacyPrepare(22,oldLegacyId));
 function ownerSession(){
  const child=spawn('docker',['exec','-i',container,'psql','-X','-w','-qAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe'],shell:false});
  let stdout='',stderr='';const listeners=[];
  child.stdout.on('data',data=>{stdout+=data;for(const item of listeners)if(stdout.includes(item.marker))item.resolve();});
  child.stderr.on('data',data=>stderr+=data);
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',status=>{for(const item of listeners)item.reject(Error('Synthetic cutover session ended before checkpoint'));
   resolve({status,stdout,stderr});});});
  const wait=marker=>new Promise((resolve,reject)=>{if(stdout.includes(marker))return resolve();listeners.push({marker,resolve,reject});});
  return {child,done,wait};
 }
 const writer=ownerSession(),cutover=ownerSession(),gate='712305009';
 writer.child.stdin.write(`SELECT pg_advisory_lock(${gate});SELECT 'WRITER_READY';\n`);
 await writer.wait('WRITER_READY');
 const body=relayMigration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'');
 cutover.child.stdin.end(`BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT count(*) FROM payments.personal_company_payment;
  SELECT 'CUTOVER_SNAPSHOT_READY';SELECT pg_advisory_xact_lock(${gate});${body}COMMIT;`);
 await cutover.wait('CUTOVER_SNAPSHOT_READY');
 writer.child.stdin.end(`SET ROLE ${role};${legacySubmit(22,oldLegacyId,oldHash)}${legacyVerify(22,oldLegacyId,oldHash)}
  ${legacyPrepare(23,lateLegacyId)}${legacySubmit(23,lateLegacyId,lateHash)}RESET ROLE;SELECT pg_advisory_unlock(${gate});`);
 const [writerResult,cutoverResult]=await Promise.all([writer.done,cutover.done]);
 assert.equal(writerResult.status,0,writerResult.stderr);assert.equal(cutoverResult.status,0,cutoverResult.stderr);probes++;
 eq(`SELECT status FROM payments.personal_company_payment WHERE id='${oldLegacyId}';`,'confirmed',false);
 eq(`SELECT status FROM payments.personal_transfer_request WHERE id='${oldLegacyId}';`,'prepared',false);
 eq(`SELECT count(*) FROM payments.personal_transfer_request WHERE id='${lateLegacyId}';`,'0',false);
 const aa=`0x${'ab'.repeat(20)}`,entry='0x0000000071727de22e5e9d8baf0edac6f37da032',implementation='0x90040487a6c9f949c4f07cadcfb0f3b8eeab4229';
 const digest=id=>`0x${createHash('sha256').update(`synthetic-native:${id}`).digest('hex')}`;
 const nativePrepare=(index,id,fields={})=>{const data={amount:'30000000',nonce:'0',fee:'100',ownerCap:'200',globalCap:'10000000000000000000',relay:aa,entry,implementation,...fields};
  return `SELECT id::text||'|'||status FROM payments.prepare_personal_polygon_relay('${extra[index][0]}','${extra[index][1]}','${data.amount}','${id}',
   '${data.nonce}','${digest(id)}','${data.relay}','${data.entry}','0x${'5a'.repeat(32)}','${data.implementation}','${data.fee}','${data.ownerCap}','${data.globalCap}');`;};
 const abandon=(index,id)=>`SELECT status FROM payments.abandon_personal_polygon_relay('${extra[index][0]}','${id}');`;
 const stalePendingId=randomUUID();eq(nativePrepare(22,stalePendingId),`${stalePendingId}|prepared`);
 eq(abandon(22,stalePendingId),'expired');
 reject(nativePrepare(20,lateLegacyId),'polygon_relay_request_already_used');
 reject(nativePrepare(23,randomUUID()),'polygon_relay_pending_exists');
 value(legacyVerify(23,lateLegacyId,lateHash));
 eq(`SELECT status||'|'||chain_reference FROM payments.personal_transfer_request WHERE id='${lateLegacyId}';`,'confirmed|137',false);
 const lateRecoveredId=randomUUID();eq(nativePrepare(23,lateRecoveredId),`${lateRecoveredId}|prepared`);eq(abandon(23,lateRecoveredId),'expired');
 eq(`SELECT chain_id||'|'||transaction_hash FROM payments.personal_company_payment WHERE id='${lateLegacyId}';`,`137|${lateHash}`,false);
 eq(originalSnapshot,originalRows,false);eq(otherFinancial,otherRows,false);eq(oldFunctions,oldFunctionRows,false);
 const newFunctionFilter=`p.pronamespace='payments'::regnamespace AND p.oid NOT IN(${beforeFunctionOids.map(oid=>Number(oid)).join(',')})`;
 const profile=JSON.parse(value(`SELECT jsonb_object_agg(p.proname,md5(pg_get_functiondef(p.oid)) ORDER BY p.proname)
  FROM pg_proc p WHERE ${newFunctionFilter};`,false));
 assert.equal(Object.keys(profile).length,32);probes++;
 const newRelations=JSON.parse(value(`SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind) ORDER BY c.relname)::text
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='payments' AND c.oid NOT IN(${beforeRelationOids.map(Number).join(',')});`,false));
 assert.equal(newRelations.length,46);probes++;
 // Detailed state, concurrency and signed-BFF HTTP probes follow.
 if(context.joined){
  const source=fileURLToPath(new URL('../app/src',import.meta.url));
  const front=fileURLToPath(new URL('../../mindblisspowerfront/src/lib',import.meta.url));
  const core=fileURLToPath(new URL('../deploy/cloudflare/core/src',import.meta.url));
  const result=docker(['run','--rm','--pull','never','--network',`container:${container}`,'--mount',`type=bind,source=${source},target=/app/src,readonly`,
   '--mount',`type=bind,source=${front},target=/personal-front/lib,readonly`,'--mount',`type=bind,source=${core},target=/backend-core,readonly`,
   '-e','PERSONAL_POLYGON_RELAY_SYNTHETIC_DOCKER=1','-e',`PERSONAL_POLYGON_RELAY_DATABASE_URL=postgres://personal_flow_fixture@127.0.0.1:5432/${database}`,
   'mindbliss-polygon-relay-tests:20261111','bun','test','src/modules/payments/polygon-relay-flow.integration.test.ts']);
  if(result.status!==0)throw Error(`Synthetic Polygon HTTP flow failed: ${result.stderr||result.error?.message}`);
  const scenarios=Number(result.stderr.match(/(\d+) pass\b/)?.[1]||0),assertions=Number(result.stderr.match(/(\d+) expect\(\) calls/)?.[1]||0);
  assert.equal(scenarios,3,'All three enabled real HTTP flows must execute');assert.ok(assertions>=200,'Joined flow must execute its assertions');
  assert.equal(Number(result.stderr.match(/(\d+) skip\b/)?.[1]||0),0,'Joined flows cannot silently skip');
  console.log(JSON.stringify({polygonRelayJoinedFlow:'passed',apiScenarios:scenarios,apiAssertions:assertions,
   network:'isolated-container',externalNetwork:'disabled',realTransfers:0}));
 }
 // Runtime sees reviewed owner-scoped capabilities only, never encrypted rows,
 // private dispatch helpers, views, sequences or reporting-default table grants.
 const newNames=newRelations.map(item=>`'${item.name}'`).join(',');
 eq(`SELECT bool_and(NOT has_table_privilege('${role}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
   AND NOT has_table_privilege('app_read',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) FROM pg_class c
   WHERE c.relnamespace='payments'::regnamespace AND c.relkind IN('r','v') AND c.relname IN(${newNames});`,'t',false);
 eq(`SELECT bool_and(relrowsecurity) FROM pg_class WHERE relnamespace='payments'::regnamespace AND relkind='r' AND relname IN(${newNames});`,'t',false);
 eq(`SELECT NOT has_sequence_privilege('${role}','payments.personal_polygon_relay_event_seq_seq','USAGE,SELECT,UPDATE');`,'t',false);
 eq(`SELECT count(*) FROM pg_proc p WHERE ${newFunctionFilter} AND has_function_privilege('${role}',p.oid,'EXECUTE');`,'16',false);
 eq(`SELECT NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE ${newFunctionFilter}
   AND a.grantee<>p.proowner AND a.grantee<>'${role}'::regrole);`,'t',false);
 reject('SELECT * FROM payments.personal_polygon_relay;','permission denied');
 reject('SELECT * FROM payments.personal_polygon_relay_internal;','permission denied');
 reject('SELECT * FROM payments.personal_polygon_relay_operation;','permission denied');
 reject('SELECT payments.polygon_relay_budget_total(NULL);','permission denied');
 reject(`SELECT * FROM payments.polygon_relay_lock('${extra[0][0]}','${randomUUID()}',true);`,'permission denied');
 const testId=randomUUID(),cipher=`v1.${'n'.repeat(16)}.${'c'.repeat(64)}.${'t'.repeat(22)}`;
 const authorize=(index,id,encrypted=cipher)=>`SELECT status FROM payments.authorize_personal_polygon_relay('${extra[index][0]}','${id}','${digest(id)}','${encrypted}','v1');`;
 const begin=(index,id,attempt,nonce='0')=>`SELECT should_prepare FROM payments.begin_personal_polygon_relay('${extra[index][0]}','${id}','${attempt}','${nonce}');`;
 const lease=(index,id)=>value(`SELECT lease_token FROM payments.read_personal_polygon_relay('${extra[index][0]}','${id}');`);
 const persist=(index,id,attempt,token,hash,until,quote='80',encrypted=cipher)=>`SELECT should_send FROM payments.persist_personal_polygon_relay_operation(
  '${extra[index][0]}','${id}','${attempt}','${token}','${hash}','${encrypted}','v1',0,${until},'${quote}');`;
 const release=(index,id,attempt,token)=>`SELECT status FROM payments.release_personal_polygon_relay_attempt('${extra[index][0]}','${id}','${attempt}','${token}','sponsorship_rejected');`;
 const proofBlock='80001999',proofHash=`0x${'c499'.repeat(16)}`,sharedTransaction=`0x${'c498'.repeat(16)}`;
 const confirm=(index,id,attempt,hash,confs=12,cost='50',tx=sharedTransaction)=>`SELECT status FROM payments.confirm_personal_polygon_relay(
  '${extra[index][0]}','${id}','${attempt}','${hash}','${tx}','${proofBlock}','${proofHash}',${confs},'${cost}');`;
 eq(nativePrepare(0,testId),`${testId}|prepared`);eq(nativePrepare(0,testId),`${testId}|prepared`);
 eq(`SELECT count(*) FROM payments.personal_polygon_sponsor_reservation WHERE payment_id='${testId}';`,'1',false);
 reject(nativePrepare(0,testId,{amount:'30000001'}),'polygon_relay_request_already_used');
 reject(nativePrepare(1,testId),'polygon_relay_request_already_used');
 for(const amount of ['0','-1','01','1.0','NaN','1e6','9'.repeat(79)])reject(nativePrepare(0,randomUUID(),{amount}),'polygon_relay_invalid_request');
 for(const fields of [{nonce:'-1'},{nonce:'01'},{fee:'0'},{fee:'1000000000000000001'},{ownerCap:'2000000000000000001'},
  {globalCap:'10000000000000000001'},{entry:`0x${'1'.repeat(40)}`},{relay:`0x${'0'.repeat(40)}`},{implementation:`0x${'2'.repeat(40)}`}])
  reject(nativePrepare(0,randomUUID(),fields),'polygon_relay_invalid_request');
 reject(`BEGIN ISOLATION LEVEL REPEATABLE READ;${nativePrepare(0,testId)}`,'polygon_relay_invalid_request');
 eq(authorize(0,testId),'authorized');
 const cipherBefore=value(`SELECT authorization_ciphertext FROM payments.personal_polygon_relay WHERE id='${testId}';`,false);
 eq(authorize(0,testId,cipher.replace('n'.repeat(16),'q'.repeat(16))),'authorized');
 eq(`SELECT authorization_ciphertext FROM payments.personal_polygon_relay WHERE id='${testId}';`,cipherBefore,false);
 reject(abandon(0,testId),'polygon_relay_operation_locked');
 reject(`SELECT * FROM payments.expire_personal_polygon_relay('${extra[0][0]}','${testId}');`,'polygon_relay_operation_locked');
 reject(`SELECT * FROM payments.prepare_personal_company_payment_v3('${extra[0][0]}','${extra[0][1]}','1','${randomUUID()}',137);`,'company_payment_pending_exists');
 reject(nativePrepare(0,randomUUID()),'polygon_relay_pending_exists');
 const attempt=randomUUID(),operation=`0x${'c451'.repeat(16)}`;eq(begin(0,testId,attempt),'t');
 const firstLease=lease(0,testId);eq(begin(0,testId,attempt),'f');
 value(`UPDATE payments.personal_polygon_relay_attempt SET lease_expires_at=created_at+interval '1 microsecond' WHERE id='${attempt}';`,false);
 eq(begin(0,testId,attempt),'t');const currentLease=lease(0,testId);assert.notEqual(currentLease,firstLease);probes++;
 let until=Math.floor(Date.now()/1000)+300;
 reject(persist(0,testId,attempt,firstLease,operation,until),'polygon_relay_lease_lost');
 reject(release(0,testId,attempt,firstLease),'polygon_relay_lease_lost');
 eq(persist(0,testId,attempt,currentLease,operation,until),'t');
 eq(persist(0,testId,attempt,currentLease,operation,until),'f');
 reject(persist(0,testId,attempt,currentLease,`0x${'c454'.repeat(16)}`,until),'polygon_relay_operation_conflict');
 reject(persist(0,testId,attempt,currentLease,operation,until+1),'polygon_relay_operation_conflict');
 reject(release(0,testId,attempt,currentLease),'polygon_relay_operation_locked');
 eq(begin(0,testId,attempt),'f');
 eq(`SELECT status FROM payments.mark_personal_polygon_relay_ambiguous('${extra[0][0]}','${testId}','${attempt}');`,'ambiguous');
 eq(`SELECT state FROM payments.personal_polygon_sponsor_reservation WHERE attempt_id='${attempt}';`,'held',false);
 reject(`UPDATE payments.personal_polygon_relay_account SET active_attempt_id=NULL WHERE active_attempt_id='${attempt}';`,'polygon_relay_operation_locked',false);
 reject(confirm(0,testId,attempt,operation,11),'polygon_relay_invalid_proof');
 reject(confirm(0,testId,attempt,operation,12,'81'),'polygon_relay_receipt_conflict');
 eq(confirm(0,testId,attempt,operation),'confirmed');
 const terminalBefore=value(`SELECT to_jsonb(p)::text FROM payments.personal_polygon_relay p WHERE id='${testId}';`,false);
 eq(confirm(0,testId,attempt,operation,20),'confirmed');
 eq(`SELECT to_jsonb(p)::text FROM payments.personal_polygon_relay p WHERE id='${testId}';`,terminalBefore,false);
 eq(`SELECT state FROM payments.personal_polygon_sponsor_reservation WHERE attempt_id='${attempt}';`,'spent',false);
 eq(`SELECT active_attempt_id IS NULL FROM payments.personal_polygon_relay_account WHERE relayer_address='${aa}';`,'t',false);
 const reusedNonceId=randomUUID();eq(nativePrepare(0,reusedNonceId),`${reusedNonceId}|prepared`);
 reject(authorize(0,reusedNonceId),'polygon_relay_nonce_reserved');eq(abandon(0,reusedNonceId),'expired');
 eq(`SELECT count(*) FROM payments.personal_polygon_native_authorization WHERE wallet_address='${extra[0][1]}' AND authorization_nonce='0';`,'1',false);
 // All evidence tables reject even privileged accidental rewrites/deletion.
 for(const table of ['personal_polygon_native_authorization','personal_polygon_relay_operation','personal_polygon_relay_event','personal_polygon_relay_outcome']){
  reject(`DELETE FROM payments.${table};`,'polygon_relay_append_only',false);
  reject(`TRUNCATE payments.${table};`,'polygon_relay_append_only|cannot truncate',false);
 }
 reject(`UPDATE payments.personal_polygon_relay SET amount_atomic='1' WHERE id='${testId}';`,'polygon_relay_snapshot_immutable',false);
 reject(`SELECT * FROM payments.read_personal_polygon_relay('${extra[1][0]}','${testId}');`,'polygon_relay_not_found');
 reject(nativePrepare(0,randomUUID(),{nonce:'1',ownerCap:'150'}),'polygon_relay_budget_exceeded');
 const raceId=randomUUID();eq(nativePrepare(2,raceId),`${raceId}|prepared`);
 const cancellationRace=await Promise.all([context.parallelPsql(authorize(2,raceId)),context.parallelPsql(abandon(2,raceId))]);
 assert.equal(cancellationRace.filter(result=>result.status===0).length,1);
 assert.equal(cancellationRace.filter(result=>result.status!==0&&/polygon_relay_(operation_locked|expired)/.test(result.stderr)).length,1);probes++;
 const racedStatus=value(`SELECT status FROM payments.read_personal_polygon_relay('${extra[2][0]}','${raceId}');`);
 eq(`SELECT count(*) FROM payments.personal_polygon_native_authorization WHERE payment_id='${raceId}';`,racedStatus==='authorized'?'1':'0',false);
 eq(`SELECT state FROM payments.personal_polygon_sponsor_reservation WHERE payment_id='${raceId}';`,racedStatus==='authorized'?'held':'released',false);
 const beforeBudget=BigInt(value('SELECT payments.polygon_relay_budget_total(NULL)::text;',false));
 const budgetCap=(beforeBudget+150n).toString(),budgetIds=[randomUUID(),randomUUID()];
 const budgetRace=await Promise.all(budgetIds.map((id,index)=>context.parallelPsql(nativePrepare(16+index,id,{globalCap:budgetCap}))));
 assert.equal(budgetRace.filter(result=>result.status===0).length,1);
 assert.equal(budgetRace.filter(result=>result.status!==0&&/polygon_relay_budget_exceeded/.test(result.stderr)).length,1);probes++;
 eq('SELECT payments.polygon_relay_budget_total(NULL)::text;',(beforeBudget+100n).toString(),false);
 eq(originalSnapshot,originalRows,false);eq(otherFinancial,otherRows,false);eq(oldFunctions,oldFunctionRows,false);
 await writeFile(new URL('../.wrangler/polygon-relay-schema/manifest-105.json',import.meta.url),JSON.stringify({
  migrationSha256:createHash('sha256').update(relayMigration).digest('hex'),functions:profile,relations:newRelations,
  legacyTriggers:JSON.parse(value(`SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname)::text
   FROM pg_trigger t WHERE t.tgrelid='payments.personal_company_payment'::regclass AND NOT t.tgisinternal;`,false)),probes,joined:context.joined},null,2));
 console.log(JSON.stringify({polygonRelaySchema:'passed',probes,profile,oldFinancialHistoryUnchanged:true,
  productionConnections:0,externalNetwork:'disabled',realTransfers:0,actualCharges:0}));
}
