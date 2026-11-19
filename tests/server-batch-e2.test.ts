import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import {
  accounts,
  createDatabase,
  filmSupplyOrderLines,
  filmSupplyOrders,
  filmDeliveries,
  fillingDeliveries,
  fillingOrderLines,
  fillingOrders,
  projectAssignments,
  projects,
  sevenPurchaseOrders,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';
import { buildAuditViewForRole, type AuditHistoryRow } from '../apps/api/src/audit-view.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('server-batch-e2 tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);

const staffId = uuidv7();
const viewerId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();
const sevenPoId = uuidv7();
let staffToken = '';
let viewerToken = '';
let app: ReturnType<typeof createApp>;

function cookie(token: string) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

async function requestAs(token: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  const response = await app.request(url, {
    method,
    headers: { 'content-type': 'application/json', ...cookie(token) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

async function createSession(userId: string) {
  const { token, tokenHash } = issueToken();
  await db.insert(sessions).values({
    id: uuidv7(), userId, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  });
  return token;
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(`${os.tmpdir()}/kanei-batch-e2-`);
  app = createApp({ db });
  const now = new Date();
  await db.execute(sql`
    truncate table audit_events, delivery_confirmations, film_deliveries, filling_deliveries,
      film_supply_order_lines, filling_order_lines, film_supply_orders, filling_orders,
      seven_purchase_orders, pre_order_references, document_versions, documents,
      artwork_revisions, artwork_approval_events, evidence_manual_verifications,
      maker_po_events, maker_purchase_orders, commission_readiness,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  await db.insert(users).values([
    { id: staffId, username: 'staff_batch_e2', passwordHash: 'not-a-login-hash', displayName: '合成担当者E2', role: 'staff' },
    { id: viewerId, username: 'viewer_batch_e2', passwordHash: 'not-a-login-hash', displayName: '合成閲覧者E2', role: 'viewer' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成E2顧客', role: 'end_customer', externalCode: 'E2-CUST' },
    { id: sevenAccountId, name: '合成E2セブン', role: 'seven', externalCode: 'E2-SEVEN' },
    { id: makerAccountId, name: '合成E2メーカー', role: 'maker', externalCode: 'E2-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'E2-PROJECT',
    name: '合成E2案件',
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
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: staffId, projectId },
    { id: uuidv7(now), userId: viewerId, projectId }
  ]);
  staffToken = await createSession(staffId);
  viewerToken = await createSession(viewerId);
});

afterAll(async () => {
  await pool.end();
});

describe('server batch E follow-ups', () => {
  it('emits the F-00 line contract from Seven-PO-bound order creation and rejects a mismatched delivery unit', async () => {
    const now = new Date();
    await db.insert(sevenPurchaseOrders).values({
      id: sevenPoId,
      projectId,
      poNumber: 'SEVEN-E2-001',
      officialRegisteredAt: now,
      promotedAt: now,
      promotedByUserId: staffId,
      verificationStatus: 'verified' as const,
      verifiedAt: now,
      verifiedByUserId: staffId,
      verificationNote: '合成E2確認',
      createdByUserId: staffId,
      createdAt: now,
      updatedAt: now
    });

    const created = await requestAs(staffToken, 'POST', `/api/seven-purchase-orders/${sevenPoId}/supply-orders`, {
      code: 'FSO-E2-SUPPLY-001',
      lines: [{ lineNumber: 1, description: '合成フィルムE2', orderedQuantity: 10, unit: 'rolls' }]
    });
    expect(created.status).toBe(201);
    const orderId = (created.body as { id: string }).id;
    const lineId = (created.body as { lines: Array<{ id: string; unit: string }> }).lines[0]!.id;

    const staffAudit = await requestAs(staffToken, 'GET', `/api/projects/${projectId}/audit-history?entityType=film_supply_order_line`);
    expect(staffAudit.status).toBe(200);
    const events = (staffAudit.body as { events: Array<{ action: string; requestMetadata: Record<string, unknown> | null; afterState: Record<string, unknown> | null }> }).events;
    const lineEvents = events.filter((event) => event.action === 'FILM_SUPPLY_ORDER_LINE_CREATED');
    expect(lineEvents).toHaveLength(1);
    // Staff metadata remains operation-only; the event body identifies the line.
    expect(lineEvents[0]!.requestMetadata).toEqual({ operation: 'supply_order:create' });
    expect(lineEvents[0]!.afterState).toMatchObject({
      id: lineId,
      filmSupplyOrderId: orderId,
      lineNumber: 1,
      unit: 'rolls'
    });

    const viewerAudit = await requestAs(viewerToken, 'GET', `/api/projects/${projectId}/audit-history?entityType=film_supply_order_line`);
    expect(viewerAudit.status).toBe(200);
    const viewerLine = (viewerAudit.body as { events: Array<{ afterState: Record<string, unknown> | undefined }> }).events[0]!;
    expect(viewerLine.afterState).toBeUndefined();

    const mismatched = await requestAs(staffToken, 'POST', `/api/film-supply-orders/${orderId}/deliveries`, {
      filmSupplyOrderLineId: lineId,
      deliveredQuantity: 1,
      unit: 'sheets'
    });
    expect(mismatched.status).toBe(422);
    expect(mismatched.body).toMatchObject({ code: 'DELIVERY_UNIT_MISMATCH' });
    expect((mismatched.body as { error: string }).error).toContain('rolls');
    expect(await db.select().from(filmDeliveries).where(eq(filmDeliveries.filmSupplyOrderId, orderId))).toHaveLength(0);
  });

  it('rejects filling delivery unit mismatches before persistence', async () => {
    const now = new Date();
    const orderId = uuidv7(now);
    const lineId = uuidv7(now);
    await db.insert(fillingOrders).values({
      id: orderId,
      projectId,
      code: 'FILLO-E2-001',
      createdByUserId: staffId,
      createdAt: now,
      updatedAt: now
    });
    await db.insert(fillingOrderLines).values({
      id: lineId,
      fillingOrderId: orderId,
      lineNumber: 1,
      description: '合成充填E2',
      orderedQuantity: '20.000',
      unit: 'pods',
      createdAt: now,
      updatedAt: now
    });

    const mismatched = await requestAs(staffToken, 'POST', `/api/filling-orders/${orderId}/deliveries`, {
      fillingOrderLineId: lineId,
      deliveredQuantity: 2,
      unit: 'pieces'
    });
    expect(mismatched.status).toBe(422);
    expect(mismatched.body).toMatchObject({ code: 'DELIVERY_UNIT_MISMATCH' });
    expect((mismatched.body as { error: string }).error).toContain('pods');
    expect(await db.select().from(fillingDeliveries).where(eq(fillingDeliveries.fillingOrderId, orderId))).toHaveLength(0);
  });

  it('staff sees business document identity while viewer still sees only lifecycle/readiness state', () => {
    const documentRow: AuditHistoryRow = {
      id: 'document-event-1',
      action: 'DOCUMENT_VERSION_UPLOADED',
      entityType: 'document_version',
      entityId: 'version-1',
      beforeState: null,
      afterState: {
        id: 'version-1',
        documentId: 'document-1',
        versionNumber: 2,
        documentType: 'approval_evidence',
        originalFilename: 'approval-evidence.eml',
        sha256: 'a'.repeat(64),
        storagePath: '/private/evidence',
        byteSize: 1234
      },
      occurredAt: new Date('2026-11-19T09:00:00.000Z'),
      requestMetadata: { operation: 'document:create' },
      actor: null
    };
    const staff = buildAuditViewForRole('staff', [documentRow])[0]!;
    expect(staff.afterState).toMatchObject({
      id: 'version-1',
      documentId: 'document-1',
      documentType: 'approval_evidence',
      originalFilename: 'approval-evidence.eml'
    });
    expect(staff.afterState).not.toHaveProperty('sha256');
    expect(staff.afterState).not.toHaveProperty('storagePath');
    expect(staff.afterState).not.toHaveProperty('byteSize');

    const orderRow: AuditHistoryRow = {
      id: 'order-event-1',
      action: 'FILM_SUPPLY_ORDER_CREATED',
      entityType: 'film_supply_order',
      entityId: 'order-1',
      beforeState: null,
      afterState: { code: 'FSO-SECRET-E2', status: 'DRAFT', paymentTerms: 'prepaid' },
      occurredAt: new Date('2026-11-19T09:00:00.000Z'),
      requestMetadata: null,
      actor: null
    };
    const viewer = buildAuditViewForRole('viewer', [orderRow])[0]!;
    expect(viewer.afterState).toEqual({ status: 'DRAFT', paymentTerms: 'prepaid' });
    expect(JSON.stringify(viewer)).not.toContain('FSO-SECRET-E2');
    expect(viewer).not.toHaveProperty('requestMetadata');
  });
});
