import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (!process.argv.includes('--qa-docker')) throw new Error('Requires --qa-docker and the existing synthetic mindbliss-qa stack');
const name = `mindbliss-edge-drill-${randomBytes(6).toString('hex')}`;
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
let created = false;
try {
  docker(['run', '-d', '--name', name, '--network', 'mindbliss-qa_preview',
    '-e', 'CLIENT_HOST=http://client.example.invalid', '-e', 'ADMIN_HOST=http://admin.example.invalid',
    '-e', 'WEBHOOK_HOST=http://webhook.example.invalid', 'mindbliss/edge:infra-20261023']);
  created = true;
  const script = `
    import http from 'node:http';
    const origin=${JSON.stringify(`http://${name}:80`)};
    const request=(url,method,host)=>new Promise((resolve,reject)=>{
      const req=http.request(origin+url,{method,headers:{host}},response=>{
        response.resume();response.on('end',()=>resolve(response.statusCode));
      });
      req.on('error',reject);req.end(method==='POST'?'synthetic invalid signature':'');
    });
    const cases=[
      ['GET','/api/admin/dashboard',404],['POST','/api/admin/users',404],
      ['GET','/health',404],['GET','/api/webhooks/stripe',404],
      ['PUT','/api/webhooks/stripe',404],['POST','/api/webhooks/stripe/extra',404],
      ['POST','/api/webhooks/stripe',400]
    ];
    for(let attempt=0;attempt<30;attempt++){
      try{await request('/health','GET','webhook.example.invalid');break;}
      catch(error){if(attempt===29)throw error;await new Promise(r=>setTimeout(r,100));}
    }
    for(const [method,url,status] of cases){
      const actual=await request(url,method,'webhook.example.invalid');
      if(actual!==status)throw Error(method+' '+url+': expected '+status+', got '+actual);
    }
    for(const host of ['client.example.invalid','admin.example.invalid']){
      const actual=await request('/login','GET',host);
      if(actual!==200)throw Error(host+': login did not resolve, got '+actual);
    }
    console.log('PASS: 9 edge probes; only signed-Stripe route reaches payments (invalid signature rejected), private admin/API paths stay blocked.');
  `;
  console.log(docker(['exec', 'mindbliss-qa-client-1', 'node', '--input-type=module', '-e', script]));
} finally {
  if (!/^mindbliss-edge-drill-[a-f0-9]{12}$/.test(name)) throw new Error('Unsafe cleanup target');
  if (created) docker(['rm', '-f', '-v', name]);
}
