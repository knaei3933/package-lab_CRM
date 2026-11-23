/**
 * P2 R05: the Idempotency-Key answers live in the idempotency_keys table
 * (migration 0027) instead of the API process memory. Scope is (user, key):
 * a restart, a second API process or a new login of the same user replays the
 * first completed answer; another user never sees it. Normal, refusal,
 * permission and integration cases. Runs only against kanei_crm_mvp_test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  createDatabase,
  projectAssignments,
  projects,
  sessions,
  sevenPurchaseOrders,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { issueToken, SESSION_COOKIE, type AppDatabase } from '../apps/api/src/auth.js';
import { DbIdempotencyStore, roleScopedIdempotencyKey, sha256Hex, type IdempotencyBackend, type StoredResponse } from '../apps/api/src/idempotency.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('p2-idempotency-store tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();

const tokens = { admin: '', staff: '' };
type Role = keyof typeof tokens;
type App = ReturnType<typeof createApp>;

let counter = 0;
function nextTag(): string {
  counter += 1;
  return `${Date.now().toString(36)}${String(counter).padStart(3, '0')}`;
}

async function newSession(userId: string): Promise<string> {
  const { token, tokenHash } = issueToken();
  await db.insert(sessions).values({ id: uuidv7(), userId, tokenHash, expiresAt: new Date(Date.now() + 3600_000) });
  return token;
}

async function postWith(app: App, token: string, body: unknown, key: string) {
  const response = await app.request(`/api/projects/${projectId}/seven-purchase-orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}`, 'idempotency-key': key },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, replayed: response.headers.get('idempotent-replayed') };
}
const post = (app: App, role: Role, body: unknown, key: string) => postWith(app, tokens[role], body, key);

async function poCount(poNumber: string): Promise<number> {
  return (await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.poNumber, poNumber))).length;
}

/**
 * P4 N8: a write through the API stores its key scoped by the caller's role
 * (`roleScopedIdempotencyKey`); a store-level begin() in these tests uses the
 * key as given. The row helpers read either form for the user's role.
 */
const roleOf = (userId: string) => (userId === adminId ? 'admin' : 'staff');
const apiStoredKey = (userId: string, key: string) => roleScopedIdempotencyKey(roleOf(userId), key);

async function keyRows(userId: string, key: string) {
  return (await db.execute(sql`
    select state, response_status, fingerprint from idempotency_keys
    where user_id = ${userId} and idempotency_key in (${key}, ${apiStoredKey(userId, key)})
  `) as unknown as { rows: Array<{ state: string; response_status: number | null; fingerprint: string }> }).rows;
}

function fingerprintOf(body: unknown): string {
  return `${sha256Hex(`POST /api/projects/${projectId}/seven-purchase-orders`)}:${sha256Hex(JSON.stringify(body))}`;
}

