import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  accounts,
  createDatabase,
  filmSupplyOrders,
  makerPurchaseOrders,
  projects,
  sevenPurchaseOrders,
  users,
  uuidv7
} from '@kanei/db';
import { buildMakerPoSnapshot, computeMakerPoSnapshotSha256 } from '@kanei/core';

/**
 * M8-HARDEN3 (0020): the B2 creation gate as a BEFORE INSERT trigger, verified
 * at the database level on the isolated test DB. The trigger uses exactly the
 * 0018 index predicate (deleted_at IS NULL AND status <> 'CANCELLED'), so the
 * two backstops agree on every edge: the trigger rejects every insert the
 * index rejects and passes every insert the index passes — the soft-delete and
 * status edges included.
 */

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl.includes('kanei_crm_mvp_test')) {
  throw new Error('0020 trigger tests require DATABASE_URL to name the kanei_crm_mvp_test database');
}

const { db, pool } = createDatabase(databaseUrl);

const staffId = uuidv7();
const endCustomerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();

const RUN = Date.now().toString(36);

/** The snapshotSha256 CHECK (`^[0-9a-f]{64}$`) needs a real canonical digest. */
function makerPoSnapshot(orderId: string, orderCode: string) {
  return buildMakerPoSnapshot({
    order: { id: orderId, code: orderCode, sevenPoNumber: null },
    items: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: '100000.000', unit: 'sheets' }],
    artworkFiles: [{ designKey: 'label-front', revisionNo: 1, fileSha256: 'a'.repeat(64) }],
    amounts: { currency: 'JPY', totalAmount: '480000' },
    recipientAddress: 'maker-po@example.com'
  });
}

