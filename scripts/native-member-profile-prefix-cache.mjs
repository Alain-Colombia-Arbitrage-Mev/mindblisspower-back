import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const root=new URL('../',import.meta.url),directory=new URL('../.wrangler/native-member-profile-prefix/',import.meta.url);
const hash=value=>createHash('sha256').update(value).digest('hex');
async function inputs(){
  const migrations=(await readdir(new URL('_meta/migration/',root))).filter(name=>{const n=Number(name.match(/^(\d+)_/)?.[1]);return n>=93&&n<=114&&n!==113;}).map(name=>`_meta/migration/${name}`);
  const probes=(await readdir(new URL('scripts/',root))).filter(name=>name.endsWith('schema-probes.mjs')&&!['native-member-profile-schema-probes.mjs','meld-sandbox-checkout-buy-schema-probes.mjs'].includes(name)).map(name=>`scripts/${name}`);
  const files=[...migrations,...probes,'scripts/test-wallet-funding-schema.mjs','scripts/test-polygon-relay-schema.mjs','scripts/test-meld-sandbox-reconciliation-schema.mjs','scripts/test-administrative-wallet-signing-schema.mjs','scripts/native-member-profile-prefix-cache.mjs'].sort();
  return hash(JSON.stringify(await Promise.all(files.map(async path=>[path,await readFile(new URL(path,root),'utf8')]))));
}
export async function loadNativeProfilePrefixCache(){try{const manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8')),source=await readFile(new URL('synthetic-through114.sql',directory),'utf8');
  if(manifest.synthetic!=='native-profile-through114-v1'||manifest.inputHash!==await inputs()||manifest.sha256!==hash(source))return null;
  assert.equal(manifest.productionConnections,0);assert.equal(manifest.network,'none');assert.equal(manifest.hostPorts,0);assert.equal(manifest.prefix114Probes,202);return{manifest,source};
}catch{return null;}}
export async function saveNativeProfilePrefixCache({container,docker,value,database}){
  assert.equal(docker(['inspect','--format','{{ index .Config.Labels "mindbliss.synthetic" }} {{ .HostConfig.NetworkMode }}',container]).stdout.trim(),'polygon-relay-schema none');
  assert.match(container,/^mb-polygon-relay-test-[a-f0-9-]{36}$/);assert.equal(database,'mindbliss_curated_20261025');
  const roles=JSON.parse(value("SELECT jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'inherit',rolinherit,'super',rolsuper,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication,'bypassrls',rolbypassrls,'config',rolconfig)ORDER BY rolname)::text FROM pg_roles WHERE rolname<>'postgres'AND rolname NOT LIKE 'pg_%';",false));
  for(const role of roles){assert.match(role.name,/^[a-z][a-z0-9_]{0,62}$/);for(const key of['super','createdb','createrole','replication','bypassrls'])assert.equal(role[key],false);assert.equal(role.config,null);}
  const members=JSON.parse(value("SELECT coalesce(jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'admin',a.admin_option,'inherit',a.inherit_option,'set',a.set_option)ORDER BY r.rolname,m.rolname),'[]'::jsonb)::text FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE m.rolname NOT LIKE 'pg_%' AND m.rolname<>'postgres';",false));
  const names=new Set(roles.map(role=>role.name));for(const item of members){assert.ok(names.has(item.role)&&names.has(item.member));assert.equal(item.admin,false);assert.equal(item.inherit,true);assert.equal(item.set,true);}
  const dump=docker(['exec',container,'pg_dump','-U','postgres','-d',database,'--no-owner']);assert.equal(dump.status,0);await mkdir(directory,{recursive:true});
  await writeFile(new URL('synthetic-through114.sql',directory),dump.stdout);
  await writeFile(new URL('manifest.json',directory),JSON.stringify({synthetic:'native-profile-through114-v1',inputHash:await inputs(),sha256:hash(dump.stdout),roles,members,prefix114Probes:202,productionConnections:0,network:'none',hostPorts:0}));
}
export async function runNativeProfileFromPrefixCache(cache){
  const container=`mb-native-profile-test-${randomUUID()}`,database='mindbliss_curated_20261025',role='mindbliss_auth_core_v1';
  const docker=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',shell:false,maxBuffer:32*1024*1024});
  const psql=(source,allowFailure=false)=>{const result=docker(['exec','-i',container,'psql','-X','-w','-qAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],source);if(!allowFailure&&result.status!==0)throw Error(result.stderr||'Synthetic SQL failed');return result;};
  const value=(source,runtime=true)=>psql(`${runtime?`SET ROLE ${role};`:''}${source}`).stdout.trim();
  const parallelPsql=source=>new Promise((resolve,reject)=>{const child=spawn('docker',['exec','-i',container,'psql','-X','-w','-qAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe'],shell:false});let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));child.stdin.end(`SET ROLE ${role};${source}`);});
  try{
    const result=docker(['run','--detach','--pull','never','--name',container,'--label','mindbliss.synthetic=native-profile-prefix','--network','none','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e',`POSTGRES_DB=${database}`,'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888']);assert.equal(result.status,0);
    let ready=false;for(let n=0;n<100;n++){if(docker(['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database]).status===0){ready=true;break;}await delay(200);}assert.ok(ready);
    for(const item of cache.manifest.roles)psql(`CREATE ROLE ${item.name} ${item.login?'LOGIN':'NOLOGIN'} ${item.inherit?'INHERIT':'NOINHERIT'};`);
    for(const item of cache.manifest.members)psql(`GRANT ${item.role} TO ${item.member};`);
    psql(cache.source);
    const module=await import('./native-member-profile-schema-probes.mjs');await module.runNativeMemberProfileProbes({container,docker,psql,value,parallelPsql,role,database});
  }finally{const label=docker(['inspect','--format','{{ index .Config.Labels "mindbliss.synthetic" }}',container]);if(label.status===0&&label.stdout.trim()==='native-profile-prefix'&&/^mb-native-profile-test-[a-f0-9-]{36}$/.test(container))docker(['rm','--force',container]);}
}
