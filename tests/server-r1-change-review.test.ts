import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import { and, eq } from 'drizzle-orm';
import {
  accounts,
  artworkApprovalEvents,
  artworkRevisions,
  auditEvents,
  createDatabase,
  documentVersions,
  documents,
  filmSupplyOrders,
  projectAssignments,
  projects,
  sevenPurchaseOrders,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';
import { hashPassword } from '../apps/api/src/password.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('CHANGE_REVIEW tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();
const sevenPoId = uuidv7();
const orderId = uuidv7();
const proofDocumentId = uuidv7();
const proofVersionId = uuidv7();
const requestEvidenceDocumentId = uuidv7();
const requestEvidenceVersionId = uuidv7();
const existingRevisionId = uuidv7();
const existingEvidenceDocumentId = uuidv7();
const existingEvidenceVersionId = uuidv7();
const designKey = 'label-front-t28';
const fileSha = 'a'.repeat(64);
let adminToken = '';
let staffToken = '';
let app: ReturnType<typeof createApp>;

function cookie(token: string) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

async function requestAs(token: string, body: unknown) {
  const response = await app.request(`/api/film-supply-orders/${orderId}/artwork-revisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookie(token) },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(`${os.tmpdir()}/kanei-change-review-`);
  app = createApp({ db });
  const now = new Date();
  await db.execute(`
    truncate table audit_events, artwork_approval_events, artwork_revisions, document_versions,
      documents, maker_po_events, maker_purchase_orders, film_supply_order_lines,
      film_supply_orders, seven_purchase_orders, pre_order_references,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  await db.insert(users).values([
    { id: adminId, username: 'admin_t28', passwordHash: await hashPassword('composite-admin-pass'), displayName: 'T28代表', role: 'admin' },
    { id: staffId, username: 'staff_t28', passwordHash: await hashPassword('composite-staff-pass'), displayName: 'T28担当', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: 'T28顧客', role: 'end_customer', externalCode: 'T28-CUST' },
    { id: sevenAccountId, name: 'T28セブン', role: 'seven', externalCode: 'T28-SEVEN' },
    { id: makerAccountId, name: 'T28メーカー', role: 'maker', externalCode: 'T28-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'T28-CHANGE',
    name: 'T28変更案件',
    businessUnit: 'F1' as const,
    route: 'F1' as const,
    leadSource: 'KANEI',
    endCustomerAccountId: customerAccountId,
    sevenAccountId,
    makerAccountId,
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: adminId, projectId },
    { id: uuidv7(now), userId: staffId, projectId }
  ]);
  const poTime = new Date('2026-11-18T00:00:00.000Z');
  await db.insert(sevenPurchaseOrders).values({
    id: sevenPoId,
    projectId,
    poNumber: 'SEVEN-T28-001',
    officialRegisteredAt: poTime,
    promotedAt: poTime,
    promotedByUserId: adminId,
    verificationStatus: 'verified' as const,
    verifiedAt: poTime,
    verifiedByUserId: adminId,
    verificationNote: 'T28確認済み',
    createdByUserId: adminId,
    createdAt: poTime,
    updatedAt: poTime
  });
  await db.insert(filmSupplyOrders).values({
    id: orderId,
    projectId,
    code: 'FSO-T28-001',
    status: 'FILM_IN_PRODUCTION' as const,
    sevenPurchaseOrderId: sevenPoId,
    paymentTerms: 'prepaid',
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  });

  const proofTime = new Date('2026-11-18T09:00:00.000Z');
  await db.insert(documents).values({
    id: proofDocumentId,
    projectId,
    documentType: 'proof' as const,
    issuerEntity: 'kanei' as const,
    originalFilename: 't28-old-proof.txt',
    sevenPurchaseOrderId: sevenPoId,
    filmSupplyOrderId: orderId,
    designKey,
    createdByUserId: staffId,
    createdAt: proofTime,
    updatedAt: proofTime
  });
  await db.insert(documentVersions).values({
    id: proofVersionId,
    documentId: proofDocumentId,
    versionNumber: 1,
    sha256: fileSha,
    byteSize: 10,
    storagePath: `${process.env.DOCUMENT_STORAGE_DIR}/old-proof.bin`,
    originalFilename: 't28-old-proof.txt',
    declaredMimeType: 'text/plain',
    detectedMimeType: null,
    sizeCheckPassed: true,
    typeCheckPassed: true,
    createdByUserId: staffId,
    createdAt: proofTime
  });
  await db.insert(documents).values({
    id: requestEvidenceDocumentId,
    projectId,
    documentType: 'approval_evidence' as const,
    issuerEntity: 'customer_generated' as const,
    originalFilename: 't28-change-request.eml',
    sevenPurchaseOrderId: sevenPoId,
    filmSupplyOrderId: orderId,
    designKey,
    createdByUserId: staffId,
    createdAt: proofTime,
    updatedAt: proofTime
  });
  await db.insert(documentVersions).values({
    id: requestEvidenceVersionId,
    documentId: requestEvidenceDocumentId,
    versionNumber: 1,
    sha256: 'b'.repeat(64),
    byteSize: 12,
    storagePath: `${process.env.DOCUMENT_STORAGE_DIR}/change-request.bin`,
    originalFilename: 't28-change-request.eml',
    declaredMimeType: 'message/rfc822',
    detectedMimeType: null,
    sizeCheckPassed: true,
    typeCheckPassed: true,
    createdByUserId: staffId,
    createdAt: proofTime
  });
  await db.insert(artworkRevisions).values({
    id: existingRevisionId,
    filmSupplyOrderId: orderId,
    designKey,
    revisionNo: 1,
    fileDocumentVersionId: proofVersionId,
    lotMarking: 'LOT-T28-OLD',
    note: 'initial approved artwork',
    createdByUserId: staffId,
    createdAt: proofTime
  });
  await db.insert(documents).values({
    id: existingEvidenceDocumentId,
    projectId,
    documentType: 'approval_evidence' as const,
    issuerEntity: 'customer_generated' as const,
    originalFilename: 'old-customer-approval.eml',
    sevenPurchaseOrderId: sevenPoId,
    filmSupplyOrderId: orderId,
    designKey,
    createdByUserId: staffId,
    createdAt: proofTime,
    updatedAt: proofTime
  });
  await db.insert(documentVersions).values({
    id: existingEvidenceVersionId,
    documentId: existingEvidenceDocumentId,
    versionNumber: 1,
    sha256: 'c'.repeat(64),
    byteSize: 8,
    storagePath: `${process.env.DOCUMENT_STORAGE_DIR}/old-approval.bin`,
    originalFilename: 'old-customer-approval.eml',
    declaredMimeType: 'message/rfc822',
    detectedMimeType: null,
    sizeCheckPassed: true,
    typeCheckPassed: true,
    createdByUserId: staffId,
    createdAt: proofTime
  });
  const approvalTime = new Date('2026-11-18T10:00:00.000Z');
  await db.insert(artworkApprovalEvents).values([
    {
      id: uuidv7(now),
      artworkRevisionId: existingRevisionId,
      organization: 'customer' as const,
      decision: 'APPROVE' as const,
      recordedByUserId: staffId,
      evidenceDocumentVersionId: existingEvidenceVersionId,
      evidenceIdentifier: 'MSG-T28-CUSTOMER-001',
      evidenceIdentifierStatus: 'verified_in_document',
      evidenceSource: 'email' as const,
      approvedFileSha256: fileSha,
      eventTime: approvalTime,
      recordedAt: approvalTime
    },
    {
      id: uuidv7(now),
      artworkRevisionId: existingRevisionId,
      organization: 'seven' as const,
      decision: 'APPROVE' as const,
      recordedByUserId: staffId,
      evidenceDocumentVersionId: existingEvidenceVersionId,
      evidenceIdentifier: 'MSG-T28-SEVEN-001',
      evidenceIdentifierStatus: 'verified_in_document',
      evidenceSource: 'email' as const,
      approvedFileSha256: fileSha,
      eventTime: approvalTime,
      recordedAt: approvalTime
    }
  ]);
  for (const userId of [adminId, staffId]) {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({
      id: uuidv7(), userId, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    });
    if (userId === adminId) adminToken = token;
    if (userId === staffId) staffToken = token;
  }
});

afterAll(async () => {
  await pool.end();
});

describe('R1-9 controlled lot CHANGE_REVIEW (T-28)', () => {
  it('rejects an incomplete change request before persistence', async () => {
    const hold = await app.request(`/api/film-supply-orders/${orderId}/transitions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookie(staffToken) },
      body: JSON.stringify({ to: 'ON_HOLD', reason: 'scope review before revision' })
    });
    expect(hold.status).toBe(200);
    const missing = await requestAs(staffToken, {
      designKey,
      fileDocumentVersionId: proofVersionId,
      lotMarking: 'LOT-T28-NEW',
      changeRequest: {}
    });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: 'CHANGE_REQUEST_ORGANIZATION_REQUIRED' });

    const [revisionCount] = await db.select({ count: artworkRevisions.id }).from(artworkRevisions)
      .where(and(eq(artworkRevisions.filmSupplyOrderId, orderId), eq(artworkRevisions.revisionNo, 3)));
    expect(revisionCount).toBeUndefined();
    const [order] = await db.select({ status: filmSupplyOrders.status }).from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, orderId));
    expect(order?.status).toBe('ON_HOLD');

    const approvedDuringHold = await requestAs(adminToken, {
      designKey,
      fileDocumentVersionId: proofVersionId,
      lotMarking: 'LOT-T28-HOLD-NEW',
      changeRequest: {
        requestedOrganization: 'customer',
        reason: 'hold supersession requires the complete audit record',
        evidenceDocumentVersionId: requestEvidenceVersionId,
        impactSchedule: '1日遅延',
        impactQuantity: 0,
        impactAmount: 0,
        actualCost: 0
      }
    });
    expect(approvedDuringHold.status).toBe(201);
    expect(approvedDuringHold.body).toMatchObject({
      status: 'ON_HOLD',
      invalidatedApprovals: true,
      changeReason: 'hold supersession requires the complete audit record',
      lotMarking: 'LOT-T28-HOLD-NEW'
    });
  });

  it('requires admin approval and explicit actual cost after printing starts', async () => {
    const staff = await requestAs(staffToken, {
      designKey,
      fileDocumentVersionId: proofVersionId,
      lotMarking: 'LOT-T28-NEW',
      changeRequest: {
        requestedOrganization: 'customer',
        reason: 'customer requested lot correction',
        evidenceDocumentVersionId: requestEvidenceVersionId,
        impactSchedule: '2日遅延',
        impactQuantity: 0,
        impactAmount: 12000,
        actualCost: 0
      }
    });
    expect(staff.status).toBe(403);
    expect(staff.body).toMatchObject({ code: 'PRINTED_CHANGE_ADMIN_APPROVAL_REQUIRED' });

    const withoutCost = await requestAs(adminToken, {
      designKey,
      fileDocumentVersionId: proofVersionId,
      lotMarking: 'LOT-T28-NEW',
      changeRequest: {
        requestedOrganization: 'customer',
        reason: 'customer requested lot correction',
        evidenceDocumentVersionId: requestEvidenceVersionId,
        impactSchedule: '2日遅延',
        impactQuantity: 0,
        impactAmount: 12000
      }
    });
    expect(withoutCost.status).toBe(422);
    expect(withoutCost.body).toMatchObject({ code: 'CHANGE_REQUEST_NUMERIC_FIELD_REQUIRED' });

    const tooLargeQuantity = await requestAs(adminToken, {
      designKey,
      fileDocumentVersionId: proofVersionId,
      lotMarking: 'LOT-T28-NEW',
      changeRequest: {
        requestedOrganization: 'customer',
        reason: 'scale boundary',
        evidenceDocumentVersionId: requestEvidenceVersionId,
        impactSchedule: 'なし',
        impactQuantity: 100_000_000_000,
        impactAmount: 0,
        actualCost: 0
      }
    });
    expect(tooLargeQuantity.status).toBe(422);
    expect(tooLargeQuantity.body).toMatchObject({ code: 'CHANGE_REQUEST_NUMERIC_FIELD_TOO_LARGE' });

    const tooPreciseAmount = await requestAs(adminToken, {
      designKey,
      fileDocumentVersionId: proofVersionId,
      lotMarking: 'LOT-T28-NEW',
      changeRequest: {
        requestedOrganization: 'customer',
        reason: 'scale boundary',
        evidenceDocumentVersionId: requestEvidenceVersionId,
        impactSchedule: 'なし',
        impactQuantity: 0,
        impactAmount: 1.234,
        actualCost: 0
      }
    });
    expect(tooPreciseAmount.status).toBe(422);
    expect(tooPreciseAmount.body).toMatchObject({ code: 'CHANGE_REQUEST_DECIMAL_SCALE_INVALID' });
  });

  it('records the complete lot change request and print-start approval', async () => {
    await db.update(filmSupplyOrders).set({ status: 'FILM_IN_PRODUCTION' }).where(eq(filmSupplyOrders.id, orderId));
    const approved = await requestAs(adminToken, {
      designKey,
      fileDocumentVersionId: proofVersionId,
      lotMarking: 'LOT-T28-NEW',
      note: 'controlled replacement proof',
      changeRequest: {
        requestedOrganization: 'customer',
        reason: 'customer requested lot correction',
        evidenceDocumentVersionId: requestEvidenceVersionId,
        impactSchedule: '2日遅延',
        impactQuantity: 0,
        impactAmount: 12000,
        actualCost: 0
      }
    });
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({
      status: 'CHANGE_REVIEW',
      invalidatedApprovals: true,
      changeRequestedOrganization: 'customer',
      changeReason: 'customer requested lot correction',
      changeEvidenceDocumentVersionId: requestEvidenceVersionId,
      impactSchedule: '2日遅延',
      impactQuantity: '0.000',
      impactAmount: '12000.00',
      actualCost: '0.00',
      printedChangeApprovedByUserId: adminId
    });

    const [order] = await db.select({ status: filmSupplyOrders.status }).from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, orderId));
    expect(order?.status).toBe('CHANGE_REVIEW');
    const [revision] = await db.select().from(artworkRevisions)
      .where(and(eq(artworkRevisions.filmSupplyOrderId, orderId), eq(artworkRevisions.revisionNo, 3)));
    expect(revision?.lotMarking).toBe('LOT-T28-NEW');
    expect(revision?.actualCost).toBe('0.00');
    expect(revision?.printedChangeApprovedByUserId).toBe(adminId);
    expect(revision?.printedChangeApprovedAt).toBeInstanceOf(Date);

    const [event] = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.action, 'ARTWORK_REVISION_REGISTERED'), eq(auditEvents.entityId, revision!.id)));
    expect(event?.afterState).toMatchObject({
      changeRequestedOrganization: 'customer',
      actualCost: '0.00',
      invalidatedApprovals: true
    });
  });
});
