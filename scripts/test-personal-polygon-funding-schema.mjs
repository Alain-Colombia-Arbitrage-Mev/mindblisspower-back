import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Extend the hash-checked synthetic 93..105 fixture, never a live database.
// The inherited harness owns its labelled container, has no network or ports,
// and destroys it after these probes. No production environment is loaded.
assert.equal(process.argv.length,2);
const sourceUrl=new URL('test-polygon-relay-schema.mjs',import.meta.url);
let source=await readFile(sourceUrl,'utf8');
const probesUrl=new URL('personal-polygon-funding-schema-probes.mjs',import.meta.url);
const cached='await module.runPolygonRelayProbes({container,docker,psql,value,equal,rejects,parallelPsql,immutable,role,database,joined});';
const fresh='await relayModule.runPolygonRelayProbes({container,docker,psql,value,equal,rejects,parallelPsql,immutable,role,database,joined:';
assert.equal(source.split(cached).length,2);
assert.equal(source.split(fresh).length,2);
source=source.replace(cached,`${cached}\n const polygonFunding=await import(${JSON.stringify(probesUrl.href)});await polygonFunding.runPersonalPolygonFundingProbes({container,docker,psql,value,parallelPsql,role,database});`);
// The cold-cache branch builds a second generated program. Add the probe call
// inside its own string so both paths exercise the same real PostgreSQL policy.
const coldLine='`  await relayModule.runPolygonRelayProbes({container,docker,psql,value,equal,rejects,parallelPsql,immutable,role,database,joined:${joined}});\\n`;';
assert.equal(source.split(coldLine).length,2);
source=source.replace(coldLine,'`  await relayModule.runPolygonRelayProbes({container,docker,psql,value,equal,rejects,parallelPsql,immutable,role,database,joined:${joined}});\\n`+\n'+
 `  \`  const polygonFunding=await import(${JSON.stringify(probesUrl.href)});await polygonFunding.runPersonalPolygonFundingProbes({container,docker,psql,value,parallelPsql,role,database});\\n\`;`);
// Preserve the inner generator's string pattern while relocating this wrapper.
source=source.replaceAll("'import.meta.url'","'__BASELINE_IMPORT_META__'");
source=source.replaceAll('import.meta.url',JSON.stringify(sourceUrl.href));
source=source.replaceAll("'__BASELINE_IMPORT_META__'","'import.meta.url'");
const directory=new URL('../.wrangler/personal-polygon-funding-schema/',import.meta.url);
await mkdir(directory,{recursive:true});
const generated=new URL(`harness-${randomUUID()}.mjs`,directory);
await writeFile(generated,source,{flag:'wx'});
const child=spawn(process.execPath,[fileURLToPath(generated)],{stdio:'inherit',shell:false});
process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