async function leaseOver(userId: string, key: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    select lease_expires_at <= now() as over from idempotency_keys
    where user_id = ${userId} and idempotency_key in (${key}, ${apiStoredKey(userId, key)})
  `) as unknown as { rows: Array<{ over: boolean }> }).rows;
  return rows[0]!.over;
}

/** Holds a lock that makes the seven-PO insert wait: a write that runs long. */
async function holdPoTable(): Promise<() => Promise<void>> {
  const client = await pool.connect();
  await client.query('begin');
  await client.query('lock table seven_purchase_orders in share row exclusive mode');
  return async () => {
    try {
      await client.query('commit');
    } finally {
      client.release();
    }
  };
}

const created: StoredResponse = { status: 201, body: '{"id":"first"}', contentType: 'application/json' };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let appA: App;
let appB: App;

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-p2-idem-'));
  await db.execute(sql`
    truncate table idempotency_keys, audit_events, seven_purchase_orders, pre_order_references,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  await db.insert(users).values([
    { id: adminId, username: 'admin_p2_idem', passwordHash: 'not-a-login-hash', displayName: '合成代表者P2', role: 'admin' },
    { id: staffId, username: 'staff_p2_idem', passwordHash: 'not-a-login-hash', displayName: '合成担当者P2', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成P2顧客', role: 'end_customer', externalCode: 'P2I-CUST' },
    { id: sevenAccountId, name: '合成P2セブン', role: 'seven', externalCode: 'P2I-SEVEN' },
    { id: makerAccountId, name: '合成P2メーカー', role: 'maker', externalCode: 'P2I-MAKER' }
  ]);
  const now = new Date();
  await db.insert(projects).values({
    id: projectId, code: 'P2-IDEM-A', name: '合成P2-IDEM-A', businessUnit: 'F1', route: 'F1', leadSource: 'KANEI', status: 'DRAFT',
    endCustomerAccountId: customerAccountId, sevenAccountId, makerAccountId, createdByUserId: adminId,
    createdAt: now, updatedAt: now
  });
  await db.insert(projectAssignments).values([{ id: uuidv7(), userId: staffId, projectId }]);
  tokens.admin = await newSession(adminId);
  tokens.staff = await newSession(staffId);
  // Two app instances on one database with separate default stores: a restart
  // or a second API process.
  appA = createApp({ db });
  appB = createApp({ db });
});

afterAll(async () => {
  await pool.end();
});

