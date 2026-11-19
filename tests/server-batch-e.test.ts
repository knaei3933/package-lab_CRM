import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import {
  accounts,
  createDatabase,
  filmSupplyOrders,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { hashPassword } from '../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';
import { buildAuditViewForRole, type AuditHistoryRow } from '../apps/api/src/audit-view.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('server-batch-e tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const viewerId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();
let adminToken = '';
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

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(`${os.tmpdir()}/kanei-batch-e-`);
  app = createApp({ db });
  const now = new Date();
  await db.execute(sql`
    truncate table audit_events, maker_po_events, maker_purchase_orders, artwork_revisions,
      artwork_approval_events, evidence_manual_verifications, documents, document_versions,
      pre_order_references, seven_purchase_orders, film_supply_orders, film_supply_order_lines,
      film_deliveries, filling_orders, filling_order_lines, filling_deliveries,
      commission_readiness, delivery_confirmations, project_assignments, projects, sessions,
      accounts, users cascade
  `);
  await db.insert(users).values([
    { id: adminId, username: 'batch_e_admin', passwordHash: await hashPassword('batch-e-admin-test'), displayName: '代表', role: 'admin' },
    { id: staffId, username: 'batch_e_staff', passwordHash: await hashPassword('batch-e-staff-test'), displayName: '担当', role: 'staff' },
    { id: viewerId, username: 'batch_e_viewer', passwordHash: await hashPassword('batch-e-viewer-test'), displayName: '閲覧', role: 'viewer' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '顧客', role: 'end_customer', externalCode: 'BATCH-E-CUST' },
    { id: sevenAccountId, name: 'セブン', role: 'seven', externalCode: 'BATCH-E-SEVEN' },
    { id: makerAccountId, name: 'メーカー', role: 'maker', externalCode: 'BATCH-E-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId, code: 'BATCH-E', name: 'Server batch E', businessUnit: 'F1', route: 'F1',
    leadSource: 'KANEI', status: 'DRAFT', endCustomerAccountId: customerAccountId,
    sevenAccountId, makerAccountId,
    createdByUserId: adminId, createdAt: now, updatedAt: now
  });
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: staffId, projectId },
    { id: uuidv7(now), userId: viewerId, projectId }
  ]);
  adminToken = await createSession(adminId);
  staffToken = await createSession(staffId);
  viewerToken = await createSession(viewerId);
});

afterAll(async () => {
  await pool.end();
});

async function createSession(userId: string) {
  const { token, tokenHash } = issueToken();
  await db.insert(sessions).values({
    id: uuidv7(), userId, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  });
  return token;
}

