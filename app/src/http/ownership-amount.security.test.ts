import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { TypedDataEncoder, Wallet, verifyTypedData } from 'ethers';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiEnvironment } from './types';
import { registerPersonalPolygonRelayRoutes } from './personal-polygon-relay-routes';
import { COMPANY_PAYMENT_RECIPIENT, LEGACY_POLYGON_TOKEN } from '../modules/payments/personal-company-rpc';
import { POLYGON_RELAY_ABI, POLYGON_RELAY_DOMAIN, POLYGON_RELAY_ENTRY_POINT, POLYGON_RELAY_IMPLEMENTATION,
  polygonRelayAuthorizationDigest, polygonRelayTypedData } from '../modules/payments/polygon-relay-policy';
import { decryptPolygonRelayJson, encryptPolygonRelayJson } from '../modules/payments/polygon-relay-crypto';
import { submitPersonalPolygonRelay } from '../modules/payments/polygon-relay-payment';

const prefix='/api/member/polygon-relay', secret='synthetic-ownership-amount-envelope-secret'.repeat(2);
const users={ alice:new Wallet(`0x${'2'.repeat(64)}`),bob:new Wallet(`0x${'3'.repeat(64)}`) };
type Owner=keyof typeof users;
const ids={alice:'11111111-1111-4111-8111-111111111111',bob:'22222222-2222-4222-8222-222222222222'};
const environment={AUTH_BFF_SHARED_SECRET:secret,PERSONAL_POLYGON_RELAY_ENABLED:'true',PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED:'true',
 POLYGON_RELAYER_PRIVATE_KEY:`0x${'1'.repeat(64)}`,POLYGON_RELAY_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),
 REOWN_PROJECT_ID:'a'.repeat(32),PIMLICO_API_KEY:'synthetic-only-provider-key'};
