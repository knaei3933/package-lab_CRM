import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { createDatabase, sessions, users, uuidv7 } from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { loadApiEnv } from '../apps/api/src/env.js';
import { loginGuardIdentity, loginGuardSourceEntity } from '../apps/api/src/login-guard.js';
import { hashPassword } from '../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('login unlock tests require kanei_crm_mvp_test');
}
const run = promisify(execFile);
const { db, pool } = createDatabase(databaseUrl);
const userId = uuidv7();
let token = '';
let app: ReturnType<typeof createApp>;

function login(username: string, password: string, remoteAddress = '203.0.113.10') {
  const request = new Request('http://127.0.0.1:3081/api/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:3081',
      'x-forwarded-for': remoteAddress
    },
    body: JSON.stringify({ username, password })
  });
  return app.fetch(request, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
}

async function unlock(arguments_: string[]) {
  return run('node', [path.resolve(process.cwd(), 'scripts/unlock-login-guard.mjs'), ...arguments_], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8'
  });
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(`${os.tmpdir()}/kanei-unlock-`);
  app = createApp({
    db,
    allowedOrigins: ['http://127.0.0.1:3081'],
    trustedProxyCidrs: ['127.0.0.1/32'],
    trustedProxyConfigured: true
  });
  const now = new Date();
  await db.execute('truncate table audit_events, sessions, users cascade');
  await db.insert(users).values({
    id: userId,
    username: 'unlock_recovery_user',
    passwordHash: await hashPassword('composite-recovery-pass'),
    displayName: '복구검증',
    role: 'admin'
  });
  const issued = issueToken();
  await db.insert(sessions).values({
    id: uuidv7(now), userId, tokenHash: issued.tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  });
  token = issued.token;
});

afterAll(async () => {
  await pool.end();
});

describe('append-only login guard recovery', () => {
  it('accepts both space and equals arguments and uses only the exact production flag', async () => {
    const equalsForm = await unlock(['--username=argument_form_user', '--remote-address=198.51.100.1']);
    expect(JSON.parse(equalsForm.stdout)).toMatchObject({ scope: 'identity' });
    const spaceForm = await unlock(['--username', 'argument_form_user', '--remote-address', '198.51.100.1']);
    expect(JSON.parse(spaceForm.stdout)).toMatchObject({ scope: 'identity' });
    const guarded = run('node', [path.resolve(process.cwd(), 'scripts/unlock-login-guard.mjs'), '--username', 'any', '--remote-address', '198.51.100.1'], {
      env: { ...process.env, DATABASE_URL: 'postgresql://kanei@127.0.0.1:5434/kanei_crm_mvp', ALLOW_PRODUCTION_LOGIN_UNLOCK: '0' }
    });
    await expect(guarded).rejects.toMatchObject({ code: 2 });
  });

  it('requires explicit trusted proxy CIDRs in production', () => {
    expect(() => loadApiEnv({
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'production'
    })).toThrow(/TRUSTED_PROXY_CIDRS is required/);
    expect(loadApiEnv({
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'production',
      TRUSTED_PROXY_CIDRS: '10.20.0.0/24'
    }).trustedProxyConfigured).toBe(true);
  });

  it('unlocks a locked account+IP identity without deleting failed history', async () => {
    for (let index = 0; index < 5; index += 1) {
      const failed = await login('unlock_recovery_user', `wrong-${index}`);
      expect(failed.status).toBe(401);
    }
    const locked = await login('unlock_recovery_user', 'composite-recovery-pass');
    expect(locked.status).toBe(429);
    const identity = loginGuardIdentity('unlock_recovery_user', '203.0.113.10');
    await unlock(['--username', 'unlock_recovery_user', '--remote-address', '203.0.113.10', '--reason', 'integration recovery']);
    const reset = await db.select().from((await import('@kanei/db')).auditEvents)
      .where(and(eq((await import('@kanei/db')).auditEvents.action, 'LOGIN_GUARD_RESET'), eq((await import('@kanei/db')).auditEvents.entityId, identity)));
    expect(reset).toHaveLength(1);
    const recovered = await login('unlock_recovery_user', 'composite-recovery-pass');
    expect(recovered.status).toBe(201);
    const cookie = recovered.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
  });

  it('can reset a trusted source lock after username rotation', async () => {
    const sourceIp = '203.0.113.20';
    for (let index = 0; index < 10; index += 1) {
      const failed = await login(`rotation_user_${index}`, 'not-the-password', sourceIp);
      expect(failed.status).toBe(401);
    }
    const locked = await login('rotation_user_after_limit', 'not-the-password', sourceIp);
    expect(locked.status).toBe(429);
    await unlock(['--source', '--remote-address', sourceIp, '--reason', 'source recovery integration']);
    const sourceEntity = loginGuardSourceEntity(sourceIp);
    const reset = await db.select().from((await import('@kanei/db')).auditEvents)
      .where(and(eq((await import('@kanei/db')).auditEvents.action, 'LOGIN_GUARD_RESET'), eq((await import('@kanei/db')).auditEvents.entityId, sourceEntity)));
    expect(reset).toHaveLength(1);
    const acceptedFailure = await login('rotation_user_after_reset', 'not-the-password', sourceIp);
    expect(acceptedFailure.status).toBe(401);
  });
});
