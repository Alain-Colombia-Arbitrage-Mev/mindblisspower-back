import { nowpaymentsOperationalReady } from './nowpayments-operation.mjs';
const URL = 'https://payments.core.internal/api/payments/internal/nowpayments/ready';
const ERRORS = new Set(['service_read_only', 'nowpayments_not_ready', 'unauthorized']);

/** Status-only private RPC: no caller-selected target, payment or financial mutation. */
export async function privateNOWPaymentsReadiness(env, resolve) {
  const result = await privateNOWPaymentsDiagnostics(env, resolve);
  return { enabled: result.enabled, ready: result.ready };
}

/** Private diagnosis exposes bounded status/enums only, never upstream content or credentials. */
export async function privateNOWPaymentsDiagnostics(env, resolve) {
  const result = { enabled: nowpaymentsOperationalReady(env), ready: false, http_status: 0, error: 'invalid_response' };
  if (!result.enabled) return result;
  if (typeof env.PAYMENTS_SERVICE_TOKEN !== 'string' || env.PAYMENTS_SERVICE_TOKEN.length < 16
    || /[\r\n]/.test(env.PAYMENTS_SERVICE_TOKEN)) return result;
  let timer;
  const controller = new AbortController();
  try {
    const run = async()=>{
      const response = await resolve('payments','singleton').fetch(new Request(URL,{method:'GET',redirect:'manual',
        headers:{'x-vp-service-token':env.PAYMENTS_SERVICE_TOKEN},signal:controller.signal}));
      result.http_status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0;
      const reader=response.body?.getReader();if(!reader)return { ...result };
      let raw='', bytes=0;try{const decoder=new TextDecoder();while(true){const {value,done}=await reader.read();if(done)break;
        bytes+=value.byteLength;if(bytes>1024){await reader.cancel();return { ...result };}raw+=decoder.decode(value,{stream:true});}
        raw+=decoder.decode();}finally{reader.releaseLock();}
      const data=JSON.parse(raw);
      if(response.status===200 && data?.ready===true && data.engine_schema===1) return { ...result, ready:true, error:null };
      return { ...result, error:response.status!==200 && ERRORS.has(data?.error) ? data.error : 'invalid_response' };
    };
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({ ...result });},20000);});
    return await Promise.race([run(),timeout]);
  }catch{return { ...result };}
  finally{clearTimeout(timer);}
}