function toBase64(text: string) {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function verifySevenPo(poId: string) {
  const checklist = await requestAs(staffToken, 'POST', `/api/seven-purchase-orders/${poId}/verification-checklist`, {
    issuerNameRecorded: true,
    issuerName: '合成セブン化学BATCH-E',
    documentNumberRecorded: true,
    documentNumber: 'PO-BATCH-E-001',
    issueDateRecorded: true,
    issueDate: '2026-11-19',
    sendingChannelRecorded: true,
    sendingChannel: '専用ポータル',
    pastTransactionCompared: true,
    pastTransactionNote: '過去発注書と様式が一致',
    quoteCompared: true,
    quoteMatchesPo: true,
    quoteComparisonNote: '見積と仕様・数量が一致',
    tamperHints: '',
    uncertain: false,
    confirmationReplyRecorded: false,
    confirmationReplyNote: '',
    verificationNote: '合成チェックリスト記録BATCH-E'
  });
  expect(checklist.status).toBe(200);
}

async function uploadVerifiedAcceptanceEvidence(tag: string, bindings: Record<string, string>) {
  const uploaded = await requestAs(staffToken, 'POST', `/api/projects/${projectId}/documents`, {
    documentType: 'acceptance_evidence',
    issuerEntity: 'kanei',
    filename: `batch-e-acceptance-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: toBase64(`batch-e acceptance evidence ${tag}\n`),
    ...bindings
  });
  expect(uploaded.status).toBe(201);
  const body = uploaded.body as { document: { id: string }; version: { id: string } };
  const verified = await requestAs(staffToken, 'POST', `/api/documents/${body.document.id}/verify`, {
    verificationStatus: 'verified',
    verificationNote: `合成受領証跡確認 ${tag}`
  });
  expect(verified.status).toBe(200);
  return body.version.id;
}

describe('persona friction batch E', () => {
  it('emits line audits when an order is created, making delivery line choices available', async () => {
    const poCreated = await requestAs(staffToken, 'POST', `/api/projects/${projectId}/seven-purchase-orders`, {
      poNumber: 'SEVEN-BATCH-E-001'
    });
    expect(poCreated.status).toBe(201);
    const poId = (poCreated.body as { id: string }).id;
    const poRegistered = await requestAs(staffToken, 'POST', `/api/seven-purchase-orders/${poId}/register-official`, {
      officialRegisteredAt: '2026-11-19T09:00:00.000+09:00'
    });
    expect(poRegistered.status).toBe(200);
    await verifySevenPo(poId);

    const created = await requestAs(staffToken, 'POST', `/api/projects/${projectId}/film-supply-orders`, {
      code: 'FSO-BATCH-E-001',
      paymentTerms: 'prepaid',
      lines: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 100000, unit: 'sheets' }]
    });
    expect(created.status).toBe(201);
    const orderId = (created.body as { id: string }).id;

    const staffAudit = await requestAs(staffToken, 'GET', `/api/projects/${projectId}/audit-history?entityType=film_supply_order_line`);
    expect(staffAudit.status).toBe(200);
    const staffLine = (staffAudit.body as {
      events: Array<{ action: string; afterState: Record<string, unknown> | null }>
    })
      .events.find((event) => event.action === 'FILM_SUPPLY_ORDER_LINE_CREATED');
    expect(staffLine?.afterState).toMatchObject({
      id: expect.any(String),
      filmSupplyOrderId: orderId,
      lineNumber: 1,
      description: '合成フィルム本体',
      orderedQuantity: '100000.000',
      unit: 'sheets'
    });
    for (const forbiddenKey of ['unitPrice', 'price', 'amount', 'commissionAmount']) {
      expect(staffLine?.afterState).not.toHaveProperty(forbiddenKey);
    }

    const staffOrderAudit = await requestAs(staffToken, 'GET', `/api/projects/${projectId}/audit-history?entityType=film_supply_order`);
    expect(staffOrderAudit.status).toBe(200);
    const staffOrder = (staffOrderAudit.body as {
      events: Array<{ action: string; afterState: Record<string, unknown> | null }>
    })
      .events.find((event) => event.action === 'FILM_SUPPLY_ORDER_CREATED');
    expect(staffOrder?.afterState).toMatchObject({
      status: 'DRAFT',
      paymentTerms: 'prepaid'
    });

    const viewerAudit = await requestAs(viewerToken, 'GET', `/api/projects/${projectId}/audit-history?entityType=film_supply_order`);
    expect(viewerAudit.status).toBe(200);
    const viewerOrder = (viewerAudit.body as {
      events: Array<{ action: string; afterState: Record<string, unknown> | null }>
    })
      .events.find((event) => event.action === 'FILM_SUPPLY_ORDER_CREATED');
    expect(viewerOrder?.afterState).toEqual({ status: 'DRAFT', paymentTerms: 'prepaid' });

    // The order row remains selectable as the delivery form's line parent.
    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId));
    expect(order?.code).toBe('FSO-BATCH-E-001');

    // F-00 end-to-end: this is the exact staff-work path restored by the new
    // audit row -- choose the reconstructed line, record delivery, and reach
    // explicit commission readiness evaluation without direct DB reads.
    const lineId = String(staffLine?.afterState?.id);
    const delivery = await requestAs(staffToken, 'POST', `/api/film-supply-orders/${orderId}/deliveries`, {
      filmSupplyOrderLineId: lineId,
      deliveredQuantity: 1000,
      unit: 'sheets'
    });
    expect(delivery.status).toBe(201);
    const deliveryId = (delivery.body as { id: string }).id;
    const evidenceVersionId = await uploadVerifiedAcceptanceEvidence('film', {
      sevenPurchaseOrderId: poId,
      filmSupplyOrderId: orderId
    });
    const confirmed = await requestAs(staffToken, 'POST', `/api/film-deliveries/${deliveryId}/confirmation`, {
      evidenceDocumentVersionId: evidenceVersionId
    });
    expect(confirmed.status).toBe(201);

    // Complete the explicit readiness inputs using the same audited-choice
    // flow. This proves F-00 unblocks the final delivery -> commission path.
    const fillingCreated = await requestAs(staffToken, 'POST', `/api/projects/${projectId}/filling-orders`, {
      code: 'FILLO-BATCH-E-001',
      lines: [{ lineNumber: 1, description: '合成充填カプセル', orderedQuantity: 2000, unit: 'pods' }]
    });
    expect(fillingCreated.status).toBe(201);
    const fillingOrder = fillingCreated.body as { id: string; lines: Array<{ id: string }> };
    const fillingDelivery = await requestAs(staffToken, 'POST', `/api/filling-orders/${fillingOrder.id}/deliveries`, {
      fillingOrderLineId: fillingOrder.lines[0]!.id,
      deliveredQuantity: 1900,
      unit: 'pods'
    });
    expect(fillingDelivery.status).toBe(201);
    const fillingDeliveryId = (fillingDelivery.body as { id: string }).id;
    const fillingEvidenceVersionId = await uploadVerifiedAcceptanceEvidence('filling', {
      sevenPurchaseOrderId: poId,
      fillingOrderId: fillingOrder.id
    });
    const fillingConfirmed = await requestAs(staffToken, 'POST', `/api/filling-deliveries/${fillingDeliveryId}/confirmation`, {
      evidenceDocumentVersionId: fillingEvidenceVersionId
    });
    expect(fillingConfirmed.status).toBe(201);

    const readiness = await requestAs(staffToken, 'POST', `/api/projects/${projectId}/commission-readiness`, {});
    expect(readiness.status).toBe(201);
    expect(readiness.body).toMatchObject({
      filmDeliveryRecorded: true,
      fillingDeliveryRecorded: true,
      sevenPoOfficiallyRegistered: true,
      filmDeliveryConfirmed: true,
      fillingDeliveryConfirmed: true,
      readinessState: 'READY',
      isReady: true,
      commissionCalculationAllowed: true
    });
  });

  it('shapes role-visible audit states without exposing monetary fields', () => {
    const row: AuditHistoryRow = {
      id: 'event-1',
      action: 'ARTWORK_APPROVAL_RECORDED',
      entityType: 'artwork_approval_event',
      entityId: 'approval-1',
      beforeState: null,
      afterState: {
        poNumber: 'SEVEN-BATCH-E-001',
        officialRegisteredAt: '2026-11-19T00:00:00.000Z',
        revisionNo: 2,
        artworkRevisionId: 'revision-1',
        organization: 'customer',
        decision: 'APPROVE',
        evidenceDocumentVersionId: 'version-1',
        evidenceIdentifier: '<approval@example.test>',
        evidenceIdentifierStatus: 'verified_in_document',
        evidenceSource: 'email',
        eventTime: '2026-11-19T09:00:00.000Z',
        approvedFileSha256: 'a'.repeat(64),
        externalApproverName: '外部承認者',
        unitPrice: '1000',
        totalAmount: '100000',
        commissionAmount: '5000'
      },
      occurredAt: new Date('2026-11-19T10:00:00.000Z'),
      requestMetadata: { operation: 'artwork_approval:record' },
      actor: null
    };
    const staff = buildAuditViewForRole('staff', [row])[0]!;
    expect(staff.afterState).toMatchObject({
      poNumber: 'SEVEN-BATCH-E-001',
      officialRegisteredAt: '2026-11-19T00:00:00.000Z',
      revisionNo: 2,
      organization: 'customer',
      decision: 'APPROVE',
      evidenceDocumentVersionId: 'version-1',
      evidenceIdentifier: '<approval@example.test>'
    });
    for (const forbiddenKey of ['approvedFileSha256', 'externalApproverName', 'unitPrice', 'totalAmount', 'commissionAmount']) {
      expect(staff.afterState).not.toHaveProperty(forbiddenKey);
    }

    const viewer = buildAuditViewForRole('viewer', [row])[0]!;
    expect(viewer.beforeState).toBeNull();
    expect(viewer.afterState).toBeUndefined();
    expect('afterState' in viewer).toBe(true);
    expect(viewer.beforeState).toBeNull();
    expect(viewer).not.toHaveProperty('requestMetadata');
    expect(JSON.stringify(viewer)).not.toContain('SEVEN-BATCH-E-001');
    expect(JSON.stringify(viewer)).not.toContain('<approval@example.test>');

    const readinessRow = {
      ...row,
      action: 'COMMISSION_READINESS_EVALUATED',
      entityType: 'commission_readiness',
      entityId: projectId,
      afterState: {
        projectId,
        readinessState: 'MISSING_DATA',
        isReady: false,
        blocking: ['FILM_DELIVERY_CONFIRMED'],
        filmDeliveryRecorded: true,
        filmDeliveryConfirmed: false,
        commissionAmount: '10000'
      },
      requestMetadata: { operation: 'commission_readiness:evaluate' }
    };
    const readiness = buildAuditViewForRole('viewer', [readinessRow])[0]!;
    expect(readiness.afterState).toEqual({ readinessState: 'MISSING_DATA', isReady: false });
    expect(readiness.beforeState).toBeNull();

    const staffReadiness = buildAuditViewForRole('staff', [readinessRow])[0]!;
    expect(staffReadiness.afterState).toEqual({
      readinessState: 'MISSING_DATA',
      isReady: false,
      blocking: ['FILM_DELIVERY_CONFIRMED']
    });
    expect(staffReadiness.afterState).not.toHaveProperty('commissionAmount');
  });

  it('shows payment terms to staff and viewer while keeping amounts excluded', () => {
    const row: AuditHistoryRow = {
      id: 'payment-term-event-1',
      action: 'FILM_SUPPLY_ORDER_PAYMENT_TERMS_UPDATED',
      entityType: 'film_supply_order',
      entityId: 'order-1',
      beforeState: { paymentTerms: 'undetermined' },
      afterState: {
        paymentTerms: 'prepaid',
        unitPrice: '1000',
        totalAmount: '100000',
        commissionAmount: '5000'
      },
      occurredAt: new Date('2026-11-19T10:00:00.000Z'),
      requestMetadata: { operation: 'film_order:update_payment_terms' },
      actor: null
    };
    const expectedState = { paymentTerms: 'prepaid' };
    const staff = buildAuditViewForRole('staff', [row])[0]!;
    const viewer = buildAuditViewForRole('viewer', [row])[0]!;
    expect(staff.beforeState).toEqual({ paymentTerms: 'undetermined' });
    expect(staff.afterState).toEqual(expectedState);
    expect(viewer.beforeState).toEqual({ paymentTerms: 'undetermined' });
    expect(viewer.afterState).toEqual(expectedState);
    for (const view of [staff, viewer]) {
      for (const forbiddenKey of ['unitPrice', 'totalAmount', 'commissionAmount']) {
        expect(view.afterState).not.toHaveProperty(forbiddenKey);
        expect(view.beforeState).not.toHaveProperty(forbiddenKey);
      }
      expect(view).not.toHaveProperty('unitPrice');
      expect(view).not.toHaveProperty('totalAmount');
      expect(view).not.toHaveProperty('commissionAmount');
    }
    expect(staff.requestMetadata).toEqual({ operation: 'film_order:update_payment_terms' });
    expect(viewer).not.toHaveProperty('requestMetadata');
  });
});