function row(owner:Owner){
 const address=users[owner].address.toLowerCase(),amount=owner==='alice'?'1000000':'2000000',created=new Date(Date.now()-1000);
 return {id:ids[owner],subject:owner,wallet_address:address,amount_atomic:amount,execution_mode:'polygon_native_meta_aa',chain_id:137,
  token_address:LEGACY_POLYGON_TOKEN,token_decimals:6,recipient_address:COMPANY_PAYMENT_RECIPIENT,authorization_nonce:'7',
  authorization_digest:polygonRelayAuthorizationDigest(address,amount,'7'),domain_separator:TypedDataEncoder.hashDomain(POLYGON_RELAY_DOMAIN),
  implementation_address:POLYGON_RELAY_IMPLEMENTATION,relayer_address:`0x${'4'.repeat(40)}`,entry_point:POLYGON_RELAY_ENTRY_POINT,
  max_fee_wei:'1000000000000000000',owner_daily_cap_wei:'2000000000000000000',global_daily_cap_wei:'10000000000000000000',
  created_at:created,expires_at:new Date(created.getTime()+300000),authorized_at:null,authorization_ciphertext:null,authorization_key_id:null,
  status:'prepared',attempt_id:null,user_operation_hash:null,transaction_hash:null,block_number:null,block_hash:null,confirmations:0,confirmed_at:null,
  failure_reason:null,entry_point_nonce:null,lease_token:null,lease_expires_at:null,operation_ciphertext:null,operation_key_id:null,
  quoted_max_fee_wei:null,operation_valid_after:null,operation_valid_until:null };
}
type Stored=Omit<ReturnType<typeof row>,'authorized_at'|'authorization_ciphertext'|'authorization_key_id'> & {
 authorized_at:Date|null;authorization_ciphertext:string|null;authorization_key_id:string|null;
};
function envelope(owner:Owner,path:string,method='POST',body?:unknown){
 const raw=body===undefined?'':JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000)),ip='192.0.2.1',cookie=`better-auth.session_token=synthetic-${owner}`;
 const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
 return {method,headers:{cookie,origin:'https://app.mindblisspower.com','content-type':'application/json','x-vp-auth-client-ip':ip,
  'x-vp-auth-timestamp':timestamp,'x-vp-auth-signature':createHmac('sha256',secret).update([method,path.split('?')[0],timestamp,ip,digest(cookie),digest(raw)].join('\n')).digest('hex')},
  ...(method==='POST'?{body:raw}:{})};
}
async function sign(owner:Owner,typedFor:Owner=owner,amount?:string,nonce='7'){
 const base=row(typedFor),typed=polygonRelayTypedData(base.wallet_address,amount??base.amount_atomic,nonce);
 const signature=await users[owner].signTypedData(typed.domain,typed.types,typed.message);
 expect(verifyTypedData(typed.domain,typed.types,typed.message,signature).toLowerCase()).toBe(users[owner].address.toLowerCase());
 return signature;
}
function fixture({returnForeign=false}={}){
 const records=new Map<string,Stored>(Object.entries(users).map(([owner])=>[ids[owner as Owner],row(owner as Owner)]));
 const queries:{sql:string;params:unknown[]}[]=[],methods:string[]=[];let writes=0;
 const database={execute:async(input:unknown)=>{
  const query=new PgDialect().sqlToQuery(input as SQL);queries.push(query);
  const owner=query.params[0] as string,id=query.params[1] as string;
  if(query.sql.includes('read_personal_polygon_relay_history'))return [...records.values()].filter(r=>r.subject===owner);
  const stored=records.get(id);
  if(!stored||(!returnForeign&&stored.subject!==owner))throw Error('polygon_relay_not_found');
  if(query.sql.includes('read_personal_polygon_relay('))return [{...stored}];
  if(query.sql.includes('authorize_personal_polygon_relay(')){
   // Emulate only the persistence boundary. Signature/amount verification is
   // performed by the actual application module before this writer is reached.
   expect(query.params[2]).toBe(stored.authorization_digest);
   const payload=decryptPolygonRelayJson(environment,`polygon-relay:${owner}:${id}:authorization`,query.params[3] as string) as {signature:string;authorizationDigest:string};
   expect(payload.authorizationDigest).toBe(stored.authorization_digest);
   const typed=polygonRelayTypedData(stored.wallet_address,stored.amount_atomic,stored.authorization_nonce);
   expect(verifyTypedData(typed.domain,typed.types,typed.message,payload.signature).toLowerCase()).toBe(stored.wallet_address);
   writes++;const authorized:Stored={...stored,status:'authorized',authorized_at:new Date(),authorization_ciphertext:query.params[3] as string,authorization_key_id:query.params[4] as string};
   records.set(id,authorized);return [authorized];
  }
  throw Error('unexpected persistence or dispatch');
 }} as unknown as Pick<IdentityDatabase,'execute'>;
 const fetchImpl=(async(_target,init)=>{
  const request=JSON.parse(String(init?.body));methods.push(request.method);
  let result:unknown;
  if(request.method==='eth_chainId')result='0x89';
  else if(request.method==='eth_call'){
   const data=request.params[0].data;
   if(data==='0x313ce567')result=`0x${'6'.padStart(64,'0')}`;
   else if(data.startsWith('0x70a08231'))result=`0x${'100000000'.padStart(64,'0')}`;
   else if(data===POLYGON_RELAY_ABI.encodeFunctionData('implementation'))result=`0x${POLYGON_RELAY_IMPLEMENTATION.slice(2).padStart(64,'0')}`;
   else if(data===POLYGON_RELAY_ABI.encodeFunctionData('getDomainSeperator'))result=TypedDataEncoder.hashDomain(POLYGON_RELAY_DOMAIN);
   else if(Object.values(users).some(user=>data===POLYGON_RELAY_ABI.encodeFunctionData('getNonce',[user.address])))result=`0x${'7'.padStart(64,'0')}`;
  }
  if(result===undefined)throw Error('no sponsorship, signer or broadcaster is permitted in these tests');
  return Response.json({jsonrpc:'2.0',id:request.id,result});
 }) as typeof fetch;
 const apps=Object.fromEntries((Object.keys(users) as Owner[]).map(owner=>{
  const app=new Hono<ApiEnvironment>();
  app.use('*',async(context,next)=>{context.set('session',{user:{id:owner}} as never);await next();});
  registerPersonalPolygonRelayRoutes(app,{database,environment,fetchImpl});return [owner,app];
 })) as Record<Owner,Hono<ApiEnvironment>>;
 return {records,queries,methods,database,fetchImpl,apps,writes:()=>writes,
  request:(owner:Owner,action:string,body?:unknown)=>{const path=`${prefix}/${action}`;return apps[owner].request(path,envelope(owner,path,body===undefined?'GET':'POST',body));}};
}

