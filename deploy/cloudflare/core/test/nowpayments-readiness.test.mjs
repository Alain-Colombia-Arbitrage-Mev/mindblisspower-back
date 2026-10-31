import test from 'node:test';
import assert from 'node:assert/strict';
import { privateNOWPaymentsReadiness } from '../src/nowpayments-readiness.mjs';
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
