#!/usr/bin/env node
// Verification runs from libpq environment fields; no credential URL is passed.
import { createHash } from 'node:crypto';
import { readFile, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

function option(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}
const database = option('database');
const restored = option('restored');
const source = option('source');
const startedText = option('started');
const reportPath = option('report');
if (!database || !restored || !source || !startedText || !reportPath) {
  console.error('--database --restored --source --started --report are required');
  process.exit(2);
}
if (['kanei_crm_mvp', 'kanei_crm_mvp_test'].includes(database) || /(^|_)(prod|production)(_|$)/i.test(database)) {
  console.error(`refusing protected restore target: ${database}`);
  process.exit(2);
}
const client = new pg.Client();
const readFileAsync = promisify(readFile);
await client.connect();
const scalar = async (text) => {
  const result = await client.query(text);
  const row = result.rows[0] ?? {};
  return row[Object.keys(row)[0]];
};
const tables = await scalar("select count(*)::int as value from information_schema.tables where table_schema='public'");
const audits = await scalar('select count(*)::int as value from audit_events');
const documents = await scalar('select count(*)::int as value from document_versions');
const latest = (await client.query('select max(occurred_at) as value from audit_events')).rows[0]?.value;
const versions = (await client.query('select storage_path, sha256 from document_versions order by id')).rows;
let checked = 0;
const missingOrMismatch = [];
for (const row of versions) {
  const recorded = resolve(row.storage_path);
  const sourceRoot = resolve(source);
  const restoredRoot = resolve(restored);
  const mapped = relative(sourceRoot, recorded);
  if (isAbsolute(mapped) || mapped.startsWith('..')) {
    missingOrMismatch.push(recorded);
    continue;
  }
  const candidate = join(restoredRoot, mapped);
  try {
    const actual = createHash('sha256').update(await readFileAsync(candidate)).digest('hex');
    if (actual === row.sha256) checked += 1; else missingOrMismatch.push(candidate);
  } catch { missingOrMismatch.push(candidate); }
}
const triggers = (await client.query("select tgname from pg_trigger where tgrelid='audit_events'::regclass and not tgisinternal")).rows.map(row => row.tgname);
const required = new Set(['audit_events_no_update', 'audit_events_no_delete']);
const rpoSeconds = latest ? Math.max(0, (Date.now() - new Date(latest).getTime()) / 1000) : 0;
const result = {
  target: database,
  database: { tables, audit_events: audits, document_versions: documents, latest_audit_at: latest },
  documents: { checked, missing_or_mismatch: missingOrMismatch.length },
  append_only_locks: { present: [...required].every(name => triggers.includes(name)), observed: triggers.sort() },
  rpo_seconds: Math.round(rpoSeconds),
  rto_seconds: Math.round(Date.now() / 1000 - Number(startedText)),
  passed: missingOrMismatch.length === 0 && [...required].every(name => triggers.includes(name))
};
writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
await client.end();
if (!result.passed) process.exit(1);
