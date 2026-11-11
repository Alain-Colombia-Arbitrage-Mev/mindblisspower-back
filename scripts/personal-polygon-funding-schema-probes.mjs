import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function runPersonalPolygonFundingProbes({container,docker,psql,value,parallelPsql,role,database}) {
 let probes=0;
 const eq=(sql,expected,runtime=true)=>{assert.equal(value(sql,runtime),expected);probes++;};
 const deny=(sql,code,runtime=true)=>{const result=psql(`${runtime?`SET ROLE ${role};`:''}${sql}`,true);assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(code));probes++;};
 assert.equal(docker(['inspect','--format','{{.HostConfig.NetworkMode}}',container]).stdout.trim(),'none');
 assert.match(container,/^mb-(polygon-relay|wallet-funding)-test-[a-f0-9-]{36}$/);
 assert.equal(database,'mindbliss_curated_20261025');assert.equal(role,'mindbliss_auth_core_v1');
 const directory=new URL('../.wrangler/personal-polygon-funding-schema/',import.meta.url);await mkdir(directory,{recursive:true});
 const owners=Array.from({length:7},(_,i)=>({owner:`polygon-funding-${i}`,address:`0xf6${(i+1).toString(16).padStart(2,'0')}${'81'.repeat(18)}`}));
 psql(`INSERT INTO auth."user"(id,eligible,email,name) VALUES ${owners.map(v=>`('${v.owner}',true,'${v.owner}@example.invalid','Synthetic')`).join(',')};
  INSERT INTO identity.wallet_binding(subject,address) VALUES ${owners.map(v=>`('${v.owner}','${v.address}')`).join(',')};`);
 const legacyFundingId=randomUUID(),legacyPaymentId=randomUUID(),newFundingId=randomUUID();
 const originalWriter=value(`SELECT pg_get_functiondef('payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)'::regprocedure);`,false);
 // Simulate a cached old writer body independently of CREATE OR REPLACE. It
 // remains capable of an explicit Ethereum INSERT, so the table fence matters.
 psql(originalWriter.replace('payments.create_reown_funding_intent_v3(','payments.synthetic_old_funding_writer(')+';\n'+
  `REVOKE ALL ON FUNCTION payments.synthetic_old_funding_writer(text,text,text,numeric,uuid,text,text) FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION payments.synthetic_old_funding_writer(text,text,text,numeric,uuid,text,text) TO ${role};`);
 const intent=(version,id=randomUUID(),i=0,amount='30',country='US',currency='USD',method='CREDIT_DEBIT_CARD')=>
  `SELECT id FROM payments.create_reown_funding_intent_v${version}('${owners[i].owner}','${owners[i].address}','${country}',${amount},'${id}','${method}','${currency}');`;
 const prepare=(chain,id=randomUUID(),i=1,amount='123456')=>`SELECT chain_id FROM payments.prepare_personal_company_payment_v3('${owners[i].owner}','${owners[i].address}','${amount}','${id}',${chain});`;
 eq(intent(3,legacyFundingId),legacyFundingId);
 eq(prepare(1,legacyPaymentId),'1');
 const tableQueries=JSON.parse(value(`SELECT jsonb_agg(format('SELECT %L AS name,count(*)::text AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text),'''')) AS digest FROM %I.%I t',n.nspname||'.'||c.relname,n.nspname,c.relname) ORDER BY n.nspname,c.relname)::text
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast';`,false));
 const rowsQuery=`SELECT jsonb_object_agg(name,jsonb_build_object('count',count,'digest',digest) ORDER BY name)::text FROM (${tableQueries.join(' UNION ALL ')}) s;`;
 const rowsBefore=value(rowsQuery,false);
 const functionsQuery=`SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl) ORDER BY p.oid)::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('payments','identity','mlm','auth') AND p.prokind='f'
  AND p.oid<>'payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)'::regprocedure
  AND p.proname NOT IN('create_reown_funding_intent_v4','guard_new_personal_payment_network');`;
 const functionsBefore=value(functionsQuery,false);
 const originalV3=JSON.parse(value(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'owner',p.proowner,'acl',p.proacl)::text
  FROM pg_proc p WHERE p.oid='payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)'::regprocedure;`,false));
 const defaultQuery=`SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
  WHERE d.adrelid='payments.reown_funding_intent'::regclass AND a.attname='destination_currency';`;
 const oldDefault=value(defaultQuery,false),migration=await readFile(new URL('../_meta/migration/106_personal_polygon_funding.sql',import.meta.url),'utf8');
 // A disabled RLS preflight is rejected and rolled back, rather than repaired.
 deny(`BEGIN;ALTER TABLE payments.reown_funding_intent DISABLE ROW LEVEL SECURITY;${migration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'')}`,'personal_polygon_funding_runtime_isolation_required',false);
 psql(migration);
 eq(rowsQuery,rowsBefore,false);eq(functionsQuery,functionsBefore,false);eq(defaultQuery,"'USDT_POLYGON'::text",false);
 eq(intent(4,newFundingId),newFundingId);eq(intent(4,newFundingId),newFundingId);
 eq(`SELECT destination_currency FROM payments.read_wallet_funding_status_v3('${owners[0].owner}','personal','${legacyFundingId}');`,'USDT');
 eq(`SELECT destination_currency FROM payments.read_wallet_funding_status_v3('${owners[0].owner}','personal','${newFundingId}');`,'USDT_POLYGON');
 eq(`SELECT count(DISTINCT destination_currency) FROM payments.read_wallet_funding_history_v3('${owners[0].owner}','personal');`,'2');
 deny(intent(4,legacyFundingId),'wallet_funding_request_already_used');
 deny(intent(4,newFundingId,0,'31'),'wallet_funding_request_already_used');
 deny(intent(4,newFundingId,1),'wallet_funding_request_already_used');
 deny(intent(3),'wallet_funding_network_changed');deny(intent(3,legacyFundingId),'wallet_funding_network_changed');
 deny(intent(3,randomUUID(),6).replace('create_reown_funding_intent_v3','synthetic_old_funding_writer'),'wallet_funding_network_changed');
 eq(`SELECT count(*) FROM payments.reown_funding_intent WHERE subject='${owners[6].owner}';`,'0',false);
 deny(`SELECT * FROM payments.create_reown_funding_intent('${owners[0].owner}','${owners[0].address}','US',30,'${randomUUID()}','CREDIT_DEBIT_CARD','USD');`,'wallet_funding_network_changed');
 for(const [country,currency,method,amount] of [['US','USD','CREDIT_DEBIT_CARD','30'],['MX','USD','GOOGLE_PAY','100'],['MX','MXN','SPEI','931'],['CO','USD','APPLE_PAY','15000']]){
  const id=randomUUID();eq(intent(4,id,2,amount,country,currency,method),id);
  eq(`SELECT destination_currency||'|'||source_currency||'|'||payment_method FROM payments.read_wallet_funding_status_v3('${owners[2].owner}','personal','${id}');`,`USDT_POLYGON|${currency}|${method}`);
 }
 for(const [amount,country,currency,method] of [['29.99','US','USD','CREDIT_DEBIT_CARD'],['15000.01','US','USD','CREDIT_DEBIT_CARD'],["'NaN'::numeric",'US','USD','CREDIT_DEBIT_CARD'],
  ['930.99','MX','MXN','SPEI'],['931','CO','MXN','SPEI'],['931','MX','MXN','CREDIT_DEBIT_CARD'],['30','ES','USD','CREDIT_DEBIT_CARD'],['30','CO','COP','CREDIT_DEBIT_CARD'],
  ['30','US','USD','NETELLER'],['30','US','USD','SKRILL']]) deny(intent(4,randomUUID(),2,amount,country,currency,method),'wallet_funding_invalid_request');
 deny(intent(4,randomUUID(),3).replace(owners[3].address,owners[2].address),'wallet_funding_wallet_not_linked');
 deny(intent(4,randomUUID(),3).replace(owners[3].owner,'blocked'),'wallet_funding_forbidden');
 deny(`BEGIN ISOLATION LEVEL REPEATABLE READ;SET ROLE ${role};${intent(4,randomUUID(),3)}`,'wallet_funding_unavailable',false);
 const racedId=randomUUID(),raced=await Promise.all([parallelPsql(intent(4,racedId,3)),parallelPsql(intent(4,racedId,3))]);
 assert.ok(raced.every(r=>r.status===0&&r.stdout.trim()===racedId));probes++;
 eq(`SELECT count(*) FROM payments.reown_funding_intent WHERE id='${racedId}';`,'1',false);
 for(let i=0;i<10;i++){const id=randomUUID();eq(intent(4,id,4),id);}
 deny(intent(4,randomUUID(),4),'wallet_funding_rate_limited');
 // Exact old Ethereum preparations can still replay and register a late hash.
 eq(prepare(1,legacyPaymentId),'1');
 eq(`SELECT chain_id FROM payments.prepare_personal_company_payment_v2('${owners[1].owner}','${owners[1].address}','123456','${legacyPaymentId}');`,'1');
 deny(prepare(1,randomUUID(),5),'company_payment_network_changed');
 deny(`SELECT * FROM payments.prepare_personal_company_payment_v2('${owners[5].owner}','${owners[5].address}','1','${randomUUID()}');`,'company_payment_network_changed');
 const transactionHash=`0x${'f7'.repeat(32)}`,blockHash=`0x${'f8'.repeat(32)}`;
 eq(`SELECT status FROM payments.submit_personal_company_payment('${owners[1].owner}','${legacyPaymentId}','${transactionHash}');`,'submitted');
 eq(`SELECT status FROM payments.verify_personal_company_payment('${owners[1].owner}','${legacyPaymentId}','${transactionHash}','123456789','${blockHash}',12);`,'confirmed');
 eq(`SELECT chain_id||'|'||token_address FROM payments.read_personal_company_payment('${owners[1].owner}','${legacyPaymentId}');`,'1|0xdac17f958d2ee523a2206206994597c13d831ec7');
 eq(prepare(1,legacyPaymentId),'1');eq(prepare(137,randomUUID(),5),'137');
 deny('SELECT payments.guard_new_personal_payment_network();','permission denied');
 deny('SELECT * FROM payments.reown_funding_intent;','permission denied');
 eq(`SELECT has_function_privilege('${role}','payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text)','EXECUTE');`,'t',false);
 eq(`SELECT bool_and(c.relrowsecurity) FROM pg_class c WHERE c.oid IN('payments.reown_funding_intent'::regclass,'payments.personal_company_payment'::regclass,'payments.meld_sandbox_funding_attempt'::regclass);`,'t',false);
 eq(`SELECT count(*) FROM payments.read_wallet_funding_status_v3('${owners[1].owner}','personal','${newFundingId}');`,'0');
 deny(migration,'personal_polygon_funding_requires_fresh_review',false);
 eq(functionsQuery,functionsBefore,false);
 const profile=JSON.parse(value(`SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),
  'securityDefiner',p.prosecdef,'owner',p.proowner,'config',p.proconfig,'acl',p.proacl) ORDER BY p.oid::regprocedure::text)::text FROM pg_proc p
  WHERE p.oid IN('payments.create_reown_funding_intent_v4(text,text,text,numeric,uuid,text,text)'::regprocedure,
  'payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)'::regprocedure,'payments.guard_new_personal_payment_network()'::regprocedure);`,false));
 const newV3=profile.find(p=>p.signature===originalV3.signature);assert.equal(newV3.owner,originalV3.owner);assert.deepEqual(newV3.acl,originalV3.acl);probes++;
 const triggers=JSON.parse(value(`SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled)
  ORDER BY n.nspname,c.relname,t.tgname)::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE (t.tgrelid='payments.personal_company_payment'::regclass AND t.tgname='personal_company_payment_00_network')
   OR (t.tgrelid='payments.reown_funding_intent'::regclass AND t.tgname='reown_funding_intent_00_network');`,false));
 await writeFile(new URL('manifest-106.json',directory),JSON.stringify({migrationSha256:createHash('sha256').update(migration).digest('hex'),functions:profile,
  changedFunctionBefore:originalV3,columnDefault:{schema:'payments',table:'reown_funding_intent',column:'destination_currency',before:oldDefault,after:value(defaultQuery,false)},triggers,probes},null,2));
 console.log(JSON.stringify({personalPolygonFundingSchema:'passed',probes,profile,oldRowsUnchangedByMigration:true,unchangedOtherFunctions:true,
  administrativeProviderUnchanged:true,historicalEthereumRecovery:true,productionConnections:0,externalNetwork:'disabled',realTransfers:0,actualCharges:0}));
}
