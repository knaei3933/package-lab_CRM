import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  createDatabase,
  uuidv7,
  accounts,
  auditEvents,
  commissionReadiness,
  documentVersions,
  documents,
  filmDeliveries,
  filmSupplyOrderLines,
  filmSupplyOrders,
  fillingDeliveries,
  fillingOrderLines,
  projectAssignments,
  projects,
  sevenPurchaseOrders,
  sessions,
  users
} from '@kanei/db';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../../apps/api/src/auth.js';

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();
const commissionProjectId = uuidv7();
let staffToken = '';

interface CreatedOrder {
  id: string;
  lines: { id: string; orderedQuantity: string; unit: string }[];
}

function firstLineId(order: CreatedOrder): string {
  const line = order.lines[0];
  if (!line) throw new Error('order was created without its first line');
  return line.id;
}

function cookieHeader(token: string) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

function jsonPost(token: string, body: unknown) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookieHeader(token) },
    body: JSON.stringify(body)
  } as const;
}

async function fetchCounts() {
  const result = await db.execute(sql`
    select
      (select count(*) from film_supply_orders)::int as film_orders,
      (select count(*) from film_supply_order_lines)::int as film_lines,
      (select count(*) from film_deliveries)::int as film_deliveries,
      (select count(*) from filling_orders)::int as filling_orders,
      (select count(*) from filling_order_lines)::int as filling_lines,
      (select count(*) from filling_deliveries)::int as filling_deliveries,
      (select count(*) from commission_readiness)::int as commission_rows,
      (select count(*) from seven_purchase_orders)::int as seven_pos,
      (select count(*) from pre_order_references)::int as pre_orders,
      (select count(*) from audit_events)::int as audit_events
  `);
  return result.rows[0] as {
    film_orders: number;
    film_lines: number;
    film_deliveries: number;
    filling_orders: number;
    filling_lines: number;
    filling_deliveries: number;
    commission_rows: number;
    seven_pos: number;
    pre_orders: number;
    audit_events: number;
  };
}

async function createSession(userId: string, expiresAt = new Date(Date.now() + 60 * 60 * 1000)) {
  const { token, tokenHash } = issueToken();
  await db.insert(sessions).values({ id: uuidv7(), userId, tokenHash, expiresAt });
  return token;
}

async function createFilmOrder(
  app: ReturnType<typeof createApp>,
  code: string,
  unit: string,
  orderedQuantity: number,
  sevenPurchaseOrderId?: string,
  projectIdValue: string = projectId
): Promise<CreatedOrder> {
  const response = await app.request(
    `/api/projects/${projectIdValue}/film-supply-orders`,
    jsonPost(staffToken, {
      code,
      sevenPurchaseOrderId,
      lines: [{ lineNumber: 1, description: '合成フィルム', orderedQuantity, unit }]
    })
  );
  expect(response.status).toBe(201);
  return await response.json();
}

async function createFillingOrder(
  app: ReturnType<typeof createApp>,
  code: string,
  unit: string,
  orderedQuantity: number,
  projectIdValue: string = projectId
): Promise<CreatedOrder> {
  const response = await app.request(
    `/api/projects/${projectIdValue}/filling-orders`,
    jsonPost(staffToken, {
      code,
      lines: [{ lineNumber: 1, description: '合成充填材', orderedQuantity, unit }]
    })
  );
  expect(response.status).toBe(201);
  return await response.json();
}

/**
 * M5 (T-36): composite verified delivery evidence. The evidence document is
 * inserted directly so this M1 readiness test stays focused on the readiness
 * contract; the M5 suite exercises the real upload + verify + confirm flow.
 */
