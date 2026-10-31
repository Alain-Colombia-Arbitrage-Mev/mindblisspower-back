// Exact migration73 + isolated PG18 + actual Go GET SQL under least-privilege
// groups. No DSN/env accepted. Use only --synthetic-docker.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../../../../_meta/migration/73_cloudflare_read_models.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'');
assert.doesNotMatch(sql,/\b(?:GRANT|REVOKE)\b|\bCREATE\s+ROLE\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\.|\bDELETE\s+FROM\b/i);
await import('./go-reader-policy.synthetic.mjs');