function makerPoRow(
  orderId: string,
  orderCode: string,
  overrides: Partial<typeof makerPurchaseOrders.$inferInsert> = {}
) {
  const now = new Date();
  const snapshot = makerPoSnapshot(orderId, orderCode);
  return {
    id: uuidv7(now),
    filmSupplyOrderId: orderId,
    snapshot,
    snapshotSha256: computeMakerPoSnapshotSha256(snapshot),
    status: 'DRAFT' as const,
    ceoApprovedByUserId: null,
    ceoApprovedAt: null,
    deletedAt: null,
    createdByUserId: staffId,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

/** One supply order per test: B2 cases never share a slot, never collide on unique codes. */
async function createSupplyOrder(tag: string): Promise<string> {
  const now = new Date();
  const sevenPoId = uuidv7(now);
  const orderId = uuidv7(now);
  await db.insert(sevenPurchaseOrders).values({
    id: sevenPoId,
    projectId,
    poNumber: `SEVEN-0020-${RUN}-${tag}`,
    officialRegisteredAt: now,
    createdByUserId: staffId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(filmSupplyOrders).values({
    id: orderId,
    projectId,
    code: `FSO-0020-${RUN}-${tag}`,
    status: 'MAKER_PO_READY',
    sevenPurchaseOrderId: sevenPoId,
    createdByUserId: staffId,
    createdAt: now,
    updatedAt: now
  });
  return orderId;
}

/** Walks drizzle's error cause chain for the pg driver error. */
function pgErrorOf(error: unknown): { code?: string; message?: string; constraint?: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown; constraint?: unknown };
    if (candidate.code === '23505') return candidate as { code?: string; message?: string; constraint?: string };
    current = candidate.cause;
  }
  return {};
}

describe('M8-HARDEN3 0020: the B2 creation gate as a BEFORE INSERT trigger', () => {
  beforeAll(async () => {
    const now = new Date();
    await db.insert(users).values({
      id: staffId,
      username: `0020-trigger-${RUN}`,
      passwordHash: 'x'.repeat(64),
      displayName: '0020 trigger fixtures',
      role: 'staff',
      createdAt: now,
      updatedAt: now
    });
    await db.insert(accounts).values([
      { id: endCustomerAccountId, name: `0020 trigger customer ${RUN}`, role: 'end_customer', createdAt: now, updatedAt: now },
      { id: sevenAccountId, name: `0020 trigger seven ${RUN}`, role: 'seven', createdAt: now, updatedAt: now },
      { id: makerAccountId, name: `0020 trigger maker ${RUN}`, role: 'maker', createdAt: now, updatedAt: now }
    ]);
  });

  beforeAll(async () => {
    const now = new Date();
    await db.insert(projects).values({
      id: projectId,
      code: `PRJ-0020-${RUN}`,
      name: '0020 trigger project',
      businessUnit: 'F1',
      route: 'F1',
      leadSource: 'KANEI',
      status: 'DRAFT',
      endCustomerAccountId,
      sevenAccountId,
      makerAccountId,
      createdByUserId: staffId,
      createdAt: now,
      updatedAt: now
    });
  });

  it('rejects the second active maker PO for one order — the trigger fires, not just the index', async () => {
    const orderId = await createSupplyOrder('a');
    const first = makerPoRow(orderId, `FSO-0020-${RUN}-0001`);
    await db.insert(makerPurchaseOrders).values(first);
    const second = makerPoRow(orderId, `FSO-0020-${RUN}-0001`);
    const failure = await db.insert(makerPurchaseOrders).values(second).then(
      () => null,
      (error) => error
    );
    expect(failure).toBeTruthy();
    const pg = pgErrorOf(failure);
    expect(pg.code).toBe('23505');
    // The custom message proves the TRIGGER fired: the 0018 index refusal is a
    // generic duplicate-key error naming the constraint, while the trigger
    // names the rule and the paper holding the slot.
    expect(pg.message).toContain('one active maker PO per film supply order (B2)');
    expect(pg.message).toContain(first.id);
    // No constraint name on a trigger RAISE — exactly the error shape the API's
    // makerPoActiveUniqueViolation fallback maps to 422 MAKER_PO_ALREADY_EXISTS.
    expect(pg.constraint).toBeUndefined();
    expect(await db.select({ id: makerPurchaseOrders.id }).from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, second.id))).toHaveLength(0);
  });

  it('passes a CANCELLED paper beside an active paper (history holds no slot)', async () => {
    const orderId = await createSupplyOrder('b');
    await db.insert(makerPurchaseOrders).values(makerPoRow(orderId, `FSO-0020-${RUN}-0002`));
    await db.insert(makerPurchaseOrders).values(
      makerPoRow(orderId, `FSO-0020-${RUN}-0002`, { status: 'CANCELLED' })
    );
    const rows = await db.select({ status: makerPurchaseOrders.status })
      .from(makerPurchaseOrders).where(eq(makerPurchaseOrders.filmSupplyOrderId, orderId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual(['CANCELLED', 'DRAFT']);
  });

  it('passes a soft-deleted paper beside an active paper (the 0018 soft-delete edge)', async () => {
    const orderId = await createSupplyOrder('c');
    await db.insert(makerPurchaseOrders).values(makerPoRow(orderId, `FSO-0020-${RUN}-0003`));
    await db.insert(makerPurchaseOrders).values(
      makerPoRow(orderId, `FSO-0020-${RUN}-0003`, { deletedAt: new Date() })
    );
    const rows = await db.select({ deletedAt: makerPurchaseOrders.deletedAt })
      .from(makerPurchaseOrders).where(eq(makerPurchaseOrders.filmSupplyOrderId, orderId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.deletedAt !== null)).toHaveLength(1);
  });

  it('still freezes replacement paper after a cancel (INSERT-only trigger, UPDATE path untouched)', async () => {
    const orderId = await createSupplyOrder('d');
    const active = makerPoRow(orderId, `FSO-0020-${RUN}-0004`);
    await db.insert(makerPurchaseOrders).values(active);
    await db.update(makerPurchaseOrders).set({ status: 'CANCELLED', updatedAt: new Date() })
      .where(eq(makerPurchaseOrders.id, active.id));
    await db.insert(makerPurchaseOrders).values(makerPoRow(orderId, `FSO-0020-${RUN}-0004`));
    const rows = await db.select({ status: makerPurchaseOrders.status })
      .from(makerPurchaseOrders).where(eq(makerPurchaseOrders.filmSupplyOrderId, orderId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual(['CANCELLED', 'DRAFT']);
  });

  it('still refuses when the occupier is SEND_UNVERIFIED (same predicate as the 0018 index)', async () => {
    const orderId = await createSupplyOrder('e');
    await db.insert(makerPurchaseOrders).values(
      makerPoRow(orderId, `FSO-0020-${RUN}-0005`, {
        status: 'SEND_UNVERIFIED',
        ceoApprovedByUserId: staffId,
        ceoApprovedAt: new Date()
      })
    );
    const second = makerPoRow(orderId, `FSO-0020-${RUN}-0005`);
    const failure = await db.insert(makerPurchaseOrders).values(second).then(
      () => null,
      (error) => error
    );
    expect(failure).toBeTruthy();
    const pg = pgErrorOf(failure);
    expect(pg.code).toBe('23505');
    expect(pg.message).toContain('one active maker PO per film supply order (B2)');
    expect(await db.select({ id: makerPurchaseOrders.id }).from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, second.id))).toHaveLength(0);
  });

  afterAll(async () => {
    await pool.end();
  });
});
