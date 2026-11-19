import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';

export async function runWalletMeldProductionProbes({container,docker,psql,value,parallelPsql,role,database}){
 let probes=0;const eq=(q,w,runtime=true)=>{assert.equal(value(q,runtime),w,q);probes++;};
 const deny=(q,message,runtime=true)=>{const r=psql((runtime?'SET ROLE '+role+';':'')+q,true);assert.notEqual(r.status,0,q);assert.match(r.stderr,new RegExp(message),q);probes++;};
 const lit=v=>v===null?'NULL':"'"+String(v).replaceAll("'","''")+"'";
 const hash=v=>createHash('sha256').update(v).digest('hex');
 const args=xs=>xs.map(lit).join(',');
 const row=(fn,xs)=>'SELECT row_to_json(r)::text FROM '+fn+'('+args(xs)+')r;';
 const scalar=(fn,xs)=>'SELECT '+fn+'('+args(xs)+');';
 assert.equal(docker(['inspect','--format','{{.HostConfig.NetworkMode}}',container]).stdout.trim(),'none');
 assert.equal(database,'mindbliss_curated_20261025');assert.equal(role,'mindbliss_auth_core_v1');
 const users=Array.from({length:9},(_,i)=>({subject:'production121-'+i,session:'native-production121-'+i,other:'other-production121-'+i,person:12101+i,
  address:'0x'+(12101+i).toString(16).padStart(40,'0')}));
 psql('INSERT INTO auth."user"(id,eligible,email,email_verified,name)VALUES '+users.map(u=>'('+args([u.subject,true,u.subject+'@example.invalid',true,'Synthetic Production'])+')').join(',')+';'+
  'INSERT INTO auth.session(id,user_id,expires_at)VALUES '+users.flatMap(u=>[u.session,u.other].map(s=>'('+args([s,u.subject])+",clock_timestamp()+interval '3 days')")).join(',')+';'+
  'INSERT INTO mlm.person(id,public_id,user_id,email,status,first_name,last_name,phone_number)VALUES '+users.map(u=>'('+args([u.person,randomUUID(),u.subject,u.subject+'@example.invalid','active','Synthetic','Production','2025550123'])+')').join(',')+';'+
  'INSERT INTO identity.auth_binding(subject,provider,person_id)VALUES '+users.map(u=>'('+args([u.subject,'better_auth',u.person])+')').join(',')+';');
 const activate=i=>{const u=users[i],c=JSON.parse(value(row('identity.create_sandbox_wallet_challenge',[u.subject,u.session,u.address,randomUUID(),randomBytes(32).toString('hex')])));
  const bound=JSON.parse(value(row('identity.consume_sandbox_wallet_challenge',[u.subject,u.session,c.id,u.address,c.message_hash,'a'.repeat(64)])));assert.equal(bound.verified,true);return bound;};
 const bindings=users.slice(0,8).map((_,i)=>activate(i));
 // Exercise revoked default grants in the disposable fixture, not production.
 psql('GRANT USAGE ON SCHEMA identity,payments TO sandbox_fixture_default;ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO sandbox_fixture_default;'+
  'ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT EXECUTE ON FUNCTIONS TO sandbox_fixture_default;ALTER DEFAULT PRIVILEGES IN SCHEMA identity GRANT EXECUTE ON FUNCTIONS TO sandbox_fixture_default;');
 const fns=['identity.read_wallet_meld_production_binding(text,text)','payments.protect_wallet_meld_production_attempt()',
  'payments.create_wallet_meld_production_attempt(text,text,uuid,text,numeric,text,text,text,text)',
  'payments.finish_wallet_meld_production_attempt(text,text,uuid,text,text,text)','payments.read_wallet_meld_production_attempt(text,text,uuid)',
  'payments.read_wallet_meld_production_history(text,text)','payments.record_wallet_meld_production_proof(text,uuid,jsonb,text)'];
 const oldFunctions="SELECT md5(coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl,'config',p.proconfig)ORDER BY p.oid)::text,''))FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('identity','payments','mlm')AND NOT EXISTS(SELECT FROM unnest(ARRAY["+fns.map(lit).join(',')+"]::text[])e(signature)WHERE to_regprocedure(e.signature)=p.oid);";
 const oldQueries=JSON.parse(value("SELECT jsonb_agg(format('SELECT %L name,count(*)::text count,md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n''ORDER BY to_jsonb(t)::text),''''))digest FROM %I.%I t',n.nspname||'.'||c.relname,n.nspname,c.relname)ORDER BY n.nspname,c.relname)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r'AND n.nspname NOT IN('pg_catalog','information_schema')AND n.nspname!~'^pg_toast';",false));
 const oldRows="SELECT jsonb_object_agg(name,jsonb_build_object('count',count,'digest',digest)ORDER BY name)::text FROM("+oldQueries.join(' UNION ALL ')+')q;';
 const before={rows:value(oldRows,false),functions:value(oldFunctions,false)};
 const migration=await readFile(new URL('../_meta/migration/121_wallet_meld_production_funding.sql',import.meta.url),'utf8');
 psql(migration);eq(oldRows,before.rows,false);eq(oldFunctions,before.functions,false);
 const table='payments.wallet_meld_production_attempt';
 eq('SELECT count(*)FROM '+table+';','0',false);deny('SELECT * FROM '+table+';','permission denied');
 for(const command of ['INSERT INTO '+table+'(id)VALUES(gen_random_uuid());','UPDATE '+table+" SET environment='sandbox';",'DELETE FROM '+table+';','TRUNCATE '+table+';'])deny(command,'permission denied');
 deny('SET ROLE sandbox_fixture_default;SELECT * FROM '+table+';','permission denied',false);
 for(const signature of fns){eq('SELECT has_function_privilege('+lit(role)+','+lit(signature)+",'EXECUTE');",signature.includes('protect_')?'f':'t',false);
  eq('SELECT has_function_privilege(\'sandbox_fixture_default\','+lit(signature)+",'EXECUTE');",'f',false);}
 const binding=(i=0,s=users[i].session)=>row('identity.read_wallet_meld_production_binding',[users[i].subject,s]);
 const expected=JSON.stringify({address:users[0].address,binding_reference:bindings[0].binding_reference});eq(binding(),expected);eq(binding(0,users[0].other),expected);
 deny(binding(0,users[1].session),'administrative_signing_forbidden');deny(binding(0,'missing-session'),'administrative_signing_forbidden');
 deny(binding(8),'wallet_production_verification_required');
 // Only expire the presentation/signing lease; preserve the real synthetic
 // verification message and its exact successful-consumption timestamps.
 const expiredHistorical=`UPDATE identity.sandbox_wallet_binding SET binding_expires_at=verified_at+interval '1 microsecond' WHERE subject=${lit(users[0].subject)};`;
 const create=(i=0,id=randomUUID(),{country='US',amount='50',currency='USD',method='CREDIT_DEBIT_CARD',provider='BANXA',account='production-account',session=users[i].session}={})=>
  row('payments.create_wallet_meld_production_attempt',[users[i].subject,session,id,country,amount,currency,method,provider,account]);
 const finish=(id,i=0,status='session_created',providerSession='session-'+id,customer='customer-'+i,s=users[i].session)=>scalar('payments.finish_wallet_meld_production_attempt',[users[i].subject,s,id,status,providerSession,customer]);
 const read=(id,i=0,s=users[i].session)=>row('payments.read_wallet_meld_production_attempt',[users[i].subject,s,id]);
 const history=(i=0,s=users[i].session)=>'SELECT coalesce(json_agg(r),\'[]\'::json)::text FROM payments.read_wallet_meld_production_history('+args([users[i].subject,s])+')r;';
 const persisted=JSON.parse(value('BEGIN;'+expiredHistorical+'SET ROLE '+role+';'+binding(0,users[0].other)+'ROLLBACK;',false));assert.equal(persisted.address,users[0].address);probes++;
 const expCreate=JSON.parse(value('BEGIN;'+expiredHistorical+'SET ROLE '+role+';'+create(0,randomUUID(),{session:users[0].other})+'ROLLBACK;',false));assert.equal(expCreate.created,true);probes++;
 deny('BEGIN;UPDATE auth.session SET expires_at=clock_timestamp()-interval \'1 day\' WHERE id='+lit(users[0].session)+';SET ROLE '+role+';'+binding(),'administrative_signing_forbidden',false);
 deny('BEGIN;UPDATE identity.sandbox_wallet_challenge c SET signature_hash=NULL,consumed_at=NULL FROM identity.sandbox_wallet_binding b WHERE b.subject='+lit(users[0].subject)+'AND c.id=b.challenge_id;SET ROLE '+role+';'+binding(),'wallet_production_verification_required',false);
 deny('BEGIN;UPDATE identity.sandbox_wallet_challenge c SET message_hash='+lit('b'.repeat(64))+' FROM identity.sandbox_wallet_binding b WHERE b.subject='+lit(users[0].subject)+'AND c.id=b.challenge_id;SET ROLE '+role+';'+binding(),'wallet_production_verification_required',false);
 for(const changed of [{amount:'49.99'},{amount:'25000.01'},{amount:'50.001'},{amount:'NaN'},{amount:'Infinity'},{country:'US\n'},{currency:'usd'},
  {method:'card'},{provider:'MERCURYO'},{provider:'BINANCE_CONNECT'},{provider:'BINANCECONNECT'},{provider:null},{account:'../live'},{currency:'COP',amount:'1000000000.01'}])deny(create(0,randomUUID(),changed),'wallet_production_invalid_request');
 deny(create(8),'wallet_production_verification_required');deny(create(0,randomUUID(),{session:users[1].session}),'administrative_signing_forbidden');
 const id=randomUUID(),created=JSON.parse(value(create(0,id)));assert.equal(created.created,true);assert.equal(created.address,users[0].address);assert.equal(created.customer_reference,bindings[0].binding_reference);probes++;
 assert.equal(JSON.parse(value(create(0,id))).created,false);probes++;
 for(const change of [{amount:'100'},{country:'MX'},{currency:'MXN'},{method:'SPEI'},{provider:'SWAPPED'},{account:'other-account'},{session:users[0].other}])deny(create(0,id,change),'wallet_production_request_already_used');
 deny(create(1,id),'wallet_production_request_already_used');eq(read(id,1),'');deny(read(id,0,users[1].session),'administrative_signing_forbidden');
 eq(finish(id),'t');eq(finish(id),'t');eq(finish(id,0,'session_created','other-session','customer-0'),'f');
 deny(finish(id,1),'wallet_production_forbidden');deny(finish(id,0,'session_created','session-'+id,'customer-0',users[0].other),'wallet_production_forbidden');
 deny(finish(id,0,'confirmed','session-'+id,'customer-0'),'wallet_production_invalid_request');
 deny(finish(id,0,'session_created','session-'+id,null),'wallet_production_invalid_request');
 const owned=JSON.parse(value(read(id,0,users[0].other)));assert.equal(owned.address,users[0].address);assert.equal(owned.status,'session_created');probes++;
 for(const field of ["wallet_address='0x0000000000000000000000000000000000009999'","environment='sandbox'","country_code='MX'","requested_amount=100","service_provider='SWAPPED'","payment_method='SPEI'"])
  deny('UPDATE '+table+' SET '+field+' WHERE id='+lit(id)+';','wallet_production_attempt_immutable',false);
 deny('DELETE FROM '+table+';','wallet_production_attempt_immutable',false);deny('TRUNCATE '+table+';','wallet_production_attempt_immutable',false);
 const local=randomUUID();assert.equal(JSON.parse(value(create(1,local,{country:'CO',currency:'COP',amount:'170000',method:'PSE',provider:'ONRAMPMONEY'}))).created,true);probes++;
 eq(finish(local,1,'unavailable',null,null),'t');eq(finish(local,1,'session_created','too-late','customer-1'),'f');
 const quoteTime=new Date(),proof={transactionId:'transaction-'+id,accountId:'production-account',sessionId:'session-'+id,externalSessionId:id,externalCustomerId:bindings[0].binding_reference,
  serviceProvider:'BANXA',countryCode:'US',sourceCurrencyCode:'USD',sourceAmount:'50.00',destinationCurrencyCode:'USDT_POLYGON',walletAddress:users[0].address,chainId:'137',
  providerStatus:'PROCESSING',providerUpdatedAt:quoteTime.toISOString(),receivedAmount:'0',paymentMethodType:'CREDIT_DEBIT_CARD'};
 const save=(p=proof,owner=users[0].subject,target=id,sha=hash(JSON.stringify(p)))=>scalar('payments.record_wallet_meld_production_proof',[owner,target,JSON.stringify(p),sha]);
 for(const field of Object.keys(proof)){const changed={...proof,[field]:null};deny(save(changed),'wallet_production_proof_invalid');}
 for(const changed of [{...proof,clientSecret:'must-not-store'},{...proof,providerStatus:'COMPLETED'},{...proof,sourceAmount:'NaN'},
  {...proof,providerStatus:'SETTLED',receivedAmount:'0'},{...proof,providerUpdatedAt:'infinity'},{...proof,providerUpdatedAt:new Date(Date.now()+600000).toISOString()}])deny(save(changed),'wallet_production_proof_invalid');
 for(const [field,wrong]of Object.entries({accountId:'sandbox-account',sessionId:'wrong-session',externalSessionId:randomUUID(),externalCustomerId:randomUUID(),serviceProvider:'MERCURYO',
  countryCode:'MX',sourceCurrencyCode:'MXN',sourceAmount:'51.00',destinationCurrencyCode:'USDT_ETH',walletAddress:users[1].address,chainId:'1',paymentMethodType:'APPLE_PAY'}))deny(save({...proof,[field]:wrong}),'wallet_production_proof_context_mismatch');
 deny(save(proof,users[1].subject),'wallet_production_proof_context_mismatch');deny(save(proof,users[0].subject,local),'wallet_production_proof_context_mismatch');deny(save(proof,users[0].subject,id,'bad'),'wallet_production_proof_invalid');
 assert.deepEqual(JSON.parse(value(save())),proof);probes++;const first=JSON.parse(value(read(id)));assert.deepEqual(JSON.parse(value(save())),proof);assert.deepEqual(JSON.parse(value(read(id))),first);probes++;
 const settled={...proof,providerStatus:'SETTLED',receivedAmount:'48.123456',providerUpdatedAt:new Date(quoteTime.getTime()+1000).toISOString()};assert.deepEqual(JSON.parse(value(save(settled))),settled);probes++;
 assert.deepEqual(JSON.parse(value(save())),settled);probes++;
 assert.deepEqual(JSON.parse(value(save({...settled,providerStatus:'PROCESSING',providerUpdatedAt:new Date(quoteTime.getTime()+2000).toISOString()}))),settled);probes++;
 deny(save({...settled,receivedAmount:'49'}),'wallet_production_proof_version_conflict');deny(save({...settled,transactionId:'different-transaction',providerUpdatedAt:new Date(quoteTime.getTime()+2000).toISOString()}),'wallet_production_proof_transaction_conflict');
 const duplicate=randomUUID();value(create(2,duplicate));eq(finish(duplicate,2,'session_created','session-duplicate','customer-2'),'t');
 const duplicateProof={...proof,sessionId:'session-duplicate',externalSessionId:duplicate,externalCustomerId:bindings[2].binding_reference,walletAddress:users[2].address};
 deny(save(duplicateProof,users[2].subject,duplicate),'duplicate key');
 const race=randomUUID();const raced=await Promise.all([parallelPsql(create(3,race)),parallelPsql(create(3,race))]);
 assert.ok(raced.every(r=>r.status===0));assert.deepEqual(raced.map(r=>JSON.parse(r.stdout.trim()).created).sort(),[false,true]);probes++;
 for(let i=0;i<10;i++)value(create(4,randomUUID()));deny(create(4),'wallet_production_rate_limited');
 const ownerHistory=JSON.parse(value(history()));assert.equal(ownerHistory.length,1);assert.equal(ownerHistory[0].id,id);assert.equal(JSON.parse(value(history(1))).length,1);probes++;
 eq(oldRows,before.rows,false);eq(oldFunctions,before.functions,false);
 const functions=JSON.parse(value('SELECT jsonb_agg(jsonb_build_object(\'signature\',p.oid::regprocedure::text,\'md5\',md5(pg_get_functiondef(p.oid)),\'owner\',p.proowner,\'proconfig\',p.proconfig,\'securityDefiner\',p.prosecdef,\'acl\',p.proacl,\'runtimeExecute\',has_function_privilege('+lit(role)+',p.oid,\'EXECUTE\'),\'ownerReferenceSignature\',\'identity.require_administrative_native_session(text,text)\')ORDER BY p.oid::regprocedure::text)::text FROM pg_proc p WHERE p.oid IN('+fns.map(s=>lit(s)+'::regprocedure').join(',')+');',false));
 const tableMetadata=JSON.parse(value(`SELECT jsonb_build_array(jsonb_build_object('name',${lit(table)},
  'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
   'default',pg_get_expr(d.adbin,d.adrelid))ORDER BY a.attnum)FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=${lit(table)}::regclass AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid,true))ORDER BY c.conname)
   FROM pg_constraint c WHERE c.conrelid=${lit(table)}::regclass),
  'indexes',(SELECT jsonb_agg(indexdef ORDER BY indexname)FROM pg_indexes WHERE schemaname='payments'AND tablename='wallet_meld_production_attempt'),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid,true))ORDER BY t.tgname)
   FROM pg_trigger t WHERE t.tgrelid=${lit(table)}::regclass AND NOT t.tgisinternal),
  'rls',(SELECT relrowsecurity FROM pg_class WHERE oid=${lit(table)}::regclass)))::text;`,false));
 assert.equal(tableMetadata.length,1);assert.equal(tableMetadata[0].indexes.length,4);assert.equal(tableMetadata[0].triggers.length,2);assert.equal(tableMetadata[0].rls,true);
 const manifest={migrationSha256:hash(migration),syntheticPostgresPassed:true,probes,functions,tables:[table],tableMetadata,newPrivateTables:1,newFunctions:7,oldRowsUnchanged:true,
  oldFunctionsAndFinancialRowsUnchanged:true,sandbox116Unchanged:true,persistentBindingDepositOnly:true,productionConnections:0,providerCalls:0,actualCharges:0,broadcasts:0,externalNetwork:'none'};
 await mkdir(new URL('../.wrangler/',import.meta.url),{recursive:true});await writeFile(new URL('../.wrangler/wallet-meld-production-funding-121-manifest.json',import.meta.url),JSON.stringify(manifest,null,2));
 console.log(JSON.stringify({walletMeldProductionSchema:'passed',probes,newPrivateTables:1,newFunctions:7,oldRowsUnchanged:true,sandbox116Unchanged:true,productionConnections:0,providerCalls:0,actualCharges:0,broadcasts:0}));
}