async function insertVerifiedDeliveryEvidence(
  projectIdValue: string,
  poId: string,
  filmSupplyOrderId: string | null,
  filename: string
): Promise<string> {
  const now = new Date();
  const documentId = uuidv7(now);
  const versionId = uuidv7(now);
  await db.insert(documents).values({
    id: documentId,
    projectId: projectIdValue,
    documentType: 'acceptance_evidence',
    issuerEntity: 'kanei',
    originalFilename: filename,
    sevenPurchaseOrderId: poId,
    filmSupplyOrderId,
    verificationStatus: 'verified',
    verifiedByUserId: staffId,
    verifiedAt: now,
    verificationNote: '合成納品確認（M1準備テスト用）',
    createdByUserId: staffId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(documentVersions).values({
    id: versionId,
    documentId,
    versionNumber: 1,
    sha256: Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''),
    byteSize: 32,
    storagePath: `/composite/m1/${filename}`,
    originalFilename: filename,
    declaredMimeType: 'text/plain',
    sizeCheckPassed: true,
    typeCheckPassed: true,
    createdByUserId: staffId,
    createdAt: now
  });
  return versionId;
}

beforeAll(async () => {
  await db.execute(sql`
    truncate table audit_events, project_assignments, projects, sessions, accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'admin_m1_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者M1', role: 'admin' },
    { id: staffId, username: 'staff_m1_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者M1', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成M1エンドカスタマー', role: 'end_customer', externalCode: 'TEST-M1-CUST' },
    { id: sevenAccountId, name: '合成M1セブン', role: 'seven', externalCode: 'TEST-M1-SEVEN' },
    { id: makerAccountId, name: '合成M1メーカー', role: 'maker', externalCode: 'TEST-M1-MAKER' }
  ]);
  const projectValues = [
    { projectId, code: 'TEST-M1-BASE' },
    { projectId: commissionProjectId, code: 'TEST-M1-COMMISSION' }
  ].map(({ projectId: id, code }) => ({
    id,
    code,
    name: '合成M1案件',
    businessUnit: 'F1' as const,
    route: 'F1' as const,
    leadSource: 'KANEI',
    status: 'DRAFT' as const,
    endCustomerAccountId: customerAccountId,
    sevenAccountId,
    makerAccountId,
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now
  }));
  await db.insert(projects).values(projectValues);
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: staffId, projectId },
    { id: uuidv7(now), userId: staffId, projectId: commissionProjectId }
  ]);
  staffToken = await createSession(staffId);
});

afterAll(async () => {
  await pool.end();
});

describe('M1 transaction structure', () => {
  it('T-14 recording a film delivery creates no filling delivery and no commission rows', async () => {
    const app = createApp({ db });
    const order = await createFilmOrder(app, 'TEST-M1-FILM-T14', 'rolls', 12000);
    const before = await fetchCounts();

    const response = await app.request(
      `/api/film-supply-orders/${order.id}/deliveries`,
      jsonPost(staffToken, {
        filmSupplyOrderLineId: firstLineId(order),
        deliveredQuantity: 8000,
        unit: 'rolls',
        carrierReference: '合成配送T14'
      })
    );
    expect(response.status).toBe(201);

    const after = await fetchCounts();
    expect(after.film_deliveries).toBe(before.film_deliveries + 1);
    expect(after.filling_deliveries).toBe(before.filling_deliveries);
    expect(after.filling_lines).toBe(before.filling_lines);
    expect(after.filling_orders).toBe(before.filling_orders);
    expect(after.commission_rows).toBe(before.commission_rows);
    // The delivery and its audit row are written together in one transaction.
    expect(after.audit_events).toBe(before.audit_events + 1);

    const delivery = await response.json();
    expect(delivery.deliveredQuantity).toBe('8000.000');
    expect(delivery.unit).toBe('rolls');
    const [row] = await db.select().from(filmDeliveries).where(eq(filmDeliveries.id, delivery.id)).limit(1);
    expect(row?.filmSupplyOrderLineId).toBe(firstLineId(order));
    expect(row?.deliveredQuantity).toBe('8000.000');
    const [audit] = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.entityType, 'film_delivery'), eq(auditEvents.entityId, delivery.id)))
      .limit(1);
    expect(audit?.action).toBe('FILM_DELIVERY_RECORDED');
  });

  it('T-15 persists 95000 delivered against 100000 ordered without overwriting the ordered quantity', async () => {
    const app = createApp({ db });
    const order = await createFillingOrder(app, 'TEST-M1-FILL-T15', 'pods', 100000);
    const lineId = firstLineId(order);

    const response = await app.request(
      `/api/filling-orders/${order.id}/deliveries`,
      jsonPost(staffToken, {
        fillingOrderLineId: lineId,
        deliveredQuantity: 95000,
        unit: 'pods'
      })
    );
    expect(response.status).toBe(201);
    const delivery = await response.json();
    expect(delivery.deliveredQuantity).toBe('95000.000');
    expect(delivery.unit).toBe('pods');

    const rows = await db.select().from(fillingDeliveries)
      .where(eq(fillingDeliveries.fillingOrderLineId, lineId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deliveredQuantity).toBe('95000.000');

    // The ordered quantity is reference data: 95000 lives only in filling_deliveries.
    const [line] = await db.select().from(fillingOrderLines).where(eq(fillingOrderLines.id, lineId)).limit(1);
    if (!line) throw new Error('filling order line row not found');
    expect(line.orderedQuantity).toBe('100000.000');
    expect(Object.keys(line)).not.toContain('deliveredQuantity');
    expect(Object.keys(line)).not.toContain('remainingQuantity');
  });

  it('T-16 rejects film/filling unit mixing with 422 and zero persistence', async () => {
    const app = createApp({ db });
    const filmOrder = await createFilmOrder(app, 'TEST-M1-FILM-T16', 'meters', 500);
    const fillingOrder = await createFillingOrder(app, 'TEST-M1-FILL-T16', 'pieces', 50000);
    const before = await fetchCounts();

    const filmDeliveryWrongUnit = await app.request(
      `/api/film-supply-orders/${filmOrder.id}/deliveries`,
      jsonPost(staffToken, {
        filmSupplyOrderLineId: firstLineId(filmOrder),
        deliveredQuantity: 100,
        unit: 'pods'
      })
    );
    expect(filmDeliveryWrongUnit.status).toBe(422);
    expect((await filmDeliveryWrongUnit.json()).code).toBe('UNIT_DOMAIN_MISMATCH');

    const filmLineWrongUnit = await app.request(
      `/api/film-supply-orders/${filmOrder.id}/lines`,
      jsonPost(staffToken, { lineNumber: 2, description: '合成フィルム', orderedQuantity: 10, unit: 'pieces' })
    );
    expect(filmLineWrongUnit.status).toBe(422);

    const fillingLineWrongUnit = await app.request(
      `/api/filling-orders/${fillingOrder.id}/lines`,
      jsonPost(staffToken, { lineNumber: 2, description: '合成充填材', orderedQuantity: 10, unit: 'rolls' })
    );
    expect(fillingLineWrongUnit.status).toBe(422);

    const fillingDeliveryWrongUnit = await app.request(
      `/api/filling-orders/${fillingOrder.id}/deliveries`,
      jsonPost(staffToken, {
        fillingOrderLineId: firstLineId(fillingOrder),
        deliveredQuantity: 1000,
        unit: 'sheets'
      })
    );
    expect(fillingDeliveryWrongUnit.status).toBe(422);

    expect(await fetchCounts()).toEqual(before);
  });

  it('T-17 split deliveries append rows and never overwrite a recorded quantity', async () => {
    const app = createApp({ db });
    const order = await createFillingOrder(app, 'TEST-M1-FILL-T17', 'pods', 100000);
    const lineId = firstLineId(order);
    const before = await fetchCounts();

    const first = await app.request(
      `/api/filling-orders/${order.id}/deliveries`,
      jsonPost(staffToken, { fillingOrderLineId: lineId, deliveredQuantity: 30000, unit: 'pods' })
    );
    const second = await app.request(
      `/api/filling-orders/${order.id}/deliveries`,
      jsonPost(staffToken, { fillingOrderLineId: lineId, deliveredQuantity: 65000, unit: 'pods' })
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const after = await fetchCounts();
    expect(after.filling_deliveries).toBe(before.filling_deliveries + 2);
    expect(after.audit_events).toBe(before.audit_events + 2);

    const rows = await db.select().from(fillingDeliveries)
      .where(eq(fillingDeliveries.fillingOrderLineId, lineId))
      .orderBy(fillingDeliveries.deliverySequence);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.deliveredQuantity)).toEqual(['30000.000', '65000.000']);
    expect(rows.map((row) => row.deliverySequence)).toEqual([1, 2]);

    const [line] = await db.select().from(fillingOrderLines).where(eq(fillingOrderLines.id, lineId)).limit(1);
    if (!line) throw new Error('filling order line row not found');
    expect(line.orderedQuantity).toBe('100000.000');

    const firstRow = rows[0];
    if (!firstRow) throw new Error('split delivery rows not found');

    // Appending is the only write: overwriting or deleting a recorded quantity
    // is rejected at the database level.
    await expect(db.update(fillingDeliveries)
      .set({ deliveredQuantity: '95000.000' })
      .where(eq(fillingDeliveries.id, firstRow.id))).rejects.toThrow();
    await expect(db.delete(fillingDeliveries).where(eq(fillingDeliveries.id, firstRow.id))).rejects.toThrow();
  });

  it('the SEVEN_PO_VERIFIED gate reads official_registered_at only; original_received_at is reference-only', async () => {
    const app = createApp({ db });
    const poResponse = await app.request(
      `/api/projects/${projectId}/seven-purchase-orders`,
      jsonPost(staffToken, { poNumber: 'SEVEN-M1-DATE-1', originalReceivedAt: '2026-11-01T00:00:00.000Z' })
    );
    expect(poResponse.status).toBe(201);
    const po = await poResponse.json();
    expect(po.originalReceivedAt).not.toBeNull();
    expect(po.officialRegisteredAt).toBeNull();

    const order = await createFilmOrder(app, 'TEST-M1-FILM-DATE', 'sheets', 200, po.id);

    const rejected = await app.request(
      `/api/film-supply-orders/${order.id}/transitions`,
      jsonPost(staffToken, { to: 'SEVEN_PO_VERIFIED' })
    );
    expect(rejected.status).toBe(422);
    expect((await rejected.json()).code).toBe('OFFICIAL_REGISTRATION_REQUIRED');

    const [stillDraft] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.id)).limit(1);
    expect(stillDraft?.status).toBe('DRAFT');

    const registerResponse = await app.request(
      `/api/seven-purchase-orders/${po.id}/register-official`,
      jsonPost(staffToken, { officialRegisteredAt: '2026-11-03T00:00:00.000Z' })
    );
    expect(registerResponse.status).toBe(200);

    const approved = await app.request(
      `/api/film-supply-orders/${order.id}/transitions`,
      jsonPost(staffToken, { to: 'SEVEN_PO_VERIFIED' })
    );
    expect(approved.status).toBe(200);
    expect((await approved.json()).status).toBe('SEVEN_PO_VERIFIED');

    const [transitionAudit] = await db.select().from(auditEvents)
      .where(and(
        eq(auditEvents.entityType, 'film_supply_order'),
        eq(auditEvents.action, 'FILM_SUPPLY_ORDER_TRANSITIONED')
      ))
      .limit(1);
    expect(transitionAudit?.afterState).toEqual({ status: 'SEVEN_PO_VERIFIED' });
  });

  it('rejects invalid film supply order transitions with 422 and no state change', async () => {
    const app = createApp({ db });
    const order = await createFilmOrder(app, 'TEST-M1-FILM-TRANS', 'rolls', 100);
    const before = await fetchCounts();

    const skippedTransition = await app.request(
      `/api/film-supply-orders/${order.id}/transitions`,
      jsonPost(staffToken, { to: 'FILM_SHIPPED' })
    );
    expect(skippedTransition.status).toBe(422);
    expect((await skippedTransition.json()).code).toBe('INVALID_TRANSITION');

    const unknown = await app.request(
      `/api/film-supply-orders/${order.id}/transitions`,
      jsonPost(staffToken, { to: 'SOMewhere else' })
    );
    expect(unknown.status).toBe(422);
    expect((await unknown.json()).code).toBe('UNKNOWN_STATE');

    expect(await fetchCounts()).toEqual(before);
  });

  it('audit_events keep the M0 append-only pattern', async () => {
    const app = createApp({ db });
    const order = await createFilmOrder(app, 'TEST-M1-FILM-AUDIT', 'meters', 50);
    const [audit] = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.entityType, 'film_supply_order'), eq(auditEvents.entityId, order.id)))
      .limit(1);
    if (!audit) throw new Error('audit row for film supply order not found');
    expect(audit.action).toBe('FILM_SUPPLY_ORDER_CREATED');

    await expect(db.update(auditEvents)
      .set({ action: 'TAMPERED' })
      .where(eq(auditEvents.id, audit.id))).rejects.toThrow();
    await expect(db.delete(auditEvents).where(eq(auditEvents.id, audit.id))).rejects.toThrow();
  });

  it('commission readiness is evaluated explicitly and only becomes ready with film + filling + official PO', async () => {
    const app = createApp({ db });
    const url = `/api/projects/${commissionProjectId}/commission-readiness`;

    const initial = await app.request(url, jsonPost(staffToken, {}));
    expect(initial.status).toBe(201);
    const initialRow = await initial.json();
    expect(initialRow).toMatchObject({
      filmDeliveryRecorded: false,
      fillingDeliveryRecorded: false,
      sevenPoOfficiallyRegistered: false,
      isReady: false
    });
    expect(initialRow.readyAt).toBeNull();

    const fillingOrder = await createFillingOrder(app, 'TEST-M1-FILL-COMMISSION', 'pods', 10000, commissionProjectId);
    const fillingDeliveryResponse = await app.request(
      `/api/filling-orders/${fillingOrder.id}/deliveries`,
      jsonPost(staffToken, { fillingOrderLineId: firstLineId(fillingOrder), deliveredQuantity: 9000, unit: 'pods' })
    );
    expect(fillingDeliveryResponse.status).toBe(201);
    const fillingDelivery = await fillingDeliveryResponse.json();
    const poResponse = await app.request(
      `/api/projects/${commissionProjectId}/seven-purchase-orders`,
      jsonPost(staffToken, { poNumber: 'SEVEN-M1-COMMISSION-1', officialRegisteredAt: '2026-11-04T00:00:00.000Z' })
    );
    expect(poResponse.status).toBe(201);
    const po = await poResponse.json();

    const partial = await app.request(url, jsonPost(staffToken, {}));
    expect(partial.status).toBe(201);
    expect(await partial.json()).toMatchObject({
      filmDeliveryRecorded: false,
      fillingDeliveryRecorded: true,
      sevenPoOfficiallyRegistered: true,
      isReady: false
    });

    const filmOrder = await createFilmOrder(app, 'TEST-M1-FILM-COMMISSION', 'rolls', 300, undefined, commissionProjectId);
    const filmDeliveryResponse = await app.request(
      `/api/film-supply-orders/${filmOrder.id}/deliveries`,
      jsonPost(staffToken, { filmSupplyOrderLineId: firstLineId(filmOrder), deliveredQuantity: 300, unit: 'rolls' })
    );
    expect(filmDeliveryResponse.status).toBe(201);
    const filmDelivery = await filmDeliveryResponse.json();

    // M5 (T-36): recorded deliveries escalate nothing on their own — both are
    // pending confirmation here, so the explicit evaluation must stay below
    // READY even though film + filling + official PO are all in place.
    const unevidenced = await app.request(url, jsonPost(staffToken, {}));
    expect(unevidenced.status).toBe(201);
    expect(await unevidenced.json()).toMatchObject({
      filmDeliveryRecorded: true,
      fillingDeliveryRecorded: true,
      readinessState: 'PENDING_VERIFICATION',
      isReady: false
    });

    const fillingEvidenceVersionId = await insertVerifiedDeliveryEvidence(
      commissionProjectId,
      po.id,
      null,
      'm1-filling-delivery-evidence.txt'
    );
    const fillingConfirmation = await app.request(
      `/api/filling-deliveries/${fillingDelivery.id}/confirmation`,
      jsonPost(staffToken, { evidenceDocumentVersionId: fillingEvidenceVersionId })
    );
    expect(fillingConfirmation.status).toBe(201);

    const filmEvidenceVersionId = await insertVerifiedDeliveryEvidence(
      commissionProjectId,
      po.id,
      filmOrder.id,
      'm1-film-delivery-evidence.txt'
    );
    const filmConfirmation = await app.request(
      `/api/film-deliveries/${filmDelivery.id}/confirmation`,
      jsonPost(staffToken, { evidenceDocumentVersionId: filmEvidenceVersionId })
    );
    expect(filmConfirmation.status).toBe(201);

    const ready = await app.request(url, jsonPost(staffToken, {}));
    expect(ready.status).toBe(201);
    const readyRow = await ready.json();
    expect(readyRow).toMatchObject({
      filmDeliveryRecorded: true,
      fillingDeliveryRecorded: true,
      sevenPoOfficiallyRegistered: true,
      filmDeliveryConfirmed: true,
      fillingDeliveryConfirmed: true,
      readinessState: 'READY',
      isReady: true
    });
    expect(readyRow.readyAt).not.toBeNull();

    const rows = await db.select().from(commissionReadiness)
      .where(eq(commissionReadiness.projectId, commissionProjectId));
    expect(rows).toHaveLength(1);

    const [audit] = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.entityType, 'commission_readiness'), eq(auditEvents.action, 'COMMISSION_READINESS_EVALUATED')))
      .limit(1);
    expect(audit).toBeDefined();
  });

  it('promoting a pre-order reference stamps promoted_at and promoted_by', async () => {
    const app = createApp({ db });
    const referenceResponse = await app.request(
      `/api/projects/${projectId}/pre-order-references`,
      jsonPost(staffToken, { referenceCode: 'PRE-M1-0001', note: '合成先行発注', originalReceivedAt: '2026-10-20T00:00:00.000Z' })
    );
    expect(referenceResponse.status).toBe(201);
    const reference = await referenceResponse.json();

    const promoteResponse = await app.request(
      `/api/pre-order-references/${reference.id}/promote`,
      jsonPost(staffToken, { poNumber: 'SEVEN-M1-PROMOTED-1' })
    );
    expect(promoteResponse.status).toBe(201);
    const promoted = await promoteResponse.json();
    expect(promoted.preOrderReferenceId).toBe(reference.id);
    expect(promoted.promotedAt).not.toBeNull();
    expect(promoted.officialRegisteredAt).toBeNull();

    const [row] = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, promoted.id)).limit(1);
    if (!row) throw new Error('promoted seven purchase order row not found');
    expect(row.promotedAt).not.toBeNull();
    expect(row.promotedByUserId).toBe(staffId);
    expect(row.originalReceivedAt).not.toBeNull();
    expect(row.officialRegisteredAt).toBeNull();
  });
});
