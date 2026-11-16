import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { accounts, createDatabase, projectAssignments, projects, sessions, users, uuidv7 } from '@kanei/db';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../../apps/api/src/auth.js';

/**
 * M8-UI3: GET /api/projects is the list the operator-UI project selector reads.
 *
 * The selector replaces the free-typed UUID, so the endpoint must answer with
 * exactly the projects the caller may already open by id: admin reads every
 * non-deleted project, staff and viewer only the project_assignments rows they
 * hold. A project the caller cannot read must not appear at all — the list is
 * UI support for the existing permission model, never a new visibility rule.
 * Only the fields the selector renders (id, code, name, status) come back.
 */

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const unassignedStaffId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const assignedProjectId = uuidv7();
const otherProjectId = uuidv7();
const deletedProjectId = uuidv7();

let adminToken = '';
let staffToken = '';
let unassignedStaffToken = '';
let app: ReturnType<typeof createApp>;

interface ProjectSummary {
  id: string;
  code: string;
  name: string;
  status: string;
}

function cookieHeader(token: string) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

async function getAs(token: string, url: string) {
  const response = await app.request(url, { headers: cookieHeader(token) });
  return { status: response.status, body: (await response.json()) as { projects?: ProjectSummary[] } };
}

async function createSession(userId: string) {
  const { token, tokenHash } = issueToken();
  await db.insert(sessions).values({
    id: uuidv7(),
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  });
  return token;
}

beforeAll(async () => {
  app = createApp({ db });
  await db.execute(sql`
    truncate table audit_events, project_assignments, projects, sessions, accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'admin_ui3_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者UI3', role: 'admin' },
    { id: staffId, username: 'staff_ui3_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者UI3', role: 'staff' },
    { id: unassignedStaffId, username: 'staff_ui3_other_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者UI3別', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成UI3エンドカスタマー', role: 'end_customer', externalCode: 'TEST-UI3-CUST' },
    { id: sevenAccountId, name: '合成UI3セブン', role: 'seven', externalCode: 'TEST-UI3-SEVEN' },
    { id: makerAccountId, name: '合成UI3メーカー', role: 'maker', externalCode: 'TEST-UI3-MAKER' }
  ]);
  for (const [targetId, code, status] of [
    [assignedProjectId, 'TEST-F1-UI3-ASSIGNED', 'ACTIVE'],
    [otherProjectId, 'TEST-F1-UI3-OTHER', 'DRAFT'],
    [deletedProjectId, 'TEST-F1-UI3-DELETED', 'ARCHIVED']
  ] as const) {
    await db.insert(projects).values({
      id: targetId,
      code,
      name: `合成UI3案件 ${code}`,
      businessUnit: 'F1' as const,
      route: 'F1' as const,
      leadSource: 'KANEI',
      status,
      endCustomerAccountId: customerAccountId,
      sevenAccountId,
      makerAccountId,
      createdByUserId: adminId,
      createdAt: now,
      updatedAt: now
    });
  }
  // The deleted project is soft-deleted: the list must not offer it, because the
  // per-project read refuses it with 案件が見つかりません.
  await db.update(projects).set({ deletedAt: now }).where(sql`${projects.id} = ${deletedProjectId}`);
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: staffId, projectId: assignedProjectId }
  ]);
  adminToken = await createSession(adminId);
  staffToken = await createSession(staffId);
  unassignedStaffToken = await createSession(unassignedStaffId);
});

afterAll(async () => {
  await pool.end();
});

describe('M8-UI3: GET /api/projects answers the visibility the caller already has', () => {
  it('admin reads every non-deleted project and only the selector fields', async () => {
    const { status, body } = await getAs(adminToken, '/api/projects');
    expect(status).toBe(200);
    const codes = (body.projects ?? []).map((project) => project.code);
    expect(codes).toContain('TEST-F1-UI3-ASSIGNED');
    expect(codes).toContain('TEST-F1-UI3-OTHER');
    expect(codes).not.toContain('TEST-F1-UI3-DELETED');

    for (const project of body.projects ?? []) {
      expect(Object.keys(project).sort()).toEqual(['code', 'id', 'name', 'status']);
    }
    const assigned = (body.projects ?? []).find((project) => project.code === 'TEST-F1-UI3-ASSIGNED');
    expect(assigned).toMatchObject({ id: assignedProjectId, status: 'ACTIVE' });
  });

  it('staff reads only the assigned project and never an unassigned or deleted one', async () => {
    const { status, body } = await getAs(staffToken, '/api/projects');
    expect(status).toBe(200);
    expect((body.projects ?? []).map((project) => project.code)).toEqual(['TEST-F1-UI3-ASSIGNED']);
    expect(body.projects?.[0]).toMatchObject({ id: assignedProjectId, name: '合成UI3案件 TEST-F1-UI3-ASSIGNED' });
  });

  it('staff without any assignment reads an empty list, not an error', async () => {
    const { status, body } = await getAs(unassignedStaffToken, '/api/projects');
    expect(status).toBe(200);
    expect(body.projects).toEqual([]);
  });

  it('refuses the caller without a session', async () => {
    const response = await app.request('/api/projects');
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('認証が必要です');
  });
});
