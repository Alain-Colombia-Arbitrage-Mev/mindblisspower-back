import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.argv.length,2);
const prefixSha='1d8417a1cd4f7509aca6530a68e320aebac40c2a845d208c89986e6914dfcdc3';
const prefixPath=process.env.WALLET_MELD_PRODUCTION_SYNTHETIC_PREFIX;
if(!prefixPath){
 const original=new URL('test-meld-sandbox-reconciliation-schema.mjs',import.meta.url);
 let source=await readFile(original,'utf8');
 const marker="  ['meld-sandbox-reconciliation-schema-probes.mjs', 'runMeldSandboxReconciliationProbes'],";
 assert.equal(source.split(marker).length,2);
 source=source.replace(marker,marker+"\n  ['administrative-wallet-signing-schema-probes.mjs', 'runAdministrativeWalletSigningProbes'],\n  ['connected-sandbox-wallet-schema-probes.mjs', 'runConnectedSandboxWalletProbes'],\n  ['wallet-meld-production-schema-probes.mjs', 'runWalletMeldProductionProbes'],");
 const generated=new URL('.wallet-meld-production-harness-'+randomUUID()+'.mjs',import.meta.url);
 await writeFile(generated,source,{flag:'wx'});
 try{const child=spawn(process.execPath,[fileURLToPath(generated)],{stdio:'inherit',shell:false});
  process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 }finally{await unlink(generated);}
}else{
 const directory=pathToFileURL(prefixPath.replaceAll('\\','/').replace(/\/?$/,'/'));
 const manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8'));
 const source=await readFile(new URL('synthetic-through114.sql',directory),'utf8');
 assert.equal(manifest.synthetic,'native-profile-through114-v1');assert.equal(manifest.network,'none');
 assert.equal(manifest.hostPorts,0);assert.equal(manifest.productionConnections,0);assert.equal(manifest.prefix114Probes,202);
 assert.equal(manifest.sha256,prefixSha);assert.equal(createHash('sha256').update(source).digest('hex'),prefixSha);
 const container='mb-wallet-production-test-'+randomUUID(),database='mindbliss_curated_20261025',role='mindbliss_auth_core_v1';
 const docker=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',shell:false,maxBuffer:32*1024*1024});
 const psql=(sql,allowFailure=false)=>{const r=docker(['exec','-i',container,'psql','-X','-w','-qAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],sql);if(!allowFailure&&r.status!==0)throw Error(r.stderr||'Synthetic SQL failed');return r;};
 const value=(sql,runtime=true)=>psql((runtime?'SET ROLE '+role+';':'')+sql).stdout.trim();
 const parallelPsql=sql=>new Promise((resolve,reject)=>{const child=spawn('docker',['exec','-i',container,'psql','-X','-w','-qAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe'],shell:false});let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));child.stdin.end('SET ROLE '+role+';'+sql);});
 try{
  const image='postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
  const started=docker(['run','--detach','--pull','never','--name',container,'--label','mindbliss.synthetic=wallet-meld-production','--network','none','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB='+database,image]);assert.equal(started.status,0,started.stderr);
  let ready=false;for(let n=0;n<100;n++){if(docker(['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database]).status===0){ready=true;break;}await delay(200);}assert.ok(ready);
  for(const item of manifest.roles){assert.match(item.name,/^[a-z][a-z0-9_]{0,62}$/);for(const key of ['super','createdb','createrole','replication','bypassrls'])assert.equal(item[key],false);psql('CREATE ROLE '+item.name+(item.login?' LOGIN':' NOLOGIN')+(item.inherit?' INHERIT':' NOINHERIT')+';');}
  for(const item of manifest.members){assert.match(item.role,/^[a-z][a-z0-9_]{0,62}$/);assert.match(item.member,/^[a-z][a-z0-9_]{0,62}$/);assert.equal(item.admin,false);assert.equal(item.inherit,true);assert.equal(item.set,true);psql('GRANT '+item.role+' TO '+item.member+';');}
  psql(source);
  const fixture={container,docker,psql,value,parallelPsql,role,database};
  const sandbox=await import('./connected-sandbox-wallet-schema-probes.mjs');await sandbox.runConnectedSandboxWalletProbes(fixture);
  const production=await import('./wallet-meld-production-schema-probes.mjs');await production.runWalletMeldProductionProbes(fixture);
 }finally{
  const label=docker(['inspect','--format','{{ index .Config.Labels "mindbliss.synthetic" }}',container]);
  if(label.status===0&&label.stdout.trim()==='wallet-meld-production'&&/^mb-wallet-production-test-[a-f0-9-]{36}$/.test(container))docker(['rm','--force',container]);
 }
}
