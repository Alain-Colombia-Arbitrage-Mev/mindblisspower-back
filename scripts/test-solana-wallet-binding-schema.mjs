import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// Sole target: a labelled, network-disabled, disposable PostgreSQL. No DSN,
// provider, wallet signer, deployment credential or host port is accepted.
assert.equal(process.argv.length, 2);
const container=`mb-solana-binding-test-${randomUUID()}`,label='mindbliss.synthetic=solana-binding-schema';
const database='mindbliss_curated_20261025',role='mindbliss_auth_core_v1';
const image='postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
const evm=readFileSync(new URL('../_meta/migration/91_reown_wallet_binding.sql',import.meta.url),'utf8');
const migration=readFileSync(new URL('../_meta/migration/103_solana_wallet_binding.sql',import.meta.url),'utf8');
const docker=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',shell:false,maxBuffer:2*1024*1024});
let probes=0;
const psql=(source,allowFailure=false)=>{const result=docker(['exec','-i',container,'psql','-X','-w','-qAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],source);
  if(!allowFailure&&result.status!==0)throw Error(result.stderr||'Synthetic PostgreSQL failed');return result;};
const value=(source,runtime=true)=>psql(`${runtime?`SET ROLE ${role};`:''}${source}`).stdout.trim();
const equal=(source,expected,runtime=true)=>{assert.equal(value(source,runtime),expected);probes++;};
const reject=(source,pattern,runtime=true)=>{const result=psql(`${runtime?`SET ROLE ${role};`:''}${source}`,true);
  assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(pattern));probes++;};
const parallel=source=>new Promise((resolve,reject)=>{const child=spawn('docker',['exec','-i',container,'psql','-X','-w','-qAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe'],shell:false});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('error',reject);
  child.on('close',status=>resolve({status,stdout:stdout.trim(),stderr}));child.stdin.end(`SET ROLE ${role};${source}`);});
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function publicAddress(){const bytes=randomBytes(32);let integer=BigInt(`0x${bytes.toString('hex')}`),encoded='';
  while(integer){encoded=alphabet[Number(integer%58n)]+encoded;integer/=58n;}for(const byte of bytes){if(byte!==0)break;encoded='1'+encoded;}return encoded;}
const genesis='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',addresses=Array.from({length:5},publicAddress);
const binding=(owner='alice',person='1',address=addresses[0],cluster='mainnet-beta',hash=genesis)=>
  `INSERT INTO identity.solana_wallet_binding(subject,person_id,cluster,genesis_hash,address)
   VALUES('${owner}',${person},'${cluster}','${hash}','${address}');`;
const issued=new Date(),expires=new Date(issued.getTime()+300_000),message='Synthetic domain-bound ownership challenge. '.repeat(6);
const challenge=(id=randomUUID(),owner='alice',person='1',address=addresses[0],fields={})=>{
  const data={cluster:'mainnet-beta',genesis,nonce:createHash('sha256').update(randomBytes(32)).digest('hex'),message,
    issued:issued.toISOString(),expires:expires.toISOString(),consumed:null,...fields};
  return `INSERT INTO identity.solana_wallet_link_challenge(id,subject,person_id,cluster,genesis_hash,address,nonce_hash,message,issued_at,expires_at,consumed_at)
    VALUES('${id}','${owner}',${person},'${data.cluster}','${data.genesis}','${address}','${data.nonce}','${data.message}',
      '${data.issued}','${data.expires}',${data.consumed===null?'NULL':`'${data.consumed}'`});`;};
