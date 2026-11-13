import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
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

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const viewerId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();

let staffToken = '';
let adminToken = '';
let viewerToken = '';
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

async function orderStatus(orderId: string) {
  const [row] = await db.select({ status: filmSupplyOrders.status }).from(filmSupplyOrders)
    .where(eq(filmSupplyOrders.id, orderId)).limit(1);
  return row?.status ?? null;
}

async function transitionAudits(orderId: string) {
  return await db.select().from(auditEvents).where(and(
    eq(auditEvents.entityType, 'film_supply_order'),
    eq(auditEvents.entityId, orderId),
    eq(auditEvents.action, 'FILM_SUPPLY_ORDER_TRANSITIONED')
  ));
}

/** A complete human record of the seven checklist items (design section 5.10). */
function fullChecklist() {
  return {
    issuerNameRecorded: true,
    issuerName: '合成セブン化学事業M7',
    documentNumberRecorded: true,
    documentNumber: 'PO-2026-1111-07',
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
    verificationNote: '合成チェックリスト記録M7'
  };
}

/** Officially registered but never checklist-verified: the S4 hole. */
async function setupRegisteredOnlyPo(tag: string) {
  const created = await postJson(`/api/projects/${projectId}/seven-purchase-orders`, {
    poNumber: `SEVEN-M7-REG-${tag}`,
    officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(created.status).toBe(201);
  return created.body as { id: string };
}

/** PO that is both checklist-verified and officially registered (T-04/T-05/T-06). */
async function setupVerifiedPo(tag: string) {
  const po = await setupRegisteredOnlyPo(tag);
  const checklist = await postJson(`/api/seven-purchase-orders/${po.id}/verification-checklist`, fullChecklist());
  expect(checklist.status).toBe(200);
  const official = await postJson(`/api/seven-purchase-orders/${po.id}/register-official`, {
    officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(official.status).toBe(200);
  return po;
}

async function createFilmOrder(poId: string, tag: string) {
  const created = await postJson(`/api/projects/${projectId}/film-supply-orders`, {
    code: `FSO-M7-${tag}`,
    sevenPurchaseOrderId: poId,
    lines: [{ lineNumber: 1, description: '合成フィルム本体M7', orderedQuantity: 100000, unit: 'sheets' }]
  });
  expect(created.status).toBe(201);
  return created.body as { id: string; lines: Array<{ id: string }> };
}

async function transitionOrder(orderId: string, to: string) {
  return await postJson(`/api/film-supply-orders/${orderId}/transitions`, { to });
}

async function uploadDocument(
  poId: string,
  orderId: string,
  overrides: Record<string, unknown> = {}
) {
  const tag = nextTag();
  const body = {
    documentType: 'proof',
    issuerEntity: 'kanei',
    filename: `m7-doc-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: toBase64(`composite m7 document bytes ${tag}\n`),
    sevenPurchaseOrderId: poId,
    filmSupplyOrderId: orderId,
    ...overrides
  };
  const response = await postJson(`/api/projects/${projectId}/documents`, body);
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

async function registerRevision(poId: string, orderId: string, designKey: string) {
  const proof = await uploadDocument(poId, orderId, { designKey });
  const registered = await postJson(`/api/film-supply-orders/${orderId}/artwork-revisions`, {
    designKey,
    fileDocumentVersionId: proof.version.id
  });
  expect(registered.status).toBe(201);
  return registered.body as { id: string; revisionNo: number };
}

async function recordApproval(
  revisionId: string,
  evidenceDocumentVersionId: string,
  overrides: Record<string, unknown> = {}
) {
  return await postJson(`/api/artwork-revisions/${revisionId}/approvals`, {
    organization: 'customer',
    decision: 'APPROVE',
    evidenceSource: 'email',
    eventTime: '2026-11-12T10:00:00.000Z',
    evidenceDocumentVersionId,
    evidenceIdentifier: 'MSG-M7-CUSTOMER-0001',
    approverName: '合成承認者M7',
    ...overrides
  });
}

/**
 * An order whose purchase order is verified, whose artwork is dual approved,
 * and whose state sits at MAKER_PO_READY — reached only through the dedicated
 * M4 maker purchase-order endpoints from here on.
 */
async function reachMakerPoReady(tag: string) {
  const po = await setupVerifiedPo(tag);
  const order = await createFilmOrder(po.id, tag);
  for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
    const transition = await transitionOrder(order.id, to);
    expect(transition.status).toBe(200);
  }
  const revision = await registerRevision(po.id, order.id, 'label-front');
  const customerEvidence = await uploadDocument(po.id, order.id, {
    documentType: 'approval_evidence',
    issuerEntity: 'customer_generated',
    designKey: 'label-front'
  });
  const customerApproval = await recordApproval(revision.id, customerEvidence.version.id);
  expect(customerApproval.status).toBe(201);
  const sevenEvidence = await uploadDocument(po.id, order.id, {
    documentType: 'approval_evidence',
    issuerEntity: 'seven',
    designKey: 'label-front'
  });
  const sevenApproval = await recordApproval(revision.id, sevenEvidence.version.id, {
    organization: 'seven',
    evidenceIdentifier: 'MSG-M7-SEVEN-0001'
  });
  expect(sevenApproval.status).toBe(201);
  expect((sevenApproval.body as { dualApproved: boolean }).dualApproved).toBe(true);

  const ready = await transitionOrder(order.id, 'MAKER_PO_READY');
  expect(ready.status).toBe(200);
  return { poId: po.id, orderId: order.id };
}

async function createMakerPo(orderId: string) {
  const created = await postJson(`/api/film-supply-orders/${orderId}/maker-purchase-orders`, {
    recipientAddress: 'maker-po@example.com',
    amounts: { currency: 'JPY', totalAmount: '480000' }
  });
  return { status: created.status, body: created.body as { id: string; status: string; snapshotSha256: string } };
}

async function approveMakerPo(poId: string) {
  return await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {});
}

async function sendMakerPoEvidence(poId: string, evidenceDocumentVersionId: string) {
  return await postJson(`/api/maker-purchase-orders/${poId}/send-evidence`, {
    evidenceDocumentVersionId,
    senderAddress: 'staff@kanei.example',
    recipients: ['maker-po@example.com'],
    sentAt: '2026-11-13T09:00:00.000Z'
  });
}

async function acceptMakerPoEvidence(poId: string, evidenceDocumentVersionId: string) {
  return await postJson(`/api/maker-purchase-orders/${poId}/accept-evidence`, {
    evidenceDocumentVersionId,
    acceptedAt: '2026-11-13T11:00:00.000Z'
  });
}

/**
 * Walks the maker chain through the dedicated M4 endpoints and returns the
 * audit-rich trail the audit-view test reads back: a frozen snapshot with
 * amounts, a send event with sender and recipients.
 */
async function reachMakerPoAccepted(tag: string) {
  const order = await reachMakerPoReady(tag);
  const created = await createMakerPo(order.orderId);
  expect(created.status).toBe(201);
  const poId = created.body.id;

  const approved = await approveMakerPo(poId);
  expect(approved.status).toBe(200);

  const sendEvidence = await uploadDocument(order.poId, order.orderId, { documentType: 'send_evidence' });
  await verifyDocument(sendEvidence.document.id, '合成送信証跡確認M7');
  const sent = await sendMakerPoEvidence(poId, sendEvidence.version.id);
  expect(sent.status).toBe(200);

  const acceptEvidence = await uploadDocument(order.poId, order.orderId, { documentType: 'acceptance_evidence' });
  await verifyDocument(acceptEvidence.document.id, '合成受領証跡確認M7');
  const accepted = await acceptMakerPoEvidence(poId, acceptEvidence.version.id);
  expect(accepted.status).toBe(200);

  return { ...order, makerPoId: poId };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-m7-security-'));
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
    { id: adminId, username: 'admin_m7_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者M7', role: 'admin' },
    { id: staffId, username: 'staff_m7_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者M7', role: 'staff' },
    { id: viewerId, username: 'viewer_m7_test', passwordHash: await hashPassword('composite-viewer-pass'), displayName: '合成閲覧者M7', role: 'viewer' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成M7エンドカスタマー', role: 'end_customer', externalCode: 'TEST-M7-CUST' },
    { id: sevenAccountId, name: '合成M7セブン', role: 'seven', externalCode: 'TEST-M7-SEVEN' },
    { id: makerAccountId, name: '合成M7メーカー', role: 'maker', externalCode: 'TEST-M7-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'TEST-M7-PROJECT',
    name: '合成M7案件',
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
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: staffId, projectId },
    { id: uuidv7(now), userId: viewerId, projectId }
  ]);
  for (const [name, userId] of [
    ['staff', staffId],
    ['admin', adminId],
    ['viewer', viewerId]
  ] as const) {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({
      id: uuidv7(),
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    });
    if (name === 'staff') staffToken = token;
    if (name === 'admin') adminToken = token;
    if (name === 'viewer') viewerToken = token;
  }
});

afterAll(async () => {
  await pool.end();
});

describe('S1: the generic transitions endpoint never reaches the maker chain', () => {
  it('refuses APPROVED_FOR_MANUAL_SEND, MAKER_PO_SENT_MANUALLY and MAKER_PO_ACCEPTED with 422', async () => {
    const order = await reachMakerPoReady('S1');
    const before = await transitionAudits(order.orderId);

    for (const to of ['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED']) {
      const response = await transitionOrder(order.orderId, to);
      expect(response.status).toBe(422);
      const body = response.body as { code: string; error: string };
      expect(body.code).toBe('MAKER_CHAIN_TRANSITION_FORBIDDEN');
      expect(body.error).toContain('メーカー発注書');
      expect(await orderStatus(order.orderId)).toBe('MAKER_PO_READY');
    }

    // Server-side enforcement, not UI hiding: nothing was written either.
    const after = await transitionAudits(order.orderId);
    expect(after).toHaveLength(before.length);
    for (const row of after) {
      const state = row.afterState as { status: string };
      expect(['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED'])
        .not.toContain(state.status);
    }
  });

  it('keeps the dedicated M4 maker purchase-order path working end to end', async () => {
    const order = await reachMakerPoReady('S1-DEDICATED');
    const created = await createMakerPo(order.orderId);
    expect(created.status).toBe(201);
    const poId = created.body.id;

    const approved = await approveMakerPo(poId);
    expect(approved.status).toBe(200);
    expect((approved.body as { purchaseOrder: { status: string } }).purchaseOrder.status)
      .toBe('APPROVED_FOR_MANUAL_SEND');
    expect(await orderStatus(order.orderId)).toBe('APPROVED_FOR_MANUAL_SEND');

    const sendEvidence = await uploadDocument(order.poId, order.orderId, { documentType: 'send_evidence' });
    await verifyDocument(sendEvidence.document.id, '合成送信証跡確認M7');
    const sent = await sendMakerPoEvidence(poId, sendEvidence.version.id);
    expect(sent.status).toBe(200);
    expect(await orderStatus(order.orderId)).toBe('MAKER_PO_SENT_MANUALLY');

    const acceptEvidence = await uploadDocument(order.poId, order.orderId, { documentType: 'acceptance_evidence' });
    await verifyDocument(acceptEvidence.document.id, '合成受領証跡確認M7');
    const accepted = await acceptMakerPoEvidence(poId, acceptEvidence.version.id);
    expect(accepted.status).toBe(200);
    expect(await orderStatus(order.orderId)).toBe('MAKER_PO_ACCEPTED');
  });
});

describe('S2: approval evidence is identified per organization', () => {
  it('rejects a second approval of the same evidence version for the same organization', async () => {
    const po = await setupVerifiedPo('S2-DUP');
    const order = await createFilmOrder(po.id, 'S2-DUP');
    for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
      const transition = await transitionOrder(order.id, to);
      expect(transition.status).toBe(200);
    }
    const revision = await registerRevision(po.id, order.id, 'label-front');
    const evidence = await uploadDocument(po.id, order.id, {
      documentType: 'approval_evidence',
      issuerEntity: 'customer_generated',
      designKey: 'label-front'
    });

    const first = await recordApproval(revision.id, evidence.version.id);
    expect(first.status).toBe(201);
    const firstBody = first.body as { approvalEvent: { id: string; evidenceIdentifier: string; externalApproverName: string | null } };
    expect(firstBody.approvalEvent.evidenceIdentifier).toBe('MSG-M7-CUSTOMER-0001');
    expect(firstBody.approvalEvent.externalApproverName).toBe('合成承認者M7');

    const duplicate = await recordApproval(revision.id, evidence.version.id);
    expect(duplicate.status).toBe(422);
    expect((duplicate.body as { code: string }).code).toBe('EVIDENCE_DUPLICATE_REGISTRATION');

    // The refusal persisted nothing: exactly one approval event exists. The
    // count is scoped to this project AND to the revision under test — the
    // earlier tests of this file share this project, so a project filter alone
    // would still count their approval events.
    const recorded = await db.select({ id: auditEvents.id, afterState: auditEvents.afterState })
      .from(auditEvents).where(and(
        eq(auditEvents.projectId, projectId),
        eq(auditEvents.entityType, 'artwork_approval_event'),
        eq(auditEvents.action, 'ARTWORK_APPROVAL_RECORDED')
      ));
    expect(recorded.filter((row) =>
      (row.afterState as { artworkRevisionId?: string }).artworkRevisionId === revision.id
    )).toHaveLength(1);
    expect(await orderStatus(order.id)).toBe('APPROVAL_PENDING');

    // The correction flow stays open: an explicit supersession of that event.
    const superseding = await recordApproval(revision.id, evidence.version.id, {
      supersedesEventId: firstBody.approvalEvent.id
    });
    expect(superseding.status).toBe(201);
  });

  it('requires a per-organization evidenceIdentifier of at least eight characters', async () => {
    const po = await setupVerifiedPo('S2-ID');
    const order = await createFilmOrder(po.id, 'S2-ID');
    for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
      const transition = await transitionOrder(order.id, to);
      expect(transition.status).toBe(200);
    }
    const revision = await registerRevision(po.id, order.id, 'label-front');
    const evidence = await uploadDocument(po.id, order.id, {
      documentType: 'approval_evidence',
      issuerEntity: 'customer_generated',
      designKey: 'label-front'
    });

    const missing = await postJson(`/api/artwork-revisions/${revision.id}/approvals`, {
      organization: 'customer',
      decision: 'APPROVE',
      evidenceSource: 'email',
      eventTime: '2026-11-12T10:00:00.000Z',
      evidenceDocumentVersionId: evidence.version.id
    });
    expect(missing.status).toBe(422);
    expect((missing.body as { code: string }).code).toBe('EVIDENCE_IDENTIFIER_REQUIRED');

    const tooShort = await recordApproval(revision.id, evidence.version.id, { evidenceIdentifier: 'short' });
    expect(tooShort.status).toBe(422);
    expect((tooShort.body as { code: string }).code).toBe('EVIDENCE_IDENTIFIER_TOO_SHORT');
  });

  it('blocks one evidenceIdentifier shared by both organizations on the same revision', async () => {
    const po = await setupVerifiedPo('S2-CROSS');
    const order = await createFilmOrder(po.id, 'S2-CROSS');
    for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
      const transition = await transitionOrder(order.id, to);
      expect(transition.status).toBe(200);
    }
    const revision = await registerRevision(po.id, order.id, 'label-front');
    const customerEvidence = await uploadDocument(po.id, order.id, {
      documentType: 'approval_evidence',
      issuerEntity: 'customer_generated',
      designKey: 'label-front'
    });
    const sevenEvidence = await uploadDocument(po.id, order.id, {
      documentType: 'approval_evidence',
      issuerEntity: 'seven',
      designKey: 'label-front'
    });

    const customer = await recordApproval(revision.id, customerEvidence.version.id, {
      evidenceIdentifier: 'MSG-M7-SHARED-BLOCK-01'
    });
    expect(customer.status).toBe(201);

    // A different file version does not help: the identifier is already taken
    // by the other organization on this revision.
    const reused = await recordApproval(revision.id, sevenEvidence.version.id, {
      organization: 'seven',
      evidenceIdentifier: 'MSG-M7-SHARED-BLOCK-01'
    });
    expect(reused.status).toBe(422);
    expect((reused.body as { code: string }).code).toBe('EVIDENCE_IDENTIFIER_REUSED_ACROSS_ORGANIZATIONS');
    expect((await orderStatus(order.id))).toBe('APPROVAL_PENDING');

    // Each organization carrying its own identifier is exactly what opens the gate.
    const seven = await recordApproval(revision.id, sevenEvidence.version.id, {
      organization: 'seven',
      evidenceIdentifier: 'MSG-M7-SEVEN-BLOCK-02'
    });
    expect(seven.status).toBe(201);
    expect((seven.body as { dualApproved: boolean }).dualApproved).toBe(true);
    expect(await orderStatus(order.id)).toBe('DUAL_APPROVED');

    const identifiers = await db.select({ id: auditEvents.id, afterState: auditEvents.afterState })
      .from(auditEvents).where(and(
        eq(auditEvents.projectId, projectId),
        eq(auditEvents.entityType, 'artwork_approval_event'),
        eq(auditEvents.action, 'ARTWORK_APPROVAL_RECORDED')
      ));
    // Scoped to this revision: the earlier tests of this file share this
    // project, so a project filter alone would still count their events.
    const revisionIdentifiers = identifiers.filter((row) =>
      (row.afterState as { artworkRevisionId?: string }).artworkRevisionId === revision.id
    );
    expect(revisionIdentifiers).toHaveLength(2);
    for (const row of revisionIdentifiers) {
      expect((row.afterState as { evidenceIdentifier: string }).evidenceIdentifier).toBeTruthy();
    }
  });
});

describe('S3: the audit history answer is filtered by role, the rows never are', () => {
  it('hides amounts, snapshots and senders from staff and everything but the summary from viewer', async () => {
    const trail = await reachMakerPoAccepted('S3');
    const url = `/api/projects/${projectId}/audit-history?limit=500`;

    const admin = await getAs(adminToken, url);
    expect(admin.status).toBe(200);
    const adminBody = admin.body as {
      events: Array<{ id: string; entityId: string; action: string; beforeState: unknown; afterState: Record<string, unknown>; requestMetadata: Record<string, unknown> }>;
    };
    const adminSend = adminBody.events.find((event) => event.action === 'MAKER_PO_SEND_EVIDENCE_REGISTERED');
    expect(adminSend).toBeDefined();
    const adminSendEvent = (adminSend?.afterState as { event: Record<string, unknown> }).event;
    expect(adminSendEvent.senderAddress).toBe('staff@kanei.example');
    expect(adminSendEvent.recipients).toEqual(['maker-po@example.com']);
    // Scoped to the maker purchase order this test walked: the earlier tests of
    // this file created their own maker POs in the same project, so an
    // unscoped find would compare their frozen snapshot with this one.
    const adminCreated = adminBody.events.find((event) =>
      event.action === 'MAKER_PO_CREATED' && event.entityId === trail.makerPoId
    );
    expect((adminCreated?.afterState as { snapshotSha256: string }).snapshotSha256)
      .toBe((await makerPoRow(trail.makerPoId))?.snapshotSha256);

    const staff = await getAs(staffToken, url);
    expect(staff.status).toBe(200);
    const staffBody = staff.body as {
      events: Array<{ id: string; action: string; beforeState: Record<string, unknown> | null; afterState: Record<string, unknown> | null; requestMetadata: Record<string, unknown> | null; actor: unknown }>;
    };
    expect(staffBody.events).toHaveLength(adminBody.events.length);
    const staffSend = staffBody.events.find((event) => event.action === 'MAKER_PO_SEND_EVIDENCE_REGISTERED');
    expect(staffSend?.afterState).toEqual({ status: 'MAKER_PO_SENT_MANUALLY' });
    const staffSerialized = JSON.stringify(staffBody.events);
    expect(staffSerialized).not.toContain('staff@kanei.example');
    expect(staffSerialized).not.toContain('maker-po@example.com');
    expect(staffSerialized).not.toContain('snapshotSha256');
    expect(staffSerialized).not.toContain('totalAmount');
    for (const event of staffBody.events) {
      if (event.requestMetadata !== null) {
        expect(Object.keys(event.requestMetadata)).toEqual(['operation']);
      }
      expect(event.actor).toMatchObject({ role: expect.any(String) });
    }

    const viewer = await getAs(viewerToken, url);
    expect(viewer.status).toBe(200);
    const viewerBody = viewer.body as {
      events: Array<Record<string, unknown>>;
    };
    expect(viewerBody.events).toHaveLength(adminBody.events.length);
    for (const event of viewerBody.events) {
      expect(Object.keys(event).sort()).toEqual(['action', 'actor', 'entityId', 'entityType', 'id', 'occurredAt']);
    }
    const viewerSerialized = JSON.stringify(viewerBody.events);
    expect(viewerSerialized).not.toContain('staff@kanei.example');
    expect(viewerSerialized).not.toContain('totalAmount');

    // The audit rows themselves are append-only and untouched by any read.
    const stored = await makerPoRow(trail.makerPoId);
    expect(stored?.snapshotSha256).toBe(adminCreated && (adminCreated.afterState as { snapshotSha256: string }).snapshotSha256);
    const [sendEventRow] = await db.select().from(makerPoEvents)
      .where(and(
        eq(makerPoEvents.makerPurchaseOrderId, trail.makerPoId),
        eq(makerPoEvents.eventType, 'SEND_EVIDENCE_REGISTERED')
      ));
    expect((sendEventRow as unknown as { senderAddress: string }).senderAddress).toBe('staff@kanei.example');
  });
});

describe('S4: a checklist-unverified purchase order cannot advance work', () => {
  it('refuses SEVEN_PO_VERIFIED until the authenticity checklist is recorded', async () => {
    const po = await setupRegisteredOnlyPo('S4-UNVERIFIED');
    const order = await createFilmOrder(po.id, 'S4-UNVERIFIED');

    const refused = await transitionOrder(order.id, 'SEVEN_PO_VERIFIED');
    expect(refused.status).toBe(422);
    expect((refused.body as { code: string }).code).toBe('SEVEN_PO_NOT_VERIFIED');
    expect(await orderStatus(order.id)).toBe('DRAFT');

    const checklist = await postJson(`/api/seven-purchase-orders/${po.id}/verification-checklist`, fullChecklist());
    expect(checklist.status).toBe(200);

    const allowed = await transitionOrder(order.id, 'SEVEN_PO_VERIFIED');
    expect(allowed.status).toBe(200);
    expect((allowed.body as { status: string }).status).toBe('SEVEN_PO_VERIFIED');
  });

  it('keeps T-06: the checklist never substitutes for official_registered_at', async () => {
    const created = await postJson(`/api/projects/${projectId}/seven-purchase-orders`, {
      poNumber: 'SEVEN-M7-T06'
    });
    expect(created.status).toBe(201);
    const po = created.body as { id: string };
    const checklist = await postJson(`/api/seven-purchase-orders/${po.id}/verification-checklist`, fullChecklist());
    expect(checklist.status).toBe(200);
    const order = await createFilmOrder(po.id, 'S4-T06');

    const refused = await transitionOrder(order.id, 'SEVEN_PO_VERIFIED');
    expect(refused.status).toBe(422);
    expect((refused.body as { code: string }).code).toBe('OFFICIAL_REGISTRATION_REQUIRED');
    expect(await orderStatus(order.id)).toBe('DRAFT');
  });

  it('blocks maker purchase-order creation for an order whose purchase order is unverified', async () => {
    const po = await setupRegisteredOnlyPo('S4-MAKERPO');
    const order = await createFilmOrder(po.id, 'S4-MAKERPO');
    // Composite test state: an order parked at MAKER_PO_READY without ever
    // having passed the seven PO gate.
    await db.update(filmSupplyOrders).set({ status: 'MAKER_PO_READY' })
      .where(eq(filmSupplyOrders.id, order.id));

    const created = await createMakerPo(order.id);
    expect(created.status).toBe(422);
    expect((created.body as unknown as { code: string }).code).toBe('SEVEN_PO_NOT_VERIFIED');
    const [poRow] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, order.id));
    expect(poRow).toBeUndefined();
  });

  it('keeps the artwork path closed: the proof an artwork revision needs needs a verified checklist', async () => {
    const po = await setupRegisteredOnlyPo('S4-ARTWORK');
    const order = await createFilmOrder(po.id, 'S4-ARTWORK');
    await db.update(filmSupplyOrders).set({ status: 'ARTWORK_RECEIVED' })
      .where(eq(filmSupplyOrders.id, order.id));

    const proof = await postJson(`/api/projects/${projectId}/documents`, {
      documentType: 'proof',
      issuerEntity: 'kanei',
      filename: 'm7-s4-artwork.txt',
      contentType: 'text/plain',
      contentBase64: toBase64('composite m7 artwork bytes\n'),
      sevenPurchaseOrderId: po.id,
      filmSupplyOrderId: order.id,
      designKey: 'label-front'
    });
    expect(proof.status).toBe(422);
    expect((proof.body as { code: string }).code).toBe('SEVEN_PO_NOT_VERIFIED');

    // Nothing can be registered as an artwork revision either: the endpoint
    // applies the same precedence gate to the order it would advance.
    const registered = await postJson(`/api/film-supply-orders/${order.id}/artwork-revisions`, {
      designKey: 'label-front',
      fileDocumentVersionId: '00000000-0000-7000-8000-000000000000'
    });
    expect(registered.status).toBe(422);
    expect((registered.body as { code: string }).code).toBe('SEVEN_PO_NOT_VERIFIED');

    const checklist = await postJson(`/api/seven-purchase-orders/${po.id}/verification-checklist`, fullChecklist());
    expect(checklist.status).toBe(200);
    const allowed = await postJson(`/api/projects/${projectId}/documents`, {
      documentType: 'proof',
      issuerEntity: 'kanei',
      filename: 'm7-s4-artwork.txt',
      contentType: 'text/plain',
      contentBase64: toBase64('composite m7 artwork bytes\n'),
      sevenPurchaseOrderId: po.id,
      filmSupplyOrderId: order.id,
      designKey: 'label-front'
    });
    expect(allowed.status).toBe(201);
  });
});

async function makerPoRow(poId: string) {
  const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)).limit(1);
  return row;
}
