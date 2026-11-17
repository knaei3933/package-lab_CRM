import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, eq, inArray } from 'drizzle-orm';
import { createDatabase } from '@kanei/db';
import { accounts, projectAssignments, projects, users } from '@kanei/db';
import { seedCompositeData } from '@kanei/db/seed';

/**
 * §5-5 regression: seeding is an operator command that must be safe to run
 * again. This is an integration test against the isolated test database; the
 * suite-level guard is the permission boundary for every connection.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.includes('/kanei_crm_mvp_test')) {
  throw new Error('Seed idempotency tests require DATABASE_URL to name kanei_crm_mvp_test');
}

const { db, pool } = createDatabase(databaseUrl);

async function seededRowCounts() {
  const [userCount] = await db.select({ value: count() })
    .from(users)
    .where(inArray(users.username, ['admin_composite', 'staff_composite', 'viewer_composite']));
  const [accountCount] = await db.select({ value: count() })
    .from(accounts)
    .where(inArray(accounts.externalCode, ['COMP-CUST-001', 'COMP-SEVEN-001', 'COMP-MAKER-001']));
  const [projectCount] = await db.select({ value: count() })
    .from(projects)
    .where(eq(projects.code, 'CMP-F1-0001'));
  return {
    users: userCount?.value ?? 0,
    accounts: accountCount?.value ?? 0,
    projects: projectCount?.value ?? 0
  };
}

async function seedAssignmentCount(projectId: string) {
  const assignments = await db.select({ id: projectAssignments.id })
    .from(projectAssignments)
    .where(eq(projectAssignments.projectId, projectId));
  return assignments.length;
}

describe('composite seed idempotency', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/\/kanei_crm_mvp_test(\?|$)/);
  });

  it('creates seed rows once and reuses the same rows on every rerun', async () => {
    const before = await seededRowCounts();
    const first = await seedCompositeData(databaseUrl);
    const afterFirst = await seededRowCounts();
    const firstAssignments = await seedAssignmentCount(first.projectId);

    const second = await seedCompositeData(databaseUrl);
    const afterSecond = await seededRowCounts();
    const secondAssignments = await seedAssignmentCount(second.projectId);

    // Existing databases may already contain some natural keys. Seeding must
    // fill any gaps without creating a second copy of any of them.
    expect(afterFirst).toEqual({ users: 3, accounts: 3, projects: 1 });
    expect(afterSecond).toEqual(afterFirst);
    expect(firstAssignments).toBe(2);
    expect(secondAssignments).toBe(2);
    expect(second.projectId).toBe(first.projectId);
    expect(second.userIds.staff_composite).toBe(first.userIds.staff_composite);
    expect(second.accountIds.seven).toBe(first.accountIds.seven);
  });

  it('refuses to choose a database when DATABASE_URL is absent', async () => {
    const previousUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(seedCompositeData()).rejects.toThrow('requires DATABASE_URL');
    } finally {
      process.env.DATABASE_URL = previousUrl;
    }
  });

  afterAll(async () => {
    await pool.end();
  });
});
