import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

export async function runConnectedSandboxWalletProbes({container,docker,psql,value,parallelPsql,role,database}) {
 let probes=0;const eq=(q,w,runtime=true)=>{assert.equal(value(q,runtime),w,q);probes++;};
 const deny=(q,code,runtime=true)=>{const r=psql((runtime?'SET ROLE '+role+';':'')+q,true);assert.notEqual(r.status,0,q);assert.match(r.stderr,new RegExp(code),q);probes++;};
 const lit=x=>"'"+String(x).replaceAll("'","''")+"'";const hash=x=>createHash('sha256').update(x).digest('hex');
 assert.equal(docker(['inspect','--format','{{.HostConfig.NetworkMode}}',container]).stdout.trim(),'none');assert.equal(database,'mindbliss_curated_20261025');assert.equal(role,'mindbliss_auth_core_v1');
  const applied114=await readFile(new URL('../_meta/migration/114_administrative_wallet_signing_dry_run.sql',import.meta.url),'utf8');
  const nativeGuard=applied114.replaceAll('\r\n','\n').match(/CREATE FUNCTION identity\.require_administrative_native_session\(p_subject text,p_session text\)[\s\S]*?END \$function\$;/)?.[0];assert.ok(nativeGuard);
  psql(nativeGuard.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
  eq("SELECT md5(pg_get_functiondef('identity.require_administrative_native_session(text,text)'::regprocedure));",'01bb63725c11ae353cb768a42ffa9485',false);
  // Disposable-only schema mirror for the authoritative identity/profile data.
  psql(`ALTER TABLE auth."user" ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z',
    ADD COLUMN IF NOT EXISTS phone_number text,ADD COLUMN IF NOT EXISTS phone_number_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS contact_phone_e164 text,ADD COLUMN IF NOT EXISTS contact_whatsapp_e164 text;
    CREATE TABLE IF NOT EXISTS mlm.person(id bigint PRIMARY KEY,public_id uuid NOT NULL,user_id text UNIQUE,email text,status text,blacklisted boolean NOT NULL DEFAULT false,birthday date,
      first_name text NOT NULL,last_name text NOT NULL,phone_number text NOT NULL,country text,payout_wallet_usdc text,is_admin boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z');
    CREATE TABLE IF NOT EXISTS identity.auth_binding(subject text PRIMARY KEY,provider text NOT NULL DEFAULT 'better_auth',person_id bigint NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS mlm.affiliate(id bigint PRIMARY KEY,person_id bigint NOT NULL,sponsor_id bigint,parent_id bigint,invitation_link text,status text NOT NULL DEFAULT 'active');
    ALTER TABLE mlm.person ADD COLUMN IF NOT EXISTS country text,ADD COLUMN IF NOT EXISTS payout_wallet_usdc text,
      ADD COLUMN IF NOT EXISTS birthday date,ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z';
    ALTER TABLE mlm.affiliate ADD COLUMN IF NOT EXISTS id bigint,ADD COLUMN IF NOT EXISTS sponsor_id bigint,ADD COLUMN IF NOT EXISTS parent_id bigint,ADD COLUMN IF NOT EXISTS invitation_link text;
    DO $$BEGIN IF(SELECT atttypid FROM pg_attribute WHERE attrelid='mlm.person'::regclass AND attname='public_id' AND NOT attisdropped)='bigint'::regtype THEN
      ALTER TABLE mlm.person ALTER COLUMN public_id TYPE uuid USING md5('profile-fixture-public:'||public_id::text)::uuid;
    END IF;END$$;
    CREATE TABLE IF NOT EXISTS mlm.blacklist(email_norm text,phone_last10 text,name_norm text,birthdate date);
    CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;`);
  const normalization=await readFile(new URL('../_meta/migration/43_blacklist.sql',import.meta.url),'utf8');
  for(const name of ['norm_email','norm_phone10']){const definition=normalization.match(new RegExp(`CREATE OR REPLACE FUNCTION mlm\\.${name}\\([\\s\\S]*?\\$\\$;`))?.[0];assert.ok(definition);psql(definition);}
  psql(`CREATE OR REPLACE FUNCTION mlm.norm_name(p text)RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT NULLIF(regexp_replace(lower(public.unaccent(btrim(coalesce(p,'')))),'\\s+',' ','g'),'')$$;`);
  // Use the EXACT real92 eligibility guard, not the funding harness's stub.
  const canonicalSource=await readFile(new URL('../_meta/migration/92_administrative_wallets_meld.sql',import.meta.url),'utf8');
  const canonicalGuard=canonicalSource.replaceAll('\r\n','\n').match(/CREATE FUNCTION identity\.administrative_wallet_person\(p_subject text\)[\s\S]*?END \$function\$;/)?.[0];assert.ok(canonicalGuard);
  psql(canonicalGuard.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
 // The cached dump intentionally omits ownership. Exercise new SECDEF functions
 // under a NOLOGIN, non-superuser owner, with only the existing native helper's
 // required rights. These fixture-only changes precede every invariance snapshot.
 psql("CREATE ROLE sandbox116_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;"+
  "GRANT USAGE ON SCHEMA identity,payments,auth TO sandbox116_owner;"+
  "GRANT SELECT,UPDATE ON auth.session TO sandbox116_owner;"+
  "GRANT EXECUTE ON FUNCTION identity.administrative_wallet_person(text) TO sandbox116_owner;"+
  "ALTER FUNCTION identity.require_administrative_native_session(text,text) OWNER TO sandbox116_owner;");
 const users=Array.from({length:12},(_,i)=>({subject:'sandbox116-'+i,session:'native-sandbox116-'+i,alternate:'alternate-sandbox116-'+i,person:11601+i,address:'0x'+(11601+i).toString(16).padStart(40,'0')}));
 const args=values=>values.map(x=>x===null?'NULL':lit(x)).join(',');
 const rowCall=(name,values)=>'SELECT row_to_json(r)::text FROM '+name+'('+args(values)+')r;';
 const scalar=(name,values)=>'SELECT '+name+'('+args(values)+');';
 psql('INSERT INTO auth."user"(id,eligible,email,email_verified,name)VALUES '+users.map(u=>'('+args([u.subject,true,u.subject+'@example.invalid',true,'Synthetic Sandbox'])+')').join(',')+';'+
  'INSERT INTO auth.session(id,user_id,expires_at)VALUES '+users.flatMap(u=>[u.session,u.alternate].map(s=>'('+args([s,u.subject])+",clock_timestamp()+interval '2 days')")).join(',')+';'+
  'INSERT INTO mlm.person(id,public_id,user_id,email,status,first_name,last_name,phone_number)VALUES '+users.map(u=>'('+args([u.person,randomUUID(),u.subject,u.subject+'@example.invalid','active','Synthetic','Sandbox','2025550123'])+')').join(',')+';'+
  'INSERT INTO identity.auth_binding(subject,provider,person_id)VALUES '+users.map(u=>'('+args([u.subject,'better_auth',u.person])+')').join(',')+';');
 const functionNames=['identity.read_sandbox_wallet_binding(text,text)','identity.create_sandbox_wallet_challenge(text,text,text,uuid,text)',
  'identity.read_sandbox_wallet_challenge(text,text,uuid)','identity.consume_sandbox_wallet_challenge(text,text,uuid,text,text,text)',
  'identity.require_sandbox_wallet_binding(text,text)','payments.create_connected_wallet_sandbox_attempt(text,text,uuid,text,numeric,text,text,text)',
  'payments.finish_connected_wallet_sandbox_attempt(text,text,uuid,text,text,text)','payments.read_connected_wallet_sandbox_attempt(text,text,uuid)',
  'payments.read_connected_wallet_sandbox_history(text,text)','payments.record_connected_wallet_sandbox_proof(text,uuid,jsonb,text)'];
 const names=functionNames.map(x=>lit(x.split('.')[1].split('(')[0])).join(',');
 const fnQ="SELECT md5(coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl,'config',p.proconfig)ORDER BY p.oid)::text,'')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('identity','payments','mlm')AND p.proname NOT IN("+names+');';
 const rowQueries=JSON.parse(value("SELECT jsonb_agg(format('SELECT %L AS name,count(*)::text AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n''ORDER BY to_jsonb(t)::text),''''))AS digest FROM %I.%I t',n.nspname||'.'||c.relname,n.nspname,c.relname)ORDER BY n.nspname,c.relname)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r'AND n.nspname NOT IN('pg_catalog','information_schema')AND n.nspname !~ '^pg_toast';",false));
 const rowsQ="SELECT jsonb_object_agg(name,jsonb_build_object('count',count,'digest',digest)ORDER BY name)::text FROM("+rowQueries.join(' UNION ALL ')+')s;';
 const before={rows:value(rowsQ,false),functions:value(fnQ,false),sessions:value('SELECT jsonb_agg(to_jsonb(s)ORDER BY id)::text FROM auth.session s;',false),
  owner:value("SELECT proowner FROM pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;",false)};
 const migration=await readFile(new URL('../_meta/migration/116_connected_sandbox_wallet.sql',import.meta.url),'utf8');
 psql(migration);eq(rowsQ,before.rows,false);eq(fnQ,before.functions,false);
 const tables=['identity.sandbox_wallet_challenge','identity.sandbox_wallet_binding','payments.connected_wallet_sandbox_attempt'];
 for(const table of tables){eq('SELECT count(*) FROM '+table+';','0',false);deny('SELECT * FROM '+table+';','permission denied');deny('SET ROLE sandbox_fixture_default;SELECT * FROM '+table+';','permission denied',false);}
 deny(scalar('identity.require_sandbox_wallet_binding',[users[0].subject,users[0].session]),'permission denied');
 const status=(i=0,s=users[i].session)=>rowCall('identity.read_sandbox_wallet_binding',[users[i].subject,s]);
 assert.deepEqual(JSON.parse(value(status())),{address:null,verified:false,binding_reference:null,verified_at:null,expires_at:null});probes++;
 for(const session of [users[1].session,'missing-session'])deny(status(0,session),'administrative_signing_forbidden');
 const challenge=(i=0,id=randomUUID(),address=users[i].address,s=users[i].session,nonce=randomBytes(32).toString('hex'))=>rowCall('identity.create_sandbox_wallet_challenge',[users[i].subject,s,address,id,nonce]);
 const get=(i=0,address=users[i].address,s=users[i].session)=>{const c=JSON.parse(value(challenge(i,randomUUID(),address,s)));probes++;return c;};
 const consume=(c,i=0,s=users[i].session,address=c.address,mh=c.message_hash,sh='b'.repeat(64))=>rowCall('identity.consume_sandbox_wallet_challenge',[users[i].subject,s,c.id,address,mh,sh]);
 const c=get();assert.equal(c.message_hash,hash(c.message));assert.equal(c.session_context_hash,hash(users[0].subject+'\n'+users[0].session));
 assert.equal(c.message,'wallet.mindblisspower.com wants you to verify control of this sandbox wallet:\n'+c.address+'\n\nMindbliss sandbox wallet ownership only. No transaction or transfer of funds.\nSession context: '+c.session_context_hash+
  '\n\nURI: https://wallet.mindblisspower.com/dashboard/wallet-administrative\nVersion: 1\nChain ID: 137\nNonce: '+c.nonce+'\nIssued At: '+new Date(c.issued_at).toISOString()+'\nExpiration Time: '+new Date(c.expires_at).toISOString()+'\nRequest ID: '+c.id);probes++;
 eq(challenge(0,c.id,c.address,users[0].session,c.nonce),JSON.stringify(c));
 deny(consume(c,1),'sandbox_wallet_invalid_challenge');deny(consume(c,0,users[0].alternate),'sandbox_wallet_invalid_challenge');
 deny(consume(c,0,users[0].session,users[1].address),'sandbox_wallet_signature_invalid');
 deny(consume(c,0,users[0].session,c.address,'c'.repeat(64)),'sandbox_wallet_signature_invalid');
 deny(consume(c,0,users[0].session,c.address,c.message_hash,'bad'),'sandbox_wallet_signature_invalid');
 const binding=JSON.parse(value(consume(c)));assert.equal(binding.address,c.address);assert.equal(binding.verified,true);probes++;
 deny(consume(c),'sandbox_wallet_invalid_challenge');deny(challenge(0,randomUUID(),users[1].address),'sandbox_wallet_address_immutable');
 assert.equal(JSON.parse(value(status(0,users[0].alternate))).verified,false);probes++;
 const secondSession=get(0,c.address,users[0].alternate);const rebound=JSON.parse(value(consume(secondSession,0,users[0].alternate)));
 assert.equal(rebound.binding_reference,binding.binding_reference);assert.equal(rebound.address,binding.address);assert.equal(rebound.verified,true);probes++;
 assert.equal(JSON.parse(value(status())).verified,false);probes++;
 const sharedAddress='0x'+'ab'.repeat(20),raceOne=get(1,sharedAddress),raceTwo=get(2,sharedAddress);
 const race=await Promise.all([parallelPsql(consume(raceOne,1)),parallelPsql(consume(raceTwo,2))]);
 assert.equal(race.filter(x=>x.status===0).length,1);assert.equal(race.filter(x=>/sandbox_wallet_address_in_use/.test(x.stderr)).length,1);probes++;
 eq("SELECT count(*) FROM identity.sandbox_wallet_binding WHERE wallet_address="+lit(sharedAddress)+';','1',false);
 const replay=get(3);const replays=await Promise.all([parallelPsql(consume(replay,3)),parallelPsql(consume(replay,3))]);
 assert.equal(replays.filter(x=>x.status===0).length,1);assert.equal(replays.filter(x=>/sandbox_wallet_invalid_challenge/.test(x.stderr)).length,1);probes++;
 const stale=get(4),latest=get(4);deny(consume(stale,4),'sandbox_wallet_invalid_challenge');assert.equal(JSON.parse(value(consume(latest,4))).verified,true);probes++;
 get(4);deny(challenge(4),'sandbox_wallet_rate_limited');
 for(const i of [5,6,7,8,9,10,11])assert.equal(JSON.parse(value(consume(get(i),i))).verified,true);
 const attempt=(i=0,id=randomUUID(),amount='100',country='US',currency='USD',method='CREDIT_DEBIT_CARD',account='sandbox-account',session=users[i].session)=>
  rowCall('payments.create_connected_wallet_sandbox_attempt',[users[i].subject,session,id,country,amount,currency,method,account]);
 const attemptId=randomUUID();const first=JSON.parse(value(attempt(0,attemptId,'100','US','USD','CREDIT_DEBIT_CARD','sandbox-account',users[0].alternate)));
 assert.equal(first.address,c.address);assert.equal(first.customer_reference,binding.binding_reference);assert.equal(first.created,true);probes++;
 assert.equal(JSON.parse(value(attempt(0,attemptId,'100','US','USD','CREDIT_DEBIT_CARD','sandbox-account',users[0].alternate))).created,false);probes++;
 deny(attempt(0,attemptId,'101','US','USD','CREDIT_DEBIT_CARD','sandbox-account',users[0].alternate),'sandbox_wallet_funding_request_already_used');
 deny(attempt(3,attemptId),'sandbox_wallet_funding_request_already_used');deny(attempt(),'sandbox_wallet_binding_required');
 for(const [amount,country,currency,method]of [['49','US','USD','CREDIT_DEBIT_CARD'],['25001','US','USD','CREDIT_DEBIT_CARD'],['50.001','US','USD','CREDIT_DEBIT_CARD'],['0','MX','MXN','CREDIT_DEBIT_CARD'],['10000001','MX','MXN','CREDIT_DEBIT_CARD'],['100','CO','COP','CREDIT_DEBIT_CARD'],['100','US','MXN','CREDIT_DEBIT_CARD'],['100','US','USD','PAYPAL']])deny(attempt(5,randomUUID(),amount,country,currency,method),'sandbox_wallet_funding_invalid_request');
 for(const [amount,country,currency,method]of [['50','CO','USD','APPLE_PAY'],['25000','MX','USD','GOOGLE_PAY'],['0.01','MX','MXN','CREDIT_DEBIT_CARD'],['10000000','MX','MXN','GOOGLE_PAY']])assert.equal(JSON.parse(value(attempt(5,randomUUID(),amount,country,currency,method))).created,true);
 const sameId=randomUUID();const createdRace=await Promise.all([parallelPsql(attempt(6,sameId)),parallelPsql(attempt(6,sameId))]);
 assert.ok(createdRace.every(x=>x.status===0));assert.equal(createdRace.filter(x=>JSON.parse(x.stdout.trim()).created).length,1);probes++;
 for(let n=0;n<10;n++)assert.equal(JSON.parse(value(attempt(7))).created,true);deny(attempt(7),'sandbox_wallet_funding_rate_limited');
 const finish=(id=attemptId,i=0,s=users[0].alternate,state='session_created',ps='provider-session',pc='provider-customer')=>scalar('payments.finish_connected_wallet_sandbox_attempt',[users[i].subject,s,id,state,ps,pc]);
 eq(finish(),'t');eq(finish(),'t');eq(finish(attemptId,0,users[0].alternate,'session_created','changed-session'),'f');
 deny(finish(attemptId,3,users[3].session),'sandbox_wallet_funding_forbidden');
 const read=(i=0,s=users[i].session,id=attemptId)=>rowCall('payments.read_connected_wallet_sandbox_attempt',[users[i].subject,s,id]);
 const history=(i=0,s=users[i].session)=>'SELECT count(*) FROM payments.read_connected_wallet_sandbox_history('+args([users[i].subject,s])+');';
 eq(history(0,users[0].alternate),'1');eq(history(3),'0');eq(read(3),'');
 const row=JSON.parse(value(read(0,users[0].alternate)));assert.equal(row.address,binding.address);assert.equal(row.proof,null);probes++;
 const proof={transactionId:'sandbox-transaction',accountId:'sandbox-account',sessionId:'provider-session',externalSessionId:attemptId,externalCustomerId:binding.binding_reference,serviceProvider:'TRANSAK',countryCode:'US',sourceCurrencyCode:'USD',sourceAmount:'100.00',destinationCurrencyCode:'USDT_POLYGON',walletAddress:binding.address,chainId:'137',providerStatus:'PENDING',providerUpdatedAt:new Date().toISOString(),receivedAmount:'0',paymentMethodType:'CREDIT_DEBIT_CARD'};
 const record=(p=proof,i=0,id=attemptId)=>scalar('payments.record_connected_wallet_sandbox_proof',[users[i].subject,id,JSON.stringify(p),hash(JSON.stringify(p))]);
 assert.equal(JSON.parse(value(record())).providerStatus,'PENDING');probes++;
 for(const patch of [{accountId:'foreign'},{sessionId:'foreign'},{externalSessionId:randomUUID()},{externalCustomerId:randomUUID()},{serviceProvider:'BANXA'},{countryCode:'MX'},{sourceCurrencyCode:'MXN'},{sourceAmount:'101.00'},{destinationCurrencyCode:'USDT_ETHEREUM'},{walletAddress:users[3].address},{chainId:'1'},{paymentMethodType:'GOOGLE_PAY'}])deny(record({...proof,...patch}),'sandbox_wallet_proof_context_mismatch');
 for(const patch of [{transactionId:'..'},{receivedAmount:'-1'},{sourceAmount:'100.001'},{providerStatus:'UNKNOWN'},{providerStatus:'SETTLED',receivedAmount:'0'},{providerUpdatedAt:'not-a-time'},{unexpected:'field'},{accountId:null}])deny(record({...proof,...patch}),'sandbox_wallet_proof_invalid');
 const missing={...proof};delete missing.walletAddress;deny(record(missing),'sandbox_wallet_proof_invalid');deny(record(proof,3),'sandbox_wallet_proof_context_mismatch');
 const settled={...proof,providerStatus:'SETTLED',providerUpdatedAt:new Date(Date.now()+1000).toISOString(),receivedAmount:'95.123456'};
 assert.equal(JSON.parse(value(record(settled))).providerStatus,'SETTLED');probes++;
 assert.equal(JSON.parse(value(record({...proof,providerUpdatedAt:new Date(Date.now()+2000).toISOString()}))).providerStatus,'SETTLED');probes++;
 deny(record({...settled,receivedAmount:'96'}),'sandbox_wallet_proof_version_conflict');
 deny(record({...settled,transactionId:'different-transaction'}),'sandbox_wallet_proof_transaction_conflict');
 psql('DELETE FROM auth.session WHERE id='+lit(users[0].alternate)+';');deny(read(0,users[0].alternate),'administrative_signing_forbidden');
 assert.equal(JSON.parse(value(record(settled))).providerStatus,'SETTLED');probes++;
 assert.equal(JSON.parse(value(read(0,users[0].session))).proof.providerStatus,'SETTLED');probes++;
 psql('UPDATE auth.session SET expires_at=clock_timestamp()-interval '+lit('1 second')+' WHERE id='+lit(users[8].session)+';');deny(status(8),'administrative_signing_forbidden');deny(attempt(8),'administrative_signing_forbidden');
 const exp=get(9);psql('UPDATE identity.sandbox_wallet_challenge SET issued_at=issued_at-interval '+lit('10 minutes')+',expires_at=expires_at-interval '+lit('10 minutes')+' WHERE id='+lit(exp.id)+';');deny(consume(exp,9),'sandbox_wallet_invalid_challenge');
 psql('TRUNCATE auth.session;INSERT INTO auth.session SELECT * FROM jsonb_populate_recordset(NULL::auth.session,'+lit(before.sessions)+'::jsonb);');
 eq(rowsQ,before.rows,false);eq(fnQ,before.functions,false);deny(migration,'sandbox_wallet_requires_fresh_review',false);
 const functions=functionNames.map(signature=>JSON.parse(value("SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'owner',p.proowner,'prosecdef',p.prosecdef,'proconfig',p.proconfig,'acl',p.proacl,'runtimeExecute',"+(signature!=='identity.require_sandbox_wallet_binding(text,text)')+")::text FROM pg_proc p WHERE oid="+lit(signature)+'::regprocedure;',false)));
 for(const f of functions){assert.equal(f.owner,before.owner);assert.equal(f.prosecdef,true);assert.deepEqual(f.proconfig,['search_path=pg_catalog']);probes++;}
 for(const signature of functionNames){eq('SELECT has_function_privilege('+args([role,signature,'EXECUTE'])+');',signature==='identity.require_sandbox_wallet_binding(text,text)'?'f':'t',false);eq('SELECT has_function_privilege('+args(['sandbox_fixture_default',signature,'EXECUTE'])+');','f',false);}
 const tableMetadata=tables.map(name=>JSON.parse(value("SELECT jsonb_build_object('name',"+lit(name)+",'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'kind',c.relkind,"+
  "'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid))ORDER BY a.attnum)FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),"+
  "'constraints',(SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,true))ORDER BY conname)FROM pg_constraint WHERE conrelid=c.oid),"+
  "'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid)ORDER BY indexrelid)FROM pg_index WHERE indrelid=c.oid))::text FROM pg_class c WHERE c.oid="+lit(name)+'::regclass;',false)));
 await mkdir(new URL('../.wrangler/',import.meta.url),{recursive:true});
 await writeFile(new URL('../.wrangler/connected-sandbox-wallet-116-manifest.json',import.meta.url),JSON.stringify({migrationSha256:hash(migration),syntheticPostgresPassed:true,
  functions:functions.map(f=>({...f,ownerReferenceSignature:'identity.require_administrative_native_session(text,text)'})),tables:tableMetadata,constraints:[],changedFunctions:[],probes,
  existingRowsUnchanged:true,oldFunctionsAndFinancialRowsUnchanged:true,productionConnections:0,actualCharges:0,broadcasts:0,externalNetwork:'disabled',independentOfMigration113:true},null,2));
 console.log(JSON.stringify({connectedSandboxWalletSchema:'passed',probes,uniqueImmutableDestination:true,currentNativeSessionProof:true,ownerIsolation:true,independentSandboxProof:true,oldRowsAndFunctionsUnchanged:true,productionConnections:0,actualCharges:0}));
}

