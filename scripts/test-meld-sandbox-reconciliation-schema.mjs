import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Extend the existing labelled Docker fixture, network=none, no exposed ports.
assert.equal(process.argv.length, 2);
const sourceUrl = new URL('test-polygon-relay-schema.mjs', import.meta.url);
let source = await readFile(sourceUrl, 'utf8');
const context = '{container,docker,psql,value,parallelPsql,role,database}';
const modules = [
  ['personal-polygon-funding-schema-probes.mjs', 'runPersonalPolygonFundingProbes'],
  ['personal-colombia-pse-schema-probes.mjs', 'runPersonalColombiaPseProbes'],
  ['personal-colombia-bank-schema-probes.mjs', 'runPersonalColombiaBankProbes'],
  ['personal-us-mxn-methods-schema-probes.mjs', 'runPersonalUsMxnMethodsProbes'],
  ['administrative-sandbox-mxn-schema-probes.mjs', 'runAdministrativeSandboxMxnProbes'],
  ['meld-sandbox-reconciliation-schema-probes.mjs', 'runMeldSandboxReconciliationProbes'],
];
const extend = modules.map(([path, fn], i) => `const extension${i}=await import(${JSON.stringify(new URL(path, import.meta.url).href)});await extension${i}.${fn}(${context});`).join('');
const cached = 'await module.runPolygonRelayProbes({container,docker,psql,value,equal,rejects,parallelPsql,immutable,role,database,joined});';
assert.equal(source.split(cached).length, 2); source = source.replace(cached, `${cached}\n ${extend}`);
const coldLine = '`  await relayModule.runPolygonRelayProbes({container,docker,psql,value,equal,rejects,parallelPsql,immutable,role,database,joined:${joined}});\\n`;';
assert.equal(source.split(coldLine).length, 2); source = source.replace(coldLine, coldLine.slice(0, -1) + '+\n' + `\`  ${extend}\\n\`;`);
source = source.replaceAll("'import.meta.url'", "'__BASELINE_IMPORT_META__'").replaceAll('import.meta.url', JSON.stringify(sourceUrl.href)).replaceAll("'__BASELINE_IMPORT_META__'", "'import.meta.url'");
const directory = new URL('../.wrangler/meld-sandbox-reconciliation-schema/', import.meta.url); await mkdir(directory, { recursive: true });
const generated = new URL(`harness-${randomUUID()}.mjs`, directory); await writeFile(generated, source, { flag: 'wx' });
const child = spawn(process.execPath, [fileURLToPath(generated)], { stdio: 'inherit', shell: false });
process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
