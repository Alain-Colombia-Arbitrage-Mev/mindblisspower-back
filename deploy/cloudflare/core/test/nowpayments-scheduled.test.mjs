import test from 'node:test';
import assert from 'node:assert/strict';
import { runNOWPaymentsScheduled, NOWPAYMENTS_JOB } from '../src/nowpayments-scheduled.mjs';
import { dispatchCore } from '../src/routing.mjs';
const env = { CORE_ENV:'production', NOWPAYMENTS_OPERATIONAL_ENABLED:'true', NOWPAYMENTS_ENGINE_ENABLED:'true',
  NOWPAYMENTS_MEMBERSHIPS_ENABLED:'true', NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED:'true', AUTH_SERVICES_ENABLED:'true',
  AUTH_CUTOVER_VERIFIED:'true', CORE_DATA_ACCESS_VERIFIED:'true', CORE_REPORTS_ENABLED:'true', PAYMENTS_SERVICE_TOKEN:'synthetic-scheduled-token' };
test('scheduled NOW capability requires every literal flag and never wakes a container when closed', async()=>{
  const never=()=>assert.fail('disabled job started a container');
  for(const key of Object.keys(env).filter(key=>key!=='PAYMENTS_SERVICE_TOKEN' && key!=='CORE_REPORTS_ENABLED')){
    for(const value of [undefined,false,true,'false','TRUE','1']) assert.deepEqual(await runNOWPaymentsScheduled({...env,[key]:value},never),{enabled:false});
  }
});
test('scheduled NOW run has a fixed singleton, private URL, no caller body/date and a 50 second bound',async()=>{
  let calls=0;
  const result=await runNOWPaymentsScheduled(env,(service,instance)=>{
    calls++;assert.equal(service,'payments');assert.equal(instance,'singleton');
    return {fetch:async req=>{assert.equal(req.url,NOWPAYMENTS_JOB);assert.equal(req.method,'POST');assert.equal(req.body,null);
      assert.equal(req.headers.get('x-vp-service-token'),env.PAYMENTS_SERVICE_TOKEN);assert.equal(req.redirect,'manual');assert.ok(req.signal);
      return Response.json({processed:2,engine_run:true});}};
  });
  assert.deepEqual(result,{enabled:true,processed:2,engineRun:true});assert.equal(calls,1);
});
test('busy jobs do not duplicate work, and failed/malformed/redirected jobs do not claim successful finance',async()=>{
  assert.deepEqual(await runNOWPaymentsScheduled(env,()=>({fetch:async()=>new Response(null,{status:202})})),{enabled:true,busy:true});
  for(const response of [new Response(null,{status:302}),new Response(null,{status:503}),Response.json({}),
    Response.json({processed:6,engine_run:true}),Response.json({processed:0,engine_run:'true'}),new Response('x'.repeat(1025))]){
    let calls=0;await assert.rejects(runNOWPaymentsScheduled(env,()=>({fetch:async()=>{calls++;return response;}})),/scheduled processing unavailable/);assert.equal(calls,1);
  }
});
test('no private fetch client can invoke the internal job namespace, including report GETs and encoded aliases',async()=>{
  for(const path of ['/api/payments/internal/nowpayments/run','/api/payments/%69nternal/nowpayments/run','/api//payments/internal/nowpayments/run/']){
    for(const method of ['POST','GET']) assert.equal((await dispatchCore(new Request(`https://payments.core.internal${path}`,{method,headers:{'x-vp-service-token':env.PAYMENTS_SERVICE_TOKEN}}),env,()=>assert.fail('private fetch invoked job'))).status,404);
  }
});
