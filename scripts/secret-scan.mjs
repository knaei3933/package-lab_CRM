#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const [base = 'origin/master', head = 'HEAD'] = process.argv.slice(2);
const diff = spawnSync('git', ['diff', '--unified=0', base, head], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
if (diff.status !== 0) throw new Error(diff.stderr);
let file = '';
const added = [];
for (const line of diff.stdout.split(/\r?\n/)) {
  if (line.startsWith('+++ b/')) file = line.slice(6);
  else if (line.startsWith('+') && !line.startsWith('+++')) added.push([file, line.slice(1)]);
}
const patterns = {
  quotedSecretAssignment: /['"](?:[^'"]*(?:password|secret|api[_-]?key)[^'"]*)['"]\s*(?::|=)\s*['"][^'"]+['"]/i,
  tokenFormat: /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i,
  urlWithPassword: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^/\s:@]+:[^@\s]+@/i,
  privateKeyHeader: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY( BLOCK)?-----/
};
const hits = [];
for (const [path, text] of added) {
  if (path === '.env') hits.push({ category: 'addedEnvFile', path });
  for (const [category, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) hits.push({ category, path });
  }
}
console.log(JSON.stringify({ base, head, addedLines: added.length, hits, categories: [...new Set(hits.map(h => h.category))] }, null, 2));
process.exit(hits.length ? 1 : 0);