try{
  const started=docker(['run','--detach','--pull','never','--name',container,'--label',label,'--network','none',
    '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e',`POSTGRES_DB=${database}`,image]);assert.equal(started.status,0);
  let ready=false;for(let i=0;i<100;i++){if(docker(['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database]).status===0){ready=true;break;}await delay(200);}assert.equal(ready,true);
  psql(`CREATE ROLE ${role} NOLOGIN;CREATE ROLE app_read NOLOGIN;
    CREATE SCHEMA auth;CREATE SCHEMA identity;CREATE SCHEMA mlm;CREATE SCHEMA payments;
    GRANT USAGE ON SCHEMA auth,identity,mlm TO ${role},app_read;
    CREATE TABLE auth."user"(id text PRIMARY KEY);INSERT INTO auth."user" VALUES('alice'),('bob'),('charlie'),('dave'),('erin');
    CREATE TABLE mlm.person(id bigint PRIMARY KEY);INSERT INTO mlm.person VALUES(1),(2),(3),(4),(5);
    CREATE TABLE payments.synthetic_ledger(id integer PRIMARY KEY,amount numeric);INSERT INTO payments.synthetic_ledger VALUES(1,123.45);`);
  psql(evm);
  value(`INSERT INTO identity.wallet_binding(subject,person_id,chain_id,address) VALUES('alice',1,1,'0x${'1'.repeat(40)}');`);
  psql('ALTER DEFAULT PRIVILEGES IN SCHEMA identity GRANT SELECT ON TABLES TO app_read;ALTER DEFAULT PRIVILEGES IN SCHEMA identity GRANT EXECUTE ON FUNCTIONS TO app_read;');
  const oldRows=`SELECT md5(jsonb_build_object('users',(SELECT jsonb_agg(u ORDER BY id) FROM auth."user" u),
    'persons',(SELECT jsonb_agg(p ORDER BY id) FROM mlm.person p),'evm',(SELECT jsonb_agg(b ORDER BY subject) FROM identity.wallet_binding b),
    'challenges',(SELECT jsonb_agg(c ORDER BY id) FROM identity.wallet_link_challenge c),
    'ledger',(SELECT jsonb_agg(l ORDER BY id) FROM payments.synthetic_ledger l))::text);`;
  const before=value(oldRows,false);psql(migration);equal(oldRows,before,false);
  equal(`SELECT bool_and(attcollation='"C"'::regcollation) FROM pg_attribute WHERE attname='address'
    AND attrelid IN('identity.solana_wallet_binding'::regclass,'identity.solana_wallet_link_challenge'::regclass);`,'t',false);
  for(const table of ['solana_wallet_binding','solana_wallet_link_challenge']){
    for(const permission of ['SELECT','INSERT'])equal(`SELECT has_table_privilege('${role}','identity.${table}','${permission}');`,'t',false);
    equal(`SELECT has_table_privilege('app_read','identity.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE');`,'f',false);
    equal(`SELECT has_table_privilege('${role}','identity.${table}','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');`,'f',false);
  }
  equal(`SELECT has_column_privilege('${role}','identity.solana_wallet_link_challenge','consumed_at','UPDATE');`,'t',false);
  equal(`SELECT bool_and(NOT has_column_privilege('${role}',attrelid,attnum,'UPDATE')) FROM pg_attribute
    WHERE attrelid='identity.solana_wallet_link_challenge'::regclass AND attnum>0 AND NOT attisdropped AND attname<>'consumed_at';`,'t',false);
  for(const name of ['guard_solana_wallet_link_challenge','guard_solana_wallet_binding']){
    equal(`SELECT NOT has_function_privilege('${role}','identity.${name}()','EXECUTE') AND NOT has_function_privilege('app_read','identity.${name}()','EXECUTE');`,'t',false);
  }
  equal(`SELECT count(*) FROM identity.solana_wallet_binding;`,'0');
  value(binding());equal(`SELECT address FROM identity.solana_wallet_binding WHERE subject='alice';`,addresses[0]);
  equal(`SELECT e.address||'|'||s.address FROM identity.wallet_binding e JOIN identity.solana_wallet_binding s USING(subject) WHERE e.subject='alice';`,`0x${'1'.repeat(40)}|${addresses[0]}`);
  reject(binding('bob','2',addresses[0]),'unique constraint');reject(binding('charlie','1',addresses[2]),'unique constraint');reject(binding('alice','2',addresses[1]),'unique constraint');
  for(const args of [['bob','2','0x'+'a'.repeat(40)],['bob','2',addresses[1],'devnet'],['bob','2',addresses[1],'mainnet-beta','EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG']])reject(binding(...args),'check constraint');
  reject(binding('missing','2',addresses[1]),'foreign key');reject(binding('bob','99',addresses[1]),'foreign key');
  const index=[...addresses[0]].findIndex((char,i)=>i>0&&/[a-hj-km-np-zA-HJ-KM-NP-Z]/.test(char));assert.ok(index>0);
  const char=addresses[0][index],variant=addresses[0].slice(0,index)+(char===char.toLowerCase()?char.toUpperCase():char.toLowerCase())+addresses[0].slice(index+1);
  value(binding('dave','4',variant));equal(`SELECT count(DISTINCT address) FROM identity.solana_wallet_binding WHERE subject IN('alice','dave');`,'2');
  reject(`UPDATE identity.solana_wallet_binding SET address='${addresses[1]}' WHERE subject='alice';`,'permission denied');
  reject(`DELETE FROM identity.solana_wallet_binding WHERE subject='alice';`,'permission denied');
  reject('TRUNCATE identity.solana_wallet_binding;','permission denied');
  reject(`UPDATE identity.solana_wallet_binding SET address='${addresses[1]}' WHERE subject='alice';`,'solana_wallet_binding_immutable',false);
  reject(`DELETE FROM identity.solana_wallet_binding WHERE subject='alice';`,'solana_wallet_binding_immutable',false);
  reject('TRUNCATE identity.solana_wallet_binding;','solana_wallet_binding_immutable',false);
  const id=randomUUID(),nonce='a'.repeat(64);value(challenge(id,'alice','1',addresses[0],{nonce}));
  reject(challenge(randomUUID(),'alice','1',addresses[0],{nonce}),'unique constraint');
  for(const fields of [{cluster:'devnet'},{genesis:'invalid'},{nonce:'x'.repeat(64)},{message:'short'},
    {expires:new Date(expires.getTime()+1).toISOString()},{expires:issued.toISOString()},
    {consumed:new Date(issued.getTime()-1).toISOString()}])reject(challenge(randomUUID(),'alice','1',addresses[0],fields),'check constraint');
  reject(challenge('00000000-0000-0000-0000-000000000000'),'check constraint');
  reject(`UPDATE identity.solana_wallet_link_challenge SET message='${message}changed' WHERE id='${id}';`,'permission denied');
  reject(`UPDATE identity.solana_wallet_link_challenge SET message='${message}changed' WHERE id='${id}';`,'solana_wallet_challenge_immutable',false);
  reject(`UPDATE identity.solana_wallet_link_challenge SET consumed_at=NULL WHERE id='${id}';`,'solana_wallet_challenge_immutable');
  const consumed=new Date(issued.getTime()+1_000).toISOString();
  value(`UPDATE identity.solana_wallet_link_challenge SET consumed_at='${consumed}' WHERE id='${id}';`);
  value(`UPDATE identity.solana_wallet_link_challenge SET consumed_at='${consumed}' WHERE id='${id}';`);
  reject(`UPDATE identity.solana_wallet_link_challenge SET consumed_at=NULL WHERE id='${id}';`,'solana_wallet_challenge_immutable');
  reject(`UPDATE identity.solana_wallet_link_challenge SET consumed_at='${new Date(issued.getTime()+2_000).toISOString()}' WHERE id='${id}';`,'solana_wallet_challenge_immutable');
  reject('DELETE FROM identity.solana_wallet_link_challenge;','permission denied');reject('TRUNCATE identity.solana_wallet_link_challenge;','permission denied');
  reject('DELETE FROM identity.solana_wallet_link_challenge;','solana_wallet_challenge_immutable',false);
  reject('TRUNCATE identity.solana_wallet_link_challenge;','solana_wallet_challenge_immutable',false);
  const raceId=randomUUID();value(challenge(raceId,'bob','2',addresses[1]));
  const races=await Promise.all([0,1].map(()=>parallel(`UPDATE identity.solana_wallet_link_challenge SET consumed_at=clock_timestamp()
    WHERE id='${raceId}' AND consumed_at IS NULL RETURNING id;`)));
  assert.equal(races.filter(result=>result.status===0&&result.stdout===raceId).length,1);
  assert.equal(races.filter(result=>result.status===0&&result.stdout==='').length,1);probes++;
  const rollbackId=randomUUID();value(challenge(rollbackId,'bob','2',addresses[1]));
  value(`BEGIN;${binding('bob','2',addresses[1])}UPDATE identity.solana_wallet_link_challenge SET consumed_at=clock_timestamp() WHERE id='${rollbackId}';ROLLBACK;`);
  equal(`SELECT count(*) FROM identity.solana_wallet_binding WHERE subject='bob';`,'0');
  equal(`SELECT consumed_at IS NULL FROM identity.solana_wallet_link_challenge WHERE id='${rollbackId}';`,'t');
  equal(oldRows,before,false);reject(migration,'solana_wallet_binding_requires_fresh_review',false);
  const profile=JSON.parse(value(`SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid)) ORDER BY proname) FROM pg_proc
    WHERE oid IN('identity.guard_solana_wallet_link_challenge()'::regprocedure,'identity.guard_solana_wallet_binding()'::regprocedure);`,false));
  console.log(JSON.stringify({solanaWalletBindingSchema:'passed',probes,profile,oldEvmIdentityAndLedgerUnchanged:true,
    mainnetOnly:true,base58CasePreserved:true,externalNetwork:'disabled',productionConnections:0,realSignatures:0,realTransfers:0}));
}catch(error){console.error(JSON.stringify({solanaWalletBindingSchema:'failed',message:error.message}));process.exitCode=1;
}finally{const ownership=docker(['inspect','--format','{{ index .Config.Labels "mindbliss.synthetic" }}',container]);
  if(ownership.status===0&&ownership.stdout.trim()==='solana-binding-schema'&&/^mb-solana-binding-test-[a-f0-9-]{36}$/.test(container))docker(['rm','--force',container]);}
