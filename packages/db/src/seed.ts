import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { createDatabase, uuidv7 } from './index.js';
import { accounts, projectAssignments, projects, users } from './schema.js';
import { hashPassword } from '../../../apps/api/src/password.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://kanei:local_only_dev@127.0.0.1:5434/kanei_crm_mvp';

const seedUsers = [
  { username: 'admin_composite', role: 'admin' as const, displayName: '合成代表者', password: 'composite-admin-pass' },
  { username: 'staff_composite', role: 'staff' as const, displayName: '合成担当者', password: 'composite-staff-pass' },
  { username: 'viewer_composite', role: 'viewer' as const, displayName: '合成閲覧者', password: 'composite-viewer-pass' }
];

const seedAccounts = [
  { name: '合成エンドカスタマー株式会社', role: 'end_customer' as const, externalCode: 'COMP-CUST-001' },
  { name: '合成セブン化学事業', role: 'seven' as const, externalCode: 'COMP-SEVEN-001' },
  { name: '合成フィルム製造業者', role: 'maker' as const, externalCode: 'COMP-MAKER-001' }
];

// Idempotency contract: every seeded row is keyed by its natural unique column
// (users.username / accounts.external_code / projects.code /
// project_assignments(user_id, project_id)). Each insert carries
// ON CONFLICT DO NOTHING and the surviving row is then read back by the same
// natural key, so a re-run reuses every pre-existing row instead of minting a
// second copy. The previous code generated a fresh uuidv7() per run and
// blind-inserted, so a re-run crashed on the first duplicate users.username.
// Existing rows are never mutated: a re-run does not overwrite a password
// changed after the first seed and does not resurrect soft-deleted rows —
// soft-deleted matches are reused as-is and reported so the operator notices.
async function main() {
  const { db, pool } = createDatabase(databaseUrl);
  try {
    const userIds: Record<string, string> = {};
    for (const user of seedUsers) {
      const [existing] = await db.select({ id: users.id }).from(users)
        .where(eq(users.username, user.username)).limit(1);
      if (existing) {
        userIds[user.username] = existing.id;
        console.log(`user ${user.username}: already seeded, reusing`);
        continue;
      }
      await db.insert(users).values({
        id: uuidv7(),
        username: user.username,
        passwordHash: await hashPassword(user.password),
        displayName: user.displayName,
        role: user.role
      }).onConflictDoNothing();
      const [row] = await db.select({ id: users.id }).from(users)
        .where(eq(users.username, user.username)).limit(1);
      if (!row) throw new Error(`user ${user.username}: insert did not land and no existing row found`);
      userIds[user.username] = row.id;
      console.log(`user ${user.username}: created`);
    }

    const accountIds: Record<string, string> = {};
    for (const account of seedAccounts) {
      const [existing] = await db.select({ id: accounts.id, deletedAt: accounts.deletedAt }).from(accounts)
        .where(eq(accounts.externalCode, account.externalCode)).limit(1);
      if (existing) {
        accountIds[account.role] = existing.id;
        console.log(`account ${account.externalCode}: already seeded, reusing${existing.deletedAt ? ' (soft-deleted)' : ''}`);
        continue;
      }
      await db.insert(accounts)
        .values({ id: uuidv7(), name: account.name, role: account.role, externalCode: account.externalCode })
        .onConflictDoNothing();
      const [row] = await db.select({ id: accounts.id }).from(accounts)
        .where(eq(accounts.externalCode, account.externalCode)).limit(1);
      if (!row) throw new Error(`account ${account.externalCode}: insert did not land and no existing row found`);
      accountIds[account.role] = row.id;
      console.log(`account ${account.externalCode}: created`);
    }

    const projectCode = 'CMP-F1-0001';
    const [existingProject] = await db.select({ id: projects.id, deletedAt: projects.deletedAt }).from(projects)
      .where(eq(projects.code, projectCode)).limit(1);
    let projectId: string;
    if (existingProject) {
      projectId = existingProject.id;
      console.log(`project ${projectCode}: already seeded, reusing${existingProject.deletedAt ? ' (soft-deleted — hidden from the UI list)' : ''}`);
    } else {
      const now = new Date();
      await db.insert(projects).values({
        id: uuidv7(),
        code: projectCode,
        name: '合成F1案件（M0検証用）',
        businessUnit: 'F1',
        route: 'F1',
        leadSource: 'KANEI',
        status: 'DRAFT',
        endCustomerAccountId: accountIds.end_customer!,
        sevenAccountId: accountIds.seven!,
        makerAccountId: accountIds.maker!,
        createdByUserId: userIds.admin_composite!,
        createdAt: now,
        updatedAt: now
      }).onConflictDoNothing();
      const [row] = await db.select({ id: projects.id }).from(projects)
        .where(eq(projects.code, projectCode)).limit(1);
      if (!row) throw new Error(`project ${projectCode}: insert did not land and no existing row found`);
      projectId = row.id;
      console.log(`project ${projectCode}: created`);
    }

    // (user_id, project_id) is unique, so re-running over an already-assigned
    // project is a no-op while it also repairs a first run that was
    // interrupted between the project and the assignment inserts.
    await db.insert(projectAssignments).values([
      { id: uuidv7(), userId: userIds.staff_composite!, projectId },
      { id: uuidv7(), userId: userIds.viewer_composite!, projectId }
    ]).onConflictDoNothing();

    console.log('Composite seed data ready (idempotent: re-running reuses existing rows).');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
