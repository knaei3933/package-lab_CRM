import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { canPerform } from '@kanei/core';
import { createDatabase, uuidv7, accounts, auditEvents, projectAssignments, projects, sessions, users } from '@kanei/db';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../../apps/api/src/auth.js';

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const viewerId = uuidv7();
const expiredUserId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const seededProjectId = uuidv7();
let staffToken = '';
let staffTokenHash = '';

function cookieHeader(token: string) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

async function countAll() {
  const result = await db.execute(sql`
    select
      (select count(*) from users)::int as users,
      (select count(*) from sessions)::int as sessions,
      (select count(*) from accounts)::int as accounts,
      (select count(*) from projects)::int as projects,
      (select count(*) from project_assignments)::int as assignments,
      (select count(*) from audit_events)::int as audit_events
  `);
  return result.rows[0] as {
    users: number;
    sessions: number;
    accounts: number;
    projects: number;
    assignments: number;
    audit_events: number;
  };
}

async function createSession(userId: string, expiresAt = new Date(Date.now() + 60 * 60 * 1000)) {
  const { token, tokenHash } = issueToken();
  await db.insert(sessions).values({ id: uuidv7(), userId, tokenHash, expiresAt });
  return token;
}

beforeAll(async () => {
  await db.execute(sql`
    truncate table audit_events, project_assignments, projects, sessions, accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'admin_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者', role: 'admin' },
    { id: staffId, username: 'staff_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者', role: 'staff' },
    { id: viewerId, username: 'viewer_test', passwordHash: await hashPassword('composite-viewer-pass'), displayName: '合成閲覧者', role: 'viewer' },
    { id: expiredUserId, username: 'expired_test', passwordHash: await hashPassword('composite-expired-pass'), displayName: '合成失効ユーザー', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成エンドカスタマー', role: 'end_customer', externalCode: 'TEST-CUST' },
    { id: sevenAccountId, name: '合成セブン', role: 'seven', externalCode: 'TEST-SEVEN' },
    { id: makerAccountId, name: '合成メーカー', role: 'maker', externalCode: 'TEST-MAKER' }
  ]);
  await db.insert(projects).values({
    id: seededProjectId,
    code: 'TEST-F1-BASE',
    name: '合成F1ベース案件',
    businessUnit: 'F1',
    route: 'F1',
    leadSource: 'KANEI',
    status: 'DRAFT',
    endCustomerAccountId: customerAccountId,
    sevenAccountId: sevenAccountId,
    makerAccountId: makerAccountId,
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: staffId, projectId: seededProjectId },
    { id: uuidv7(now), userId: viewerId, projectId: seededProjectId }
  ]);
  staffToken = await createSession(staffId);
  staffTokenHash = '';
});

afterAll(async () => {
  await pool.end();
});

describe('M0 foundation contracts', () => {
  it('core authorization denies staff CEO approval before any HTTP handling', () => {
    const decision = canPerform(
      { id: staffId, role: 'staff', isActive: true, assignedProjectIds: [seededProjectId] },
      'ceo_approve',
      'F1'
    );
    expect(decision).toEqual({ allowed: false, reason: 'ROLE_FORBIDDEN' });
  });

  it('T-01 creates an F1 project and persists exactly one project and audit row', async () => {
    const app = createApp({ db });
    const before = await countAll();
    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookieHeader(staffToken) },
      body: JSON.stringify({
        route: 'F1',
        code: 'TEST-F1-T01',
        name: '合成F1案件 T-01',
        endCustomerAccountId: customerAccountId,
        sevenAccountId: sevenAccountId,
        makerAccountId: makerAccountId
      })
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const after = await countAll();
    expect(after.projects).toBe(before.projects + 1);
    expect(after.audit_events).toBe(before.audit_events + 1);

    const [row] = await db.select().from(projects).where(sql`${projects.id} = ${created.id}`).limit(1);
    expect(row?.route).toBe('F1');
    expect(row?.businessUnit).toBe('F1');
    expect(row?.leadSource).toBe('KANEI');
    const [audit] = await db.select().from(auditEvents)
      .where(sql`${auditEvents.entityId} = ${created.id}`).limit(1);
    expect(audit?.action).toBe('PROJECT_CREATED');
  });

  it('T-02 rejects direct_film creation with 422 and zero persistence', async () => {
    const app = createApp({ db });
    const before = await countAll();
    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookieHeader(staffToken) },
      body: JSON.stringify({
        route: 'direct_film',
        code: 'TEST-DIRECT-FILM',
        name: 'direct_film合成案件',
        endCustomerAccountId: customerAccountId,
        sevenAccountId: sevenAccountId,
        makerAccountId: makerAccountId
      })
    });

    expect(response.status).toBe(422);
    const after = await countAll();
    expect(after).toEqual(before);
  });

  it('T-03 rejects F2 POST and route mutation PATCH with zero persistence', async () => {
    const app = createApp({ db });
    const before = await countAll();
    const f2Response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookieHeader(staffToken) },
      body: JSON.stringify({
        route: 'F2',
        code: 'TEST-F2-REJECTED',
        name: 'F2合成案件',
        endCustomerAccountId: customerAccountId,
        sevenAccountId: sevenAccountId,
        makerAccountId: makerAccountId
      })
    });
    expect(f2Response.status).toBe(422);

    const patchResponse = await app.request(`/api/projects/${seededProjectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...cookieHeader(staffToken) },
      body: JSON.stringify({ route: 'F2', name: '許可されていない変更' })
    });
    expect(patchResponse.status).toBe(422);
    const after = await countAll();
    expect(after).toEqual(before);

    const [project] = await db.select().from(projects)
      .where(sql`${projects.id} = ${seededProjectId}`).limit(1);
    expect(project?.route).toBe('F1');
    expect(project?.name).toBe('合成F1ベース案件');
  });

  it('T-31 returns 403 when staff directly calls the CEO approval API', async () => {
    const app = createApp({ db });
    const before = await countAll();
    const response = await app.request('/api/ceo-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookieHeader(staffToken) },
      body: JSON.stringify({ makerPurchaseOrderId: 'synthetic-po-001' })
    });

    expect(response.status).toBe(403);
    expect(await countAll()).toEqual(before);
  });

  it('T-33 skeleton returns 401 for an expired session and persists nothing', async () => {
    const app = createApp({ db });
    await createSession(expiredUserId, new Date(Date.now() - 1000));
    const before = await countAll();
    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=not-the-stored-token`
      },
      body: JSON.stringify({ route: 'F1', code: 'SHOULD_NOT_EXIST' })
    });

    expect(response.status).toBe(401);
    const after = await countAll();
    expect(after.sessions).toBe(before.sessions);
    expect(after.projects).toBe(before.projects);
    expect(after.audit_events).toBe(before.audit_events);
  });
});