describe('P2 R05 Idempotency-Key answers are kept in idempotency_keys', () => {
  it('(a) a repeat of the same keyed write is recorded once and replayed', async () => {
    const poNumber = `SEVEN-P2I-A-${nextTag()}`;
    const key = `p2a-${nextTag()}-0001`;
    const first = await post(appA, 'staff', { poNumber }, key);
    expect(first.status).toBe(201);
    expect(first.replayed).toBeNull();
    const again = await post(appA, 'staff', { poNumber }, key);
    expect(again.status).toBe(201);
    expect(again.replayed).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await poCount(poNumber)).toBe(1);
    expect(await keyRows(staffId, key)).toEqual([expect.objectContaining({ state: 'completed', response_status: 201 })]);
  });

  it('(b) a second app instance (restart / other process) replays the first instance\'s answer', async () => {
    const poNumber = `SEVEN-P2I-B-${nextTag()}`;
    const key = `p2b-${nextTag()}-0001`;
    const first = await post(appA, 'staff', { poNumber }, key);
    expect(first.status).toBe(201);
    const restarted = createApp({ db });
    for (const app of [appB, restarted]) {
      const replay = await post(app, 'staff', { poNumber }, key);
      expect(replay.status).toBe(201);
      expect(replay.replayed).toBe('true');
      expect(replay.body.id).toBe(first.body.id);
    }
    expect(await poCount(poNumber)).toBe(1);
  });

  it('(c) three concurrent submits write once, within one instance and across two', async () => {
    for (const apps of [[appA, appA, appA], [appA, appB, appB]]) {
      const poNumber = `SEVEN-P2I-C-${nextTag()}`;
      const key = `p2c-${nextTag()}-0001`;
      const results = await Promise.all(apps.map((app) => post(app, 'staff', { poNumber }, key)));
      expect(results.map((result) => result.status)).toEqual([201, 201, 201]);
      expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
      expect(results.filter((result) => result.replayed === 'true')).toHaveLength(2);
      expect(await poCount(poNumber)).toBe(1);
    }
  });

  it('(d) another user with the same key runs their own write and never gets this user\'s answer', async () => {
    const key = `p2d-${nextTag()}-0001`;
    const staffPo = `SEVEN-P2I-D-${nextTag()}`;
    const adminPo = `SEVEN-P2I-D-${nextTag()}`;
    const staff = await post(appA, 'staff', { poNumber: staffPo }, key);
    const admin = await post(appB, 'admin', { poNumber: adminPo }, key);
    expect(staff.status).toBe(201);
    expect(admin.status).toBe(201);
    expect(admin.replayed).toBeNull();
    expect(admin.body.id).not.toBe(staff.body.id);
    // The admin sending the staff's exact body is a new request (a duplicate),
    // not a replay of the staff's answer.
    const adminSameBody = await post(appA, 'admin', { poNumber: staffPo }, `p2d-${nextTag()}-0002`);
    expect(adminSameBody.status).toBe(409);
    expect(adminSameBody.replayed).toBeNull();
    const adminStaffKey = await post(appA, 'admin', { poNumber: adminPo }, key);
    expect(adminStaffKey.replayed).toBe('true');
    expect(adminStaffKey.body.id).toBe(admin.body.id);
    expect(await keyRows(staffId, key)).toHaveLength(1);
    expect(await keyRows(adminId, key)).toHaveLength(1);
  });

  it('(e) the same key with another body is refused 422 IDEMPOTENCY_KEY_REUSED, also on another instance', async () => {
    const poNumber = `SEVEN-P2I-E-${nextTag()}`;
    const key = `p2e-${nextTag()}-0001`;
    expect((await post(appA, 'staff', { poNumber }, key)).status).toBe(201);
    for (const app of [appA, appB]) {
      const other = await post(app, 'staff', { poNumber: `${poNumber}-X` }, key);
      expect(other.status).toBe(422);
      expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(other.replayed).toBeNull();
    }
    expect(await poCount(`${poNumber}-X`)).toBe(0);
    const invalid = await post(appA, 'staff', { poNumber }, 'x');
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('(f) a refusal is not stored: the corrected submit with the same key really runs', async () => {
    const poNumber = `SEVEN-P2I-F-${nextTag()}`;
    const key = `p2f-${nextTag()}-0001`;
    const refused = await post(appA, 'staff', { poNumber, originalReceivedAt: 'not-a-date' }, key);
    expect(refused.status).toBe(422);
    expect(await keyRows(staffId, key)).toHaveLength(0);
    const corrected = await post(appB, 'staff', { poNumber }, key);
    expect(corrected.status).toBe(201);
    expect(corrected.replayed).toBeNull();
    expect(await poCount(poNumber)).toBe(1);
    // A 409 DUPLICATE is a refusal too and is not kept either.
    const dupKey = `p2f-${nextTag()}-0002`;
    const duplicate = await post(appA, 'staff', { poNumber }, dupKey);
    expect(duplicate.status).toBe(409);
    expect(await keyRows(staffId, dupKey)).toHaveLength(0);
  });

  it('(g) an expired answer is claimed again, and the sweep deletes expired rows at most once per interval', async () => {
    const expiredKey = `p2g-${nextTag()}-0001`;
    await db.execute(sql`
      insert into idempotency_keys (user_id, idempotency_key, fingerprint, state, response_status, response_body,
        response_content_type, lease_expires_at, created_at, completed_at, expires_at)
      values (${staffId}, ${expiredKey}, 'old-fingerprint', 'completed', 201, '{"id":"old"}', 'application/json',
        now() - interval '25 hours', now() - interval '25 hours', now() - interval '25 hours', now() - interval '1 hour')
    `);
    // The sweep is off here (huge interval) so the expired row is met by begin itself.
    const noSweep = new DbIdempotencyStore(db, { sweepIntervalMs: Number.POSITIVE_INFINITY });
    const reclaimed = await noSweep.begin(staffId, expiredKey, 'new-fingerprint');
    expect(reclaimed.kind).toBe('execute');
    expect(await keyRows(staffId, expiredKey)).toEqual([expect.objectContaining({ state: 'pending', fingerprint: 'new-fingerprint' })]);
    if (reclaimed.kind === 'execute') await reclaimed.complete(created);
    expect((await noSweep.begin(staffId, expiredKey, 'new-fingerprint')).kind).toBe('replay');

    const swept = [`p2g-${nextTag()}-0002`, `p2g-${nextTag()}-0003`];
    const live = `p2g-${nextTag()}-0004`;
    for (const key of swept) {
      await db.execute(sql`
        insert into idempotency_keys (user_id, idempotency_key, fingerprint, state, lease_expires_at, created_at, expires_at)
        values (${staffId}, ${key}, 'f', 'pending', now() - interval '2 days', now() - interval '2 days', now() - interval '1 day')
      `);
    }
    const liveStore = new DbIdempotencyStore(db, { sweepIntervalMs: 60_000 });
    const liveClaim = await liveStore.begin(staffId, live, 'f');
    expect(liveClaim.kind).toBe('execute');
    if (liveClaim.kind === 'execute') await liveClaim.complete(created);
    for (const key of swept) expect(await keyRows(staffId, key)).toHaveLength(0);
    // Within the interval a second begin does not sweep again.
    const late = `p2g-${nextTag()}-0005`;
    await db.execute(sql`
      insert into idempotency_keys (user_id, idempotency_key, fingerprint, state, lease_expires_at, created_at, expires_at)
      values (${staffId}, ${late}, 'f', 'pending', now() - interval '2 days', now() - interval '2 days', now() - interval '1 day')
    `);
    const unswept = await liveStore.begin(staffId, `p2g-${nextTag()}-0006`, 'f');
    if (unswept.kind === 'execute') await unswept.complete(null);
    expect(await keyRows(staffId, late)).toHaveLength(1);
    expect(await liveStore.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(await keyRows(staffId, late)).toHaveLength(0);
    expect(await keyRows(staffId, live)).toHaveLength(1);
  });

  it('(h) a pending row whose holder died (lease over, no heartbeat) is never run again: 409 IDEMPOTENCY_OUTCOME_UNKNOWN, no write', async () => {
    const poNumber = `SEVEN-P2I-H-${nextTag()}`;
    const key = `p2h-${nextTag()}-0001`;
    await db.execute(sql`
      insert into idempotency_keys (user_id, idempotency_key, fingerprint, state, lease_expires_at, created_at, expires_at)
      values (${staffId}, ${apiStoredKey(staffId, key)}, ${fingerprintOf({ poNumber })}, 'pending',
        now() - interval '1 second', now() - interval '5 minutes', now() + interval '23 hours')
    `);
    for (const app of [appA, appB]) {
      const result = await post(app, 'staff', { poNumber }, key);
      expect(result.status).toBe(409);
      expect(result.body).toEqual({
        error: '前回の送信の結果を確認できませんでした。画面を再読み込みして、記録されたかどうかを確認してください',
        code: 'IDEMPOTENCY_OUTCOME_UNKNOWN'
      });
      expect(result.replayed).toBeNull();
    }
    expect(await poCount(poNumber)).toBe(0);
    // Several racing processes all fail closed; none claims the key.
    const racers = [0, 1, 2].map(() => new DbIdempotencyStore(db, { leaseMs: 300, pollIntervalMs: 50 }));
    const results = await Promise.all(racers.map((store) => store.begin(staffId, apiStoredKey(staffId, key), fingerprintOf({ poNumber }))));
    expect(results).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }, { kind: 'unknown' }]);
    expect(await keyRows(staffId, key)).toEqual([expect.objectContaining({ state: 'pending' })]);
    // Another body with that key is still the existing 422.
    const other = await post(appA, 'staff', { poNumber: `${poNumber}-X` }, key);
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // A fresh key (screen reloaded) runs normally.
    expect((await post(appA, 'staff', { poNumber }, `p2h-${nextTag()}-0002`)).status).toBe(201);
    expect(await poCount(poNumber)).toBe(1);
  });

  it('(M1-A) a same-process retry of a write running past its lease waits and replays; the write runs once', async () => {
    // No heartbeat here, so the lease really runs out while the first runs.
    const store = new DbIdempotencyStore(db, { leaseMs: 300, pollIntervalMs: 50, heartbeatMs: Number.POSITIVE_INFINITY });
    const app = createApp({ db, idempotencyStore: store });
    const poNumber = `SEVEN-P2I-MA-${nextTag()}`;
    const key = `p2ma-${nextTag()}-0001`;
    const release = await holdPoTable();
    let first: ReturnType<typeof post> | undefined;
    let second: ReturnType<typeof post> | undefined;
    try {
      first = post(app, 'staff', { poNumber }, key);
      await sleep(500);
      expect(await leaseOver(staffId, key)).toBe(true);
      second = post(app, 'staff', { poNumber }, key);
      await sleep(150);
    } finally {
      await release();
    }
    const [one, two] = await Promise.all([first!, second!]);
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.replayed).toBe('true');
    expect(two.body.id).toBe(one.body.id);
    expect(await poCount(poNumber)).toBe(1);
  });

  it('(M1-B) the heartbeat keeps a long write alive: another process waits and replays instead of failing or re-running', async () => {
    const options = { leaseMs: 300, pollIntervalMs: 50 };
    const holder = createApp({ db, idempotencyStore: new DbIdempotencyStore(db, options) });
    const otherProcess = createApp({ db, idempotencyStore: new DbIdempotencyStore(db, options) });
    const poNumber = `SEVEN-P2I-MB-${nextTag()}`;
    const key = `p2mb-${nextTag()}-0001`;
    const release = await holdPoTable();
    let first: ReturnType<typeof post> | undefined;
    let second: ReturnType<typeof post> | undefined;
    try {
      first = post(holder, 'staff', { poNumber }, key);
      await sleep(500);
      // Past the first lease, the row is still alive thanks to the renewals.
      expect(await leaseOver(staffId, key)).toBe(false);
      second = post(otherProcess, 'staff', { poNumber }, key);
      await sleep(150);
    } finally {
      await release();
    }
    const [one, two] = await Promise.all([first!, second!]);
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.replayed).toBe('true');
    expect(two.body.id).toBe(one.body.id);
    expect(await poCount(poNumber)).toBe(1);
  });

  it('(M1-B) the heartbeat stops at complete and a failed answer store leaves the key fail-closed, not re-run', async () => {
    let failSettle = false;
    let calls = 0;
    const flaky = {
      execute: (query: Parameters<AppDatabase['execute']>[0]) => {
        calls += 1;
        return failSettle
          ? Promise.reject(Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' }))
          : db.execute(query);
      }
    } as unknown as Pick<AppDatabase, 'execute'>;
    const options = { leaseMs: 300, pollIntervalMs: 50 };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = new DbIdempotencyStore(flaky, options);
      const key = `p2mc-${nextTag()}-0001`;
      const claim = await store.begin(staffId, key, 'f');
      expect(claim.kind).toBe('execute');
      failSettle = true;
      if (claim.kind === 'execute') await claim.complete(created);
      failSettle = false;
      const callsAtComplete = calls;
      await sleep(450);
      // The store made no call after complete: no renewal outlives the request.
      expect(calls).toBe(callsAtComplete);
      // No renewal after complete: the lease ran out, and the key is unknown, not runnable.
      expect(await leaseOver(staffId, key)).toBe(true);
      expect(await new DbIdempotencyStore(db, options).begin(staffId, key, 'f')).toEqual({ kind: 'unknown' });
      expect(errors.mock.calls.map((args) => args.map(String).join(' ')).join('\n')).not.toContain(key);
    } finally {
      errors.mockRestore();
    }
  });

  it('a waiter on another process gets null when the first request was refused, and then claims the key', async () => {
    const key = `p2w-${nextTag()}-0001`;
    const first = new DbIdempotencyStore(db, { pollIntervalMs: 50 });
    const second = new DbIdempotencyStore(db, { pollIntervalMs: 50 });
    const claim = await first.begin(staffId, key, 'f');
    expect(claim.kind).toBe('execute');
    const waiting = await second.begin(staffId, key, 'f');
    expect(waiting.kind).toBe('wait');
    const sameProcess = await first.begin(staffId, key, 'f');
    expect(sameProcess.kind).toBe('wait');
    if (claim.kind === 'execute') await claim.complete({ status: 422, body: '{}', contentType: 'application/json' });
    if (waiting.kind === 'wait') expect(await waiting.pending).toBeNull();
    if (sameProcess.kind === 'wait') expect(await sameProcess.pending).toBeNull();
    const retried = await second.begin(staffId, key, 'f');
    expect(retried.kind).toBe('execute');
    if (retried.kind === 'execute') await retried.complete(null);
  });

  it('(i) after a new login (new session, same user) the same key replays', async () => {
    const poNumber = `SEVEN-P2I-I-${nextTag()}`;
    const key = `p2i-${nextTag()}-0001`;
    const first = await post(appA, 'staff', { poNumber }, key);
    expect(first.status).toBe(201);
    const relogin = await newSession(staffId);
    const again = await postWith(appB, relogin, { poNumber }, key);
    expect(again.status).toBe(201);
    expect(again.replayed).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await poCount(poNumber)).toBe(1);
    // A forged cookie is never cached or replayed.
    const forged = await postWith(appB, 'forged', { poNumber }, key);
    expect(forged.status).toBe(401);
    expect(forged.replayed).toBeNull();
  });

  it('(j) a database failure in the store answers 503 DB_UNAVAILABLE and writes nothing', async () => {
    const down = {
      execute: () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5434'), { code: 'ECONNREFUSED' }))
    } as unknown as Pick<AppDatabase, 'execute'>;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createApp({ db, idempotencyStore: new DbIdempotencyStore(down) });
      const poNumber = `SEVEN-P2I-J-${nextTag()}`;
      const result = await post(app, 'staff', { poNumber }, `p2j-${nextTag()}-0001`);
      expect(result.status).toBe(503);
      expect(result.body.code).toBe('DB_UNAVAILABLE');
      expect(result.replayed).toBeNull();
      expect(await poCount(poNumber)).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });

  it('a database failure while storing the answer keeps the user\'s 201 and logs no request data', async () => {
    let calls = 0;
    // Call 1 is the sweep, call 2 the claim; the store/release calls fail.
    const flaky = {
      execute: (query: Parameters<AppDatabase['execute']>[0]) => {
        calls += 1;
        if (calls >= 3) return Promise.reject(Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' }));
        return db.execute(query);
      }
    } as unknown as Pick<AppDatabase, 'execute'>;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createApp({ db, idempotencyStore: new DbIdempotencyStore(flaky) });
      const poNumber = `SEVEN-P2I-K-${nextTag()}`;
      const key = `p2k-${nextTag()}-0001`;
      const result = await post(app, 'staff', { poNumber }, key);
      expect(result.status).toBe(201);
      expect(await poCount(poNumber)).toBe(1);
      const logged = errors.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(logged).toContain('[idempotency]');
      expect(logged).not.toContain(poNumber);
      expect(logged).not.toContain(key);
      // The row stays pending until its lease runs out; meanwhile the DB
      // unique constraint is the duplicate guard.
      expect(await keyRows(staffId, key)).toEqual([expect.objectContaining({ state: 'pending' })]);
    } finally {
      errors.mockRestore();
    }
  });
});

