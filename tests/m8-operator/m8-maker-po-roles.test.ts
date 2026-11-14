import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
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
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../../apps/api/src/auth.js';

/**
 * M8-OPERATOR: maker purchase-order role matrix and response separation.
 *
 * FIX 1 — GET /api/maker-purchase-orders/:poId and GET
 * /api/film-supply-orders/:orderId/maker-purchase-orders answer by role: admin
 * sees the whole frozen paper (amounts, digest, recipient), staff sees the
 * work-necessary fields, viewer sees a non-sensitive status summary. The rows
 * themselves are never rewritten.
 * FIX 2 — the matrix is enforced with canPerform at every maker-PO endpoint:
 * admin creates / approves / confirms acceptance finally, staff records send
 * evidence and provisional acceptances, viewer reads.
 * FIX 3 — the G6 payment gate is surfaced as a read, and recording
 * paymentTerms is never an 入金確認 (payment_confirmed_at stays null).
 * FIX 4 — approval evidence identifiers are verified against text evidence and
 * flagged pending_manual_verification for binary (PDF/image) evidence, which
 * never completes the dual approval on its own.
 */

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

let adminToken = '';
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

/** A one-page minimal PDF: real binary bytes, no readable text layer. */
const BINARY_PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n', 'utf8'),
  Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]),
  Buffer.from('%%EOF\n', 'utf8')
]);