test('two authenticated users cannot read, authorize, submit, verify or abandon each other\'s payment even with the other valid wallet signature',async()=>{
 const f=fixture(),aliceSignature=await sign('alice');
 for(const owner of ['alice','bob'] as const){
  const other=owner==='alice'?'bob':'alice',signature=other==='alice'?aliceSignature:await sign('bob');
  for(const action of ['status','authorize','submit','verify','abandon']){
   const response=await f.request(owner,action==='status'?`status?paymentId=${ids[other]}`:action,
    action==='status'?undefined:{paymentId:ids[other],...(action==='authorize'?{signature}:{})});
   expect(response.status).toBe(404);expect(await response.json()).toEqual({error:'polygon_relay_not_found'});
   expect(f.queries.at(-1)!.params.slice(0,2)).toEqual([owner,ids[other]]);
  }
  const history=await f.request(owner,'history');expect(history.status).toBe(200);
  const data=await history.json() as {payments:{paymentId:string;walletAddress:string}[]};
  expect(data.payments.map(p=>p.paymentId)).toEqual([ids[owner]]);
  expect(data.payments[0]!.walletAddress).toBe(users[owner].address.toLowerCase());
  expect(history.headers.get('cache-control')).toBe('private, no-store');
 }
 expect(f.methods).toEqual([]);expect(f.writes()).toBe(0);
});

test('a foreign-owner row returned by a broken persistence boundary still fails closed before signature validation or provider access',async()=>{
 const f=fixture({returnForeign:true});
 for(const action of ['status','authorize','submit','verify']){
  const response=await f.request('bob',action==='status'?`status?paymentId=${ids.alice}`:action,
   action==='status'?undefined:{paymentId:ids.alice,...(action==='authorize'?{signature:await sign('alice')}:{})});
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'polygon_relay_unavailable'});
 }
 expect(f.methods).toEqual([]);expect(f.writes()).toBe(0);
});

test('a valid signature from another wallet or for another amount or nonce cannot authorize an owned intent',async()=>{
 const f=fixture();
 for(const [owner,signature] of [
  ['alice',await sign('bob','alice')],['bob',await sign('alice','bob')],
  ['alice',await sign('alice','alice','2000000')],['alice',await sign('alice','alice','999999')],
  ['alice',await sign('alice','alice','1000000','8')],
 ] as const){
  const response=await f.request(owner,'authorize',{paymentId:ids[owner],signature});
  expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'polygon_relay_signature_invalid'});
 }
 expect(f.methods).toEqual([]);expect(f.writes()).toBe(0);
});

test('the exact reviewed amount is authorized once; exact replay is read-only and changing amount or ownership cannot replace it',async()=>{
 const f=fixture(),signature=await sign('alice');
 const response=await f.request('alice','authorize',{paymentId:ids.alice,signature});expect(response.status).toBe(200);
 const authorized=await response.json();expect(authorized).toMatchObject({paymentId:ids.alice,walletAddress:users.alice.address.toLowerCase(),amountAtomic:'1000000',status:'authorized'});
 expect(f.writes()).toBe(1);const reads=f.methods.length;expect(reads).toBeGreaterThan(0);
 const replay=await f.request('alice','authorize',{paymentId:ids.alice,signature});expect(replay.status).toBe(200);expect(await replay.json()).toEqual(authorized);
 const exact=await f.request('alice','prepare',{requestId:ids.alice,amountAtomic:'1000000'});expect(exact.status).toBe(201);expect(await exact.json()).toEqual(authorized);
 for(const amountAtomic of ['1','999999','2000000']){
  const changed=await f.request('alice','prepare',{requestId:ids.alice,amountAtomic});
  expect(changed.status).toBe(409);expect(await changed.json()).toEqual({error:'polygon_relay_request_already_used'});
 }
 const foreign=await f.request('bob','authorize',{paymentId:ids.alice,signature});expect(foreign.status).toBe(404);
 expect(f.writes()).toBe(1);expect(f.methods).toHaveLength(reads);
 expect(f.records.get(ids.alice)!.amount_atomic).toBe('1000000');
 expect(f.methods.every(method=>method==='eth_chainId'||method==='eth_call')).toBe(true);
});

