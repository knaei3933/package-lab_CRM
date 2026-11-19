import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  accounts,
  auditEvents,
  createDatabase,
  filmSupplyOrderLines,
  filmSupplyOrders,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('backfill script tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);
const scriptPath = path.resolve(process.cwd(), 'scripts/backfill-film-line-audit-events-20261119.sql');

const staffId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();
const orderId = uuidv7();
const apiLineId = uuidv7();
const missingLineId = uuidv7();

type QueryResult = { rows?: Array<Record<string, unknown>> };
type MultiStatementResult = QueryResult | Array<QueryResult>;

async function runBackfill(): Promise<number> {
  const script = await readFile(scriptPath, 'utf8');
  const raw = await pool.query(script) as unknown as MultiStatementResult;
  const results = Array.isArray(raw) ? raw : [raw];
  const rows = results.flatMap((result) => result.rows ?? []);
  const inserted = rows.find((row) => 'inserted_count' in row);
  if (!inserted) throw new Error('backfill script did not report inserted_count');
  return Number(inserted.inserted_count);
}

beforeAll(async () => {
  const now = new Date();
  await db.execute(`
    truncate table audit_events, delivery_confirmations, film_deliveries, filling_deliveries,
      film_supply_order_lines, filling_order_lines, film_supply_orders, filling_orders,
      seven_purchase_orders, pre_order_references, document_versions, documents,
      artwork_revisions, artwork_approval_events, evidence_manual_verifications,
      maker_po_events, maker_purchase_orders, commission_readiness,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  await db.insert(users).values({
    id: staffId,
    username: 'staff_backfill_script',
    passwordHash: 'not-a-login-hash',
    displayName: '合成バックフィル担当',
    role: 'staff'
  });
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成バックフィル顧客', role: 'end_customer', externalCode: 'BACKFILL-CUST' },
    { id: sevenAccountId, name: '合成バックフィルセブン', role: 'seven', externalCode: 'BACKFILL-SEVEN' },
    { id: makerAccountId, name: '合成バックフィルメーカー', role: 'maker', externalCode: 'BACKFILL-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'BACKFILL-SCRIPT',
    name: '合成バックフィル案件',
    businessUnit: 'F1' as const,
    route: 'F1' as const,
    leadSource: 'KANEI' as const,
    endCustomerAccountId: customerAccountId,
    sevenAccountId,
    makerAccountId,
    createdByUserId: staffId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(projectAssignments).values({ id: uuidv7(now), userId: staffId, projectId });
  await db.insert(filmSupplyOrders).values({
    id: orderId,
    projectId,
    code: 'FSO-BACKFILL-SCRIPT',
    status: 'DRAFT' as const,
    paymentTerms: 'undetermined',
    createdByUserId: staffId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  });
  await db.insert(filmSupplyOrderLines).values([
    {
      id: apiLineId,
      filmSupplyOrderId: orderId,
      lineNumber: 1,
      description: '既存API明細',
      orderedQuantity: '10.000',
      unit: 'rolls',
      createdAt: now,
      updatedAt: now
    },
    {
      id: missingLineId,
      filmSupplyOrderId: orderId,
      lineNumber: 2,
      description: 'レガシー明細',
      orderedQuantity: '20.000',
      unit: 'sheets',
      createdAt: now,
      updatedAt: now
    }
  ]);
  // This deliberately uses the API /lines operation marker, not the backfill
  // marker. The fixed script must treat any line-created event as sufficient.
  await db.insert(auditEvents).values({
    id: uuidv7(now),
    projectId,
    actorUserId: staffId,
    action: 'FILM_SUPPLY_ORDER_LINE_CREATED',
    entityType: 'film_supply_order_line',
    entityId: apiLineId,
    beforeState: null,
    afterState: {
      id: apiLineId,
      filmSupplyOrderId: orderId,
      lineNumber: 1,
      description: '既存API明細',
      orderedQuantity: '10.000',
      unit: 'rolls'
    },
    occurredAt: now,
    requestMetadata: { operation: 'film_order_line:create', filmSupplyOrderId: orderId }
  });
});

afterAll(async () => {
  await pool.end();
});

describe('film line backfill script (2026-11-19)', () => {
  it('skips lines that already have any API line-created audit event and inserts only true gaps', async () => {
    expect(await runBackfill()).toBe(1);

    const events = await db.select()
      .from(auditEvents)
      .where(and(
        eq(auditEvents.action, 'FILM_SUPPLY_ORDER_LINE_CREATED'),
        eq(auditEvents.entityType, 'film_supply_order_line')
      ));
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.entityId === apiLineId)).toHaveLength(1);
    expect(events.find((event) => event.entityId === apiLineId)?.requestMetadata)
      .toEqual({ operation: 'film_order_line:create', filmSupplyOrderId: orderId });
    const backfillEvent = events.find((event) => event.entityId === missingLineId);
    expect(backfillEvent?.actorUserId).toBeNull();
    expect(backfillEvent?.requestMetadata).toMatchObject({
      operation: 'film_order_line_backfill:2026-11-19',
      actor: 'system:film_order_line_backfill',
      sourceLineId: missingLineId
    });
  });

  it('is idempotent on rerun and creates no append-only duplicate groups', async () => {
    expect(await runBackfill()).toBe(0);

    const groups = await db.execute(`
      select entity_id, count(*)::int as count
      from audit_events
      where action = 'FILM_SUPPLY_ORDER_LINE_CREATED'
        and entity_type = 'film_supply_order_line'
      group by entity_id
      having count(*) <> 1
    `);
    expect(groups.rows).toEqual([]);
    const total = await db.select()
      .from(auditEvents)
      .where(and(
        eq(auditEvents.action, 'FILM_SUPPLY_ORDER_LINE_CREATED'),
        eq(auditEvents.entityType, 'film_supply_order_line')
      ));
    expect(total).toHaveLength(2);
  });

  it('keeps the main database fail-closed behind an explicit approval setting', async () => {
    const script = await readFile(scriptPath, 'utf8');
    expect(script).toContain("current_database() = 'kanei_crm_mvp'");
    expect(script).toContain('kanei.allow_main_backfill_20261119');
    expect(script).toContain("<> 'approved'");
    expect(script).toMatch(/RAISE EXCEPTION[\s\S]{0,200}refusing main DB backfill rerun/);
  });
});
