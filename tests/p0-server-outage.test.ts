/**
 * P0 R04: a database that is down or hangs answers fast with a distinguishable
 * code instead of an endless wait (persona B4). The hanging database is a local
 * TCP listener that accepts and never speaks; the refused one is a closed port.
 * Neither touches the shared PostgreSQL container. The statement timeout case
 * runs one pg_sleep on the isolated test database only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { sql } from 'drizzle-orm';
import { createDatabase, DEFAULT_DB_CONNECT_TIMEOUT_MS, DEFAULT_DB_STATEMENT_TIMEOUT_MS } from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { SESSION_COOKIE } from '../apps/api/src/auth.js';
import { classifyDatabaseError, isSafeUserMessage } from '../apps/api/src/error-codes.js';

const testUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(testUrl)) {
  throw new Error('p0-server-outage tests require kanei_crm_mvp_test');
}

let hangingServer: net.Server;
let hangingPort = 0;
let closedPort = 0;
const openSockets = new Set<net.Socket>();
const pools: Array<{ end: () => Promise<void> }> = [];

function urlFor(port: number) {
  return `postgres://nobody:nothing@127.0.0.1:${port}/none`;
}

beforeAll(async () => {
  hangingServer = net.createServer((socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', () => resolve()));
  hangingPort = (hangingServer.address() as net.AddressInfo).port;
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  closedPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(async () => {
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
  await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
});

function appFor(port: number, options: { connect?: number; login?: number } = {}) {
  const { db, pool } = createDatabase(urlFor(port), { connectionTimeoutMillis: options.connect ?? 300 });
  pools.push(pool);
  return createApp({ db, port: 3096, loginTimeoutMs: options.login ?? 15_000, healthDbTimeoutMs: 500 });
}

async function timed(run: () => Promise<Response>) {
  const started = Date.now();
  const response = await run();
  return { response, body: await response.json() as Record<string, unknown>, elapsed: Date.now() - started };
}

describe('R04 outage answers', () => {
  it('uses 5 s connect and 10 s statement timeouts by default', async () => {
    expect(DEFAULT_DB_CONNECT_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_DB_STATEMENT_TIMEOUT_MS).toBe(10_000);
    const { db, pool } = createDatabase(testUrl);
    pools.push(pool);
    const result = await db.execute(sql`show statement_timeout`);
    expect((result.rows[0] as { statement_timeout: string }).statement_timeout).toBe('10s');
  });

  it('answers 503 DB_UNAVAILABLE quickly when the database accepts but never answers', async () => {
    const app = appFor(hangingPort);
    const { response, body, elapsed } = await timed(() => app.request('/api/me', { headers: { cookie: `${SESSION_COOKIE}=token` } }));
    expect(response.status).toBe(503);
    expect(body.code).toBe('DB_UNAVAILABLE');
    expect(isSafeUserMessage(body.error)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1|\d{4,5}|nobody|postgres/);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(elapsed).toBeLessThan(3_000);
  });

  it('answers 503 DB_UNAVAILABLE on a refused connection, and a write is not a server error', async () => {
    const app = appFor(closedPort);
    const read = await timed(() => app.request('/api/projects', { headers: { cookie: `${SESSION_COOKIE}=token` } }));
    expect(read.response.status).toBe(503);
    expect(read.body.code).toBe('DB_UNAVAILABLE');
    const write = await timed(() => app.request('/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=token` }, body: '{}'
    }));
    expect(write.body.code).toBe('DB_UNAVAILABLE');
    expect(write.elapsed).toBeLessThan(3_000);
  });

  it('keeps "not logged in" distinct from "cannot check the session"', async () => {
    const app = appFor(closedPort);
    const anonymous = await app.request('/api/me');
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { code: string }).code).toBe('AUTH_REQUIRED');
    const withCookie = await app.request('/api/me', { headers: { cookie: `${SESSION_COOKIE}=token` } });
    expect(withCookie.status).toBe(503);
  });

  it('bounds the login: LOGIN_TIMEOUT before a slow database connect gives up', async () => {
    const app = appFor(hangingPort, { connect: 5_000, login: 300 });
    const { response, body, elapsed } = await timed(() => app.request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'someone', password: 'something' })
    }));
    expect(response.status).toBe(503);
    expect(body.code).toBe('LOGIN_TIMEOUT');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(elapsed).toBeLessThan(2_000);
  });

  it('a login against a refused database answers DB_UNAVAILABLE, not a generic error', async () => {
    const app = appFor(closedPort, { login: 5_000 });
    const response = await app.request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'someone', password: 'something' })
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe('DB_UNAVAILABLE');
  });

  it('reports the real port and the database state on /api/health', async () => {
    const down = appFor(closedPort);
    const downBody = await (await down.request('/api/health')).json();
    expect(downBody).toEqual({ status: 'ok', app: 'api', port: 3096, db: 'down' });
    const { db, pool } = createDatabase(testUrl);
    pools.push(pool);
    const up = createApp({ db, port: 3096 });
    expect(await (await up.request('/api/health')).json()).toEqual({ status: 'ok', app: 'api', port: 3096, db: 'ok' });
  });

  it('classifies a statement_timeout cancellation as DB_TIMEOUT and answers it with 503', async () => {
    const { db, pool } = createDatabase(testUrl, { statementTimeoutMs: 150 });
    pools.push(pool);
    const failure = await db.execute(sql`select pg_sleep(1)`).then(() => null, (error: unknown) => error);
    expect(failure).not.toBeNull();
    expect(classifyDatabaseError(failure)).toBe('DB_TIMEOUT');

    // The same classification reaches the HTTP answer: a database whose
    // queries are cancelled answers DB_TIMEOUT.
    const cancelled = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const chain: any = new Proxy(() => chain, {
      get: (_target, prop) => (prop === 'then'
        ? (_resolve: unknown, reject: (error: unknown) => void) => reject(cancelled)
        : () => chain)
    });
    const fakeDb: any = new Proxy({}, { get: () => () => chain });
    const app = createApp({ db: fakeDb });
    const response = await app.request('/api/me', { headers: { cookie: `${SESSION_COOKIE}=token` } });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe('DB_TIMEOUT');
  });

  it('does not classify ordinary errors as an outage (unit)', () => {
    expect(classifyDatabaseError(new Error('boom'))).toBeNull();
    expect(classifyDatabaseError({ code: '23505' })).toBeNull();
    expect(classifyDatabaseError({ code: 'ECONNREFUSED' })).toBe('DB_UNAVAILABLE');
    expect(classifyDatabaseError({ message: 'Failed query', cause: { code: '08006' } })).toBe('DB_UNAVAILABLE');
    expect(classifyDatabaseError(new Error('timeout exceeded when trying to connect'))).toBe('DB_UNAVAILABLE');
    expect(classifyDatabaseError({ errors: [{ code: 'ECONNREFUSED' }] })).toBe('DB_UNAVAILABLE');
  });
});
