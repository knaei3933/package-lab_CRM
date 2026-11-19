#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const [databaseUrl, restored, source, startedText, reportPath] = process.argv.slice(2);
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (databaseName === 'kanei_crm_mvp') {
  console.error('refusing canonical main database');
  process.exit(2);
}
const started = Number(startedText);
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
const scalar = async (sql) => (await client.query(sql)).rows[0]?.[Object.keys((await client.query(sql)).rows[0] ?? {})[0]];
const tables = await scalar("select count(*)::int as value from information_schema.tables where table_schema='public'");
const audits = await scalar('select count(*)::int as value from audit_events');
const documents = await scalar('select count(*)::int as value from document_versions');
const latest = (await client.query('select max(occurred_at) as value from audit_events')).rows[0]?.value;

const versions = (await client.query('select storage_path, sha256 from document_versions order by id')).rows;
let checked = 0;
const missingOrMismatch = [];
for (const row of versions) {
  let candidate = row.storage_path;
  if (source && candidate.startsWith(source)) candidate = path.join(restored, path.relative(source, candidate));
  else if (!path.isAbsolute(candidate)) candidate = path.join(restored, candidate);
  try {
    const digest = createHash('sha256').update(await import('node:fs/promises').then(mod => mod.readFile(candidate))).digest('hex');
    if (digest === row.sha256) checked += 1;
    else missingOrMismatch.push(candidate);
  } catch {
    missingOrMismatch.push(candidate);
  }
}
const triggers = (await client.query(`select tgname from pg_trigger where tgrelid='audit_events'::regclass and not tgisinternal`)).rows.map(row => row.tgname);
const requiredTriggers = new Set(['audit_events_no_update', 'audit_events_no_delete']);
const rpoSeconds = latest ? Math.max(0, (Date.now() - new Date(latest).getTime()) / 1000) : 0;
const result = {
  database: { tables, audit_events: audits, document_versions: documents, latest_audit_at: latest },
  documents: { checked, missing_or_mismatch: missingOrMismatch.length },
  append_only_locks: { present: [...requiredTriggers].every(name => triggers.includes(name)), observed: triggers.sort() },
  send_transition_locks: {
    audit_update_blocked: triggers.includes('audit_events_no_update'),
    audit_delete_blocked: triggers.includes('audit_events_no_delete')
  },
  rpo_seconds: Math.round(rpoSeconds),
  rto_seconds: Math.round(Date.now() / 1000 - started),
  passed: missingOrMismatch.length === 0 && [...requiredTriggers].every(name => triggers.includes(name))
};
writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
await client.end();
if (!result.passed) process.exit(1);
