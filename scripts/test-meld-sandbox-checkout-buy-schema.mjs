import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
assert.equal(process.argv.length, 2);
const original = new URL('test-meld-sandbox-reconciliation-schema.mjs', import.meta.url);
let source = await readFile(original, 'utf8');
const marker = "  ['meld-sandbox-reconciliation-schema-probes.mjs', 'runMeldSandboxReconciliationProbes'],";
assert.equal(source.split(marker).length, 2);
source = source.replace(marker, `${marker}\n  ['meld-sandbox-checkout-buy-schema-probes.mjs', 'runMeldSandboxCheckoutBuyProbes'],`);
// The source is generated in the same scripts directory so its import.meta
// references retain their original, reviewed baseline and labelled Docker rules.
const generated = new URL(`.meld-checkout-harness-${randomUUID()}.mjs`, import.meta.url);
await writeFile(generated, source, { flag: 'wx' });
try {
  const child = spawn(process.execPath, [fileURLToPath(generated)], { stdio: 'inherit', shell: false });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
} finally { await unlink(generated); }
