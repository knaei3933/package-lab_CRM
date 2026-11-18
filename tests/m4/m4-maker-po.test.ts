import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  auditEvents,
  createDatabase,
  documents,
  documentVersions,
  filmSupplyOrderLines,
  filmSupplyOrders,
  makerPoEvents,
  makerPurchaseOrders,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../../apps/api/src/auth.js';
import { plausibleTestSentAt, sendMakerPoEmlEvidence } from '../helpers/maker-po-evidence.js';

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();

let staffToken = '';
let adminToken = '';
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

/**
 * A body that does not parse as JSON is an unhandled endpoint failure (Hono's
 * default answer is the plain text "Internal Server Error" with no handler
 * stack), not a business refusal. Naming the endpoint and the body here is what
 * turns a bare `SyntaxError: Unexpected token 'I'` from an order-dependent
 * failure into a one-line pointer at the culprit route.
 */
async function parseJsonResponse(
  method: string,
  url: string,
  response: { status: number; text(): Promise<string> }
) {
  const raw = await response.text();
  try {
    return { status: response.status, body: JSON.parse(raw) };
  } catch {
    throw new Error(
      `${method} ${url} answered HTTP ${response.status} with a non-JSON body: ${raw.slice(0, 300)}`
    );
  }
}

async function postAs(token: string, url: string, body: unknown) {
  const response = await app.request(url, jsonPost(token, body));
  return await parseJsonResponse('POST', url, response);
}

async function postJson(url: string, body: unknown) {
  return await postAs(staffToken, url, body);
}

async function getJson(url: string) {
  const response = await app.request(url, { method: 'GET', headers: cookieHeader(staffToken) });
  return await parseJsonResponse('GET', url, response);
}

/** A complete human record of the seven checklist items (design section 5.10). */
function fullChecklist(overrides: Record<string, unknown> = {}) {
  return {
    issuerNameRecorded: true,
    issuerName: '合成セブン化学事業',
    documentNumberRecorded: true,
    documentNumber: 'PO-2026-1111-01',
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
    verificationNote: '合成チェックリスト記録',
    ...overrides
  };
}

