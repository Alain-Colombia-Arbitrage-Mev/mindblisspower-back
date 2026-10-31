import { nowpaymentsOperationalReady } from './nowpayments-operation.mjs';
const URL = 'https://payments.core.internal/api/payments/internal/nowpayments/ready';

/** Status-only private RPC: no caller-selected target, payment or financial mutation. */
export async function privateNOWPaymentsReadiness(env, resolve) {
  if (!nowpaymentsOperationalReady(env)) return { enabled: false, ready: false };
  if (typeof env.PAYMENTS_SERVICE_TOKEN !== 'string' || env.PAYMENTS_SERVICE_TOKEN.length < 16
    || /[\r\n]/.test(env.PAYMENTS_SERVICE_TOKEN)) return { enabled: true, ready: false };
  let timer;
  const controller = new AbortController();
  try {
    const run = async()=>{
      const response = await resolve('payments','singleton').fetch(new Request(URL,{method:'GET',redirect:'manual',
        headers:{'x-vp-service-token':env.PAYMENTS_SERVICE_TOKEN},signal:controller.signal}));
      if(response.status!==200){await response.body?.cancel();return false;}
      const reader=response.body?.getReader();if(!reader)return false;
      let raw='';try{const decoder=new TextDecoder();while(true){const {value,done}=await reader.read();if(done)break;
        if(value.byteLength>1024 || raw.length+value.byteLength>1024){await reader.cancel();return false;}raw+=decoder.decode(value,{stream:true});}
        raw+=decoder.decode();}finally{reader.releaseLock();}
      const data=JSON.parse(raw);return data?.ready===true && data.engine_schema===1;
    };
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(false);},20000);});
    return {enabled:true,ready:await Promise.race([run(),timeout])};
  }catch{return {enabled:true,ready:false};}
  finally{clearTimeout(timer);}
}
