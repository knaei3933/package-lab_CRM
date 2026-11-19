#!/usr/bin/env node
// Representative recovery only. Append-only reset markers never rewrite or
// delete LOGIN_FAILED history; the login handler starts a new epoch after the
// latest matching reset.
import { createHash } from 'node:crypto';
import pg from 'pg';

const args = process.argv.slice(2);
function option(name) {
  const equals = `--${name}=`;
  const equalItem = args.find(arg => arg.startsWith(equals));
  if (equalItem !== undefined) return equalItem.slice(equals.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}
const username = option('username');
const remoteAddress = option('remote-address');
const sourceOnly = args.includes('--source');
const reason = option('reason') ?? 'operator login-guard reset';
const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const dbPath = decodeURIComponent(new URL(url).pathname);
if (process.env.ALLOW_PRODUCTION_LOGIN_UNLOCK !== '1' && dbPath !== '/kanei_crm_mvp_test') {
  console.error('refusing non-test unlock: set ALLOW_PRODUCTION_LOGIN_UNLOCK exactly to 1 only with representative approval');
  process.exit(2);
}
if (sourceOnly) {
  if (!remoteAddress || username !== undefined) {
    console.error('usage for source reset: unlock-login-guard.mjs --source IP --remote-address IP [--reason TEXT]');
    process.exit(2);
  }
} else if (!username || !remoteAddress) {
  console.error('usage: unlock-login-guard.mjs --username NAME --remote-address IP [--reason TEXT]');
  console.error('usage for every identity at a source: unlock-login-guard.mjs --source --remote-address IP [--reason TEXT]');
  process.exit(2);
}

const identity = sourceOnly ? undefined : createHash('sha256')
  .update(['login_guard_v2', username.trim().toLowerCase(), remoteAddress].join('\0'))
  .digest('hex');
const entityId = sourceOnly ? `source:${remoteAddress}` : identity;
const advisoryKey = sourceOnly ? 215469 : 215468;
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  await client.query('select pg_advisory_xact_lock($1, $2)', [advisoryKey, 20261119]);
  const result = await client.query(
    `insert into audit_events(id,project_id,actor_user_id,action,entity_type,entity_id,before_state,after_state,occurred_at,request_metadata)
     values(gen_random_uuid(),null,null,'LOGIN_GUARD_RESET','login_guard',$1,null,$2,now(),$3)
     returning id,occurred_at`,
    [entityId, { reason, resetAt: new Date().toISOString(), scope: sourceOnly ? 'source' : 'identity' }, {
      operation: 'auth:login_guard_reset',
      remoteAddress,
      ...(sourceOnly ? {} : { username: username.trim().toLowerCase() })
    }]
  );
  await client.query('commit');
  console.log(JSON.stringify({ scope: sourceOnly ? 'source' : 'identity', entity: entityId, event: result.rows[0] }, null, 2));
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}