/** PO that is both checklist-verified and officially registered (T-04/T-05/T-06). */
async function setupVerifiedPo(projectId: string, tag: string) {
  const created = await postJson(`/api/projects/${projectId}/seven-purchase-orders`, {
    poNumber: `SEVEN-M4-${tag}`
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

interface SupplyOrder {
  poId: string;
  orderId: string;
  /**
   * M8-HARDEN2 FIX 1: the bytes the approved artwork revision freezes, so a
   * send .eml can attach exactly them — the only attachment a VERIFIED send
   * accepts.
   */
  artworkBytes: string;
}

async function uploadBoundDocument(
  order: Pick<SupplyOrder, 'poId' | 'orderId'>,
  projectId: string,
  overrides: Record<string, unknown> = {}
) {
  const tag = nextTag();
  const content = `composite m4 document bytes ${tag}\n`;
  const body = {
    documentType: 'proof',
    issuerEntity: 'kanei',
    filename: `m4-doc-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: toBase64(content),
    ...overrides
  };
  const response = await postJson(`/api/projects/${projectId}/documents`, body);
  expect(response.status).toBe(201);
  return {
    ...(response.body as { document: { id: string }; version: { id: string; sha256: string } }),
    bytes: content
  };
}

/** Uploads an order-level evidence document (send / acceptance evidence). */
async function uploadOrderEvidence(
  order: SupplyOrder,
  projectId: string,
  documentType: 'send_evidence' | 'acceptance_evidence',
  tag: string,
  makerPoId?: string
) {
  return await uploadBoundDocument(order, projectId, {
    documentType,
    issuerEntity: 'kanei',
    sevenPurchaseOrderId: order.poId,
    filmSupplyOrderId: order.orderId,
    // M8-HARDEN FIX B2 (d): acceptance evidence names the paper it closes.
    ...(makerPoId ? { makerPurchaseOrderId: makerPoId } : {})
  });
}

/** Registers the current revision of one design from a freshly uploaded proof. */
async function registerDesignRevision(order: { poId: string; orderId: string }, projectId: string, designKey: string) {
  const proof = await uploadBoundDocument(order, projectId, {
    documentType: 'proof',
    issuerEntity: 'kanei',
    sevenPurchaseOrderId: order.poId,
    filmSupplyOrderId: order.orderId,
    designKey
  });
  const registered = await postJson(`/api/film-supply-orders/${order.orderId}/artwork-revisions`, {
    designKey,
    fileDocumentVersionId: proof.version.id
  });
  expect(registered.status).toBe(201);
  return {
    proofVersionId: proof.version.id,
    fileSha256: proof.version.sha256,
    /** The proof bytes themselves: the attachment a VERIFIED send has to carry. */
    artworkBytes: proof.bytes,
    revision: registered.body as { id: string; revisionNo: number }
  };
}

function approvalBody(overrides: Record<string, unknown> = {}) {
  const organization = typeof overrides.organization === 'string' ? overrides.organization : 'customer';
  return {
    organization,
    decision: 'APPROVE',
    evidenceSource: 'email',
    eventTime: '2026-11-10T10:00:00.000Z',
    // M7 security fix S2: each organization carries its own evidence identifier.
    evidenceIdentifier: `MSG-M4-${organization.toUpperCase()}-0001`,
    externalApproverName: '合成承認者',
    externalApproverOrg: '合成エンドカスタマー',
    ...overrides
  };
}

async function recordApproval(revisionId: string, overrides: Record<string, unknown> = {}) {
  return await postJson(`/api/artwork-revisions/${revisionId}/approvals`, approvalBody(overrides));
}

async function uploadApprovalEvidence(order: SupplyOrder, projectId: string, designKey: string, issuer: string) {
  // M7-SEC3 FIX 1: the evidence identifier must be derivable from the cited
  // evidence content, so the synthetic evidence quotes the identifier that
  // approvalBody registers the approval with.
  const organization = issuer === 'seven' ? 'seven' : 'customer';
  const identifier = `MSG-M4-${organization.toUpperCase()}-0001`;
  return await uploadBoundDocument(order, projectId, {
    documentType: 'approval_evidence',
    issuerEntity: issuer,
    sevenPurchaseOrderId: order.poId,
    filmSupplyOrderId: order.orderId,
    designKey,
    contentBase64: toBase64(`composite m4 approval evidence\nidentifier: ${identifier}\n`)
  });
}

/**
 * An order whose purchase order is verified, whose artwork is dual approved,
 * and whose state sits at MAKER_PO_READY with two lines on it.
 */
async function createMakerPoReadyOrder(projectId: string, tag: string): Promise<SupplyOrder> {
  const po = await setupVerifiedPo(projectId, tag);
  const created = await postJson(`/api/seven-purchase-orders/${po.id}/supply-orders`, {
    code: `FSO-M4-${tag}`,
    // M7-SEC3 FIX 3: this helper walks the chain into the maker PO CEO approval,
    // so the G6 transaction terms must be settled up front.
    paymentTerms: 'prepaid',
    lines: [
      { lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 100000, unit: 'sheets' },
      { lineNumber: 2, description: '合成台紙', orderedQuantity: 50, unit: 'rolls' }
    ]
  });
  expect(created.status).toBe(201);
  const order = created.body as { id: string };
  for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
    const transition = await postJson(`/api/film-supply-orders/${order.id}/transitions`, { to });
    expect(transition.status).toBe(200);
  }
  const registered = await registerDesignRevision({ poId: po.id, orderId: order.id }, projectId, 'label-front');
  const supplyOrder: SupplyOrder = { poId: po.id, orderId: order.id, artworkBytes: registered.artworkBytes };
  const customerEvidence = await uploadApprovalEvidence(supplyOrder, projectId, 'label-front', 'customer_generated');
  const customerApproval = await recordApproval(registered.revision.id, {
    evidenceDocumentVersionId: customerEvidence.version.id
  });
  expect(customerApproval.status).toBe(201);
  const sevenEvidence = await uploadApprovalEvidence(supplyOrder, projectId, 'label-front', 'seven');
  const sevenApproval = await recordApproval(registered.revision.id, {
    organization: 'seven',
    evidenceDocumentVersionId: sevenEvidence.version.id
  });
  expect(sevenApproval.status).toBe(201);
  expect(sevenApproval.body.dualApproved).toBe(true);

  const ready = await postJson(`/api/film-supply-orders/${order.id}/transitions`, { to: 'MAKER_PO_READY' });
  expect(ready.status).toBe(200);
  return supplyOrder;
}

interface MakerPoResponse {
  id: string;
  filmSupplyOrderId: string;
  snapshot: {
    order: { id: string; code: string; sevenPoNumber: string | null };
    items: Array<{ lineNumber: number; description: string; orderedQuantity: string; unit: string }>;
    quantities: Array<{ lineNumber: number; orderedQuantity: string; unit: string }>;
    specs: { artworkFiles: Array<{ designKey: string; revisionNo: number; fileSha256: string }> };
    amounts: { currency: string; totalAmount: string } | null;
    recipient: { address: string };
  };
  snapshotSha256: string;
  status: string;
  ceoApprovedByUserId: string | null;
  ceoApprovedAt: string | null;
}

async function createMakerPo(orderId: string) {
  // M8-OPERATOR FIX 2: freezing the maker paper is the representative's act, so
  // the chain walks use the admin token from here on.
  const created = await postAs(adminToken, `/api/film-supply-orders/${orderId}/maker-purchase-orders`, {
    recipientAddress: 'maker-po@example.com',
    amounts: { currency: 'JPY', totalAmount: '480000' }
  });
  expect(created.status).toBe(201);
  return created.body as MakerPoResponse;
}

async function approveMakerPo(poId: string) {
  return await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {});
}

interface EventRow {
  id: string;
  eventType: string;
  evidenceDocumentVersionId: string | null;
  senderAddress: string | null;
  recipients: Array<string> | null;
  sentAt: string | null;
  attachmentHashes: Array<string> | null;
  verificationStatus: string;
  recordedByUserId: string;
}

async function sendEvidence(
  poId: string,
  body: Record<string, unknown>
) {
  return await postJson(`/api/maker-purchase-orders/${poId}/send-evidence`, body);
}

/** M8-OPERATOR FIX 2: the final acceptance is recorded by the representative. */
async function acceptEvidence(
  poId: string,
  body: Record<string, unknown>
) {
  return await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, body);
}

async function listEvents(poId: string) {
  const rows = await db.select().from(makerPoEvents)
    .where(eq(makerPoEvents.makerPurchaseOrderId, poId))
    .orderBy(makerPoEvents.recordedAt, makerPoEvents.id);
  return rows as unknown as EventRow[];
}

async function makerPoRow(poId: string) {
  const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)).limit(1);
  return row;
}

async function orderRow(orderId: string) {
  const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
  return row;
}

/** Reaches APPROVED_FOR_MANUAL_SEND with a valid send evidence document ready. */
async function reachApprovedMakerPo(projectId: string, tag: string) {
  const order = await createMakerPoReadyOrder(projectId, tag);
  const po = await createMakerPo(order.orderId);
  const approval = await approveMakerPo(po.id);
  expect(approval.status).toBe(200);
  return { order, po };
}

async function reachSentMakerPo(projectId: string, tag: string) {
  const context = await reachApprovedMakerPo(projectId, tag);
  // M8-HARDEN FIX C1: the send evidence is the original .eml of the
  // production-order mail, verified as an email. M8-HARDEN2 FIX 1: the mail
  // carries the approved artwork, which is what a VERIFIED send requires.
  const sent = await sendMakerPoEmlEvidence(
    (url, body) => postAs(staffToken, url, body),
    context.po.id,
    { orderCode: `FSO-M4-${tag}`, attachmentBytes: context.order.artworkBytes }
  );
  expect(sent.status).toBe(200);
  expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');
  return context;
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-m4-maker-po-'));
  app = createApp({ db });

  await db.execute(sql`
    truncate table audit_events, maker_po_events, maker_purchase_orders, artwork_revisions,
      artwork_approval_events, documents, document_versions, pre_order_references,
      seven_purchase_orders, film_supply_orders, film_supply_order_lines, film_deliveries,
      filling_orders, filling_order_lines, filling_deliveries, commission_readiness,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'admin_m4_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者M4', role: 'admin' },
    { id: staffId, username: 'staff_m4_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者M4', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成M4エンドカスタマー', role: 'end_customer', externalCode: 'TEST-M4-CUST' },
    { id: sevenAccountId, name: '合成M4セブン', role: 'seven', externalCode: 'TEST-M4-SEVEN' },
    { id: makerAccountId, name: '合成M4メーカー', role: 'maker', externalCode: 'TEST-M4-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'TEST-M4-PROJECT',
    name: '合成M4案件',
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
  });
  await db.insert(projectAssignments).values({ id: uuidv7(now), userId: staffId, projectId });
  staffToken = await (async () => {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({
      id: uuidv7(),
      userId: staffId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    });
    return token;
  })();
  adminToken = await (async () => {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({
      id: uuidv7(),
      userId: adminId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    });
    return token;
  })();
});

afterAll(async () => {
  await pool.end();
});

describe('M4 maker purchase orders with manual-send evidence', () => {
  it('T-20 freezes the maker paper, requires the CEO approval, and records the manual-send trail', async () => {
    const order = await createMakerPoReadyOrder(projectId, 'T20');
    const po = await createMakerPo(order.orderId);

    expect(po.status).toBe('DRAFT');
    expect(po.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(po.snapshot.order.id).toBe(order.orderId);
    expect(po.snapshot.recipient.address).toBe('maker-po@example.com');
    expect(po.snapshot.quantities).toEqual([
      { lineNumber: 1, orderedQuantity: '100000.000', unit: 'sheets' },
      { lineNumber: 2, orderedQuantity: '50.000', unit: 'rolls' }
    ]);
    expect(po.snapshot.specs.artworkFiles).toHaveLength(1);
    expect(po.snapshot.amounts).toEqual({ currency: 'JPY', totalAmount: '480000' });
    expect(po.ceoApprovedAt).toBeNull();
    expect(po.ceoApprovedByUserId).toBeNull();

    const listed = await getJson(`/api/film-supply-orders/${order.orderId}/maker-purchase-orders`);
    expect(listed.status).toBe(200);
    expect((listed.body as { makerPurchaseOrders: Array<{ id: string }> }).makerPurchaseOrders
      .map((row) => row.id)).toContain(po.id);

    // Staff approval attempts are refused (T-31 role pattern) and persist nothing.
    const staffAttempt = await postJson(`/api/maker-purchase-orders/${po.id}/ceo-approval`, {});
    expect(staffAttempt.status).toBe(403);
    expect((await makerPoRow(po.id))?.status).toBe('DRAFT');
    expect((await makerPoRow(po.id))?.ceoApprovedAt).toBeNull();

    const approved = await approveMakerPo(po.id);
    expect(approved.status).toBe(200);
    const approvedBody = approved.body as { purchaseOrder: MakerPoResponse; approvalEvent: EventRow };
    expect(approvedBody.purchaseOrder.status).toBe('APPROVED_FOR_MANUAL_SEND');
    // Nothing moved since creation, so the CEO approved exactly the created digest.
    expect(approvedBody.purchaseOrder.snapshotSha256).toBe(po.snapshotSha256);
    expect(approvedBody.purchaseOrder.ceoApprovedByUserId).toBe(adminId);
    expect(approvedBody.approvalEvent.eventType).toBe('CEO_APPROVED');
    expect(approvedBody.approvalEvent.verificationStatus).toBe('UNVERIFIED');

    const [orderAfterApproval] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, order.orderId)).limit(1);
    expect(orderAfterApproval?.status).toBe('APPROVED_FOR_MANUAL_SEND');

    const [createdAudit] = await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityType, 'maker_purchase_order'),
      eq(auditEvents.entityId, po.id),
      eq(auditEvents.action, 'MAKER_PO_CREATED')
    )).limit(1);
    // M8-OPERATOR FIX 2: the paper is frozen by the representative.
    expect(createdAudit?.actorUserId).toBe(adminId);
    const [approvalAudit] = await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityType, 'maker_po_event'),
      eq(auditEvents.entityId, approvedBody.approvalEvent.id)
    )).limit(1);
    expect(approvalAudit?.action).toBe('MAKER_PO_CEO_APPROVED');
    expect(approvalAudit?.actorUserId).toBe(adminId);

    const sent = await sendMakerPoEmlEvidence(
      (url, body) => postAs(staffToken, url, body),
      po.id,
      { orderCode: 'FSO-M4-T20', attachmentBytes: order.artworkBytes }
    );
    expect(sent.status).toBe(200);
    const sentBody = sent.body as {
      status: string;
      verificationStatus: string;
      verificationMethod: string | null;
      event: EventRow;
    };
    expect(sentBody.status).toBe('MAKER_PO_SENT_MANUALLY');
    expect(sentBody.verificationStatus).toBe('VERIFIED');
    expect(sentBody.event.eventType).toBe('SEND_EVIDENCE_REGISTERED');
    // M8-HARDEN FIX C1: the evidence is the stored .eml and the event names how
    // it was verified.
    expect(typeof sentBody.event.evidenceDocumentVersionId).toBe('string');
    expect(sentBody.verificationMethod).toBe('eml_header_check');
    expect(sentBody.event.senderAddress).toBe('staff@kanei.example');
    expect(sentBody.event.recipients).toEqual(['maker-po@example.com']);
    expect(sentBody.event.verificationStatus).toBe('VERIFIED');
    // The evidence document's own bytes, then the approved artwork the message
    // carried (M8-HARDEN2 FIX 1: that match is what verified the send).
    expect(sentBody.event.attachmentHashes).toEqual([sent.built.sha256, sent.built.attachmentSha256]);
    expect((await orderRow(order.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');

    const acceptDoc = await uploadOrderEvidence(order, projectId, 'acceptance_evidence', 'T20', po.id);
    const verified = await postJson(`/api/documents/${acceptDoc.document.id}/verify`, {
      verificationStatus: 'verified',
      verificationNote: '合成受領確認'
    });
    expect(verified.status).toBe(200);
    // M8-OPERATOR FIX 2: staff cannot finalize the acceptance; the paper stays
    // where it is until the representative confirms it.
    const staffAcceptAttempt = await postJson(`/api/maker-purchase-orders/${po.id}/accept-evidence`, {
      evidenceDocumentVersionId: acceptDoc.version.id,
      acceptedAt: '2026-11-12T11:00:00.000Z'
    });
    expect(staffAcceptAttempt.status).toBe(403);
    expect((await makerPoRow(po.id))?.status).toBe('MAKER_PO_SENT_MANUALLY');

    const accepted = await acceptEvidence(po.id, {
      evidenceDocumentVersionId: acceptDoc.version.id,
      acceptedAt: '2026-11-12T11:00:00.000Z'
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = accepted.body as { status: string; event: EventRow };
    expect(acceptedBody.status).toBe('MAKER_PO_ACCEPTED');
    expect(acceptedBody.event.eventType).toBe('ACCEPT_EVIDENCE_REGISTERED');
    expect(acceptedBody.event.verificationStatus).toBe('VERIFIED');
    expect((await orderRow(order.orderId))?.status).toBe('MAKER_PO_ACCEPTED');

    const events = await listEvents(po.id);
    expect(events.map((event) => event.eventType))
      .toEqual(['CEO_APPROVED', 'SEND_EVIDENCE_REGISTERED', 'ACCEPT_EVIDENCE_REGISTERED']);
    for (const event of events) {
      const [audit] = await db.select().from(auditEvents).where(and(
        eq(auditEvents.entityType, 'maker_po_event'),
        eq(auditEvents.entityId, event.id)
      )).limit(1);
      expect(audit?.action).toBeTruthy();
      expect(audit?.actorUserId).toBe(staffId === event.recordedByUserId ? staffId : adminId);
    }
  });

  it('T-21 a send registered with only a timestamp stays unverified and blocks every further transition', async () => {
    const { order, po } = await reachApprovedMakerPo(projectId, 'T21');

    const timestampOnly = await sendEvidence(po.id, { sentAt: '2026-11-12T09:30:00.000Z' });
    expect(timestampOnly.status).toBe(200);
    const body = timestampOnly.body as { status: string; verificationStatus: string; event: EventRow };
    expect(body.status).toBe('SEND_UNVERIFIED');
    expect(body.verificationStatus).toBe('UNVERIFIED');
    expect(body.event.eventType).toBe('SEND_EVIDENCE_REGISTERED');
    expect(body.event.verificationStatus).toBe('UNVERIFIED');
    expect(body.event.sentAt).toBe('2026-11-12T09:30:00.000Z');
    expect(body.event.senderAddress).toBeNull();
    expect(body.event.recipients).toBeNull();
    expect(body.event.evidenceDocumentVersionId).toBeNull();
    expect((await makerPoRow(po.id))?.status).toBe('SEND_UNVERIFIED');

    // SEND_UNVERIFIED is a dead end: a later proof cannot unblock it either.
    const laterEvidence = await uploadOrderEvidence(order, projectId, 'send_evidence', 'T21');
    const secondSend = await sendEvidence(po.id, {
      evidenceDocumentVersionId: laterEvidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-12T10:00:00.000Z'
    });
    expect(secondSend.status).toBe(422);
    expect((secondSend.body as { code: string }).code).toBe('MAKER_PO_TRANSITION_BLOCKED');
    const reApproval = await approveMakerPo(po.id);
    expect(reApproval.status).toBe(422);
    expect((reApproval.body as { code: string }).code).toBe('MAKER_PO_TRANSITION_BLOCKED');
    const acceptAttempt = await acceptEvidence(po.id, {
      evidenceDocumentVersionId: laterEvidence.version.id
    });
    expect(acceptAttempt.status).toBe(422);
    expect((acceptAttempt.body as { code: string }).code).toBe('MAKER_PO_TRANSITION_BLOCKED');

    expect(await listEvents(po.id)).toHaveLength(2);
    expect((await makerPoRow(po.id))?.status).toBe('SEND_UNVERIFIED');
    expect((await orderRow(order.orderId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');
  });

  it('T-22 acceptance is only reachable behind a verified acceptance document', async () => {
    const { order, po } = await reachSentMakerPo(projectId, 'T22');

    const missing = await acceptEvidence(po.id, {});
    expect(missing.status).toBe(422);
    expect((missing.body as { code: string }).code).toBe('ACCEPT_EVIDENCE_REQUIRED');

    const unknown = await acceptEvidence(po.id, {
      evidenceDocumentVersionId: '00000000-0000-7000-8000-000000000000'
    });
    expect(unknown.status).toBe(422);
    expect((unknown.body as { code: string }).code).toBe('ACCEPT_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND');

    const wrongType = await uploadOrderEvidence(order, projectId, 'send_evidence', 'T22-WRONG');
    const mistyped = await acceptEvidence(po.id, {
      evidenceDocumentVersionId: wrongType.version.id
    });
    expect(mistyped.status).toBe(422);
    expect((mistyped.body as { code: string }).code).toBe('ACCEPT_EVIDENCE_DOCUMENT_TYPE_INVALID');

    const acceptDoc = await uploadOrderEvidence(order, projectId, 'acceptance_evidence', 'T22', po.id);
    const unverified = await acceptEvidence(po.id, {
      evidenceDocumentVersionId: acceptDoc.version.id
    });
    expect(unverified.status).toBe(422);
    expect((unverified.body as { code: string }).code).toBe('ACCEPT_EVIDENCE_NOT_VERIFIED');

    // None of the refusals moved the PO or recorded an acceptance.
    expect((await makerPoRow(po.id))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((await listEvents(po.id)).filter((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED'))
      .toHaveLength(0);

    const verified = await postJson(`/api/documents/${acceptDoc.document.id}/verify`, {
      verificationStatus: 'verified',
      verificationNote: '合成受領確認T22'
    });
    expect(verified.status).toBe(200);
    const accepted = await acceptEvidence(po.id, {
      evidenceDocumentVersionId: acceptDoc.version.id,
      acceptedAt: '2026-11-12T12:00:00.000Z'
    });
    expect(accepted.status).toBe(200);
    expect((accepted.body as { status: string }).status).toBe('MAKER_PO_ACCEPTED');
    const acceptEvents = (await listEvents(po.id))
      .filter((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED');
    expect(acceptEvents).toHaveLength(1);
    expect(acceptEvents[0]!.verificationStatus).toBe('VERIFIED');
    expect(acceptEvents[0]!.evidenceDocumentVersionId).toBe(acceptDoc.version.id);
  });

  it('T-23 a quantity change voids the approved snapshot and forces re-approval', async () => {
    const { order, po } = await reachApprovedMakerPo(projectId, 'T23');
    const approvedHash = po.snapshotSha256;

    const [line] = await db.select().from(filmSupplyOrderLines).where(and(
      eq(filmSupplyOrderLines.filmSupplyOrderId, order.orderId),
      eq(filmSupplyOrderLines.lineNumber, 1)
    )).limit(1);
    const drifted = await db.update(filmSupplyOrderLines)
      .set({ orderedQuantity: '95000.000' })
      .where(eq(filmSupplyOrderLines.id, line!.id))
      .returning({ id: filmSupplyOrderLines.id });
    expect(drifted).toHaveLength(1);

    const evidence = await uploadOrderEvidence(order, projectId, 'send_evidence', 'T23');
    const refused = await sendEvidence(po.id, {
      evidenceDocumentVersionId: evidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-12T09:40:00.000Z'
    });
    expect(refused.status).toBe(422);
    const refusedBody = refused.body as {
      code: string;
      status: string;
      approvedSnapshotSha256: string;
      currentSnapshotSha256: string;
    };
    expect(refusedBody.code).toBe('SNAPSHOT_VOIDED');
    expect(refusedBody.status).toBe('SNAPSHOT_VOIDED');
    expect(refusedBody.approvedSnapshotSha256).toBe(approvedHash);
    expect(refusedBody.currentSnapshotSha256).not.toBe(approvedHash);

    expect((await makerPoRow(po.id))?.status).toBe('SNAPSHOT_VOIDED');
    const voided = (await listEvents(po.id)).filter((event) => event.eventType === 'SNAPSHOT_VOIDED');
    expect(voided).toHaveLength(1);
    expect(voided[0]!.verificationStatus).toBe('UNVERIFIED');
    // The send was refused: no send evidence was recorded for this attempt.
    expect((await listEvents(po.id)).filter((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED'))
      .toHaveLength(0);

    // Re-approval re-freezes the drifted order data under a new digest.
    const reapproved = await approveMakerPo(po.id);
    expect(reapproved.status).toBe(200);
    const reapprovedBody = reapproved.body as { purchaseOrder: MakerPoResponse };
    expect(reapprovedBody.purchaseOrder.status).toBe('APPROVED_FOR_MANUAL_SEND');
    expect(reapprovedBody.purchaseOrder.snapshotSha256).not.toBe(approvedHash);
    expect(reapprovedBody.purchaseOrder.snapshot.quantities).toEqual([
      { lineNumber: 1, orderedQuantity: '95000.000', unit: 'sheets' },
      { lineNumber: 2, orderedQuantity: '50.000', unit: 'rolls' }
    ]);

    // M8-HARDEN FIX C1: the re-send is proven with the original .eml, verified
    // as an email — a stored document alone no longer proves a send. The order
    // data (and so the approved artwork hash) is unchanged, so the mail carries
    // the same approved bytes (M8-HARDEN2 FIX 1).
    const sent = await sendMakerPoEmlEvidence(
      (url, body) => postAs(staffToken, url, body),
      po.id,
      { orderCode: 'FSO-M4-T23', sentAtIso: plausibleTestSentAt(), attachmentBytes: order.artworkBytes }
    );
    expect(sent.status).toBe(200);
    expect((sent.body as { status: string }).status).toBe('MAKER_PO_SENT_MANUALLY');
  });

  it('T-24 an artwork change voids the approved snapshot and forces re-approval', async () => {
    const { order, po } = await reachApprovedMakerPo(projectId, 'T24');
    const approvedHash = po.snapshotSha256;

    const secondProof = await uploadBoundDocument(order, projectId, {
      documentType: 'proof',
      issuerEntity: 'kanei',
      sevenPurchaseOrderId: order.poId,
      filmSupplyOrderId: order.orderId,
      designKey: 'label-front'
    });
    const second = await postJson(`/api/film-supply-orders/${order.orderId}/artwork-revisions`, {
      designKey: 'label-front',
      fileDocumentVersionId: secondProof.version.id
    });
    expect(second.status).toBe(201);
    expect((second.body as { revisionNo: number }).revisionNo).toBe(2);

    // M8-HARDEN FIX A3: revision 2 holds no approval from either organization,
    // so the boundary refuses the send before the snapshot is even compared —
    // and a boundary refusal is not a void, so the paper is left untouched.
    const refused = await sendMakerPoEmlEvidence(
      (url, body) => postAs(staffToken, url, body),
      po.id,
      { orderCode: 'FSO-M4-T24', sentAtIso: plausibleTestSentAt() }
    );
    expect(refused.status).toBe(422);
    const refusedBody = refused.body as {
      code: string;
      missingApprovals: Array<{ designKey: string; organization: string }>;
    };
    expect(refusedBody.code).toBe('DUAL_APPROVAL_NO_LONGER_VALID');
    expect(refusedBody.missingApprovals).toEqual([
      { designKey: 'label-front', organization: 'customer' },
      { designKey: 'label-front', organization: 'seven' }
    ]);
    expect((await makerPoRow(po.id))?.status).toBe('APPROVED_FOR_MANUAL_SEND');

    // M8-HARDEN FIX A3: the re-approval is no longer the leak it used to be.
    // Certifying again is refused by the transition guard before the approval
    // re-check even runs — only DRAFT or SNAPSHOT_VOIDED paper can be frozen —
    // so the answer carries no missing approvals and the paper stays untouched.
    const refusedReapproval = await approveMakerPo(po.id);
    expect(refusedReapproval.status).toBe(422);
    expect((refusedReapproval.body as { code: string }).code).toBe('MAKER_PO_TRANSITION_BLOCKED');
    expect((refusedReapproval.body as { from: string }).from).toBe('APPROVED_FOR_MANUAL_SEND');
    expect((await makerPoRow(po.id))?.status).toBe('APPROVED_FOR_MANUAL_SEND');

    // The recovery starts with both organizations approving the NEW revision:
    // only then may the paper be certified over it again.
    const secondRevision = (second.body as { id: string }).id;
    for (const organization of ['customer', 'seven'] as const) {
      // The evidence issuer is the document vocabulary, not the approval
      // organization: a customer-sourced evidence is 'customer_generated'.
      const approvalEvidence = await uploadApprovalEvidence(
        order,
        projectId,
        'label-front',
        organization === 'seven' ? 'seven' : 'customer_generated'
      );
      const approval = await recordApproval(secondRevision, {
        organization,
        evidenceDocumentVersionId: approvalEvidence.version.id
      });
      expect(approval.status).toBe(201);
    }
    // The gate has re-opened, but the approved digest still names revision 1,
    // so the first registration over the re-approved artwork voids the paper
    // through G10 — that void is what makes a fresh approval reachable again.
    const staleSend = await sendMakerPoEmlEvidence(
      (url, body) => postAs(staffToken, url, body),
      po.id,
      { orderCode: 'FSO-M4-T24', sentAtIso: plausibleTestSentAt() }
    );
    expect(staleSend.status).toBe(422);
    expect((staleSend.body as { code: string }).code).toBe('SNAPSHOT_VOIDED');
    expect((await makerPoRow(po.id))?.status).toBe('SNAPSHOT_VOIDED');

    const reapproved = await approveMakerPo(po.id);
    expect(reapproved.status).toBe(200);
    const reapprovedBody = reapproved.body as { purchaseOrder: MakerPoResponse };
    expect(reapprovedBody.purchaseOrder.snapshotSha256).not.toBe(approvedHash);
    expect(reapprovedBody.purchaseOrder.snapshot.specs.artworkFiles).toEqual([
      { designKey: 'label-front', revisionNo: 2, fileSha256: secondProof.version.sha256 }
    ]);
    expect((await orderRow(order.orderId))?.status).toBe('CHANGE_REVIEW');

    const sent = await sendMakerPoEmlEvidence(
      (url, body) => postAs(staffToken, url, body),
      po.id,
      // The re-approved snapshot freezes revision 2, so the mail carries those
      // bytes (M8-HARDEN2 FIX 1).
      { orderCode: 'FSO-M4-T24', sentAtIso: plausibleTestSentAt(), attachmentBytes: secondProof.bytes }
    );
    expect(sent.status).toBe(200);
    expect((sent.body as { status: string }).status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((await makerPoRow(po.id))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    // The order mirror is skipped from an exception state; the maker PO remains
    // the authority for its own lifecycle.
    expect((await orderRow(order.orderId))?.status).toBe('CHANGE_REVIEW');
  });

  it('T-24a re-filing identical evidence bytes resolves to the stored version instead of a second version row', async () => {
    const { po } = await reachApprovedMakerPo(projectId, 'T24A');
    // One instant for both registrations: the .eml bytes then match exactly,
    // which is what two attempts inside the same wall-clock second produce
    // (the Date header is the only byte of the message that moves, at
    // whole-second resolution).
    const sentAtIso = plausibleTestSentAt();

    // The first registration fails a header check (a subject that names no
    // order), so the paper stays where it is and a corrected filing remains
    // possible — the shape T-24's recovery walks through.
    const first = await sendMakerPoEmlEvidence(
      (url, body) => postAs(staffToken, url, body),
      po.id,
      { orderCode: 'FSO-M4-T24A', sentAtIso, subject: '製造先発注書（件名に発注コードなし）' }
    );
    expect(first.status).toBe(200);
    expect((first.body as { verificationStatus: string }).verificationStatus)
      .toBe('PENDING_MANUAL_VERIFICATION');
    expect((await makerPoRow(po.id))?.status).toBe('APPROVED_FOR_MANUAL_SEND');

    const evidenceBefore = await db.select({ versionId: documentVersions.id, documentId: documents.id })
      .from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(and(
        eq(documents.projectId, projectId),
        eq(documents.documentType, 'send_evidence'),
        eq(documents.originalFilename, `maker-po-${po.id}-send-evidence.eml`)
      ));
    expect(evidenceBefore).toHaveLength(1);
    const evidenceDocumentId = evidenceBefore[0]!.documentId;
    const documentAuditIds = async () => (await db.select({ id: auditEvents.id }).from(auditEvents)
      .where(and(eq(auditEvents.entityType, 'document'), eq(auditEvents.entityId, evidenceDocumentId))))
      .map((row) => row.id).sort();
    const auditsBefore = await documentAuditIds();

    // The second filing brings the same bytes. They resolve to the version
    // already stored (T-27, the same rule the generic upload applies): the
    // answer is the business verdict again, never a bare Internal Server Error
    // from a duplicate (document_id, sha256) version row.
    const second = await sendMakerPoEmlEvidence(
      (url, body) => postAs(staffToken, url, body),
      po.id,
      { orderCode: 'FSO-M4-T24A', sentAtIso, subject: '製造先発注書（件名に発注コードなし）' }
    );
    expect(second.status).toBe(200);
    expect((second.body as { verificationStatus: string }).verificationStatus)
      .toBe('PENDING_MANUAL_VERIFICATION');
    expect((await makerPoRow(po.id))?.status).toBe('APPROVED_FOR_MANUAL_SEND');

    const evidenceAfter = await db.select({ versionId: documentVersions.id, documentId: documents.id })
      .from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(and(
        eq(documents.projectId, projectId),
        eq(documents.documentType, 'send_evidence'),
        eq(documents.originalFilename, `maker-po-${po.id}-send-evidence.eml`)
      ));
    expect(evidenceAfter).toHaveLength(1);
    // A repeat filing writes no document row and no document audit row.
    expect(await documentAuditIds()).toEqual(auditsBefore);
    expect((await listEvents(po.id))
      .filter((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED')
      .map((event) => event.evidenceDocumentVersionId))
      .toEqual([evidenceAfter[0]!.versionId, evidenceAfter[0]!.versionId]);
  });

  it('T-25 two simultaneous transitions produce exactly one effective transition and a consistent trail', async () => {
    // Two concurrent sends of the same approved maker PO.
    const sendContext = await reachApprovedMakerPo(projectId, 'T25A');
    const [sendOne, sendTwo] = await Promise.all([
      sendMakerPoEmlEvidence(
        (url, body) => postAs(staffToken, url, body),
        sendContext.po.id,
        {
          orderCode: 'FSO-M4-T25A',
          sentAtIso: plausibleTestSentAt(),
          messageId: '<m4-t25a-one@mail.kanei.example>',
          attachmentBytes: sendContext.order.artworkBytes
        }
      ),
      sendMakerPoEmlEvidence(
        (url, body) => postAs(staffToken, url, body),
        sendContext.po.id,
        {
          orderCode: 'FSO-M4-T25A',
          sentAtIso: plausibleTestSentAt(),
          messageId: '<m4-t25a-two@mail.kanei.example>',
          attachmentBytes: sendContext.order.artworkBytes
        }
      )
    ]);
    expect([sendOne.status, sendTwo.status].sort()).toEqual([200, 422]);
    const sendWinner = sendOne.status === 200 ? sendOne : sendTwo;
    const sendLoser = sendOne.status === 200 ? sendTwo : sendOne;
    expect((sendLoser.body as { code: string }).code).toBe('MAKER_PO_TRANSITION_BLOCKED');
    expect((sendWinner.body as { status: string }).status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((await makerPoRow(sendContext.po.id))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    const sendEvents = (await listEvents(sendContext.po.id))
      .filter((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED');
    expect(sendEvents).toHaveLength(1);
    const [sendPoRow] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, sendContext.po.id)).limit(1);
    expect(sendPoRow?.snapshotSha256).toBe(sendContext.po.snapshotSha256);

    // Two concurrent CEO approvals of the same draft maker PO.
    const approvalContext = await createMakerPoReadyOrder(projectId, 'T25B');
    const draftPo = await createMakerPo(approvalContext.orderId);
    const [approvalOne, approvalTwo] = await Promise.all([
      approveMakerPo(draftPo.id),
      approveMakerPo(draftPo.id)
    ]);
    expect([approvalOne.status, approvalTwo.status].sort()).toEqual([200, 422]);
    const approvalLoser = approvalOne.status === 200 ? approvalTwo : approvalOne;
    expect(['MAKER_PO_STATE_CHANGED', 'MAKER_PO_TRANSITION_BLOCKED'])
      .toContain((approvalLoser.body as { code: string }).code);
    expect((await makerPoRow(draftPo.id))?.status).toBe('APPROVED_FOR_MANUAL_SEND');
    const approvalEvents = (await listEvents(draftPo.id))
      .filter((event) => event.eventType === 'CEO_APPROVED');
    expect(approvalEvents).toHaveLength(1);
  });

  it('maker_po_events are append-only and every M4 write carries its audit row in the same transaction', async () => {
    const { order, po } = await reachApprovedMakerPo(projectId, 'APP');
    const sent = await sendMakerPoEmlEvidence(
      (url, body) => postAs(staffToken, url, body),
      po.id,
      { orderCode: 'FSO-M4-APP', sentAtIso: plausibleTestSentAt(), attachmentBytes: order.artworkBytes }
    );
    expect(sent.status).toBe(200);

    const events = await listEvents(po.id);
    expect(events.map((event) => event.eventType)).toEqual(['CEO_APPROVED', 'SEND_EVIDENCE_REGISTERED']);
    const firstEvent = events[0]!;

    await expect(db.update(makerPoEvents)
      .set({ verificationStatus: 'VERIFIED' })
      .where(eq(makerPoEvents.id, firstEvent.id)))
      .rejects.toThrow(/append-only/);
    await expect(db.delete(makerPoEvents)
      .where(eq(makerPoEvents.id, firstEvent.id)))
      .rejects.toThrow(/append-only/);
    const [survivor] = await db.select().from(makerPoEvents).where(eq(makerPoEvents.id, firstEvent.id)).limit(1);
    expect(survivor?.verificationStatus).toBe(firstEvent.verificationStatus);

    for (const event of events) {
      const [audit] = await db.select().from(auditEvents).where(and(
        eq(auditEvents.entityType, 'maker_po_event'),
        eq(auditEvents.entityId, event.id)
      )).limit(1);
      expect(audit?.action).toBeTruthy();
    }
    const poAudits = await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityType, 'maker_purchase_order'),
      eq(auditEvents.entityId, po.id)
    ));
    // M8-OPER3 re-derives the dual-approval gate at the boundary and appends one
    // MAKER_PO_DUAL_APPROVAL_RECHECK audit row per re-check (here: CEO approval
    // and send). The create-time re-check is recorded against the film supply
    // order, so it does not appear in this list.
    expect(poAudits.map((audit) => audit.action).sort())
      .toEqual([
        'MAKER_PO_CREATED',
        'MAKER_PO_DUAL_APPROVAL_RECHECK',
        'MAKER_PO_DUAL_APPROVAL_RECHECK',
        'MAKER_PO_STATUS_CHANGED',
        'MAKER_PO_STATUS_CHANGED'
      ]);

    // The version the evidence cites resolves to the order-bound send evidence
    // document (a document's first version shares the document's identity).
    // M8-HARDEN FIX C1: the cited version is now the stored .eml the endpoint
    // filed for this paper.
    const sendEvent = events[1]!;
    const [evidenceRow] = await db.select({
      filmSupplyOrderId: documents.filmSupplyOrderId,
      documentType: documents.documentType,
      declaredMimeType: documentVersions.declaredMimeType
    }).from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(eq(documentVersions.id, sendEvent.evidenceDocumentVersionId!)).limit(1);
    expect(evidenceRow?.filmSupplyOrderId).toBe(order.orderId);
    expect(evidenceRow?.documentType).toBe('send_evidence');
    expect(evidenceRow?.declaredMimeType).toBe('message/rfc822');
  });
});
