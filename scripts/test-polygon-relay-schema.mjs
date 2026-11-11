import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Reuse the independently validated 93..101 synthetic fixture without editing
// its frozen harness. A cached pg_dump is synthetic-only, hash-bound to those
// exact sources, and restored solely into a labelled network-disabled container.
const joined=process.argv.length===3&&process.argv[2]==='--joined';
const ownershipAmount=process.argv.length===3&&process.argv[2]==='--ownership-amount';
assert.ok(process.argv.length===2||joined||ownershipAmount);
if(ownershipAmount){
 const health=spawnSync('docker',['info','--format','{{.ServerVersion}}'],{encoding:'utf8',shell:false,timeout:15000});
 assert.equal(health.status,0,'Docker Engine must respond before isolated ownership probes can run');
}
const root=new URL('../',import.meta.url),directory=new URL('.wrangler/polygon-relay-schema/',root);
await mkdir(directory,{recursive:true});
const baselineUrl=new URL('scripts/test-wallet-funding-schema.mjs',root),baseline=await readFile(baselineUrl,'utf8');
const dependencies=['93_wallet_funding_isolation.sql','94_wallet_funding_payment_methods.sql','95_wallet_funding_status_reads.sql',
 '96_personal_usd20_membership_catalog.sql','97_personal_mxn_spei_requests.sql','98_personal_company_payments.sql','99_personal_ethereum_only.sql',
 '100_personal_multichain_payments.sql','101_personal_company_payment_events.sql'];
const inputs=[baseline,...await Promise.all(dependencies.map(name=>readFile(new URL(`_meta/migration/${name}`,root),'utf8')))];
const inputHash=createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
const cacheSql=new URL('synthetic-baseline.sql',directory),cacheManifest=new URL('synthetic-baseline.json',directory);
const moduleUrl=new URL('scripts/polygon-relay-schema-probes.mjs',root);
let cache;
try{const manifest=JSON.parse(await readFile(cacheManifest,'utf8'));const source=await readFile(cacheSql,'utf8');
 if(manifest.synthetic==='wallet-funding-schema-v1'&&manifest.inputHash===inputHash
  &&manifest.sha256===createHash('sha256').update(source).digest('hex'))cache=source;
}catch{}
if(!cache){
 const marker='\n  console.log(JSON.stringify({ walletFundingSchema:';
 assert.equal(baseline.split(marker).length,2);
 const injection=`\n  const relayModule=await import(${JSON.stringify(moduleUrl.href)});\n`+
  `  await relayModule.saveSyntheticBaseline({container,docker,database,inputHash:${JSON.stringify(inputHash)},directory:${JSON.stringify(directory.href)}});\n`+
  `  await relayModule.runPolygonRelayProbes({container,docker,psql,value,equal,rejects,parallelPsql,immutable,role,database,joined:${joined}});\n`;
 const ownershipInjection=ownershipAmount?`\n const securityModule=await import(${JSON.stringify(new URL('scripts/ownership-amount-schema-probes.mjs',root).href)});await securityModule.runOwnershipAmountProbes({container,docker,psql,value,parallelPsql,role,database});\n`:'';
 const generated=baseline.replaceAll('import.meta.url',JSON.stringify(baselineUrl.href)).replace(marker,injection+ownershipInjection+marker);
 const path=new URL(`harness-${randomUUID()}.mjs`,directory);await writeFile(path,generated,{flag:'wx'});
 const child=spawn(process.execPath,[fileURLToPath(path)],{stdio:'inherit',shell:false});
 process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
}else{
 const container=`mb-polygon-relay-test-${randomUUID()}`,database='mindbliss_curated_20261025',role='mindbliss_auth_core_v1';
 const image='postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
 const docker=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',shell:false,maxBuffer:16*1024*1024});
 const psql=(source,allowFailure=false)=>{const result=docker(['exec','-i',container,'psql','-X','-w','-qAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],source);
  if(!allowFailure&&result.status!==0)throw Error(result.stderr||'Synthetic SQL failed');return result;};
 const value=(source,runtime=true)=>psql(`${runtime?`SET ROLE ${role};`:''}${source}`).stdout.trim();
 const equal=(source,expected,runtime=true)=>assert.equal(value(source,runtime),expected);
 const rejects=(source,pattern)=>{const result=psql(`SET ROLE ${role};${source}`,true);assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(pattern));};
 const immutable=(source,pattern)=>{const result=psql(source,true);assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(pattern));};
 const parallelPsql=source=>new Promise((resolve,reject)=>{const child=spawn('docker',['exec','-i',container,'psql','-X','-w','-qAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe'],shell:false});
  let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));child.stdin.end(`SET ROLE ${role};${source}`);});
 try{
  const started=docker(['run','--detach','--pull','never','--name',container,'--label','mindbliss.synthetic=polygon-relay-schema','--network','none',
   '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e',`POSTGRES_DB=${database}`,image]);assert.equal(started.status,0);
  let ready=false;for(let i=0;i<100;i++){if(docker(['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database]).status===0){ready=true;break;}await delay(200);}assert.equal(ready,true);
  psql(`CREATE ROLE ${role} NOLOGIN;CREATE ROLE app_read NOLOGIN;${cache}`);
  const module=await import(moduleUrl);await module.runPolygonRelayProbes({container,docker,psql,value,equal,rejects,parallelPsql,immutable,role,database,joined});
  if(ownershipAmount){const securityModule=await import(new URL('scripts/ownership-amount-schema-probes.mjs',root));await securityModule.runOwnershipAmountProbes({container,docker,psql,value,parallelPsql,role,database});}
 }catch(error){console.error(JSON.stringify({polygonRelaySchema:'failed',message:error.message}));process.exitCode=1;
 }finally{const ownership=docker(['inspect','--format','{{ index .Config.Labels "mindbliss.synthetic" }}',container]);
  if(ownership.status===0&&ownership.stdout.trim()==='polygon-relay-schema'&&/^mb-polygon-relay-test-[a-f0-9-]{36}$/.test(container))docker(['rm','--force',container]);}
}