test('post-review actions cannot select another user or wallet, alter amount, or claim a confirmed status through added body fields',async()=>{
 const f=fixture(),signature=await sign('alice');
 for(const action of ['authorize','submit','verify','abandon'])for(const extra of [
  {amountAtomic:'2000000'},{amount:2},{subject:'bob'},{userId:'bob'},{owner:'bob'},{walletAddress:users.bob.address},{address:users.bob.address},{status:'confirmed'},
 ]){
  const response=await f.request('alice',action,{paymentId:ids.alice,...(action==='authorize'?{signature}:{}),...extra});
  expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'invalid_request'});
 }
 expect(f.queries).toEqual([]);expect(f.methods).toEqual([]);expect(f.writes()).toBe(0);
});

test('changing the signed BFF body or swapping Alice\'s cookie for Bob\'s cannot reach any transfer database function',async()=>{
 const f=fixture(),path=`${prefix}/prepare`,body={requestId:ids.alice,amountAtomic:'1000000'};
 const original=envelope('alice',path,'POST',body);
 const changedBody={...original,body:JSON.stringify({...body,amountAtomic:'2000000'})};
 expect((await f.apps.alice.request(path,changedBody)).status).toBe(403);
 const changedCookie={...original,headers:{...original.headers,cookie:'better-auth.session_token=synthetic-bob'}};
 expect((await f.apps.bob.request(path,changedCookie)).status).toBe(403);
 expect(f.queries).toEqual([]);expect(f.methods).toEqual([]);expect(f.writes()).toBe(0);
});

test('an accepted authorization cannot be transplanted across owners or silently used with a changed persisted amount before dispatch',async()=>{
 const f=fixture(),signature=await sign('alice');
 const accepted=await f.request('alice','authorize',{paymentId:ids.alice,signature});expect(accepted.status).toBe(200);
 const alice={...f.records.get(ids.alice)!},bob={...f.records.get(ids.bob)!},reads=f.methods.length;
 const variants=[
  {owner:'bob' as const,value:{...bob,status:'authorized',authorized_at:alice.authorized_at,authorization_ciphertext:alice.authorization_ciphertext,authorization_key_id:alice.authorization_key_id}},
  {owner:'alice' as const,value:{...alice,amount_atomic:'2000000'}},
 ];
 for(const variant of variants){
  f.records.set(ids[variant.owner],variant.value as Stored);
  await expect(submitPersonalPolygonRelay(f.database,{paymentId:ids[variant.owner]},variant.owner,{environment,fetchImpl:f.fetchImpl})).rejects.toThrow();
 }
 expect(f.methods).toHaveLength(reads);expect(f.writes()).toBe(1);
 expect(f.queries.every(q=>!/begin_personal|persist_personal|mark_personal/.test(q.sql))).toBe(true);
});

test('authorization and saved-operation ciphertext are bound to the exact owner, payment, purpose and dispatch attempt',async()=>{
 const payload={signature:await sign('alice'),authorizationDigest:row('alice').authorization_digest};
 const authorizationContext=`polygon-relay:alice:${ids.alice}:authorization`;
 const encrypted=encryptPolygonRelayJson(environment,authorizationContext,payload);
 expect(decryptPolygonRelayJson(environment,authorizationContext,encrypted.ciphertext)).toEqual(payload);
 for(const context of [`polygon-relay:bob:${ids.alice}:authorization`,`polygon-relay:alice:${ids.bob}:authorization`,
  `polygon-relay:alice:${ids.alice}:operation:${ids.bob}`]){
  expect(()=>decryptPolygonRelayJson(environment,context,encrypted.ciphertext)).toThrow('polygon_relay_authorization_unavailable');
 }
 const attemptA='33333333-3333-4333-8333-333333333333',attemptB='44444444-4444-4444-8444-444444444444';
 const operationContext=`polygon-relay:alice:${ids.alice}:operation:${attemptA}`;
 const operation=encryptPolygonRelayJson(environment,operationContext,{amountAtomic:'1000000',reviewedRecipient:COMPANY_PAYMENT_RECIPIENT});
 for(const context of [`polygon-relay:bob:${ids.alice}:operation:${attemptA}`,`polygon-relay:alice:${ids.bob}:operation:${attemptA}`,
  `polygon-relay:alice:${ids.alice}:operation:${attemptB}`,authorizationContext]){
  expect(()=>decryptPolygonRelayJson(environment,context,operation.ciphertext)).toThrow('polygon_relay_authorization_unavailable');
 }
});
