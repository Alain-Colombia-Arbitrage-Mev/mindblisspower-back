import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const credentialPatterns = [
  ['stripe_key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/],
  ['aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['provider_key', /\bsk-proj-[A-Za-z0-9_-]{25,}\b/],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\r\n]/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/],
];

export function inspectPublicationFile(name, content) {
  const path = name.replaceAll('\\', '/');
  const reasons = [];
  const filename = path.split('/').at(-1);
  const example = filename.endsWith('.example');
  if ((/^(?:\.env(?:\.|$)|.*\.env$)/.test(filename) && !example)
      || /(?:^|\/)(?:\.claude-flow|\.superdesign|backups|private-keys|node_modules)(?:\/|$)/.test(path)
      || /\.(?:dump(?:\.age)?|agekey|p12|pfx|sqlite\d*|db|rvf|jsonl|csv|bak|log)(?:\.lock)?$/i.test(filename)
      || ['$OUT', '$P'].includes(filename)) reasons.push('private_or_generated_file');
  if (content.length > 2 * 1024 * 1024) reasons.push('oversized_file_requires_review');
  if (content.includes(0)) reasons.push('binary_file_requires_review');
  const text = content.toString('utf8');
  for (const [code, pattern] of credentialPatterns) if (pattern.test(text)) reasons.push(code);
  for (const match of text.matchAll(/postgres(?:ql)?:\/\/([^\s:@/]+):([^\s@]+)@([^\s/'"`]+)/g)) {
    const password = match[2];
    const synthetic = /^(?:fixture|synthetic(?:[-_].*)?|test|devpass|local|password|pass|postgres|x|example|secret)$/i.test(password)
      || /^(?:\$\{|<|YOUR_|REPLACE|CHANGE|GENERATE|ENCODED_)/i.test(password);
    if (!synthetic) reasons.push('database_credential_url');
  }
  return [...new Set(reasons)];
}

export function checkStaged(repository) {
  const git = args => execFileSync('git', ['-C', repository, ...args], { maxBuffer: 8 * 1024 * 1024 });
  const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).toString('utf8').split('\0').filter(Boolean);
  const findings = [];
  for (const name of names) {
    const content = git(['show', `:${name}`]);
    const reasons = inspectPublicationFile(name, content);
    if (reasons.length) findings.push({ file: name, reasons });
  }
  return { checked: names.length, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected repository path');
    const result = checkStaged(resolve(process.argv[2]));
    // Deliberately report filenames and categories only, never matching text.
    console.log(JSON.stringify(result, null, 2));
    if (result.findings.length) process.exitCode = 1;
  } catch {
    console.error('Publication input check failed; inspect the selected Git index locally.');
    process.exitCode = 1;
  }
}
