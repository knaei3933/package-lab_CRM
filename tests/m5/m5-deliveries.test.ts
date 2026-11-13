import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  auditEvents,
  commissionReadiness,
  createDatabase,
  deliveryConfirmations,
  filmSupplyOrders,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../../apps/api/src/auth.js';

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const viewerId = uuidv7();
const outsiderStaffId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();
const otherProjectId = uuidv7();
const readyProjectId = uuidv7();

let staffToken = '';
let viewerToken = '';
let outsiderToken = '';
let app: ReturnType<typeof createApp>;

let uniqueCounter = 0;
function nextTag(): string {
  uniqueCounter += 1;
  return String(uniqueCounter).padStart(4, '0');
}

function toBase64(text: string) {
  return Buffer.from(text, 'utf8').toString('base64');
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

async function postAs(token: string, url: string, body: unknown) {
  const response = await app.request(url, jsonPost(token, body));
  return { status: response.status, body: await response.json() };
}

async function postJson(url: string, body: unknown) {
  return await postAs(staffToken, url, body);
}

async function getAs(token: string, url: string) {
  const response = await app.request(url, { method: 'GET', headers: cookieHeader(token) });
  return { status: response.status, body: await response.json() };
}

async function getJson(url: string) {
  return await getAs(staffToken, url);
}

/** A complete human record of the seven checklist items (design section 5.10). */
function fullChecklist() {
  return {
    issuerNameRecorded: true,
    issuerName: '合成セブン化学事業M5',
    documentNumberRecorded: true,
    documentNumber: 'PO-2026-1111-05',
    issueDateRecorded: true,
    issueDate: '2026-11-11',
    sendingChannelRecorded: true,
    sendingChannel: '専用ポータル',
    pastTransactionCompared: true,
    pastTransactionNote: '過去3件の発注書と様式が一致',
    quoteCompared: true,
    quoteMatchesPo: true,
    quoteComparisonNote: '見積と仕様・数量・金額が一致',
    tamperHints: '',
    uncertain: false,
    confirmationReplyRecorded: false,
    confirmationReplyNote: '',
    verificationNote: '合成チェックリスト記録M5'
  };
}

/** PO that is both checklist-verified and officially registered (T-04/T-05). */
async function setupVerifiedPo(projectIdValue: string, tag: string) {
  const created = await postJson(`/api/projects/${projectIdValue}/seven-purchase-orders`, {
    poNumber: `SEVEN-M5-${tag}`,
    officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(created.status).toBe(201);
  const po = created.body as { id: string };

  const checklist = await postJson(`/api/seven-purchase-orders/${po.id}/verification-checklist`, fullChecklist());
  expect(checklist.status).toBe(200);
  const official = await postJson(`/api/seven-purchase-orders/${po.id}/register-official`, {
    officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(official.status).toBe(200);
  return po;
}

interface FillingDeliveryContext {
  orderId: string;
  deliveryId: string;
}

async function createFillingDelivery(projectIdValue: string, tag: string): Promise<FillingDeliveryContext> {
  const created = await postJson(`/api/projects/${projectIdValue}/filling-orders`, {
    code: `FILLO-M5-${tag}`,
    lines: [{ lineNumber: 1, description: '合成充填カプセルM5', orderedQuantity: 10000, unit: 'pods' }]
  });
  expect(created.status).toBe(201);
  const order = created.body as { id: string; lines: Array<{ id: string }> };
  const delivered = await postJson(`/api/filling-orders/${order.id}/deliveries`, {
    fillingOrderLineId: order.lines[0]!.id,
    deliveredQuantity: 9000,
    unit: 'pods',
    carrierReference: '合成運送M5'
  });
  expect(delivered.status).toBe(201);
  return { orderId: order.id, deliveryId: (delivered.body as { id: string }).id };
}

async function uploadAcceptanceEvidence(
  projectIdValue: string,
  overrides: Record<string, unknown> = {}
) {
  const tag = nextTag();
  const response = await postJson(`/api/projects/${projectIdValue}/documents`, {
    documentType: 'acceptance_evidence',
    issuerEntity: 'kanei',
    filename: `m5-accept-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: toBase64(`composite m5 acceptance evidence ${tag}\n`),
    ...overrides
  });
  expect(response.status).toBe(201);
  return response.body as { document: { id: string }; version: { id: string; sha256: string } };
}

async function verifyDocument(documentId: string, note: string) {
  const verified = await postJson(`/api/documents/${documentId}/verify`, {
    verificationStatus: 'verified',
    verificationNote: note
  });
  expect(verified.status).toBe(200);
}

interface ChainOrder {
  poId: string;
  orderId: string;
  firstLineId: string;
}

/**
 * Walks the whole normal chain over the API and stops right after reaching
 * targetStatus: verified PO, supply order, the chain up to APPROVAL_PENDING,
 * artwork revision, both approvals (the second one auto-advances the order to
 * DUAL_APPROVED, exactly like the M3 flow), then the rest of the chain. This is
 * the only helper that exercises the long chain; other tests seed composite
 * order states directly.
 */
async function createChainOrderAt(projectIdValue: string, tag: string, targetStatus: string): Promise<ChainOrder> {
  const po = await setupVerifiedPo(projectIdValue, tag);
  const created = await postJson(`/api/seven-purchase-orders/${po.id}/supply-orders`, {
    code: `FSO-M5-${tag}`,
    lines: [{ lineNumber: 1, description: '合成フィルム本体M5', orderedQuantity: 5000, unit: 'sheets' }]
  });
  expect(created.status).toBe(201);
  const order = created.body as { id: string; lines: Array<{ id: string }> };

  for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
    const transition = await postJson(`/api/film-supply-orders/${order.id}/transitions`, { to });
    expect(transition.status).toBe(200);
    if (to === targetStatus) {
      const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.id)).limit(1);
      expect(row?.status).toBe(targetStatus);
      return { poId: po.id, orderId: order.id, firstLineId: order.lines[0]!.id };
    }
  }

  const proof = await postJson(`/api/projects/${projectIdValue}/documents`, {
    documentType: 'proof',
    issuerEntity: 'kanei',
    filename: `m5-proof-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: toBase64(`composite m5 proof ${tag}\n`),
    sevenPurchaseOrderId: po.id,
    filmSupplyOrderId: order.id,
    designKey: 'label-front-m5'
  });
  expect(proof.status).toBe(201);
  const proofVersionId = (proof.body as { version: { id: string } }).version.id;
  const revision = await postJson(`/api/film-supply-orders/${order.id}/artwork-revisions`, {
    designKey: 'label-front-m5',
    fileDocumentVersionId: proofVersionId
  });
  expect(revision.status).toBe(201);
  const revisionId = (revision.body as { id: string }).id;

  for (const [organization, issuer] of [['customer', 'customer_generated'], ['seven', 'seven']] as const) {
    const evidence = await postJson(`/api/projects/${projectIdValue}/documents`, {
      documentType: 'approval_evidence',
      issuerEntity: issuer,
      filename: `m5-approval-${organization}-${tag}.txt`,
      contentType: 'text/plain',
      contentBase64: toBase64(`composite m5 approval evidence ${organization} ${tag}\n`),
      sevenPurchaseOrderId: po.id,
      filmSupplyOrderId: order.id,
      designKey: 'label-front-m5'
    });
    expect(evidence.status).toBe(201);
    const approval = await postJson(`/api/artwork-revisions/${revisionId}/approvals`, {
      organization,
      decision: 'APPROVE',
      evidenceSource: 'email',
      eventTime: '2026-11-10T10:00:00.000Z',
      evidenceDocumentVersionId: (evidence.body as { version: { id: string } }).version.id,
      externalApproverName: '合成承認者M5',
      externalApproverOrg: '合成承認組織M5'
    });
    expect(approval.status).toBe(201);
  }

  for (const to of [
    'MAKER_PO_READY',
    'APPROVED_FOR_MANUAL_SEND',
    'MAKER_PO_SENT_MANUALLY',
    'MAKER_PO_ACCEPTED',
    'FILM_IN_PRODUCTION',
    'FILM_SHIPPED',
    'FILM_DELIVERED'
  ]) {
    const transition = await postJson(`/api/film-supply-orders/${order.id}/transitions`, { to });
    expect(transition.status).toBe(200);
    if (to === targetStatus) break;
  }
  const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.id)).limit(1);
  expect(row?.status).toBe(targetStatus);
  return { poId: po.id, orderId: order.id, firstLineId: order.lines[0]!.id };
}

interface ReadinessResponse {
  filmDeliveryRecorded: boolean;
  fillingDeliveryRecorded: boolean;
  sevenPoOfficiallyRegistered: boolean;
  filmDeliveryConfirmed: boolean;
  fillingDeliveryConfirmed: boolean;
  readinessState: string;
  isReady: boolean;
  readyAt: string | null;
  commissionCalculationAllowed: boolean;
  blocking: string[];
}

async function evaluateReadiness(projectIdValue: string) {
  return await postJson(`/api/projects/${projectIdValue}/commission-readiness`, {});
}

async function confirmDelivery(url: string, body: Record<string, unknown>) {
  return await postJson(url, body);
}

/** The audit rows that name one entity, in recording order. */
async function auditRowsFor(entityType: string, entityId: string) {
  return await db.select().from(auditEvents)
    .where(and(eq(auditEvents.entityType, entityType), eq(auditEvents.entityId, entityId)))
    .orderBy(auditEvents.occurredAt, auditEvents.id);
}

async function assumptionAuditCount(orderId: string) {
  return (await auditRowsFor('film_supply_order', orderId))
    .filter((row) => row.action === 'FILM_RECEIPT_ASSUMPTION_RECORDED').length;
}

async function orderRow(orderId: string) {
  const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
  return row;
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-m5-deliveries-'));
  app = createApp({ db });

  await db.execute(sql`
    truncate table audit_events, delivery_confirmations, maker_po_events, maker_purchase_orders,
      artwork_revisions, artwork_approval_events, documents, document_versions, pre_order_references,
      seven_purchase_orders, film_supply_orders, film_supply_order_lines, film_deliveries,
      filling_orders, filling_order_lines, filling_deliveries, commission_readiness,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'admin_m5_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者M5', role: 'admin' },
    { id: staffId, username: 'staff_m5_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者M5', role: 'staff' },
    { id: viewerId, username: 'viewer_m5_test', passwordHash: await hashPassword('composite-viewer-pass'), displayName: '合成閲覧者M5', role: 'viewer' },
    { id: outsiderStaffId, username: 'outsider_m5_test', passwordHash: await hashPassword('composite-outsider-pass'), displayName: '合成部外担当M5', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成M5エンドカスタマー', role: 'end_customer', externalCode: 'TEST-M5-CUST' },
    { id: sevenAccountId, name: '合成M5セブン', role: 'seven', externalCode: 'TEST-M5-SEVEN' },
    { id: makerAccountId, name: '合成M5メーカー', role: 'maker', externalCode: 'TEST-M5-MAKER' }
  ]);
  await db.insert(projects).values([
    {
      id: projectId,
      code: 'TEST-M5-PROJECT',
      name: '合成M5案件',
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
    },
    {
      id: otherProjectId,
      code: 'TEST-M5-OTHER-PROJECT',
      name: '合成M5別案件',
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
    },
    {
      id: readyProjectId,
      code: 'TEST-M5-READY-PROJECT',
      name: '合成M5手数料準備案件',
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
    }
  ]);
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: staffId, projectId },
    { id: uuidv7(now), userId: staffId, projectId: otherProjectId },
    { id: uuidv7(now), userId: staffId, projectId: readyProjectId },
    { id: uuidv7(now), userId: viewerId, projectId }
  ]);
  for (const [name, userId] of [
    ['staff', staffId],
    ['admin', adminId],
    ['viewer', viewerId],
    ['outsider', outsiderStaffId]
  ] as const) {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({
      id: uuidv7(),
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    });
    if (name === 'staff') staffToken = token;
    if (name === 'viewer') viewerToken = token;
    if (name === 'outsider') outsiderToken = token;
  }
});

afterAll(async () => {
  await pool.end();
});

describe('M5 commission readiness and delivery confirmation (T-36)', () => {
  it('deliveries recorded without evidence stay pending confirmation and never escalate readiness', async () => {
    const initial = await evaluateReadiness(projectId);
    expect(initial.status).toBe(201);
    expect(initial.body).toMatchObject({
      filmDeliveryRecorded: false,
      fillingDeliveryRecorded: false,
      sevenPoOfficiallyRegistered: false,
      filmDeliveryConfirmed: false,
      fillingDeliveryConfirmed: false,
      readinessState: 'MISSING_DATA',
      isReady: false,
      commissionCalculationAllowed: false
    });
    expect((initial.body as ReadinessResponse).readyAt).toBeNull();

    await setupVerifiedPo(projectId, 'T36');
    await createFillingDelivery(projectId, 'T36');
    const chain = await createChainOrderAt(projectId, 'T36-CHAIN', 'FILM_DELIVERED');
    const filmDelivery = await postJson(`/api/film-supply-orders/${chain.orderId}/deliveries`, {
      filmSupplyOrderLineId: chain.firstLineId,
      deliveredQuantity: 5000,
      unit: 'sheets'
    });
    expect(filmDelivery.status).toBe(201);

    const pending = await evaluateReadiness(projectId);
    expect(pending.status).toBe(201);
    const pendingBody = pending.body as ReadinessResponse;
    expect(pendingBody).toMatchObject({
      filmDeliveryRecorded: true,
      fillingDeliveryRecorded: true,
      sevenPoOfficiallyRegistered: true,
      filmDeliveryConfirmed: false,
      fillingDeliveryConfirmed: false,
      readinessState: 'PENDING_VERIFICATION',
      isReady: false,
      commissionCalculationAllowed: false
    });
    expect(pendingBody.readyAt).toBeNull();
    expect(pendingBody.blocking).toEqual([
      'FILM_DELIVERY_PENDING_CONFIRMATION',
      'FILLING_DELIVERY_PENDING_CONFIRMATION'
    ]);

    // Recording deliveries never wrote a confirmation row and never moved the
    // stored readiness row: readiness moved only because this test called the
    // explicit evaluate endpoint (T-14/T-36).
    expect(await db.select().from(deliveryConfirmations)).toHaveLength(0);
    const [readinessRow] = await db.select().from(commissionReadiness)
      .where(eq(commissionReadiness.projectId, projectId)).limit(1);
    expect(readinessRow?.readinessState).toBe('PENDING_VERIFICATION');
    expect(readinessRow?.isReady).toBe(false);
    expect(readinessRow?.readyAt).toBeNull();
  });

  it('readiness reaches READY only once every delivery is confirmed with verified evidence', async () => {
    // A dedicated project keeps the evidence picture exact: one confirmed
    // filling delivery alone must not escalate readiness.
    const filling = await createFillingDelivery(readyProjectId, 'READY-F');
    const fillingPo = await setupVerifiedPo(readyProjectId, 'READY-PO');
    const fillingEvidence = await uploadAcceptanceEvidence(readyProjectId, { sevenPurchaseOrderId: fillingPo.id });
    await verifyDocument(fillingEvidence.document.id, '合成納品確認（READY充填）');
    const confirmedFilling = await confirmDelivery(
      `/api/filling-deliveries/${filling.deliveryId}/confirmation`,
      { evidenceDocumentVersionId: fillingEvidence.version.id }
    );
    expect(confirmedFilling.status).toBe(201);

    const stillPending = await evaluateReadiness(readyProjectId);
    const stillPendingBody = stillPending.body as ReadinessResponse;
    expect(stillPendingBody.fillingDeliveryConfirmed).toBe(true);
    expect(stillPendingBody.filmDeliveryConfirmed).toBe(false);
    expect(stillPendingBody.readinessState).toBe('PENDING_VERIFICATION');
    expect(stillPendingBody.isReady).toBe(false);
    expect(stillPendingBody.commissionCalculationAllowed).toBe(false);

    const chain = await createChainOrderAt(readyProjectId, 'READY-FILM', 'FILM_DELIVERED');
    const delivery = await postJson(`/api/film-supply-orders/${chain.orderId}/deliveries`, {
      filmSupplyOrderLineId: chain.firstLineId,
      deliveredQuantity: 800,
      unit: 'sheets'
    });
    expect(delivery.status).toBe(201);
    const filmEvidence = await uploadAcceptanceEvidence(readyProjectId, {
      sevenPurchaseOrderId: chain.poId,
      filmSupplyOrderId: chain.orderId
    });
    await verifyDocument(filmEvidence.document.id, '合成納品確認（READYフィルム）');
    const confirmedFilm = await confirmDelivery(
      `/api/film-deliveries/${(delivery.body as { id: string }).id}/confirmation`,
      { evidenceDocumentVersionId: filmEvidence.version.id }
    );
    expect(confirmedFilm.status).toBe(201);

    const ready = await evaluateReadiness(readyProjectId);
    expect(ready.status).toBe(201);
    const readyBody = ready.body as ReadinessResponse;
    expect(readyBody).toMatchObject({
      filmDeliveryRecorded: true,
      fillingDeliveryRecorded: true,
      sevenPoOfficiallyRegistered: true,
      filmDeliveryConfirmed: true,
      fillingDeliveryConfirmed: true,
      readinessState: 'READY',
      isReady: true,
      commissionCalculationAllowed: true
    });
    expect(readyBody.readyAt).not.toBeNull();
    expect(readyBody.blocking).toEqual([]);

    const [row] = await db.select().from(commissionReadiness)
      .where(eq(commissionReadiness.projectId, readyProjectId)).limit(1);
    expect(row?.readinessState).toBe('READY');
    expect(row?.isReady).toBe(true);
    const [audit] = await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityType, 'commission_readiness'),
      eq(auditEvents.entityId, readyProjectId),
      eq(auditEvents.action, 'COMMISSION_READINESS_EVALUATED')
    )).limit(1);
    expect(audit).toBeDefined();
  });

  it('a delivery is confirmed only by a verified acceptance evidence document', async () => {
    const filling = await createFillingDelivery(projectId, 'EV');
    const fillUrl = `/api/filling-deliveries/${filling.deliveryId}/confirmation`;
    const projectPo = await setupVerifiedPo(projectId, 'EV-PO');

    const missing = await confirmDelivery(fillUrl, {});
    expect(missing.status).toBe(422);
    expect((missing.body as { code: string }).code).toBe('DELIVERY_EVIDENCE_REQUIRED');

    const unknown = await confirmDelivery(fillUrl, {
      evidenceDocumentVersionId: '00000000-0000-7000-8000-000000000000'
    });
    expect(unknown.status).toBe(422);
    expect((unknown.body as { code: string }).code).toBe('DELIVERY_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND');

    const foreignPo = await setupVerifiedPo(otherProjectId, 'FOREIGN');
    const foreignDoc = await postAs(staffToken, `/api/projects/${otherProjectId}/documents`, {
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      filename: 'm5-foreign-acceptance.txt',
      contentType: 'text/plain',
      contentBase64: toBase64('composite foreign acceptance evidence\n'),
      sevenPurchaseOrderId: foreignPo.id
    });
    expect(foreignDoc.status).toBe(201);
    const foreignVersionId = (foreignDoc.body as { version: { id: string } }).version.id;
    const mismatched = await confirmDelivery(fillUrl, { evidenceDocumentVersionId: foreignVersionId });
    expect(mismatched.status).toBe(422);
    expect((mismatched.body as { code: string }).code).toBe('DELIVERY_EVIDENCE_PROJECT_MISMATCH');

    const wrongType = await postJson(`/api/projects/${projectId}/documents`, {
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      filename: `m5-send-${nextTag()}.txt`,
      contentType: 'text/plain',
      contentBase64: toBase64('composite wrong-type delivery evidence\n'),
      sevenPurchaseOrderId: projectPo.id
    });
    expect(wrongType.status).toBe(201);
    const wrongTypeId = (wrongType.body as { version: { id: string } }).version.id;
    const mistyped = await confirmDelivery(fillUrl, { evidenceDocumentVersionId: wrongTypeId });
    expect(mistyped.status).toBe(422);
    expect((mistyped.body as { code: string }).code).toBe('DELIVERY_EVIDENCE_DOCUMENT_TYPE_INVALID');

    const unverifiedDoc = await uploadAcceptanceEvidence(projectId, { sevenPurchaseOrderId: projectPo.id });
    const unverified = await confirmDelivery(fillUrl, { evidenceDocumentVersionId: unverifiedDoc.version.id });
    expect(unverified.status).toBe(422);
    expect((unverified.body as { code: string }).code).toBe('DELIVERY_EVIDENCE_NOT_VERIFIED');

    // None of the refusals persisted a confirmation for this delivery or escalated anything.
    expect(await db.select().from(deliveryConfirmations)
      .where(eq(deliveryConfirmations.fillingDeliveryId, filling.deliveryId))).toHaveLength(0);

    await verifyDocument(unverifiedDoc.document.id, '合成納品確認M5');
    const confirmed = await confirmDelivery(fillUrl, {
      evidenceDocumentVersionId: unverifiedDoc.version.id,
      note: '合成納品確認記録M5'
    });
    expect(confirmed.status).toBe(201);
    const confirmedBody = confirmed.body as {
      confirmation: { id: string; evidenceDocumentVersionId: string; deliveryKind: string };
      delivery: { id: string; kind: string; confirmationState: string };
      auditEventId: string;
    };
    expect(confirmedBody.confirmation.deliveryKind).toBe('filling');
    expect(confirmedBody.confirmation.evidenceDocumentVersionId).toBe(unverifiedDoc.version.id);
    expect(confirmedBody.delivery.confirmationState).toBe('CONFIRMED');

    const again = await confirmDelivery(fillUrl, { evidenceDocumentVersionId: unverifiedDoc.version.id });
    expect(again.status).toBe(422);
    expect((again.body as { code: string }).code).toBe('DELIVERY_ALREADY_CONFIRMED');

    const [audit] = await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityType, 'delivery_confirmation'),
      eq(auditEvents.entityId, confirmedBody.confirmation.id)
    )).limit(1);
    expect(audit?.action).toBe('FILLING_DELIVERY_CONFIRMED');
    expect(audit?.actorUserId).toBe(staffId);
    expect(audit?.id).toBe(confirmedBody.auditEventId);
    expect((audit?.afterState as { evidenceDocumentVersionId: string }).evidenceDocumentVersionId)
      .toBe(unverifiedDoc.version.id);

    await expect(db.update(deliveryConfirmations)
      .set({ note: '改ざん' })
      .where(eq(deliveryConfirmations.id, confirmedBody.confirmation.id)))
      .rejects.toThrow(/append-only/);
    await expect(db.delete(deliveryConfirmations)
      .where(eq(deliveryConfirmations.id, confirmedBody.confirmation.id)))
      .rejects.toThrow(/append-only/);
  });

  it('a film delivery confirmation demands evidence bound to its own film supply order', async () => {
    const chain = await createChainOrderAt(projectId, 'FILM-EV', 'FILM_DELIVERED');
    const delivery = await postJson(`/api/film-supply-orders/${chain.orderId}/deliveries`, {
      filmSupplyOrderLineId: chain.firstLineId,
      deliveredQuantity: 1200,
      unit: 'sheets'
    });
    expect(delivery.status).toBe(201);
    const filmUrl = `/api/film-deliveries/${(delivery.body as { id: string }).id}/confirmation`;

    const unbound = await uploadAcceptanceEvidence(projectId, { sevenPurchaseOrderId: chain.poId });
    await verifyDocument(unbound.document.id, '合成納品確認（他発注分）');
    const orderMismatch = await confirmDelivery(filmUrl, { evidenceDocumentVersionId: unbound.version.id });
    expect(orderMismatch.status).toBe(422);
    expect((orderMismatch.body as { code: string }).code).toBe('DELIVERY_EVIDENCE_ORDER_MISMATCH');

    const bound = await uploadAcceptanceEvidence(projectId, {
      sevenPurchaseOrderId: chain.poId,
      filmSupplyOrderId: chain.orderId
    });
    await verifyDocument(bound.document.id, '合成納品確認（本発注分）');
    const confirmed = await confirmDelivery(filmUrl, { evidenceDocumentVersionId: bound.version.id });
    expect(confirmed.status).toBe(201);
    const confirmedBody = confirmed.body as { confirmation: { id: string }; delivery: { confirmationState: string } };
    expect(confirmedBody.delivery.confirmationState).toBe('CONFIRMED');
    const [audit] = await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityType, 'delivery_confirmation'),
      eq(auditEvents.entityId, confirmedBody.confirmation.id)
    )).limit(1);
    expect(audit?.action).toBe('FILM_DELIVERY_CONFIRMED');
  });
});

describe('M5 manual film receipt assumption', () => {
  it('records the assumption only from FILM_DELIVERED, with note, acknowledgment and audit row', async () => {
    const chain = await createChainOrderAt(projectId, 'RA-HAPPY', 'FILM_DELIVERED');
    const orderId = chain.orderId;
    const url = `/api/film-supply-orders/${orderId}/receipt-assumption`;

    // The generic transition endpoint refuses the terminal state: the
    // assumption is reachable only through this recording action.
    const generic = await postJson(`/api/film-supply-orders/${orderId}/transitions`, {
      to: 'FILM_RECEIPT_ASSUMED_NO_ISSUE'
    });
    expect(generic.status).toBe(422);
    expect((generic.body as { code: string }).code).toBe('RECEIPT_ASSUMPTION_ACTION_REQUIRED');
    expect((await orderRow(orderId))?.status).toBe('FILM_DELIVERED');

    const noNote = await postJson(url, { acknowledgeNoEvidence: true });
    expect(noNote.status).toBe(422);
    expect((noNote.body as { code: string }).code).toBe('RECEIPT_ASSUMPTION_NOTE_REQUIRED');

    const noAcknowledgment = await postJson(url, { note: '合成メモ' });
    expect(noAcknowledgment.status).toBe(422);
    expect((noAcknowledgment.body as { code: string }).code).toBe('RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED');

    const badDate = await postJson(url, { note: '合成メモ', acknowledgeNoEvidence: true, assumedAt: 'nope' });
    expect(badDate.status).toBe(422);
    expect((badDate.body as { code: string }).code).toBe('INVALID_RECEIPT_ASSUMED_AT');

    // None of the refusals recorded an assumption.
    expect(await assumptionAuditCount(orderId)).toBe(0);

    const recorded = await postJson(url, {
      note: '受領待機期間は未確定のため、問題なしとみなして受領を記録する（合成）',
      acknowledgeNoEvidence: true,
      assumedAt: '2026-11-12T09:00:00.000Z'
    });
    expect(recorded.status).toBe(200);
    const recordedBody = recorded.body as {
      status: string;
      previousStatus: string;
      receiptAssumedAt: string;
      receiptAssumedNote: string;
      receiptAssumedByUserId: string;
      evidenceFreeAcknowledgment: boolean;
      auditEventId: string;
    };
    expect(recordedBody.status).toBe('FILM_RECEIPT_ASSUMED_NO_ISSUE');
    expect(recordedBody.previousStatus).toBe('FILM_DELIVERED');
    expect(recordedBody.receiptAssumedAt).toBe('2026-11-12T09:00:00.000Z');
    expect(recordedBody.receiptAssumedByUserId).toBe(staffId);
    expect(recordedBody.evidenceFreeAcknowledgment).toBe(true);

    const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    expect(row?.status).toBe('FILM_RECEIPT_ASSUMED_NO_ISSUE');
    expect(row?.receiptAssumedAt).not.toBeNull();
    expect(row?.receiptAssumedByUserId).toBe(staffId);
    expect(row?.receiptAssumedNote).toContain('受領待機期間');

    // The audit row was written in the same transaction as the transition.
    const assumptionAudits = await auditRowsFor('film_supply_order', orderId);
    const assumptionAudit = assumptionAudits.find((auditRow) => auditRow.action === 'FILM_RECEIPT_ASSUMPTION_RECORDED');
    expect(assumptionAudit).toBeDefined();
    expect(assumptionAudit?.id).toBe(recordedBody.auditEventId);
    expect(assumptionAudit?.actorUserId).toBe(staffId);
    expect(assumptionAudit?.beforeState).toMatchObject({ status: 'FILM_DELIVERED' });
    expect(assumptionAudit?.afterState).toMatchObject({
      status: 'FILM_RECEIPT_ASSUMED_NO_ISSUE',
      evidenceFreeAcknowledgment: true
    });

    // The terminal state accepts nothing anymore, including a second assumption.
    const second = await postJson(url, { note: '合成メモ2', acknowledgeNoEvidence: true });
    expect(second.status).toBe(422);
    expect((second.body as { code: string }).code).toBe('RECEIPT_ASSUMPTION_ONLY_FROM_FILM_DELIVERED');
    expect((await orderRow(orderId))?.status).toBe('FILM_RECEIPT_ASSUMED_NO_ISSUE');
    expect(await assumptionAuditCount(orderId)).toBe(1);
  });

  it('refuses the assumption from every state other than FILM_DELIVERED', async () => {
    const shipped = await createChainOrderAt(projectId, 'RA-SHIPPED', 'FILM_SHIPPED');
    const early = await postJson(`/api/film-supply-orders/${shipped.orderId}/receipt-assumption`, {
      note: '合成メモ（早期）',
      acknowledgeNoEvidence: true
    });
    expect(early.status).toBe(422);
    expect((early.body as { code: string }).code).toBe('RECEIPT_ASSUMPTION_ONLY_FROM_FILM_DELIVERED');
    expect((await orderRow(shipped.orderId))?.status).toBe('FILM_SHIPPED');

    // Exception states are composite test data: a held order cannot assume a
    // receipt either.
    const delivered = await createChainOrderAt(projectId, 'RA-HELD', 'FILM_DELIVERED');
    await db.update(filmSupplyOrders)
      .set({ status: 'ON_HOLD' })
      .where(eq(filmSupplyOrders.id, delivered.orderId));
    const held = await postJson(`/api/film-supply-orders/${delivered.orderId}/receipt-assumption`, {
      note: '合成メモ（保留中）',
      acknowledgeNoEvidence: true
    });
    expect(held.status).toBe(422);
    expect((held.body as { code: string }).code).toBe('RECEIPT_ASSUMPTION_ONLY_FROM_FILM_DELIVERED');
    expect((await orderRow(delivered.orderId))?.status).toBe('ON_HOLD');

    for (const orderId of [shipped.orderId, delivered.orderId]) {
      expect(await assumptionAuditCount(orderId)).toBe(0);
    }
  });

  it('nothing schedules the assumption: the order stays FILM_DELIVERED until a human records it', async () => {
    const chain = await createChainOrderAt(projectId, 'RA-TIMER', 'FILM_DELIVERED');
    const orderId = chain.orderId;

    // Read traffic and an explicit readiness evaluation happen; no timer, no
    // cron, no derived transition may move the order on its own.
    await getJson('/api/status-labels');
    await getJson(`/api/projects/${projectId}/audit-history`);
    await evaluateReadiness(projectId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
    expect(row?.status).toBe('FILM_DELIVERED');
    expect(row?.receiptAssumedAt).toBeNull();
    expect(row?.receiptAssumedByUserId).toBeNull();
    expect(row?.receiptAssumedNote).toBeNull();
  });
});

describe('M5 Japanese status labels endpoint', () => {
  it('is session-gated and serves the complete Japanese surface', async () => {
    const anonymous = await app.request('/api/status-labels');
    expect(anonymous.status).toBe(401);

    const response = await getJson('/api/status-labels');
    expect(response.status).toBe(200);
    const surface = response.body as {
      filmSupplyOrderStates: Array<{ key: string; label: string }>;
      makerPurchaseOrderStatuses: Array<{ key: string; label: string }>;
      commissionReadinessStates: Array<{ key: string; label: string }>;
      fillingDeliveryConfirmationStates: Array<{ key: string; label: string }>;
      approvalOrganizations: Array<{ key: string; label: string }>;
    };
    expect(surface.filmSupplyOrderStates).toHaveLength(17);
    expect(surface.makerPurchaseOrderStatuses).toHaveLength(6);
    expect(surface.commissionReadinessStates).toHaveLength(3);
    expect(surface.fillingDeliveryConfirmationStates).toHaveLength(2);
    expect(surface.approvalOrganizations).toHaveLength(2);

    const labels = [
      ...surface.filmSupplyOrderStates,
      ...surface.makerPurchaseOrderStatuses,
      ...surface.commissionReadinessStates,
      ...surface.fillingDeliveryConfirmationStates,
      ...surface.approvalOrganizations
    ].map((entry) => entry.label);
    for (const expected of [
      'セブン化学発注書確認済',
      'デザインデータ受領',
      '校了（顧客）',
      '校了（セブン化学）',
      '製造先発注承認待ち',
      '送信確認待ち',
      'フィルム納品完了',
      '充填製品納品確認待ち'
    ]) {
      expect(labels).toContain(expected);
    }
    for (const entry of labels) {
      expect(entry).toMatch(/[぀-ヿ一-鿿]/);
    }
  });
});

describe('M5 audit history endpoint', () => {
  it('is access-controlled: anonymous 401, unassigned staff 403, unknown project 404', async () => {
    const anonymous = await app.request(`/api/projects/${projectId}/audit-history`);
    expect(anonymous.status).toBe(401);

    const outsider = await getAs(outsiderToken, `/api/projects/${projectId}/audit-history`);
    expect(outsider.status).toBe(403);

    const viewer = await getAs(viewerToken, `/api/projects/${projectId}/audit-history`);
    expect(viewer.status).toBe(200);

    const unknown = await getJson('/api/projects/00000000-0000-7000-8000-000000000000/audit-history');
    expect(unknown.status).toBe(404);
  });

  it('lists audit_events for one order with before/after states, actor and time', async () => {
    const chain = await createChainOrderAt(projectId, 'AUDIT', 'FILM_DELIVERED');
    await postJson(`/api/film-supply-orders/${chain.orderId}/receipt-assumption`, {
      note: '合成監査用の受領記録',
      acknowledgeNoEvidence: true
    });

    const response = await getJson(
      `/api/projects/${projectId}/audit-history?entityType=film_supply_order&entityId=${chain.orderId}`
    );
    expect(response.status).toBe(200);
    const body = response.body as {
      projectId: string;
      count: number;
      events: Array<{
        action: string;
        entityType: string;
        entityId: string;
        beforeState: Record<string, unknown> | null;
        afterState: Record<string, unknown> | null;
        occurredAt: string;
        actor: { id: string; displayName: string; role: string } | null;
      }>;
    };
    expect(body.projectId).toBe(projectId);
    expect(body.count).toBe(body.events.length);
    expect(body.events.length).toBeGreaterThan(0);
    for (const event of body.events) {
      expect(event.entityType).toBe('film_supply_order');
      expect(event.entityId).toBe(chain.orderId);
      expect(event.occurredAt).toBeTruthy();
      expect(event.actor).toMatchObject({ id: staffId, role: 'staff' });
    }
    const actions = body.events.map((event) => event.action);
    expect(actions[0]).toBe('FILM_SUPPLY_ORDER_CREATED');
    expect(actions).toContain('FILM_SUPPLY_ORDER_TRANSITIONED');
    expect(actions).toContain('FILM_RECEIPT_ASSUMPTION_RECORDED');
    const assumption = body.events.find((event) => event.action === 'FILM_RECEIPT_ASSUMPTION_RECORDED')!;
    expect(assumption.beforeState).toMatchObject({ status: 'FILM_DELIVERED' });
    expect(assumption.afterState).toMatchObject({ status: 'FILM_RECEIPT_ASSUMED_NO_ISSUE' });

    // The events are listed in recording order (time then id).
    const times = body.events.map((event) => new Date(event.occurredAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('never returns another project’s audit rows', async () => {
    const foreignPo = await setupVerifiedPo(otherProjectId, 'AUDIT-F');
    const foreignRows = await db.select().from(auditEvents)
      .where(eq(auditEvents.entityId, foreignPo.id));
    expect(foreignRows.length).toBeGreaterThan(0);

    const own = await getJson(`/api/projects/${projectId}/audit-history?limit=500`);
    expect(own.status).toBe(200);
    const events = (own.body as { events: Array<{ entityId: string }> }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.entityId === foreignPo.id)).toBe(false);

    const other = await getJson(`/api/projects/${otherProjectId}/audit-history`);
    expect(other.status).toBe(200);
    const otherEvents = (other.body as { events: Array<{ entityId: string }> }).events;
    expect(otherEvents.some((event) => event.entityId === foreignPo.id)).toBe(true);
    expect(otherEvents.some((event) => event.entityType === 'film_supply_order')).toBe(false);
  });
});
