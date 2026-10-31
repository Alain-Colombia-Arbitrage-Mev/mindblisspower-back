import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { privateNOWPaymentsReadiness, privateNOWPaymentsDiagnostics } from '../src/nowpayments-readiness.mjs';
import { dispatchCore } from '../src/routing.mjs';
const env={CORE_ENV:'production',NOWPAYMENTS_OPERATIONAL_ENABLED:'true',NOWPAYMENTS_ENGINE_ENABLED:'true',NOWPAYMENTS_MEMBERSHIPS_ENABLED:'true',
  NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED:'true',AUTH_SERVICES_ENABLED:'true',AUTH_CUTOVER_VERIFIED:'true',CORE_DATA_ACCESS_VERIFIED:'true',PAYMENTS_SERVICE_TOKEN:'synthetic-readiness-token'};
test('NOW private readiness is default-closed without ever reading a secret or starting a container',async()=>{
  const disabled={...env,NOWPAYMENTS_ENGINE_ENABLED:'false'};Object.defineProperty(disabled,'PAYMENTS_SERVICE_TOKEN',{get:()=>assert.fail('closed gate read token')});
  assert.deepEqual(await privateNOWPaymentsReadiness(disabled,()=>assert.fail('closed gate started container')),{enabled:false,ready:false});
});
test('NOW private readiness uses a fixed read-only authenticated target and projects only its exact schema boolean',async()=>{
  assert.deepEqual(await privateNOWPaymentsReadiness(env,(service,instance)=>{
    assert.equal(service,'payments');assert.equal(instance,'singleton');return {fetch:async request=>{
      assert.equal(request.url,'https://payments.core.internal/api/payments/internal/nowpayments/ready');assert.equal(request.method,'GET');assert.equal(request.body,null);
      assert.equal(request.headers.get('x-vp-service-token'),env.PAYMENTS_SERVICE_TOKEN);return Response.json({ready:true,engine_schema:1,private:'must-not-return'});}};
  }),{enabled:true,ready:true});
});
test('missing, redirected, failed, malformed or overly large readiness responses never claim readiness',async()=>{
  for(const response of [new Response(null,{status:302}),new Response(null,{status:503}),new Response('x'.repeat(1025)),Response.json({ready:'true',engine_schema:1}),Response.json({ready:true,engine_schema:2}),new Response('not-json')]){
    assert.deepEqual(await privateNOWPaymentsReadiness(env,()=>({fetch:async()=>response})),{enabled:true,ready:false});
  }
});

test('diagnostic RPC projects only the actual HTTP status and allowlisted error, never arbitrary body fields',async()=>{
  for(const [status,error] of [[503,'service_read_only'],[503,'nowpayments_not_ready'],[401,'unauthorized'],[500,'database-password-secret']]){
    let calls=0;
    const result=await privateNOWPaymentsDiagnostics(env,(service,instance)=>({fetch:async request=>{
      calls++;assert.equal(service,'payments');assert.equal(instance,'singleton');
      assert.equal(request.url,'https://payments.core.internal/api/payments/internal/nowpayments/ready');
      assert.equal(request.method,'GET');assert.equal(request.body,null);assert.equal(request.redirect,'manual');
      return Response.json({error,secret:'must-not-escape',sql:'must-not-escape'},{status,headers:{'x-private':'must-not-escape'}});
    }}));
    assert.equal(calls,1);
    assert.deepEqual(result,{enabled:true,ready:false,http_status:status,error:status===500?'invalid_response':error});
    assert.doesNotMatch(JSON.stringify(result),/must-not-escape|database-password|sql|x-private/);
  }
  assert.deepEqual(await privateNOWPaymentsDiagnostics(env,()=>({fetch:async()=>Response.json({ready:true,engine_schema:1,secret:'hidden'})})),
    {enabled:true,ready:true,http_status:200,error:null});
});

test('diagnostics bound response bytes and timeout, including failed streams, without reflecting data',async t=>{
  for(const response of [new Response('not-json',{status:503}),new Response('x'.repeat(1025),{status:500}),
    new Response(new Uint8Array(1025),{status:500}),new Response(null,{status:401}),Response.json({ready:true,engine_schema:2})]){
    const result=await privateNOWPaymentsDiagnostics(env,()=>({fetch:async()=>response}));
    assert.equal(result.ready,false);assert.equal(result.http_status,response.status);assert.equal(result.error,'invalid_response');
  }
  assert.deepEqual(await privateNOWPaymentsDiagnostics(env,()=>({fetch:async()=>{throw new Error('private DSN');}})),
    {enabled:true,ready:false,http_status:0,error:'invalid_response'});
  t.mock.timers.enable({apis:['setTimeout']});
  let signal;
  const pending=privateNOWPaymentsDiagnostics(env,()=>({fetch:request=>{signal=request.signal;return new Promise(()=>{});}}));
  await Promise.resolve();t.mock.timers.tick(20000);
  assert.deepEqual(await pending,{enabled:true,ready:false,http_status:0,error:'invalid_response'});
  assert.equal(signal.aborted,true);
});

test('diagnostic entrypoint rejects arguments before resolution and no public internal namespace dispatches it',async()=>{
  const source=readFileSync(new URL('../src/worker.mjs',import.meta.url),'utf8');
  const body=source.split('export class PrivateCoreProbe extends WorkerEntrypoint {')[1].split('\nfor (const')[0];
  let calls=0;
  const Probe=vm.runInNewContext(`(class PrivateCoreProbe extends WorkerEntrypoint {${body})`,{
    WorkerEntrypoint:class{constructor(){this.env=env;}},resolveFor:()=>()=>{},
    privateNOWPaymentsDiagnostics:()=>{calls++;return {enabled:true,ready:true,http_status:200,error:null};},
  });
  const probe=new Probe();
  assert.throws(()=>probe.nowpaymentsDiagnostics('caller-path'),/accepts no arguments/);
  assert.equal(calls,0);assert.equal(probe.nowpaymentsDiagnostics().ready,true);assert.equal(calls,1);
  for(const path of ['/api/payments/internal/nowpayments/diagnostics','/api/payments/internal/nowpayments/ready']){
    const response=await dispatchCore(new Request(`https://payments.core.internal${path}`),env,()=>assert.fail('public dispatch reached internal probe'));
    assert.notEqual(response.status,200);
  }
});
