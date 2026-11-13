import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {loadNativeProfilePrefixCache,runNativeProfileFromPrefixCache}from'./native-member-profile-prefix-cache.mjs';
assert.equal(process.argv.length, 2);
const cached=await loadNativeProfilePrefixCache();
if(cached){await runNativeProfileFromPrefixCache(cached);process.exit(0);}
const original = new URL('test-meld-sandbox-reconciliation-schema.mjs', import.meta.url);
let source = await readFile(original, 'utf8');
const marker = "  ['meld-sandbox-reconciliation-schema-probes.mjs', 'runMeldSandboxReconciliationProbes'],";
assert.equal(source.split(marker).length, 2);
source = source.replace(marker, `${marker}\n  ['administrative-wallet-signing-schema-probes.mjs', 'runAdministrativeWalletSigningProbes'],\n  ['native-member-profile-prefix-cache.mjs', 'saveNativeProfilePrefixCache'],\n  ['native-member-profile-schema-probes.mjs', 'runNativeMemberProfileProbes'],`);
const generated = new URL(`.native-profile-harness-${randomUUID()}.mjs`, import.meta.url);
await writeFile(generated, source, { flag: 'wx' });
try {
  const child = spawn(process.execPath, [fileURLToPath(generated)], { stdio: 'inherit', shell: false });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
} finally { await unlink(generated); }
