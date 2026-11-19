import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { and, eq, sql } from 'drizzle-orm';
import { auditEvents, createDatabase, users, uuidv7 } from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { hashPassword } from '../apps/api/src/password.js';

/**
 * UI batch F (review H2 / server F2 contract) against the REAL API over HTTP on
 * the isolated test database: the web login relay (route handler) posts to an
 * API listener on 127.0.0.1, whose default TRUSTED_PROXY_CIDRS trusts that
 * peer. Checked: with the proxy declaration the API's lock key is the browser
 * address the proxy wrote (one browser's failures do not lock the
 * representative out of another browser); spoofed left X-Forwarded-For
 * entries cannot rotate the key; without the declaration nothing is forwarded
 * and every browser shares the web's own address (the safe fallback); the
 * relay answers the lockout in Japanese with the remaining wait and the same
 * words for a missing account.
 */

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);
const representative = { id: uuidv7(), username: 'admin_f_login_test', password: 'composite-admin-pass' };
let server: ReturnType<typeof serve>;
let POST: (request: Request) => Promise<Response>;

beforeAll(async () => {
  await db.execute(sql`truncate table audit_events, sessions, project_assignments cascade`);
  await db.delete(users).where(eq(users.username, representative.username));
  await db.insert(users).values({
    id: representative.id,
    username: representative.username,
    passwordHash: await hashPassword(representative.password),
    displayName: '合成代表者F',
    role: 'admin'
  });
  const app = createApp({ db });
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
  });
  expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  process.env.KANEI_API_BASE_URL = `http://127.0.0.1:${port}`;
  ({ POST } = await import('../apps/web/src/app/api/auth/login/route.js'));
});

afterEach(() => {
  delete process.env.KANEI_WEB_BEHIND_TRUSTED_PROXY;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(users).where(eq(users.id, representative.id));
  await pool.end();
});

/** One browser post through the relay; `forwardedFor` is what reached the web process. */
async function relayLogin(username: string, password: string, forwardedFor?: string) {
  const response = await POST(new Request('http://kanei-r1web.localhost:4580/api/auth/login', {
    method: 'POST',
    headers: {
      host: 'kanei-r1web.localhost:4580',
      origin: 'http://kanei-r1web.localhost:4580',
      'content-type': 'application/json',
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {})
    },
    body: JSON.stringify({ username, password })
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown>, retryAfter: response.headers.get('retry-after') };
}

async function failureAddresses(): Promise<string[]> {
  const rows = await db.select({ metadata: auditEvents.requestMetadata }).from(auditEvents)
    .where(and(eq(auditEvents.action, 'LOGIN_FAILED'), eq(auditEvents.entityType, 'login_guard')));
  return rows.map((row) => String((row.metadata as { remoteAddress?: unknown } | null)?.remoteAddress));
}

async function clearFailures() {
  await db.execute(sql`truncate table audit_events cascade`);
}

const LOCKED_PREFIX = 'ログインの失敗が続いたため、一時的にログインを受け付けていません。約';

describe('behind the declared proxy: the lock follows the browser address', () => {
  it('five failures lock browser A only; the representative still signs in from browser B', async () => {
    await clearFailures();
    process.env.KANEI_WEB_BEHIND_TRUSTED_PROXY = '1';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await relayLogin(representative.username, 'wrong-guess', '203.0.113.10')).status);
    }
    const locked = await relayLogin(representative.username, representative.password, '203.0.113.10');
    expect([...statuses, locked.status]).toEqual([401, 401, 401, 401, 401, 429]);
    expect(String(locked.body.error).startsWith(LOCKED_PREFIX)).toBe(true);
    expect(locked.body).toMatchObject({ code: 'LOGIN_TEMPORARILY_LOCKED' });
    expect(locked.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(locked.retryAfter).toBe(String(locked.body.retryAfterSeconds));

    const otherBrowser = await relayLogin(representative.username, representative.password, '198.51.100.20');
    expect(otherBrowser.status).toBe(201);
    expect(new Set(await failureAddresses())).toEqual(new Set(['203.0.113.10']));
  });

  it('a browser writing its own left entries cannot rotate the lock key', async () => {
    await clearFailures();
    process.env.KANEI_WEB_BEHIND_TRUSTED_PROXY = '1';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await relayLogin(representative.username, 'wrong-guess', `10.9.9.${attempt}, 203.0.113.30`)).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(new Set(await failureAddresses())).toEqual(new Set(['203.0.113.30']));
  });

  it('a missing account reads exactly like a wrong password, and locks the same way', async () => {
    await clearFailures();
    process.env.KANEI_WEB_BEHIND_TRUSTED_PROXY = '1';
    const missing: Array<Record<string, unknown>> = [];
    const wrong: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      missing.push((await relayLogin('no_such_user_f', 'wrong-guess', '203.0.113.40')).body);
      wrong.push((await relayLogin(representative.username, 'wrong-guess', '203.0.113.41')).body);
    }
    expect(missing.slice(0, 5)).toEqual(Array(5).fill({ error: 'ユーザー名またはパスワードが正しくありません。' }));
    expect(missing.slice(0, 5)).toEqual(wrong.slice(0, 5));
    for (const body of [missing[5]!, wrong[5]!]) {
      expect(body.code).toBe('LOGIN_TEMPORARILY_LOCKED');
      expect(String(body.error).startsWith(LOCKED_PREFIX)).toBe(true);
    }
  });
});

describe('without the declaration nothing is forwarded (safe fallback)', () => {
  it('browser-written X-Forwarded-For is ignored: all attempts are the web process address', async () => {
    await clearFailures();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await relayLogin(representative.username, 'wrong-guess', `203.0.113.${50 + attempt}`)).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    const addresses = new Set(await failureAddresses());
    expect(addresses.size).toBe(1);
    expect([...addresses][0]).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
  });
});