// P2 independent review M-1 / M-2 (2026-11-21).
describe('P2 review: a written answer that could not be stored never reopens its key; the two 409s are distinct', () => {
  it('M-1: only the answer store fails (the follow-up succeeds) → the same key answers 409 IDEMPOTENCY_OUTCOME_UNKNOWN, one write', async () => {
    let calls = 0;
    // Call 1 is the sweep, call 2 the claim, call 3 the answer store (fails
    // once), call 4 the "outcome unknown" mark (succeeds) — the reviewer's case
    // where the old code deleted the row and reopened the key.
    const flaky = {
      execute: (query: Parameters<AppDatabase['execute']>[0]) => {
        calls += 1;
        if (calls === 3) return Promise.reject(Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' }));
        return db.execute(query);
      }
    } as unknown as Pick<AppDatabase, 'execute'>;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const writer = createApp({ db, idempotencyStore: new DbIdempotencyStore(flaky) });
      const poNumber = `SEVEN-P2R-M1-${nextTag()}`;
      const key = `p2rm1-${nextTag()}-0001`;
      const first = await post(writer, 'staff', { poNumber }, key);
      expect(first.status).toBe(201);
      expect(calls).toBe(4);
      expect(await keyRows(staffId, key)).toEqual([expect.objectContaining({ state: 'pending' })]);
      expect(await leaseOver(staffId, key)).toBe(true);
      // A retry (the client never saw the 201) on this process and on another.
      for (const app of [writer, createApp({ db })]) {
        const retry = await post(app, 'staff', { poNumber }, key);
        expect(retry.status).toBe(409);
        expect(retry.body.code).toBe('IDEMPOTENCY_OUTCOME_UNKNOWN');
      }
      expect(await poCount(poNumber)).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });

  it('M-1: a 2xx answer above the replay limit keeps the key closed (unknown), never deleted', async () => {
    const store = new DbIdempotencyStore(db, { pollIntervalMs: 50 });
    const key = `p2rbig-${nextTag()}-0001`;
    const claim = await store.begin(staffId, key, 'f');
    expect(claim.kind).toBe('execute');
    if (claim.kind === 'execute') await claim.complete({ status: 201, body: 'x'.repeat(300 * 1024), contentType: 'application/json' });
    expect(await keyRows(staffId, key)).toEqual([expect.objectContaining({ state: 'pending' })]);
    expect(await new DbIdempotencyStore(db).begin(staffId, key, 'f')).toEqual({ kind: 'unknown' });
  });

  it('M-1: a refusal still releases the key so a corrected submit runs (P0 rule kept)', async () => {
    const store = new DbIdempotencyStore(db);
    const key = `p2rref-${nextTag()}-0001`;
    const claim = await store.begin(staffId, key, 'f');
    if (claim.kind === 'execute') await claim.complete({ status: 422, body: '{}', contentType: 'application/json' });
    expect(await keyRows(staffId, key)).toEqual([]);
    const again = await store.begin(staffId, key, 'g');
    expect(again.kind).toBe('execute');
    if (again.kind === 'execute') await again.complete(null);
  });

  it('M-2: a first request still running after the waits answers 409 IDEMPOTENCY_IN_PROGRESS and writes nothing', async () => {
    let begins = 0;
    const busy: IdempotencyBackend = {
      begin: () => {
        begins += 1;
        return { kind: 'wait', pending: Promise.resolve(null) };
      }
    };
    const app = createApp({ db, idempotencyStore: busy });
    const poNumber = `SEVEN-P2R-M2-${nextTag()}`;
    const result = await post(app, 'staff', { poNumber }, `p2rm2-${nextTag()}-0001`);
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: '同じ送信をまだ処理しています。少し待ってから、同じ画面のままもう一度送信してください',
      code: 'IDEMPOTENCY_IN_PROGRESS'
    });
    expect(begins).toBe(4);
    expect(await poCount(poNumber)).toBe(0);
  });

  it('M-2: the two outcomes are different codes, and neither is the generic CONFLICT', async () => {
    const { ERROR_MESSAGES_JA } = await import('../apps/api/src/error-codes.js');
    expect(ERROR_MESSAGES_JA.IDEMPOTENCY_IN_PROGRESS).toBeTruthy();
    expect(ERROR_MESSAGES_JA.IDEMPOTENCY_OUTCOME_UNKNOWN).toBeTruthy();
    expect(ERROR_MESSAGES_JA.IDEMPOTENCY_IN_PROGRESS).not.toBe(ERROR_MESSAGES_JA.IDEMPOTENCY_OUTCOME_UNKNOWN);
  });
});