function cookieHeader(token: string) {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

async function requestAs(token: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const response = await app.request(url, {
    method,
    headers: { 'content-type': 'application/json', ...cookieHeader(token) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function getAs(token: string, url: string) {
  return await requestAs(token, 'GET', url);
}

async function postAs(token: string, url: string, body: unknown = {}) {
  return await requestAs(token, 'POST', url, body);
}

async function patchAs(token: string, url: string, body: unknown = {}) {
  return await requestAs(token, 'PATCH', url, body);
}

interface MakerPoSnapshotFixture {
  order: { id: string; code: string; sevenPoNumber: string | null };
  items: Array<{ lineNumber: number; description: string; orderedQuantity: string; unit: string }>;
  quantities: Array<{ lineNumber: number; orderedQuantity: string; unit: string }>;
  specs: { artworkFiles: Array<{ designKey: string; revisionNo: number; fileSha256: string }> };
  amounts: { currency: string; totalAmount: string } | null;
  recipient: { address: string };
}

function snapshotFixture(orderId: string, code: string): MakerPoSnapshotFixture {
  return {
    order: { id: orderId, code, sevenPoNumber: null },
    items: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: '100000.000', unit: 'sheets' }],
    quantities: [{ lineNumber: 1, orderedQuantity: '100000.000', unit: 'sheets' }],
    specs: { artworkFiles: [] },
    amounts: { currency: 'JPY', totalAmount: '480000' },
    recipient: { address: 'maker-po@example.com' }
  };
}

/** Inserts a maker PO row directly, so view tests do not need the whole chain. */
async function insertMakerPo(input: {
  orderId: string;
  orderCode: string;
  status?: string;
  withAmounts?: boolean;
}) {
  const now = new Date();
  const poId = uuidv7(now);
  await db.insert(makerPurchaseOrders).values({
    id: poId,
    filmSupplyOrderId: input.orderId,
    snapshot: {
      ...snapshotFixture(input.orderId, input.orderCode),
      amounts: input.withAmounts === false ? null : { currency: 'JPY', totalAmount: '480000' }
    },
    snapshotSha256: 'a'.repeat(64),
    status: input.status ?? 'MAKER_PO_SENT_MANUALLY',
    ceoApprovedByUserId: adminId,
    ceoApprovedAt: now,
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(makerPoEvents).values({
    id: uuidv7(now),
    makerPurchaseOrderId: poId,
    eventType: 'SEND_EVIDENCE_REGISTERED',
    senderAddress: 'staff@kanei.example',
    recipients: ['maker-po@example.com'],
    sentAt: now,
    attachmentHashes: ['b'.repeat(64)],
    verificationStatus: 'VERIFIED',
    recordedByUserId: staffId,
    recordedAt: now
  });
  return poId;
}

async function insertOrder(input: {
  projectId: string;
  code: string;
  paymentTerms?: string;
  status?: string;
}) {
  const now = new Date();
  const orderId = uuidv7(now);
  await db.insert(filmSupplyOrders).values({
    id: orderId,
    projectId: input.projectId,
    code: input.code,
    status: input.status ?? 'MAKER_PO_READY',
    paymentTerms: input.paymentTerms ?? 'undetermined',
    createdByUserId: adminId,
    createdAt: now,
    updatedAt: now
  });
  return orderId;
}

async function poRow(poId: string) {
  const [row] = await db.select().from(makerPurchaseOrders)
    .where(eq(makerPurchaseOrders.id, poId)).limit(1);
  return row;
}

async function poEvents(poId: string) {
  return await db.select().from(makerPoEvents)
    .where(eq(makerPoEvents.makerPurchaseOrderId, poId))
    .orderBy(makerPoEvents.recordedAt, makerPoEvents.id);
}

// ---------------------------------------------------------------------------
// The real chain (seven PO verified → dual approval → MAKER_PO_READY), used by
// the endpoints that freeze and confirm real paper.
// ---------------------------------------------------------------------------

function fullChecklist() {
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
    verificationNote: '合成チェックリスト記録'
  };
}

async function uploadDocument(input: {
  projectId: string;
  documentType: string;
  issuerEntity: string;
  designKey?: string;
  orderId?: string;
  poId?: string;
  contentType?: string;
  content?: string;
}) {
  const tag = nextTag();
  const contentType = input.contentType ?? 'text/plain';
  const content = input.content ?? `composite m8 document bytes ${tag}\n`;
  const response = await postAs(staffToken, `/api/projects/${input.projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `m8-doc-${tag}.${contentType === 'application/pdf' ? 'pdf' : 'txt'}`,
    contentType,
    contentBase64: contentType === 'application/pdf'
      ? BINARY_PDF_BYTES.toString('base64')
      : toBase64(content),
    ...(input.poId ? { sevenPurchaseOrderId: input.poId } : {}),
    ...(input.orderId ? { filmSupplyOrderId: input.orderId } : {}),
    ...(input.designKey ? { designKey: input.designKey } : {})
  });
  expect(response.status).toBe(201);
  return response.body as { document: { id: string }; version: { id: string; sha256: string } };
}

/**
 * An order whose purchase order is verified and whose artwork revision is
 * registered, parked at APPROVAL_PENDING with no approval recorded yet — the
 * shape the evidence-identifier tests need: every approval they record is the
 * first one for the design.
 */
async function reachApprovalPending(input: {
  projectId: string;
  tag: string;
  paymentTerms?: 'prepaid' | 'on_delivery' | 'undetermined';
}) {
  const poNumber = `SEVEN-M8-${input.tag}`;
  const createdPo = await postAs(staffToken, `/api/projects/${input.projectId}/seven-purchase-orders`, {
    poNumber,
    officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(createdPo.status).toBe(201);
  const po = createdPo.body as { id: string };

  const checklist = await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/verification-checklist`, fullChecklist());
  expect(checklist.status).toBe(200);
  const official = await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/register-official`, {
    officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(official.status).toBe(200);

  const createdOrder = await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/supply-orders`, {
    code: `FSO-M8-${input.tag}`,
    paymentTerms: input.paymentTerms ?? 'prepaid',
    lines: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 100000, unit: 'sheets' }]
  });
  expect(createdOrder.status).toBe(201);
  const order = createdOrder.body as { id: string; paymentTerms: string };

  for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
    const transition = await postAs(staffToken, `/api/film-supply-orders/${order.id}/transitions`, { to });
    expect(transition.status).toBe(200);
  }

  const proof = await uploadDocument({
    projectId: input.projectId,
    documentType: 'proof',
    issuerEntity: 'kanei',
    designKey: 'label-front',
    orderId: order.id,
    poId: po.id
  });
  const revision = await postAs(staffToken, `/api/film-supply-orders/${order.id}/artwork-revisions`, {
    designKey: 'label-front',
    fileDocumentVersionId: proof.version.id
  });
  expect(revision.status).toBe(201);
  const revisionBody = revision.body as { id: string };

  return { poId: po.id, orderId: order.id, revisionId: revisionBody.id, paymentTerms: order.paymentTerms };
}

/** Records one counted approval with text evidence that quotes its identifier. */
async function recordTextApproval(input: {
  projectId: string;
  order: { poId: string; orderId: string };
  revisionId: string;
  organization: 'customer' | 'seven';
  tag: string;
}) {
  const identifier = `MSG-M8-${input.organization.toUpperCase()}-${input.tag}`;
  const evidence = await uploadDocument({
    projectId: input.projectId,
    documentType: 'approval_evidence',
    issuerEntity: input.organization === 'seven' ? 'seven' : 'customer_generated',
    designKey: 'label-front',
    orderId: input.order.orderId,
    poId: input.order.poId,
    content: `composite m8 approval evidence\nidentifier: ${identifier}\n`
  });
  const approval = await postAs(staffToken, `/api/artwork-revisions/${input.revisionId}/approvals`, {
    organization: input.organization,
    decision: 'APPROVE',
    evidenceSource: 'email',
    eventTime: '2026-11-10T10:00:00.000Z',
    evidenceIdentifier: identifier,
    evidenceDocumentVersionId: evidence.version.id
  });
  expect(approval.status).toBe(201);
  return { identifier, approval, evidence };
}

