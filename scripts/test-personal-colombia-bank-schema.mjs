import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Extend only the existing isolated, hash-checked 93..106 PostgreSQL fixture.
// Its labelled disposable container exposes no ports and has no external network.
assert.equal(process.argv.length, 2);
const sourceUrl = new URL('test-polygon-relay-schema.mjs', import.meta.url);
let source = await readFile(sourceUrl, 'utf8');
const polygonUrl = new URL('personal-polygon-funding-schema-probes.mjs', import.meta.url);
const copUrl = new URL('personal-colombia-pse-schema-probes.mjs', import.meta.url);
const bankUrl = new URL('personal-colombia-bank-schema-probes.mjs', import.meta.url);
const context = '{container,docker,psql,value,parallelPsql,role,database}';
const extend = `const polygonFunding=await import(${JSON.stringify(polygonUrl.href)});await polygonFunding.runPersonalPolygonFundingProbes(${context});const cop=await import(${JSON.stringify(copUrl.href)});await cop.runPersonalColombiaPseProbes(${context});const banks=await import(${JSON.stringify(bankUrl.href)});await banks.runPersonalColombiaBankProbes(${context});`;
const cached = 'await module.runPolygonRelayProbes({container,docker,psql,value,equal,rejects,parallelPsql,immutable,role,database,joined});';
assert.equal(source.split(cached).length, 2);
source = source.replace(cached, `${cached}\n ${extend}`);
const coldLine = '`  await relayModule.runPolygonRelayProbes({container,docker,psql,value,equal,rejects,parallelPsql,immutable,role,database,joined:${joined}});\\n`;';
assert.equal(source.split(coldLine).length, 2);
source = source.replace(coldLine, coldLine.slice(0, -1) + '+\n' + `\`  ${extend}\\n\`;`);
source = source.replaceAll("'import.meta.url'", "'__BASELINE_IMPORT_META__'");
source = source.replaceAll('import.meta.url', JSON.stringify(sourceUrl.href));
source = source.replaceAll("'__BASELINE_IMPORT_META__'", "'import.meta.url'");
const directory = new URL('../.wrangler/personal-cop-bank-schema/', import.meta.url);
await mkdir(directory, { recursive: true });
const generated = new URL(`harness-${randomUUID()}.mjs`, directory);
await writeFile(generated, source, { flag: 'wx' });
const child = spawn(process.execPath, [fileURLToPath(generated)], { stdio: 'inherit', shell: false });
process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
