import 'dotenv/config';
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

async function main() {
  const { db, pool } = createDatabase(databaseUrl);
  try {
    const userIds: Record<string, string> = {};
    for (const user of seedUsers) {
      const id = uuidv7();
      userIds[user.username] = id;
      await db.insert(users).values({
        id,
        username: user.username,
        passwordHash: await hashPassword(user.password),
        displayName: user.displayName,
        role: user.role
      });
    }

    const accountIds: Record<string, string> = {};
    for (const account of seedAccounts) {
      const id = uuidv7();
      accountIds[account.role] = id;
      await db.insert(accounts).values({ id, name: account.name, role: account.role, externalCode: account.externalCode });
    }

    const projectId = uuidv7();
    const now = new Date();
    await db.insert(projects).values({
      id: projectId,
      code: 'CMP-F1-0001',
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
    });
    await db.insert(projectAssignments).values([
      { id: uuidv7(now), userId: userIds.staff_composite!, projectId },
      { id: uuidv7(now), userId: userIds.viewer_composite!, projectId }
    ]);
    console.log('Composite seed data inserted.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
