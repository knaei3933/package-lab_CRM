import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  artworkApprovalEvents,
  auditEvents,
  createDatabase,
  filmSupplyOrders,
  makerPoEvents,
  makerPurchaseOrders,
  projectAssignments,
  preOrderReferences,
  projects,
  sevenPurchaseOrders,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { hashPassword } from '../apps/api/src/password.js';
import { hashToken, issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';
import { buildAuditViewForRole } from '../apps/api/src/audit-view.js';

const databaseUrl = process.env.DATABASE_URL!;
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
let poId = '';
let heldOrderId = '';

async function createSession(userId: string) {
  const now = new Date();
  const { token, tokenHash } = issueToken();
  await db.insert(sessions).values({
    id: uuidv7(now),
    userId,
    tokenHash,
    expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000)
  });
  return token;
}

function cookieHeader(token: string) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

async function postAs(token: string, url: string, body?: unknown) {
  const response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookieHeader(token) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

async function getAs(token: string, url: string) {
  const response = await app.request(url, { headers: cookieHeader(token) });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-approved-rules-'));
  app = createApp({ db });
  await db.execute(sql`
    truncate table audit_events, maker_po_events, maker_purchase_orders, artwork_revisions,
      artwork_approval_events, evidence_manual_verifications, documents, document_versions,
      pre_order_references, seven_purchase_orders, film_supply_orders, film_supply_order_lines,
      film_deliveries, filling_orders, filling_order_lines, filling_deliveries,
      commission_readiness, delivery_confirmations, project_assignments, projects, sessions,
      accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'approved_admin_test', passwordHash: await hashPassword('approved-admin-pass'), displayName: '代表者', role: 'admin' },
    { id: staffId, username: 'approved_staff_test', passwordHash: await hashPassword('approved-staff-pass'), displayName: '担当者', role: 'staff' },
    { id: viewerId, username: 'approved_viewer_test', passwordHash: await hashPassword('approved-viewer-pass'), displayName: '閲覧者', role: 'viewer' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成顧客', role: 'end_customer', externalCode: 'APPROVED-CUST' },
    { id: sevenAccountId, name: '合成セブン', role: 'seven', externalCode: 'APPROVED-SEVEN' },
    { id: makerAccountId, name: '合成メーカー', role: 'maker', externalCode: 'APPROVED-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'APPROVED-RULES',
    name: '承認済みサーバー規則テスト',
    businessUnit: 'F1',
    route: 'F1',
    leadSource: 'KANEI',
    status: 'DRAFT',
    endCustomerAccountId: customerAccountId,
    sevenAccountId,
    makerAccountId,
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: staffId, projectId },
    { id: uuidv7(now), userId: viewerId, projectId }
  ]);
  adminToken = await createSession(adminId);
  staffToken = await createSession(staffId);
  viewerToken = await createSession(viewerId);
  const created = await postAs(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, {
    poNumber: 'PO-APPROVED-FIRST',
    originalReceivedAt: '2026-11-18T00:00:00.000Z'
  });
  expect(created.status).toBe(201);
  poId = (created.body as { id: string }).id;

  // A synthetic hold event preserves the exact immediate-origin contract used
  // by production transitions; this avoids building the full maker chain here.
  const holdAt = new Date();
  heldOrderId = uuidv7(holdAt);
  await db.insert(filmSupplyOrders).values({
    id: heldOrderId,
    projectId,
    code: 'FSO-APPROVED-HOLD',
    status: 'ON_HOLD',
    paymentTerms: 'prepaid',
    holdReason: 'test hold',
    createdByUserId: adminId,
    createdAt: holdAt,
    updatedAt: holdAt,
    deletedAt: null
  });
  await db.insert(auditEvents).values({
    id: uuidv7(holdAt),
    projectId,
    actorUserId: staffId,
    action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
    entityType: 'film_supply_order',
    entityId: heldOrderId,
    beforeState: { status: 'APPROVED_FOR_MANUAL_SEND' },
    afterState: { status: 'ON_HOLD' },
    occurredAt: holdAt,
    requestMetadata: { operation: 'film_order:transition' }
  });
});

afterAll(async () => {
  await pool.end();
});

describe('official registration date overwrite rule', () => {
  it('staff records the first date, viewer cannot, and staff cannot overwrite it', async () => {
    const viewerFirst = await postAs(viewerToken, `/api/seven-purchase-orders/${poId}/register-official`, {
      officialRegisteredAt: '2026-11-18T00:00:00.000Z'
    });
    expect(viewerFirst.status).toBe(403);

    const staffFirst = await postAs(staffToken, `/api/seven-purchase-orders/${poId}/register-official`, {
      officialRegisteredAt: '2026-11-18T00:00:00.000Z'
    });
    expect(staffFirst.status).toBe(200);

    const staffOverwrite = await postAs(staffToken, `/api/seven-purchase-orders/${poId}/register-official`, {
      officialRegisteredAt: '2026-01-01T00:00:00.000Z'
    });
    expect(staffOverwrite.status).toBe(403);
    const [afterStaffRefusal] = await db.select().from(sevenPurchaseOrders)
      .where(eq(sevenPurchaseOrders.id, poId)).limit(1);
    expect(afterStaffRefusal?.officialRegisteredAt?.toISOString()).toBe('2026-11-18T00:00:00.000Z');
  });

  it('admin overwrite succeeds and the audit event carries both date values', async () => {
    const overwritten = await postAs(adminToken, `/api/seven-purchase-orders/${poId}/register-official`, {
      officialRegisteredAt: '2026-01-01T00:00:00.000Z'
    });
    expect(overwritten.status).toBe(200);

    const [row] = await db.select({ officialRegisteredAt: sevenPurchaseOrders.officialRegisteredAt })
      .from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, poId)).limit(1);
    expect(row?.officialRegisteredAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');

    const [event] = await db.select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, poId))
      .orderBy(sql`${auditEvents.occurredAt} desc`)
      .limit(1);
    expect(event?.action).toBe('SEVEN_PO_OFFICIALLY_REGISTERED');
    expect(event?.beforeState).toMatchObject({
      officialRegisteredAt: '2026-11-18T00:00:00.000Z'
    });
    expect(event?.afterState).toMatchObject({
      officialRegisteredAt: '2026-01-01T00:00:00.000Z'
    });
  });
});

describe('staff approval evidence selection contract', () => {
  it('exposes document type and artwork binding, but not raw upload snapshots', () => {
    const row = {
      id: 'audit-1',
      action: 'DOCUMENT_VERSION_UPLOADED',
      entityType: 'document_version',
      entityId: 'version-1',
      beforeState: null,
      afterState: {
        id: 'version-1',
        documentId: 'document-1',
        versionNumber: 1,
        documentType: 'approval_evidence',
        filmSupplyOrderId: 'order-1',
        designKey: 'label-front',
        sha256: 'secret-hash',
        storagePath: '/secret/path',
        byteSize: 1234
      },
      occurredAt: new Date('2026-11-18T00:00:00.000Z'),
      requestMetadata: { operation: 'document:create', documentId: 'secret-document-id' },
      actor: { id: staffId, displayName: '担当者', role: 'staff' }
    };

    const staffViews = buildAuditViewForRole('staff', [row]);
    expect(staffViews).toHaveLength(1);
    const staffView = staffViews[0]!;
    expect(staffView.afterState).toEqual({
      id: 'version-1',
      documentId: 'document-1',
      versionNumber: 1,
      documentType: 'approval_evidence',
      filmSupplyOrderId: 'order-1',
      designKey: 'label-front'
    });
    expect(staffView.requestMetadata).toEqual({ operation: 'document:create' });

    const viewerView = buildAuditViewForRole('viewer', [row])[0]!;
    expect(viewerView.beforeState).toBeNull();
    expect(viewerView.afterState).toBeUndefined();
    expect(viewerView).not.toHaveProperty('requestMetadata');
  });

  it('carries a real upload through staff audit selection into approval recording', async () => {
    const checklist = {
      issuerNameRecorded: true,
      issuerName: '合成セブン',
      documentNumberRecorded: true,
      documentNumber: 'PO-APPROVED-EVIDENCE',
      issueDateRecorded: true,
      issueDate: '2026-11-18',
      sendingChannelRecorded: true,
      sendingChannel: '専用ポータル',
      pastTransactionCompared: true,
      pastTransactionNote: '過去3件と一致',
      quoteCompared: true,
      quoteMatchesPo: true,
      quoteComparisonNote: '見積と一致',
      tamperHints: '',
      uncertain: false,
      confirmationReplyRecorded: false,
      confirmationReplyNote: '',
      verificationNote: '合成チェックリスト'
    };
    expect((await postAs(staffToken, `/api/seven-purchase-orders/${poId}/verification-checklist`, checklist)).status).toBe(200);
    await db.update(filmSupplyOrders).set({ sevenPurchaseOrderId: poId })
      .where(eq(filmSupplyOrders.id, heldOrderId));

    async function uploadDocument(documentType: 'proof' | 'approval_evidence', content: string) {
      const response = await postAs(staffToken, `/api/projects/${projectId}/documents`, {
        documentType,
        issuerEntity: documentType === 'proof' ? 'kanei' : 'customer_generated',
        filename: `${documentType}-real-selection.txt`,
        contentType: 'text/plain',
        contentBase64: Buffer.from(content, 'utf8').toString('base64'),
        sevenPurchaseOrderId: poId,
        filmSupplyOrderId: heldOrderId,
        designKey: 'label-front'
      });
      expect(response.status).toBe(201);
      return response.body as { document: { id: string }; version: { id: string } };
    }

    const proof = await uploadDocument('proof', 'proof for real staff selection\n');
    const revisionResponse = await postAs(staffToken, `/api/film-supply-orders/${heldOrderId}/artwork-revisions`, {
      designKey: 'label-front',
      fileDocumentVersionId: proof.version.id
    });
    expect(revisionResponse.status).toBe(201);
    const revision = revisionResponse.body as { id: string };

    const identifier = '<real-staff-selection@mail.example>';
    const evidence = await uploadDocument(
      'approval_evidence',
      `approval evidence\nMessage-ID: ${identifier}\n`
    );
    const history = await getAs(staffToken, `/api/projects/${projectId}/audit-history?entityType=document_version&entityId=${evidence.version.id}`);
    expect(history.status).toBe(200);
    const staffEvent = (history.body as { events: Array<{ afterState: Record<string, unknown> | null }> }).events[0]!;
    expect(staffEvent.afterState).toMatchObject({
      id: evidence.version.id,
      documentId: evidence.document.id,
      versionNumber: 1,
      documentType: 'approval_evidence',
      filmSupplyOrderId: heldOrderId,
      designKey: 'label-front'
    });
    expect(staffEvent.afterState).not.toHaveProperty('sha256');
    expect(staffEvent.afterState).not.toHaveProperty('storagePath');
    expect(staffEvent.afterState).not.toHaveProperty('originalFilename');

    const approval = await postAs(staffToken, `/api/artwork-revisions/${revision.id}/approvals`, {
      organization: 'customer',
      decision: 'APPROVE',
      evidenceSource: 'email',
      eventTime: '2026-11-18T10:00:00.000Z',
      evidenceIdentifier: identifier,
      evidenceDocumentVersionId: evidence.version.id
    });
    expect(approval.status).toBe(201);
    const approvalBody = approval.body as { approvalEvent: { recordedByUserId: string } };
    expect(approvalBody.approvalEvent.recordedByUserId).toBe(staffId);
    const [approvalRow] = await db.select().from(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.evidenceDocumentVersionId, evidence.version.id)).limit(1);
    expect(approvalRow?.recordedByUserId).toBe(staffId);
  });
});

describe('hold release and production-chain guard', () => {
  it('blocks a pre-acceptance hold from reaching production for every role', async () => {
    const staffAttempt = await postAs(staffToken, `/api/film-supply-orders/${heldOrderId}/transitions`, {
      to: 'FILM_IN_PRODUCTION'
    });
    expect(staffAttempt.status).toBe(422);
    expect(staffAttempt.body).toMatchObject({ code: 'INVALID_TRANSITION' });

    const adminAttempt = await postAs(adminToken, `/api/film-supply-orders/${heldOrderId}/transitions`, {
      to: 'FILM_IN_PRODUCTION'
    });
    expect(adminAttempt.status).toBe(422);
    expect(adminAttempt.body).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('makes hold release admin-only, requires a reason, and recovers a cleaned maker origin to READY', async () => {
    const staffRelease = await postAs(staffToken, `/api/film-supply-orders/${heldOrderId}/hold-release`, {
      reason: 'staff cannot release'
    });
    expect(staffRelease.status).toBe(403);
    const viewerRelease = await postAs(viewerToken, `/api/film-supply-orders/${heldOrderId}/hold-release`, {
      reason: 'viewer cannot release'
    });
    expect(viewerRelease.status).toBe(403);

    const missingReason = await postAs(adminToken, `/api/film-supply-orders/${heldOrderId}/hold-release`, {});
    expect(missingReason.status).toBe(422);
    expect(missingReason.body).toMatchObject({ code: 'HOLD_RELEASE_REASON_REQUIRED' });

    const released = await postAs(adminToken, `/api/film-supply-orders/${heldOrderId}/hold-release`, {
      reason: 'root cause resolved'
    });
    expect(released.status).toBe(200);
    // The representative delegated this recovery rule: a hold whose origin was
    // a maker-chain step must not resume there when its only paper was cleaned
    // up during the hold; that would freeze replacement work at a dead step.
    expect(released.body).toMatchObject({ status: 'MAKER_PO_READY', holdReason: null });

    const [event] = await db.select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'FILM_SUPPLY_ORDER_HOLD_RELEASED'))
      .orderBy(sql`${auditEvents.occurredAt} desc`)
      .limit(1);
    expect(event?.entityId).toBe(heldOrderId);
    expect(event?.beforeState).toMatchObject({ status: 'ON_HOLD', holdReason: 'test hold' });
    expect(event?.afterState).toMatchObject({ status: 'MAKER_PO_READY', holdReason: null });
    expect(event?.requestMetadata).toMatchObject({
      operation: 'film_order:release_hold',
      reason: 'root cause resolved',
      originState: 'APPROVED_FOR_MANUAL_SEND',
      intendedReverseRecovery: 'no_active_maker_po_after_cleanup'
    });
  });
});

describe('cancellation review production guard', () => {
  it('rejects a DRAFT-origin cancellation shortcut to production but resumes its origin', async () => {
    const now = new Date();
    const orderId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: 'FSO-CANCELLATION-GUARD', status: 'CANCELLATION_REVIEW',
      paymentTerms: 'prepaid', createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });
    await db.insert(auditEvents).values({
      id: uuidv7(now), projectId, actorUserId: staffId, action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
      entityType: 'film_supply_order', entityId: orderId, beforeState: { status: 'DRAFT' },
      afterState: { status: 'CANCELLATION_REVIEW' }, occurredAt: now,
      requestMetadata: { operation: 'film_order:transition' }
    });
    const staffJump = await postAs(staffToken, `/api/film-supply-orders/${orderId}/transitions`, { to: 'FILM_IN_PRODUCTION' });
    expect(staffJump.status).toBe(422);
    expect(staffJump.body).toMatchObject({ code: 'CANCELLATION_REVIEW_RESOLUTION_REQUIRED' });
    const adminJump = await postAs(adminToken, `/api/film-supply-orders/${orderId}/transitions`, { to: 'FILM_IN_PRODUCTION' });
    expect(adminJump.status).toBe(422);
    expect(adminJump.body).toMatchObject({ code: 'CANCELLATION_REVIEW_RESOLUTION_REQUIRED' });
    const staffResume = await postAs(staffToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, {
      outcome: 'resume', reason: 'staff cannot resolve'
    });
    expect(staffResume.status).toBe(403);
    const resumed = await postAs(adminToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, {
      outcome: 'resume', reason: 'cancellation concern resolved'
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'DRAFT' });
  });
});

describe('maker-chain cancellation review recovery', () => {
  it('lets admin resume a cleaned maker-chain origin to READY or close the order as cancelled', async () => {
    const now = new Date();
    const origin = 'MAKER_PO_SENT_MANUALLY';
    const orderId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: 'FSO-CR-MAKER-ORIGIN', status: 'CANCELLATION_REVIEW',
      paymentTerms: 'prepaid', createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });
    const entry = await db.insert(auditEvents).values({
      id: uuidv7(now), projectId, actorUserId: staffId, action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
      entityType: 'film_supply_order', entityId: orderId, beforeState: { status: origin },
      afterState: { status: 'CANCELLATION_REVIEW' }, occurredAt: now,
      requestMetadata: { operation: 'film_order:transition' }
    }).returning({ id: auditEvents.id });

    const generic = await postAs(adminToken, `/api/film-supply-orders/${orderId}/transitions`, { to: origin });
    expect(generic.status).toBe(422);
    expect(generic.body).toMatchObject({ code: 'CANCELLATION_REVIEW_RESOLUTION_REQUIRED' });

    const wrongResume = await postAs(adminToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, {
      outcome: 'resume', reason: 'wrong origin requested', resumeStatus: 'MAKER_PO_ACCEPTED'
    });
    expect(wrongResume.status).toBe(422);
    expect(wrongResume.body).toMatchObject({ code: 'CANCELLATION_RESUME_TARGET_INVALID' });

    const resumed = await postAs(adminToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, {
      outcome: 'resume', reason: 'review resolved at the original maker step'
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'MAKER_PO_READY' });
    const [audit] = await db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'FILM_SUPPLY_ORDER_CANCELLATION_REVIEW_RESOLVED'))
      .orderBy(sql`${auditEvents.occurredAt} desc`).limit(1);
    expect(audit?.beforeState).toMatchObject({ status: 'CANCELLATION_REVIEW' });
    expect(audit?.afterState).toMatchObject({ status: 'MAKER_PO_READY' });
    expect(audit?.requestMetadata).toMatchObject({
      operation: 'film_order:resolve_cancellation_review',
      outcome: 'resume',
      origin,
      intendedReverseRecovery: 'no_active_maker_po_after_cleanup',
      reviewEventId: entry[0]?.id
    });
  });

  it('lets admin end a known-origin review as terminal CANCELLED', async () => {
    const now = new Date();
    const orderId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: 'FSO-CR-CANCEL-END', status: 'CANCELLATION_REVIEW',
      paymentTerms: 'prepaid', createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });
    await db.insert(auditEvents).values({
      id: uuidv7(now), projectId, actorUserId: staffId, action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
      entityType: 'film_supply_order', entityId: orderId, beforeState: { status: 'MAKER_PO_ACCEPTED' },
      afterState: { status: 'CANCELLATION_REVIEW' }, occurredAt: now,
      requestMetadata: { operation: 'film_order:transition' }
    });
    const closed = await postAs(adminToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, {
      outcome: 'cancel', reason: 'external cancellation confirmed'
    });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'CANCELLED' });
    const [row] = await db.execute(sql`select status from film_supply_orders where id = ${orderId}`)
      .then((result) => result.rows as Array<{ status: string }>);
    expect(row?.status).toBe('CANCELLED');
    const reopened = await postAs(adminToken, `/api/film-supply-orders/${orderId}/transitions`, { to: 'DRAFT' });
    expect(reopened.status).toBe(409);
    expect(reopened.body).toMatchObject({ code: 'FILM_ORDER_CANCELLED' });
    const resolvedAgain = await postAs(adminToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, {
      outcome: 'cancel', reason: 'already closed'
    });
    expect(resolvedAgain.status).toBe(409);
    expect(resolvedAgain.body).toMatchObject({ code: 'FILM_ORDER_CANCELLED' });
  });
});

describe('legacy cancellation review recovery', () => {
  it('requires an explicit safe resume target and validates maker evidence', async () => {
    const now = new Date();
    const orderId = uuidv7(now);
    const paperId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: 'FSO-LEGACY-CR', status: 'CANCELLATION_REVIEW',
      paymentTerms: 'prepaid', createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });
    await db.insert(makerPurchaseOrders).values({
      id: paperId, filmSupplyOrderId: orderId,
      snapshot: { order: { id: orderId }, items: [], artworkFiles: [], amounts: [] },
      snapshotSha256: 'c'.repeat(64), status: 'DRAFT', createdByUserId: adminId, createdAt: now, updatedAt: now
    });
    const staffResolve = await postAs(staffToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, {
      outcome: 'resume', reason: 'staff cannot resolve', resumeStatus: 'DRAFT'
    });
    expect(staffResolve.status).toBe(403);
    const missingResume = await postAs(adminToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, {
      outcome: 'resume', reason: 'legacy recovery'
    });
    expect(missingResume.status).toBe(422);
    expect(missingResume.body).toMatchObject({ code: 'CANCELLATION_RESUME_REQUIRED' });
    const unsafeResume = await postAs(adminToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, {
      outcome: 'resume', reason: 'unsafe recovery', resumeStatus: 'FILM_IN_PRODUCTION'
    });
    expect(unsafeResume.status).toBe(422);
    expect(unsafeResume.body).toMatchObject({ code: 'CANCELLATION_RESUME_TARGET_INVALID' });
    const evidenceMismatch = await postAs(adminToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, {
      outcome: 'resume', reason: 'accepted paper claimed without evidence', resumeStatus: 'MAKER_PO_ACCEPTED'
    });
    expect(evidenceMismatch.status).toBe(422);
    expect(evidenceMismatch.body).toMatchObject({ code: 'CANCELLATION_RESUME_EVIDENCE_MISMATCH' });
    const resumed = await postAs(adminToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, {
      outcome: 'resume', reason: 'legacy recovery', resumeStatus: 'DRAFT'
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'DRAFT' });
  });
});

describe('exception-state maker gates and change review gate', () => {
  it.each([
    ['CANCELLATION_REVIEW'],
    ['CHANGE_REVIEW']
  ])('blocks maker PO CEO approval while %s and leaves the paper unchanged', async (status) => {
    const now = new Date();
    const orderId = uuidv7(now);
    const paperId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: `FSO-${status}-MAKER-GATE`, status: status as 'CANCELLATION_REVIEW' | 'CHANGE_REVIEW',
      paymentTerms: 'prepaid', createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });
    await db.insert(makerPurchaseOrders).values({
      id: paperId, filmSupplyOrderId: orderId,
      snapshot: { order: { id: orderId }, items: [], artworkFiles: [], amounts: [] },
      snapshotSha256: status === 'CANCELLATION_REVIEW' ? 'd'.repeat(64) : 'e'.repeat(64),
      status: 'DRAFT', createdByUserId: adminId, createdAt: now, updatedAt: now
    });
    const approved = await postAs(adminToken, `/api/maker-purchase-orders/${paperId}/ceo-approval`, {});
    expect(approved.status).toBe(409);
    expect(approved.body).toMatchObject({
      code: 'ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED',
      orderStatus: status
    });
    const [paper] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, paperId)).limit(1);
    expect(paper?.status).toBe('DRAFT');
    expect(paper?.ceoApprovedAt).toBeNull();
  });

  it('does not let CHANGE_REVIEW skip the verified seven-PO boundary', async () => {
    const now = new Date();
    const orderId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: 'FSO-CHANGE-PO-GATE', status: 'CHANGE_REVIEW',
      paymentTerms: 'prepaid', createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });
    const skipped = await postAs(staffToken, `/api/film-supply-orders/${orderId}/transitions`, {
      to: 'APPROVAL_PENDING'
    });
    expect(skipped.status).toBe(422);
    expect(skipped.body).toMatchObject({ code: 'SEVEN_PO_REQUIRED' });

    await db.update(filmSupplyOrders).set({ sevenPurchaseOrderId: poId })
      .where(eq(filmSupplyOrders.id, orderId));
    const allowed = await postAs(staffToken, `/api/film-supply-orders/${orderId}/transitions`, {
      to: 'APPROVAL_PENDING'
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ status: 'APPROVAL_PENDING' });
  });
});

describe('maker PO work while held', () => {
  it('blocks CEO approval with 409 and leaves the paper unchanged', async () => {
    const now = new Date();
    const orderId = uuidv7(now);
    const paperId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: 'FSO-HOLD-MAKER-GATE', status: 'ON_HOLD', paymentTerms: 'prepaid',
      holdReason: 'waiting for customer', createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });
    await db.insert(makerPurchaseOrders).values({
      id: paperId, filmSupplyOrderId: orderId,
      snapshot: { order: { id: orderId }, items: [], artworkFiles: [], amounts: [] },
      snapshotSha256: 'a'.repeat(64), status: 'DRAFT', createdByUserId: adminId, createdAt: now, updatedAt: now
    });
    const approved = await postAs(adminToken, `/api/maker-purchase-orders/${paperId}/ceo-approval`, {});
    expect(approved.status).toBe(409);
    expect(approved.body).toMatchObject({ code: 'ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED' });
    const [paper] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, paperId)).limit(1);
    expect(paper?.status).toBe('DRAFT');
    expect(paper?.ceoApprovedAt).toBeNull();
  });
});

describe('legacy hold recovery', () => {
  it('lets an admin explicitly resume a safe legacy state with a required reason', async () => {
    const now = new Date();
    const orderId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: 'FSO-LEGACY-HOLD', status: 'ON_HOLD', paymentTerms: 'prepaid',
      createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });
    const staffRelease = await postAs(staffToken, `/api/film-supply-orders/${orderId}/hold-release`, {
      reason: 'staff cannot release', resumeStatus: 'MAKER_PO_READY'
    });
    expect(staffRelease.status).toBe(403);
    const missingResume = await postAs(adminToken, `/api/film-supply-orders/${orderId}/hold-release`, { reason: 'legacy recovery' });
    expect(missingResume.status).toBe(422);
    expect(missingResume.body).toMatchObject({ code: 'HOLD_ORIGIN_UNKNOWN' });
    const unsafeResume = await postAs(adminToken, `/api/film-supply-orders/${orderId}/hold-release`, {
      reason: 'legacy recovery', resumeStatus: 'FILM_IN_PRODUCTION'
    });
    expect(unsafeResume.status).toBe(422);
    expect(unsafeResume.body).toMatchObject({ code: 'HOLD_RESUME_STATUS_INVALID' });
    const released = await postAs(adminToken, `/api/film-supply-orders/${orderId}/hold-release`, {
      reason: 'legacy recovery', resumeStatus: 'MAKER_PO_READY'
    });
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ status: 'MAKER_PO_READY', holdReason: null });
  });

  it('refuses a legacy maker-chain resume whose active paper lacks that evidence', async () => {
    const now = new Date();
    const orderId = uuidv7(now);
    const paperId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: 'FSO-LEGACY-HOLD-EVIDENCE', status: 'ON_HOLD', paymentTerms: 'prepaid',
      createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });
    await db.insert(makerPurchaseOrders).values({
      id: paperId, filmSupplyOrderId: orderId,
      snapshot: { order: { id: orderId }, items: [], artworkFiles: [], amounts: [] },
      snapshotSha256: 'b'.repeat(64), status: 'DRAFT', createdByUserId: adminId, createdAt: now, updatedAt: now
    });
    const refused = await postAs(adminToken, `/api/film-supply-orders/${orderId}/hold-release`, {
      reason: 'accepted paper claimed without evidence', resumeStatus: 'MAKER_PO_ACCEPTED'
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'HOLD_RESUME_EVIDENCE_MISMATCH' });
  });
});

describe('hold reason and audit labels', () => {
  it('rejects blank Unicode reasons and records an entering hold reason', async () => {
    const now = new Date();
    const orderId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: 'FSO-HOLD-REASON', status: 'DRAFT', paymentTerms: 'prepaid',
      createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });
    const blank = await postAs(adminToken, `/api/film-supply-orders/${orderId}/transitions`, {
      to: 'ON_HOLD', holdReason: '\u200b \t\n'
    });
    expect(blank.status).toBe(422);
    expect(blank.body).toMatchObject({ code: 'HOLD_REASON_REQUIRED' });
    for (const [label, hidden] of [
      ['U+3164', '\u3164'],
      ['U+115F', '\u115f'],
      ['U+2800', '\u2800'],
      ['combining mark', '\u1161'],
      ['variation selector', '\ufe0f']
    ] as const) {
      const rejected = await postAs(adminToken, `/api/film-supply-orders/${orderId}/transitions`, {
        to: 'ON_HOLD', holdReason: hidden
      });
      expect(rejected.status, `${label} is not visible content`).toBe(422);
      expect(rejected.body).toMatchObject({ code: 'HOLD_REASON_REQUIRED' });
    }
    const tooLong = await postAs(adminToken, `/api/film-supply-orders/${orderId}/transitions`, {
      to: 'ON_HOLD', holdReason: 'a'.repeat(1001)
    });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body).toMatchObject({ code: 'HOLD_REASON_TOO_LONG' });
    const held = await postAs(adminToken, `/api/film-supply-orders/${orderId}/transitions`, {
      to: 'ON_HOLD', holdReason: ' customer confirmation pending '
    });
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({ status: 'ON_HOLD', holdReason: 'customer confirmation pending' });
    const [enterAudit] = await db.select().from(auditEvents)
      .where(eq(auditEvents.entityId, orderId)).orderBy(sql`${auditEvents.occurredAt} desc`).limit(1);
    expect(enterAudit?.beforeState).toMatchObject({ status: 'DRAFT', holdReason: null });
    expect(enterAudit?.afterState).toMatchObject({ status: 'ON_HOLD', holdReason: 'customer confirmation pending' });
    const blankRelease = await postAs(adminToken, `/api/film-supply-orders/${orderId}/hold-release`, { reason: '\u200b\t ' });
    expect(blankRelease.status).toBe(422);
    expect(blankRelease.body).toMatchObject({ code: 'HOLD_RELEASE_REASON_REQUIRED' });
    const hiddenRelease = await postAs(adminToken, `/api/film-supply-orders/${orderId}/hold-release`, {
      reason: '\u3164\u2800\ufe0f'
    });
    expect(hiddenRelease.status).toBe(422);
    expect(hiddenRelease.body).toMatchObject({ code: 'HOLD_RELEASE_REASON_REQUIRED' });
    const wrongResume = await postAs(adminToken, `/api/film-supply-orders/${orderId}/hold-release`, {
      reason: 'origin is known', resumeStatus: 'MAKER_PO_READY'
    });
    expect(wrongResume.status).toBe(422);
    expect(wrongResume.body).toMatchObject({ code: 'HOLD_RESUME_STATUS_INVALID' });
    const released = await postAs(adminToken, `/api/film-supply-orders/${orderId}/hold-release`, {
      reason: 'customer confirmation received'
    });
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ status: 'DRAFT', holdReason: null });
    const [releaseAudit] = await db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'FILM_SUPPLY_ORDER_HOLD_RELEASED'))
      .orderBy(sql`${auditEvents.occurredAt} desc`).limit(1);
    expect(releaseAudit?.entityId).toBe(orderId);
    expect(releaseAudit?.requestMetadata).toMatchObject({ operation: 'film_order:release_hold', holdEventId: enterAudit?.id });
  });

  it('rejects U+FFA0, limits raw length, and preserves visible combining marks', async () => {
    const now = new Date();
    const orderId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: 'FSO-REASON-PRESERVE', status: 'DRAFT', paymentTerms: 'prepaid',
      holdReason: null, createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });

    const halfwidthFiller = await postAs(adminToken, `/api/film-supply-orders/${orderId}/transitions`, {
      to: 'ON_HOLD', holdReason: '\uFFA0'
    });
    expect(halfwidthFiller.status).toBe(422);
    expect(halfwidthFiller.body).toMatchObject({ code: 'HOLD_REASON_REQUIRED' });

    const rawTooLong = await postAs(adminToken, `/api/film-supply-orders/${orderId}/transitions`, {
      to: 'ON_HOLD', holdReason: `${'\u200b'.repeat(10000)}a`
    });
    expect(rawTooLong.status).toBe(422);
    expect(rawTooLong.body).toMatchObject({ code: 'HOLD_REASON_TOO_LONG' });

    const thai = 'กิ';
    const held = await postAs(adminToken, `/api/film-supply-orders/${orderId}/transitions`, {
      to: 'ON_HOLD', holdReason: 'waiting for Thai evidence'
    });
    expect(held.status).toBe(200);
    const released = await postAs(adminToken, `/api/film-supply-orders/${orderId}/hold-release`, {
      reason: `Thai visible: ${thai}`
    });
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ status: 'DRAFT' });
    const [event] = await db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'FILM_SUPPLY_ORDER_HOLD_RELEASED'))
      .orderBy(sql`${auditEvents.occurredAt} desc`).limit(1);
    expect(((event?.requestMetadata as { reason?: string }).reason ?? '').includes(thai)).toBe(true);
  });
});

describe('official-date write paths', () => {
  it('applies the common overwrite guard to promote-official', async () => {
    const now = new Date();
    const referenceId = uuidv7(now);
    await db.insert(preOrderReferences).values({
      id: referenceId, projectId, referenceCode: 'PRE-APPROVED-OVERWRITE', originalReceivedAt: now,
      createdByUserId: staffId, createdAt: now, updatedAt: now
    });
    await db.update(sevenPurchaseOrders).set({ preOrderReferenceId: referenceId })
      .where(eq(sevenPurchaseOrders.id, poId));
    const staffOverwrite = await postAs(staffToken, `/api/pre-order-references/${referenceId}/promote-official`, {
      officialRegisteredAt: '2025-01-01T00:00:00.000Z'
    });
    expect(staffOverwrite.status).toBe(403);
    const [afterStaff] = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, poId)).limit(1);
    expect(afterStaff?.officialRegisteredAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const adminOverwrite = await postAs(adminToken, `/api/pre-order-references/${referenceId}/promote-official`, {
      officialRegisteredAt: '2026-02-01T00:00:00.000Z'
    });
    expect(adminOverwrite.status).toBe(200);
    const [afterAdmin] = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, poId)).limit(1);
    expect(afterAdmin?.officialRegisteredAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    const [audit] = await db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'PRE_ORDER_PROMOTED_OFFICIAL'))
      .orderBy(sql`${auditEvents.occurredAt} desc`).limit(1);
    expect(audit?.requestMetadata).toMatchObject({ operation: 'pre_order:promote_official_overwrite' });
    expect(audit?.beforeState).toMatchObject({ officialRegisteredAt: '2026-01-01T00:00:00.000Z' });
    expect(audit?.afterState).toMatchObject({ officialRegisteredAt: '2026-02-01T00:00:00.000Z' });
  });

  it('still lets staff perform the first promote-official registration', async () => {
    const now = new Date();
    const referenceId = uuidv7(now);
    const promotedPoId = uuidv7(now);
    await db.insert(preOrderReferences).values({
      id: referenceId, projectId, referenceCode: 'PRE-APPROVED-FIRST', originalReceivedAt: now,
      createdByUserId: staffId, createdAt: now, updatedAt: now
    });
    await db.insert(sevenPurchaseOrders).values({
      id: promotedPoId, projectId, poNumber: 'PO-APPROVED-PROMOTE-FIRST', preOrderReferenceId: referenceId,
      originalReceivedAt: now, officialRegisteredAt: null, verificationStatus: 'verified', verifiedAt: now,
      verifiedByUserId: staffId, promotedAt: null, promotedByUserId: null, createdByUserId: staffId,
      createdAt: now, updatedAt: now
    });
    const promoted = await postAs(staffToken, `/api/pre-order-references/${referenceId}/promote-official`, {
      officialRegisteredAt: '2026-03-01T00:00:00.000Z'
    });
    expect(promoted.status).toBe(200);
    const [row] = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, promotedPoId)).limit(1);
    expect(row?.officialRegisteredAt?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('atomizes simultaneous first registrations and records before=null once', async () => {
    for (let round = 0; round < 5; round += 1) {
      const now = new Date();
      const atomicPoId = uuidv7(now);
      await db.insert(sevenPurchaseOrders).values({
        id: atomicPoId, projectId, poNumber: `PO-ATOMIC-${round}`, originalReceivedAt: now,
        officialRegisteredAt: null, createdByUserId: staffId, createdAt: now, updatedAt: now
      });
      const [first, second] = await Promise.all([
        postAs(staffToken, `/api/seven-purchase-orders/${atomicPoId}/register-official`, { officialRegisteredAt: '2026-04-01T00:00:00.000Z' }),
        postAs(staffToken, `/api/seven-purchase-orders/${atomicPoId}/register-official`, { officialRegisteredAt: '2026-04-02T00:00:00.000Z' })
      ]);
      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses[0]).toBe(200);
      // A loser that observed the committed date before entering is a normal
      // overwrite 403; one that entered with a stale null snapshot is a 409.
      expect([403, 409]).toContain(statuses[1]);
      const rows = await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.id, atomicPoId));
      expect(rows).toHaveLength(1);
      const winner = rows[0]!.officialRegisteredAt?.toISOString();
      expect(['2026-04-01T00:00:00.000Z', '2026-04-02T00:00:00.000Z']).toContain(winner);
      const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, atomicPoId));
      expect(events).toHaveLength(1);
      expect(events[0]!.beforeState).toMatchObject({ officialRegisteredAt: null });
      expect(events[0]!.afterState).toMatchObject({ officialRegisteredAt: winner });
    }
  });

  it('never turns a promote-official gate refusal inside the race into a null 200', async () => {
    const now = new Date();
    const referenceId = uuidv7(now);
    const racePoId = uuidv7(now);
    await db.insert(preOrderReferences).values({
      id: referenceId, projectId, referenceCode: 'PRE-APPROVED-RACE', originalReceivedAt: now,
      createdByUserId: staffId, createdAt: now, updatedAt: now
    });
    await db.insert(sevenPurchaseOrders).values({
      id: racePoId, projectId, poNumber: 'PO-APPROVED-PROMOTE-RACE', preOrderReferenceId: referenceId,
      originalReceivedAt: now, officialRegisteredAt: null, verificationStatus: 'verified', verifiedAt: now,
      verifiedByUserId: staffId, promotedAt: null, promotedByUserId: null, createdByUserId: staffId,
      createdAt: now, updatedAt: now
    });

    for (let round = 0; round < 5; round += 1) {
      const [promoted] = await Promise.all([
        postAs(staffToken, `/api/pre-order-references/${referenceId}/promote-official`, {
          officialRegisteredAt: '2026-05-01T00:00:00.000Z'
        }),
        db.update(sevenPurchaseOrders).set({ verificationStatus: 'unverified', verifiedAt: null, verifiedByUserId: null, reviewPending: true, reviewNote: 'race gate probe' })
          .where(eq(sevenPurchaseOrders.id, racePoId))
      ]);
      expect([409, 422]).toContain(promoted.status);
      expect(promoted.body, 'a refused race must never answer a null 200').toBeTruthy();
      const [row] = await db.select().from(sevenPurchaseOrders)
        .where(eq(sevenPurchaseOrders.id, racePoId)).limit(1);
      expect(row?.officialRegisteredAt).toBeNull();
      await db.update(sevenPurchaseOrders).set({
        verificationStatus: 'verified', verifiedAt: now, verifiedByUserId: staffId,
        reviewPending: false, reviewNote: null
      }).where(eq(sevenPurchaseOrders.id, racePoId));
    }
  });
  it('allows cleanup-only maker cancellation on frozen/closed orders without revival', async () => {
    const now = new Date();
    const cancelOrderId = uuidv7(now);
    const reviewOrderId = uuidv7(now);
    const paperId = uuidv7(now);
    const reviewPaperId = uuidv7(now);
    const revisionOrderId = uuidv7(now);
    await db.insert(filmSupplyOrders).values([
      {
        id: cancelOrderId, projectId, code: 'FSO-CANCELLED-PAPER', status: 'CANCELLED',
        paymentTerms: 'prepaid', createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
      },
      {
        id: reviewOrderId, projectId, code: 'FSO-CR-PAPER', status: 'CANCELLATION_REVIEW',
        paymentTerms: 'prepaid', createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
      },
      {
        id: revisionOrderId, projectId, code: 'FSO-CANCELLED-REVISION', status: 'CANCELLED',
        paymentTerms: 'prepaid', createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
      }
    ]);
    await db.insert(makerPurchaseOrders).values([
      {
        id: paperId, filmSupplyOrderId: cancelOrderId,
        snapshot: { order: { id: cancelOrderId }, items: [], artworkFiles: [], amounts: [] },
        snapshotSha256: 'f'.repeat(64), status: 'MAKER_PO_SENT_MANUALLY',
        ceoApprovedByUserId: adminId, ceoApprovedAt: now,
        createdByUserId: adminId, createdAt: now, updatedAt: now
      },
      {
        id: reviewPaperId, filmSupplyOrderId: reviewOrderId,
        snapshot: { order: { id: reviewOrderId }, items: [], artworkFiles: [], amounts: [] },
        snapshotSha256: 'e'.repeat(64), status: 'MAKER_PO_SENT_MANUALLY',
        ceoApprovedByUserId: adminId, ceoApprovedAt: now,
        createdByUserId: adminId, createdAt: now, updatedAt: now
      }
    ]);
    await db.insert(makerPoEvents).values([
      {
        id: uuidv7(now), makerPurchaseOrderId: paperId, eventType: 'CEO_APPROVED',
        verificationStatus: 'UNVERIFIED', recordedByUserId: adminId, recordedAt: now
      },
      {
        id: uuidv7(now), makerPurchaseOrderId: paperId, eventType: 'SEND_EVIDENCE_REGISTERED',
        verificationStatus: 'VERIFIED', recordedByUserId: staffId, recordedAt: now
      }
    ]);

    // The CANCELLED order owns its terminal status: cleanup is allowed, but no
    // mirror may revive it.
    const cancelled = await postAs(adminToken, `/api/maker-purchase-orders/${paperId}/cancel`, {
      note: 'review decision: close the obsolete paper'
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED' });
    const [paper] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, paperId)).limit(1);
    expect(paper?.status).toBe('CANCELLED');

    const acknowledgement = await postAs(adminToken, `/api/maker-purchase-orders/${paperId}/cancellation-acknowledgement`, {
      note: 'maker confirmed cancellation'
    });
    expect(acknowledgement.status).toBe(201);
    expect(acknowledgement.body).toMatchObject({ status: 'CANCELLED' });
    const [paperOrder] = await db.execute(sql`select status from film_supply_orders where id = ${cancelOrderId}`)
      .then((result) => result.rows as Array<{ status: string }>);
    expect(paperOrder?.status).toBe('CANCELLED');

    // CANCELLATION_REVIEW: remaining paper cleanup is still possible, with no
    // representative-owned state change.
    const closedCleanup = await postAs(adminToken, `/api/maker-purchase-orders/${reviewPaperId}/cancel`, {
      note: 'close paper left behind by the cancelled order'
    });
    expect(closedCleanup.status).toBe(200);
    expect(closedCleanup.body).toMatchObject({ status: 'CANCELLED' });
    const [closedPaper] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, reviewPaperId)).limit(1);
    expect(closedPaper?.status).toBe('CANCELLED');
    const [reviewOrder] = await db.execute(sql`select status from film_supply_orders where id = ${reviewOrderId}`)
      .then((result) => result.rows as Array<{ status: string }>);
    expect(reviewOrder?.status).toBe('CANCELLATION_REVIEW');

    // Progressive work is still frozen on CANCELLATION_REVIEW.
    const progressive = await postAs(adminToken, `/api/maker-purchase-orders/${reviewPaperId}/ceo-approval`, {});
    expect(progressive.status).toBe(409);
    expect(progressive.body).toMatchObject({ code: 'ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED' });

    const revision = await postAs(staffToken, `/api/film-supply-orders/${revisionOrderId}/artwork-revisions`, {
      designKey: 'label-front', fileDocumentVersionId: uuidv7(now)
    });
    expect(revision.status).toBe(409);
    expect(revision.body).toMatchObject({ code: 'FILM_ORDER_CANCELLED' });
    const [revisionOrder] = await db.execute(sql`select status from film_supply_orders where id = ${revisionOrderId}`)
      .then((result) => result.rows as Array<{ status: string }>);
    expect(revisionOrder?.status).toBe('CANCELLED');
    expect(await db.select().from(auditEvents)
      .where(eq(auditEvents.entityId, revisionOrderId))).toHaveLength(0);

    // Replacement remains frozen even after cleanup is complete.
    const replacement = await postAs(adminToken, `/api/film-supply-orders/${cancelOrderId}/maker-purchase-orders`, {
      recipientAddress: 'replacement@example.com'
    });
    expect(replacement.status).toBe(409);
    expect(replacement.body).toMatchObject({
      code: 'FILM_ORDER_CANCELLED_MAKER_PO_ACTION_BLOCKED',
      orderStatus: 'CANCELLED'
    });
    expect(await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, cancelOrderId))).toHaveLength(1);

    const [orderAuditCount] = await db.execute(sql`
      select count(*)::int as count
      from audit_events
      where action = 'FILM_SUPPLY_ORDER_TRANSITIONED'
        and entity_id in (${cancelOrderId}, ${reviewOrderId})
    `).then((result) => result.rows as Array<{ count: number }>);
    expect(orderAuditCount?.count).toBe(0);
  });

  it('rejects every side path to a closed film order without changing its status', async () => {
    const now = new Date();
    const orderId = uuidv7(now);
    await db.insert(filmSupplyOrders).values({
      id: orderId, projectId, code: 'FSO-CANCELLED-SIDES', status: 'CANCELLED',
      paymentTerms: 'prepaid', createdByUserId: adminId, createdAt: now, updatedAt: now, deletedAt: null
    });

    const probes = [
      () => postAs(staffToken, `/api/film-supply-orders/${orderId}/transitions`, { to: 'MAKER_PO_READY' }),
      () => postAs(adminToken, `/api/film-supply-orders/${orderId}/hold-release`, { reason: 'closed must not reopen' }),
      () => postAs(adminToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, { outcome: 'resume', reason: 'closed must not reopen' }),
      () => postAs(adminToken, `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, { outcome: 'cancel', reason: 'already closed' }),
      () => (async () => {
        const response = await app.request(`/api/film-supply-orders/${orderId}/payment-terms`, {
          method: 'PATCH', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${adminToken}` },
          body: JSON.stringify({ paymentTerms: 'on_delivery' })
        });
        return { status: response.status, body: await response.json() };
      })(),
      () => postAs(staffToken, `/api/film-supply-orders/${orderId}/lines`, {
        lineNumber: 2, description: 'cancelled order', orderedQuantity: 1, unit: 'sheets'
      }),
      () => postAs(staffToken, `/api/film-supply-orders/${orderId}/deliveries`, {
        lineNumber: 2, deliveredQuantity: 1, deliveredAt: '2026-11-18T00:00:00.000Z', lotNumber: 'CANCELLED'
      }),
      () => postAs(adminToken, `/api/film-supply-orders/${orderId}/receipt-assumption`, {
        assumedAt: '2026-11-18T00:00:00.000Z', note: 'cancelled order', acknowledgeNoEvidence: true
      })
    ];
    for (const [index, probe] of probes.entries()) {
      const response = await probe();
      expect(response.status, `side path ${index}`).toBe(409);
      expect(response.body).toMatchObject({ code: 'FILM_ORDER_CANCELLED' });
    }

    const [row] = await db.execute(sql`select status, payment_terms from film_supply_orders where id = ${orderId}`)
      .then((result) => result.rows as Array<{ status: string; payment_terms: string }>);
    expect(row?.status).toBe('CANCELLED');
    expect(row?.payment_terms).toBe('prepaid');
  });
});
