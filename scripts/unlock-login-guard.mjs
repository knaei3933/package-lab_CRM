#!/usr/bin/env node
// Representative recovery only: append a reset marker without rewriting the
// append-only LOGIN_FAILED history. DATABASE_URL must point to the approved DB.
import { createHash } from 'node:crypto';
import pg from 'pg';

const args = process.argv.slice(2);
function option(name) {
  const flag = `--${name}=`;
  const item = args.find(arg => arg.startsWith(flag));
  return item?.slice(flag.length);
}
const username = option('username');
const remoteAddress = option('remote-address');
const reason = option('reason') ?? 'operator login-guard reset';
const url = process.env.DATABASE_URL;
if (!username || !remoteAddress || !url) {
  console.error('usage: unlock-login-guard.mjs --username NAME --remote-address IP [--reason TEXT]  (DATABASE_URL required)');
  process.exit(2);
}
const dbPath = decodeURIComponent(new URL(url).pathname);
if (dbPath !== '/kanei_crm_mvp_test' && !process.env.ALLOW_PRODUCTION_LOGIN_UNLOCK) {
  console.error('refusing non-test unlock without ALLOW_PRODUCTION_LOGIN_UNLOCK=1');
  process.exit(2);
}
const identity = createHash('sha256')
  .update(['login_guard_v2', username.trim().toLowerCase(), remoteAddress].join('\0'))
  .digest('hex');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 215468))', [identity]);
  const result = await client.query(
    `insert into audit_events(id,project_id,actor_user_id,action,entity_type,entity_id,before_state,after_state,occurred_at,request_metadata)
     values(gen_random_uuid(),null,null,'LOGIN_GUARD_RESET','login_guard',$1,null,$2,now(),$3)
     returning id,occurred_at`,
    [identity, { reason, resetAt: new Date().toISOString() }, { operation: 'auth:login_guard_reset', remoteAddress }]
  );
  await client.query('commit');
  console.log(JSON.stringify({ identity, event: result.rows[0] }, null, 2));
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}