/** Builds an order at MAKER_PO_READY with one dual-approved design on it. */
async function reachMakerPoReady(input: {
  projectId: string;
  tag: string;
  paymentTerms?: 'prepaid' | 'on_delivery' | 'undetermined';
}) {
  const chain = await reachApprovalPending(input);
  const customer = await recordTextApproval({
    projectId: input.projectId,
    order: chain,
    revisionId: chain.revisionId,
    organization: 'customer',
    tag: input.tag
  });
  expect((customer.approval.body as { countsTowardDualApproval: boolean }).countsTowardDualApproval).toBe(true);
  const seven = await recordTextApproval({
    projectId: input.projectId,
    order: chain,
    revisionId: chain.revisionId,
    organization: 'seven',
    tag: input.tag
  });
  expect((seven.approval.body as { dualApproved: boolean }).dualApproved).toBe(true);

  const ready = await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'MAKER_PO_READY' });
  expect(ready.status).toBe(200);
  return { ...chain, customerEvidence: customer.evidence, sevenEvidence: seven.evidence };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-m8-operator-'));
  app = createApp({ db });

  await db.execute(sql`
    truncate table audit_events, maker_po_events, maker_purchase_orders, artwork_revisions,
      artwork_approval_events, documents, document_versions, pre_order_references,
      seven_purchase_orders, film_supply_orders, film_supply_order_lines, film_deliveries,
      filling_orders, filling_order_lines, filling_deliveries, commission_readiness,
      delivery_confirmations, project_assignments, projects, sessions, accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'admin_m8_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者M8', role: 'admin' },
    { id: staffId, username: 'staff_m8_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者M8', role: 'staff' },
    { id: viewerId, username: 'viewer_m8_test', passwordHash: await hashPassword('composite-viewer-pass'), displayName: '合成閲覧者M8', role: 'viewer' },
    { id: outsiderStaffId, username: 'staff_m8_other_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者M8別', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成M8エンドカスタマー', role: 'end_customer', externalCode: 'TEST-M8-CUST' },
    { id: sevenAccountId, name: '合成M8セブン', role: 'seven', externalCode: 'TEST-M8-SEVEN' },
    { id: makerAccountId, name: '合成M8メーカー', role: 'maker', externalCode: 'TEST-M8-MAKER' }
  ]);
  for (const targetProjectId of [projectId, otherProjectId]) {
    await db.insert(projects).values({
      id: targetProjectId,
      code: targetProjectId === projectId ? 'TEST-M8-PROJECT' : 'TEST-M8-PROJECT-OTHER',
      name: '合成M8案件',
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
  }
  // The assigned staff and the viewer see this project; the second staff user
  // does not, so PROJECT_NOT_ASSIGNED is reachable.
  await db.insert(projectAssignments).values([
    { id: uuidv7(), userId: staffId, projectId },
    { id: uuidv7(), userId: viewerId, projectId }
  ]);
  for (const [userId, key] of [
    [adminId, 'admin'],
    [staffId, 'staff'],
    [viewerId, 'viewer'],
    [outsiderStaffId, 'outsider']
  ] as const) {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({
      id: uuidv7(),
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    });
    if (key === 'admin') adminToken = token;
    if (key === 'staff') staffToken = token;
    if (key === 'viewer') viewerToken = token;
    if (key === 'outsider') outsiderToken = token;
  }
});

afterAll(async () => {
  await pool.end();
});

describe('M8 FIX 1: maker PO responses are shaped by the reader role', () => {
  it('the admin reads the whole frozen paper, staff the work fields, viewer a status summary', async () => {
    const orderId = await insertOrder({ projectId, code: `FSO-M8-VIEW-${nextTag()}` });
    const poId = await insertMakerPo({ orderId, orderCode: 'FSO-M8-VIEW' });

    const adminView = await getAs(adminToken, `/api/maker-purchase-orders/${poId}`);
    expect(adminView.status).toBe(200);
    const adminBody = adminView.body as {
      purchaseOrder: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
    };
    expect(adminBody.purchaseOrder.snapshot).toBeTruthy();
    expect((adminBody.purchaseOrder.snapshot as MakerPoSnapshotFixture).amounts)
      .toEqual({ currency: 'JPY', totalAmount: '480000' });
    expect(adminBody.purchaseOrder.snapshotSha256).toBe('a'.repeat(64));
    expect((adminBody.purchaseOrder.snapshot as MakerPoSnapshotFixture).recipient.address)
      .toBe('maker-po@example.com');
    expect(adminBody.events[0]).toMatchObject({ senderAddress: 'staff@kanei.example' });

    const staffView = await getAs(staffToken, `/api/maker-purchase-orders/${poId}`);
    expect(staffView.status).toBe(200);
    const staffBody = staffView.body as {
      purchaseOrder: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
    };
    // Work-necessary fields only: identity, linkage, status, dates, delivery key.
    expect(staffBody.purchaseOrder).toMatchObject({
      id: poId,
      filmSupplyOrderId: orderId,
      status: 'MAKER_PO_SENT_MANUALLY',
      orderCode: 'FSO-M8-VIEW',
      recipientAddress: 'maker-po@example.com'
    });
    expect(staffBody.purchaseOrder.createdAt).toBeTruthy();
    expect(staffBody.purchaseOrder.updatedAt).toBeTruthy();
    // No amounts, no costs, no snapshot body, no digest of a body staff cannot read.
    expect(staffBody.purchaseOrder.snapshot).toBeUndefined();
    expect(staffBody.purchaseOrder.snapshotSha256).toBeUndefined();
    expect(JSON.stringify(staffBody.purchaseOrder)).not.toContain('480000');
    expect(JSON.stringify(staffBody)).not.toContain('staff@kanei.example');
    const staffEvent = staffBody.events[0] as Record<string, unknown>;
    expect(staffEvent).toMatchObject({ eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus: 'VERIFIED' });
    expect(staffEvent.senderAddress).toBeUndefined();
    expect(staffEvent.recipients).toBeUndefined();
    expect(staffEvent.attachmentHashes).toBeUndefined();

    const viewerView = await getAs(viewerToken, `/api/maker-purchase-orders/${poId}`);
    expect(viewerView.status).toBe(200);
    const viewerBody = viewerView.body as {
      purchaseOrder: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
    };
    expect(viewerBody.purchaseOrder).toMatchObject({
      id: poId,
      status: 'MAKER_PO_SENT_MANUALLY'
    });
    expect(viewerBody.purchaseOrder.createdAt).toBeTruthy();
    expect(JSON.stringify(viewerBody)).not.toContain('480000');
    expect(viewerBody.purchaseOrder.snapshot).toBeUndefined();
    expect(viewerBody.purchaseOrder.snapshotSha256).toBeUndefined();
    expect(viewerBody.purchaseOrder.recipientAddress).toBeUndefined();
    expect(viewerBody.purchaseOrder.filmSupplyOrderId).toBeUndefined();
    expect(viewerBody.events[0]).toMatchObject({ eventType: 'SEND_EVIDENCE_REGISTERED' });
    expect(Object.keys(viewerBody.events[0] as Record<string, unknown>).sort())
      .toEqual(['eventType', 'id', 'recordedAt']);

    // Reading never rewrites the rows.
    const after = await poRow(poId);
    expect(after?.snapshot).toBeTruthy();
    expect(after?.snapshotSha256).toBe('a'.repeat(64));
    expect((await poEvents(poId)).length).toBe(1);
  });

  it('the list endpoint answers with the same role-shaped rows', async () => {
    const orderId = await insertOrder({ projectId, code: `FSO-M8-LIST-${nextTag()}` });
    const poId = await insertMakerPo({ orderId, orderCode: 'FSO-M8-LIST' });

    const adminList = await getAs(adminToken, `/api/film-supply-orders/${orderId}/maker-purchase-orders`);
    expect(adminList.status).toBe(200);
    const adminRows = (adminList.body as { makerPurchaseOrders: Array<Record<string, unknown>> }).makerPurchaseOrders;
    expect(adminRows.map((row) => row.id)).toContain(poId);
    expect(adminRows.find((row) => row.id === poId)?.snapshot).toBeTruthy();

    const staffList = await getAs(staffToken, `/api/film-supply-orders/${orderId}/maker-purchase-orders`);
    expect(staffList.status).toBe(200);
    const staffRows = (staffList.body as { makerPurchaseOrders: Array<Record<string, unknown>> }).makerPurchaseOrders;
    const staffRow = staffRows.find((row) => row.id === poId);
    expect(staffRow).toMatchObject({ status: 'MAKER_PO_SENT_MANUALLY', orderCode: 'FSO-M8-LIST' });
    expect(staffRow?.snapshot).toBeUndefined();
    expect(JSON.stringify(staffRows)).not.toContain('480000');

    const viewerList = await getAs(viewerToken, `/api/film-supply-orders/${orderId}/maker-purchase-orders`);
    expect(viewerList.status).toBe(200);
    const viewerRows = (viewerList.body as { makerPurchaseOrders: Array<Record<string, unknown>> }).makerPurchaseOrders;
    expect(JSON.stringify(viewerRows)).not.toContain('480000');
    expect(viewerRows.find((row) => row.id === poId)?.snapshot).toBeUndefined();
  });
});

describe('M8 FIX 2: the maker PO role matrix at every endpoint', () => {
  it('creating the paper is admin-only; staff and viewer get 403 and nothing is written', async () => {
    const ready = await reachMakerPoReady({ projectId, tag: `CREATE-${nextTag()}` });

    const staffAttempt = await postAs(staffToken, `/api/film-supply-orders/${ready.orderId}/maker-purchase-orders`, {
      recipientAddress: 'maker-po@example.com',
      amounts: { currency: 'JPY', totalAmount: '480000' }
    });
    expect(staffAttempt.status).toBe(403);

    const viewerAttempt = await postAs(viewerToken, `/api/film-supply-orders/${ready.orderId}/maker-purchase-orders`, {
      recipientAddress: 'maker-po@example.com'
    });
    expect(viewerAttempt.status).toBe(403);

    const outsider = await postAs(outsiderToken, `/api/film-supply-orders/${ready.orderId}/maker-purchase-orders`, {
      recipientAddress: 'maker-po@example.com'
    });
    expect(outsider.status).toBe(403);

    const created = await postAs(adminToken, `/api/film-supply-orders/${ready.orderId}/maker-purchase-orders`, {
      recipientAddress: 'maker-po@example.com',
      amounts: { currency: 'JPY', totalAmount: '480000' }
    });
    expect(created.status).toBe(201);
    const createdBody = created.body as { id: string; status: string; snapshot: { amounts: unknown } };
    expect(createdBody.status).toBe('DRAFT');
    expect(createdBody.snapshot.amounts).toEqual({ currency: 'JPY', totalAmount: '480000' });
  });

  it('sending evidence is staff work; viewer is refused and an unassigned staff user is refused', async () => {
    const ready = await reachMakerPoReady({ projectId, tag: `SEND-${nextTag()}` });
    const created = await postAs(adminToken, `/api/film-supply-orders/${ready.orderId}/maker-purchase-orders`, {
      recipientAddress: 'maker-po@example.com'
    });
    const poId = (created.body as { id: string }).id;
    const approved = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {});
    expect(approved.status).toBe(200);

    const evidence = await uploadDocument({
      projectId,
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: ready.orderId,
      poId: ready.poId,
      content: 'composite m8 send evidence\n'
    });
    const viewerAttempt = await postAs(viewerToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: evidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-13T09:00:00.000Z'
    });
    expect(viewerAttempt.status).toBe(403);

    const outsider = await postAs(outsiderToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: evidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-13T09:00:00.000Z'
    });
    expect(outsider.status).toBe(403);

    const staffSend = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: evidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-13T09:00:00.000Z'
    });
    expect(staffSend.status).toBe(200);
    const staffSendBody = staffSend.body as { status: string; purchaseOrder: Record<string, unknown> };
    expect(staffSendBody.status).toBe('MAKER_PO_SENT_MANUALLY');
    // The staff answer is the work view, not the frozen paper.
    expect(staffSendBody.purchaseOrder.snapshot).toBeUndefined();
    expect(JSON.stringify(staffSendBody)).not.toContain('480000');
  });

  it('staff records a provisional acceptance that is flagged and never finalizes; viewer is refused', async () => {
    const ready = await reachMakerPoReady({ projectId, tag: `PROV-${nextTag()}` });
    const created = await postAs(adminToken, `/api/film-supply-orders/${ready.orderId}/maker-purchase-orders`, {
      recipientAddress: 'maker-po@example.com'
    });
    const poId = (created.body as { id: string }).id;
    await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {});
    const evidence = await uploadDocument({
      projectId,
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: ready.orderId,
      poId: ready.poId,
      content: 'composite m8 send evidence\n'
    });
    await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: evidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-13T09:00:00.000Z'
    });

    const viewerAttempt = await postAs(viewerToken, `/api/maker-purchase-orders/${poId}/provisional-acceptance`, {
      acceptedAt: '2026-11-13T10:00:00.000Z'
    });
    expect(viewerAttempt.status).toBe(403);
    const outsider = await postAs(outsiderToken, `/api/maker-purchase-orders/${poId}/provisional-acceptance`, {});
    expect(outsider.status).toBe(403);

    const provisional = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/provisional-acceptance`, {
      acceptedAt: '2026-11-13T10:00:00.000Z'
    });
    expect(provisional.status).toBe(201);
    const provisionalBody = provisional.body as {
      status: string;
      provisional: boolean;
      event: { eventType: string; provisional: boolean };
      purchaseOrder: { status: string };
    };
    expect(provisionalBody.provisional).toBe(true);
    expect(provisionalBody.event.eventType).toBe('MAKER_PO_ACCEPT_RECORDED_PROVISIONAL');
    expect(provisionalBody.event.provisional).toBe(true);
    // A provisional record never moves the paper.
    expect(provisionalBody.purchaseOrder.status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((await poRow(poId))?.status).toBe('MAKER_PO_SENT_MANUALLY');

    const events = await poEvents(poId);
    const provisionalEvent = events.find((event) => event.eventType === 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL');
    expect(provisionalEvent?.provisional).toBe(true);
    const [audit] = await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityType, 'maker_po_event'),
      eq(auditEvents.entityId, provisionalEvent!.id)
    )).limit(1);
    expect(audit?.action).toBe('MAKER_PO_ACCEPT_RECORDED_PROVISIONAL');
  });

  it('final acceptance is admin-only and reports that a provisional record preceded it', async () => {
    const ready = await reachMakerPoReady({ projectId, tag: `FINAL-${nextTag()}` });
    const created = await postAs(adminToken, `/api/film-supply-orders/${ready.orderId}/maker-purchase-orders`, {
      recipientAddress: 'maker-po@example.com'
    });
    const poId = (created.body as { id: string }).id;
    await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {});
    const sendEvidence = await uploadDocument({
      projectId,
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: ready.orderId,
      poId: ready.poId,
      content: 'composite m8 send evidence\n'
    });
    await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: sendEvidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-13T09:00:00.000Z'
    });
    const acceptEvidence = await uploadDocument({
      projectId,
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: ready.orderId,
      poId: ready.poId,
      content: 'composite m8 acceptance evidence\n'
    });
    const verified = await postAs(staffToken, `/api/documents/${acceptEvidence.document.id}/verify`, {
      verificationStatus: 'verified',
      verificationNote: '合成受領確認M8'
    });
    expect(verified.status).toBe(200);

    await postAs(staffToken, `/api/maker-purchase-orders/${poId}/provisional-acceptance`, {
      acceptedAt: '2026-11-13T10:00:00.000Z'
    });

    const staffFinal = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: acceptEvidence.version.id,
      acceptedAt: '2026-11-13T12:00:00.000Z'
    });
    expect(staffFinal.status).toBe(403);
    expect((await poRow(poId))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((await poEvents(poId)).filter((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED'))
      .toHaveLength(0);

    const viewerFinal = await postAs(viewerToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: acceptEvidence.version.id
    });
    expect(viewerFinal.status).toBe(403);

    const final = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: acceptEvidence.version.id,
      acceptedAt: '2026-11-13T12:00:00.000Z'
    });
    expect(final.status).toBe(200);
    const finalBody = final.body as {
      status: string;
      precededByProvisional: boolean;
      provisionalEventId: string | null;
      purchaseOrder: { status: string };
    };
    expect(finalBody.status).toBe('MAKER_PO_ACCEPTED');
    expect(finalBody.purchaseOrder.status).toBe('MAKER_PO_ACCEPTED');
    expect(finalBody.precededByProvisional).toBe(true);
    expect(finalBody.provisionalEventId).toBeTruthy();
    expect((await poRow(poId))?.status).toBe('MAKER_PO_ACCEPTED');

    const [acceptAudit] = await db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'MAKER_PO_ACCEPT_EVIDENCE_REGISTERED'),
      eq(auditEvents.projectId, projectId)
    )).limit(1);
    expect((acceptAudit?.afterState as Record<string, unknown>).precededByProvisional).toBe(true);
  });

  it('a final acceptance with no provisional record says so', async () => {
    const ready = await reachMakerPoReady({ projectId, tag: `FINALONLY-${nextTag()}` });
    const created = await postAs(adminToken, `/api/film-supply-orders/${ready.orderId}/maker-purchase-orders`, {
      recipientAddress: 'maker-po@example.com'
    });
    const poId = (created.body as { id: string }).id;
    await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {});
    const sendEvidence = await uploadDocument({
      projectId,
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: ready.orderId,
      poId: ready.poId,
      content: 'composite m8 send evidence\n'
    });
    await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: sendEvidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-13T09:00:00.000Z'
    });
    const acceptEvidence = await uploadDocument({
      projectId,
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: ready.orderId,
      poId: ready.poId,
      content: 'composite m8 acceptance evidence\n'
    });
    await postAs(staffToken, `/api/documents/${acceptEvidence.document.id}/verify`, {
      verificationStatus: 'verified'
    });

    const final = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: acceptEvidence.version.id,
      acceptedAt: '2026-11-13T12:00:00.000Z'
    });
    expect(final.status).toBe(200);
    expect((final.body as { precededByProvisional: boolean }).precededByProvisional).toBe(false);
  });
});

describe('M8 FIX 3: the G6 payment gate as a read', () => {
  it('reports the settled terms, the block reason and a payment confirmation that never self-fills', async () => {
    const ready = await reachMakerPoReady({ projectId, tag: `G6-${nextTag()}` });
    expect(ready.paymentTerms).toBe('prepaid');

    const adminGate = await getAs(adminToken, `/api/film-supply-orders/${ready.orderId}/payment-gate`);
    expect(adminGate.status).toBe(200);
    const adminBody = adminGate.body as {
      orderId: string;
      paymentTerms: string;
      gate: { satisfied: boolean; code: string | null };
      paymentConfirmedAt: string | null;
    };
    expect(adminBody.orderId).toBe(ready.orderId);
    expect(adminBody.paymentTerms).toBe('prepaid');
    expect(adminBody.gate.satisfied).toBe(true);
    expect(adminBody.gate.code).toBeNull();
    // Recording a term is not an 入金確認: the confirmation stays empty until a
    // human records it through a dedicated action that does not exist yet.
    expect(adminBody.paymentConfirmedAt).toBeNull();

    const viewerGate = await getAs(viewerToken, `/api/film-supply-orders/${ready.orderId}/payment-gate`);
    expect(viewerGate.status).toBe(200);
    expect((viewerGate.body as { paymentTerms: string }).paymentTerms).toBe('prepaid');

    const outsider = await getAs(outsiderToken, `/api/film-supply-orders/${ready.orderId}/payment-gate`);
    expect(outsider.status).toBe(403);

    const blocked = await insertOrder({ projectId, code: `FSO-M8-G6B-${nextTag()}`, paymentTerms: 'undetermined' });
    const blockedGate = await getAs(adminToken, `/api/film-supply-orders/${blocked}/payment-gate`);
    expect(blockedGate.status).toBe(200);
    const blockedBody = blockedGate.body as {
      paymentTerms: string;
      gate: { satisfied: boolean; code: string; reason: string };
      paymentConfirmedAt: string | null;
    };
    expect(blockedBody.paymentTerms).toBe('undetermined');
    expect(blockedBody.gate.satisfied).toBe(false);
    expect(blockedBody.gate.code).toBe('PAYMENT_GATE_UNSATISFIED');
    expect(blockedBody.gate.reason).toBeTruthy();
    expect(blockedBody.paymentConfirmedAt).toBeNull();
  });

  it('keeps the terms editable in DRAFT and never confirms a payment by recording them', async () => {
    const orderId = await insertOrder({ projectId, code: `FSO-M8-G6D-${nextTag()}`, status: 'DRAFT' });
    // The terms endpoint is a PATCH on a draft (発注ドラフト까지만), not a POST.
    const updated = await patchAs(staffToken, `/api/film-supply-orders/${orderId}/payment-terms`, {
      paymentTerms: 'on_delivery'
    });
    expect(updated.status).toBe(200);
    expect((updated.body as { paymentTerms: string }).paymentTerms).toBe('on_delivery');
    expect((await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1))[0]
      ?.paymentConfirmedAt ?? null).toBeNull();

    const gate = await getAs(adminToken, `/api/film-supply-orders/${orderId}/payment-gate`);
    expect((gate.body as { gate: { satisfied: boolean } }).gate.satisfied).toBe(true);
    expect((gate.body as { paymentConfirmedAt: string | null }).paymentConfirmedAt).toBeNull();
  });
});

describe('M8 FIX 4: evidence identifiers over text and binary evidence', () => {
  it('verifies the identifier inside text evidence and counts the approval', async () => {
    const chain = await reachApprovalPending({ projectId, tag: `EVIDTXT-${nextTag()}` });
    const identifier = `MSG-M8-TXT-${nextTag()}`;
    const evidence = await uploadDocument({
      projectId,
      documentType: 'approval_evidence',
      issuerEntity: 'customer_generated',
      designKey: 'label-front',
      orderId: chain.orderId,
      poId: chain.poId,
      content: `composite m8 approval evidence\nidentifier: ${identifier}\n`
    });

    const approval = await postAs(staffToken, `/api/artwork-revisions/${chain.revisionId}/approvals`, {
      organization: 'customer',
      decision: 'APPROVE',
      evidenceSource: 'email',
      eventTime: '2026-11-12T10:00:00.000Z',
      evidenceIdentifier: identifier,
      evidenceDocumentVersionId: evidence.version.id
    });
    expect(approval.status).toBe(201);
    const approvalBody = approval.body as {
      approvalEvent: { id: string; evidenceIdentifierStatus: string };
      countsTowardDualApproval: boolean;
    };
    expect(approvalBody.approvalEvent.evidenceIdentifierStatus).toBe('verified_in_document');
    expect(approvalBody.countsTowardDualApproval).toBe(true);
    const [storedRow] = await db.select().from(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.id, approvalBody.approvalEvent.id)).limit(1);
    expect(storedRow?.evidenceIdentifierStatus).toBe('verified_in_document');
  });

  it('flags binary evidence as pending manual verification and never completes the dual approval', async () => {
    const chain = await reachApprovalPending({ projectId, tag: `EVIDPDF-${nextTag()}` });
    const revisionId = chain.revisionId;

    const binaryEvidence = await uploadDocument({
      projectId,
      documentType: 'approval_evidence',
      issuerEntity: 'customer_generated',
      designKey: 'label-front',
      orderId: chain.orderId,
      poId: chain.poId,
      contentType: 'application/pdf'
    });
    const pending = await postAs(staffToken, `/api/artwork-revisions/${revisionId}/approvals`, {
      organization: 'customer',
      decision: 'APPROVE',
      evidenceSource: 'signed_document',
      eventTime: '2026-11-12T10:00:00.000Z',
      evidenceIdentifier: 'SIGNBLOCK-that-is-not-in-the-pdf-bytes-0001',
      evidenceDocumentVersionId: binaryEvidence.version.id
    });
    expect(pending.status).toBe(201);
    const pendingBody = pending.body as {
      approvalEvent: { id: string; evidenceIdentifierStatus: string };
      countsTowardDualApproval: boolean;
      orderStatus: string;
    };
    // Recorded, but flagged: a PDF cannot prove a quoted identifier by substring.
    expect(pendingBody.approvalEvent.evidenceIdentifierStatus).toBe('pending_manual_verification');
    expect(pendingBody.countsTowardDualApproval).toBe(false);
    expect(pendingBody.orderStatus).toBe('APPROVAL_PENDING');

    const [pendingRow] = await db.select().from(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.id, pendingBody.approvalEvent.id)).limit(1);
    expect(pendingRow?.evidenceIdentifierStatus).toBe('pending_manual_verification');

    // Seven approves with text evidence: the design still lacks a counted
    // customer approval, so the order must not reach DUAL_APPROVED.
    const sevenIdentifier = `MSG-M8-SEVEN-${nextTag()}`;
    const sevenEvidence = await uploadDocument({
      projectId,
      documentType: 'approval_evidence',
      issuerEntity: 'seven',
      designKey: 'label-front',
      orderId: chain.orderId,
      poId: chain.poId,
      content: `composite m8 approval evidence\nidentifier: ${sevenIdentifier}\n`
    });
    const sevenApproval = await postAs(staffToken, `/api/artwork-revisions/${revisionId}/approvals`, {
      organization: 'seven',
      decision: 'APPROVE',
      evidenceSource: 'email',
      eventTime: '2026-11-12T10:00:00.000Z',
      evidenceIdentifier: sevenIdentifier,
      evidenceDocumentVersionId: sevenEvidence.version.id
    });
    expect(sevenApproval.status).toBe(201);
    expect((sevenApproval.body as { dualApproved: boolean }).dualApproved).toBe(false);
    expect((sevenApproval.body as { orderStatus: string }).orderStatus).toBe('APPROVAL_PENDING');
    const orderStatus = (await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, chain.orderId)).limit(1))[0]?.status;
    expect(orderStatus).toBe('APPROVAL_PENDING');

    // A counted customer approval afterwards closes the gate.
    const textIdentifier = `MSG-M8-CUSTOMER-${nextTag()}`;
    const textEvidence = await uploadDocument({
      projectId,
      documentType: 'approval_evidence',
      issuerEntity: 'customer_generated',
      designKey: 'label-front',
      orderId: chain.orderId,
      poId: chain.poId,
      content: `composite m8 approval evidence\nidentifier: ${textIdentifier}\n`
    });
    const counted = await postAs(staffToken, `/api/artwork-revisions/${revisionId}/approvals`, {
      organization: 'customer',
      decision: 'APPROVE',
      evidenceSource: 'email',
      eventTime: '2026-11-12T11:00:00.000Z',
      evidenceIdentifier: textIdentifier,
      evidenceDocumentVersionId: textEvidence.version.id
    });
    expect(counted.status).toBe(201);
    expect((counted.body as { dualApproved: boolean }).dualApproved).toBe(true);
    expect((counted.body as { orderStatus: string }).orderStatus).toBe('DUAL_APPROVED');
  });

  it('still refuses a text identifier that is not in the cited evidence', async () => {
    const chain = await reachApprovalPending({ projectId, tag: `EVIDMISS-${nextTag()}` });
    const revisionId = chain.revisionId;
    const evidence = await uploadDocument({
      projectId,
      documentType: 'approval_evidence',
      issuerEntity: 'customer_generated',
      designKey: 'label-front',
      orderId: chain.orderId,
      poId: chain.poId,
      content: 'composite m8 approval evidence\nidentifier: MSG-M8-OTHER-0001\n'
    });
    const refused = await postAs(staffToken, `/api/artwork-revisions/${revisionId}/approvals`, {
      organization: 'customer',
      decision: 'APPROVE',
      evidenceSource: 'email',
      eventTime: '2026-11-12T10:00:00.000Z',
      evidenceIdentifier: 'MSG-M8-NOT-IN-FILE-0001',
      evidenceDocumentVersionId: evidence.version.id
    });
    expect(refused.status).toBe(422);
    expect((refused.body as { code: string }).code).toBe('EVIDENCE_IDENTIFIER_NOT_IN_DOCUMENT');
  });
});
