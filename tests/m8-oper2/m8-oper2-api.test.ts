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
  evidenceManualVerifications,
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
 * M8-OPER2 regression tests over the real endpoints:
 *
 * FIX 1 — the G6 terms are enterable end to end: created with terms, updated
 * while DRAFT through PATCH /api/film-supply-orders/:orderId/payment-terms
 * (staff allowed, viewer refused), and the gate read answers the recorded term.
 * Recording a term is never an 入金確認: payment_confirmed_at stays null.
 * FIX 2 — POST /api/artwork-approval-events/:eventId/verification records a NEW
 * append-only verification (admin only) and only a 'confirmed' verification
 * lets a pending_manual_verification approval complete the dual approval.
 * FIX 3 — an order that progressed past MAKER_PO_ACCEPTED still answers its
 * maker purchase-order history read (발주서・승인・발송・수락 trail) while the
 * recording endpoints stay closed for the finished paper.
 */

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
  Buffer.from([0x10, 0x20, 0x30, 0xfe, 0xff]),
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

function fullChecklist() {
  return {
    issuerNameRecorded: true,
    issuerName: '合成セブン化学事業',
    documentNumberRecorded: true,
    documentNumber: `PO-2026-OPER2-${nextTag()}`,
    issueDateRecorded: true,
    issueDate: '2026-11-12',
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
  const content = input.content ?? `composite m8-oper2 document bytes ${tag}\n`;
  const response = await postAs(staffToken, `/api/projects/${projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `m8oper2-doc-${tag}.${contentType === 'application/pdf' ? 'pdf' : 'txt'}`,
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
 * An order at APPROVAL_PENDING with one registered design and no approval yet —
 * every approval the tests record is the first one for the design.
 */
async function reachApprovalPending(tag: string) {
  const createdPo = await postAs(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, {
    poNumber: `SEVEN-OPER2-${tag}`,
    officialRegisteredAt: '2026-11-12T09:00:00.000Z'
  });
  expect(createdPo.status).toBe(201);
  const po = createdPo.body as { id: string };

  expect((await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/verification-checklist`, fullChecklist())).status).toBe(200);
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/register-official`, {
    officialRegisteredAt: '2026-11-12T09:00:00.000Z'
  })).status).toBe(200);

  const createdOrder = await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/supply-orders`, {
    code: `FSO-OPER2-${tag}`,
    paymentTerms: 'prepaid',
    lines: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 100000, unit: 'sheets' }]
  });
  expect(createdOrder.status).toBe(201);
  const order = createdOrder.body as { id: string; paymentTerms: string; status: string };
  expect(order.status).toBe('DRAFT');

  for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
    const transition = await postAs(staffToken, `/api/film-supply-orders/${order.id}/transitions`, { to });
    expect(transition.status).toBe(200);
  }

  const proof = await uploadDocument({
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

  return { poId: po.id, orderId: order.id, revisionId: (revision.body as { id: string }).id };
}

/** Records one counted approval with text evidence that quotes its identifier. */
async function recordTextApproval(input: {
  chain: Awaited<ReturnType<typeof reachApprovalPending>>;
  organization: 'customer' | 'seven';
}) {
  const identifier = `MSG-OPER2-${input.organization.toUpperCase()}-${nextTag()}`;
  const evidence = await uploadDocument({
    documentType: 'approval_evidence',
    issuerEntity: input.organization === 'seven' ? 'seven' : 'customer_generated',
    designKey: 'label-front',
    orderId: input.chain.orderId,
    poId: input.chain.poId,
    content: `composite m8-oper2 approval evidence\nidentifier: ${identifier}\n`
  });
  const approval = await postAs(staffToken, `/api/artwork-revisions/${input.chain.revisionId}/approvals`, {
    organization: input.organization,
    decision: 'APPROVE',
    evidenceSource: 'email',
    eventTime: '2026-11-13T10:00:00.000Z',
    evidenceIdentifier: identifier,
    evidenceDocumentVersionId: evidence.version.id
  });
  expect(approval.status).toBe(201);
  return approval.body as {
    approvalEvent: { id: string; evidenceIdentifierStatus: string };
    countsTowardDualApproval: boolean;
    dualApproved: boolean;
    orderStatus: string;
  };
}

/** Records one pending approval whose evidence is a real PDF. */
async function recordPendingPdfApproval(input: {
  chain: Awaited<ReturnType<typeof reachApprovalPending>>;
  organization: 'customer' | 'seven';
}) {
  const evidence = await uploadDocument({
    documentType: 'approval_evidence',
    issuerEntity: input.organization === 'seven' ? 'seven' : 'customer_generated',
    designKey: 'label-front',
    orderId: input.chain.orderId,
    poId: input.chain.poId,
    contentType: 'application/pdf'
  });
  const approval = await postAs(staffToken, `/api/artwork-revisions/${input.chain.revisionId}/approvals`, {
    organization: input.organization,
    decision: 'APPROVE',
    evidenceSource: 'signed_document',
    eventTime: '2026-11-13T10:00:00.000Z',
    evidenceIdentifier: `SIGNBLOCK-OPER2-${nextTag()}-not-in-pdf-bytes`,
    evidenceDocumentVersionId: evidence.version.id
  });
  expect(approval.status).toBe(201);
  return approval.body as {
    approvalEvent: { id: string; evidenceIdentifierStatus: string };
    countsTowardDualApproval: boolean;
    dualApproved: boolean;
    orderStatus: string;
  };
}

/**
 * Drives an order from MAKER_PO_READY to FILM_IN_PRODUCTION through the real
 * maker purchase-order chain (create → CEO approval → send → accept).
 */
async function reachProduction(tag: string) {
  const chain = await reachApprovalPending(tag);
  expect((await recordTextApproval({ chain, organization: 'customer' })).countsTowardDualApproval).toBe(true);
  expect((await recordTextApproval({ chain, organization: 'seven' })).dualApproved).toBe(true);
  expect((await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'MAKER_PO_READY' })).status).toBe(200);

  const created = await postAs(adminToken, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, {
    recipientAddress: 'maker-po@example.com'
  });
  expect(created.status).toBe(201);
  const poId = (created.body as { id: string }).id;

  expect((await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {})).status).toBe(200);

  const sendEvidence = await uploadDocument({
    documentType: 'send_evidence',
    issuerEntity: 'kanei',
    orderId: chain.orderId,
    poId: chain.poId,
    content: 'composite m8-oper2 send evidence\n'
  });
  expect((await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
    evidenceDocumentVersionId: sendEvidence.version.id,
    senderAddress: 'staff@kanei.example',
    recipients: ['maker-po@example.com'],
    sentAt: '2026-11-14T09:00:00.000Z'
  })).status).toBe(200);

  const acceptEvidence = await uploadDocument({
    documentType: 'acceptance_evidence',
    issuerEntity: 'kanei',
    orderId: chain.orderId,
    poId: chain.poId,
    content: 'composite m8-oper2 acceptance evidence\n'
  });
  expect((await postAs(staffToken, `/api/documents/${acceptEvidence.document.id}/verify`, {
    verificationStatus: 'verified'
  })).status).toBe(200);
  expect((await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
    evidenceDocumentVersionId: acceptEvidence.version.id,
    acceptedAt: '2026-11-14T12:00:00.000Z'
  })).status).toBe(200);

  const production = await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, {
    to: 'FILM_IN_PRODUCTION'
  });
  expect(production.status).toBe(200);

  return { ...chain, poId };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-m8-oper2-'));
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
    { id: adminId, username: 'admin_oper2_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者OPER2', role: 'admin' },
    { id: staffId, username: 'staff_oper2_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者OPER2', role: 'staff' },
    { id: viewerId, username: 'viewer_oper2_test', passwordHash: await hashPassword('composite-viewer-pass'), displayName: '合成閲覧者OPER2', role: 'viewer' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成OPER2エンドカスタマー', role: 'end_customer', externalCode: 'TEST-OPER2-CUST' },
    { id: sevenAccountId, name: '合成OPER2セブン', role: 'seven', externalCode: 'TEST-OPER2-SEVEN' },
    { id: makerAccountId, name: '合成OPER2メーカー', role: 'maker', externalCode: 'TEST-OPER2-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'TEST-OPER2-PROJECT',
    name: '合成OPER2案件',
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
    { id: uuidv7(), userId: staffId, projectId },
    { id: uuidv7(), userId: viewerId, projectId }
  ]);
  for (const [userId, key] of [
    [adminId, 'admin'],
    [staffId, 'staff'],
    [viewerId, 'viewer']
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
  }
});

afterAll(async () => {
  await pool.end();
});

describe('M8-OPER2 FIX 1: the G6 terms are enterable end to end', () => {
  it('creates an order with its terms and answers the gate read with them', async () => {
    const created = await postAs(staffToken, `/api/projects/${projectId}/film-supply-orders`, {
      code: `FSO-OPER2-CREATE-${nextTag()}`,
      paymentTerms: 'prepaid',
      lines: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 50000, unit: 'sheets' }]
    });
    expect(created.status).toBe(201);
    const order = created.body as { id: string; status: string; paymentTerms: string };
    expect(order.status).toBe('DRAFT');
    expect(order.paymentTerms).toBe('prepaid');

    const gate = await getAs(staffToken, `/api/film-supply-orders/${order.id}/payment-gate`);
    expect(gate.status).toBe(200);
    expect(gate.body).toMatchObject({
      orderId: order.id,
      orderStatus: 'DRAFT',
      paymentTerms: 'prepaid',
      paymentConfirmedAt: null
    });
    expect((gate.body as { gate: { satisfied: boolean } }).gate.satisfied).toBe(true);
  });

  it('updates the terms on a DRAFT from the /orders path and records the audit row', async () => {
    // An order created without a term (the select omitted) starts undetermined —
    // the term that keeps G6 closed — on the seven-PO linked path the screen uses.
    const createdPo = await postAs(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, {
      poNumber: `SEVEN-OPER2-PATCH-${nextTag()}`,
      officialRegisteredAt: '2026-11-12T09:00:00.000Z'
    });
    expect(createdPo.status).toBe(201);
    const po = createdPo.body as { id: string };
    expect((await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/verification-checklist`, fullChecklist())).status).toBe(200);
    expect((await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/register-official`, {
      officialRegisteredAt: '2026-11-12T09:00:00.000Z'
    })).status).toBe(200);
    const created = await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/supply-orders`, {
      code: `FSO-OPER2-PATCH-${nextTag()}`,
      lines: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 50000, unit: 'sheets' }]
    });
    expect(created.status).toBe(201);
    const order = created.body as { id: string; paymentTerms: string };
    expect(order.paymentTerms).toBe('undetermined');

    const viewerAttempt = await patchAs(viewerToken, `/api/film-supply-orders/${order.id}/payment-terms`, {
      paymentTerms: 'on_delivery'
    });
    expect(viewerAttempt.status).toBe(403);

    const updated = await patchAs(staffToken, `/api/film-supply-orders/${order.id}/payment-terms`, {
      paymentTerms: 'on_delivery'
    });
    expect(updated.status).toBe(200);
    expect((updated.body as { paymentTerms: string }).paymentTerms).toBe('on_delivery');

    const [audit] = await db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'FILM_SUPPLY_ORDER_PAYMENT_TERMS_UPDATED'),
      eq(auditEvents.entityId, order.id)
    )).limit(1);
    expect(audit).toBeTruthy();
    expect((audit?.beforeState as Record<string, unknown>).paymentTerms).toBe('undetermined');
    expect((audit?.afterState as Record<string, unknown>).paymentTerms).toBe('on_delivery');

    // Recording a term is a term, never an 入金確認.
    const gate = await getAs(staffToken, `/api/film-supply-orders/${order.id}/payment-gate`);
    expect((gate.body as { paymentConfirmedAt: string | null }).paymentConfirmedAt).toBeNull();

    // Once the order leaves DRAFT the write is locked again.
    expect((await postAs(staffToken, `/api/film-supply-orders/${order.id}/transitions`, { to: 'SEVEN_PO_VERIFIED' })).status).toBe(200);
    const locked = await patchAs(adminToken, `/api/film-supply-orders/${order.id}/payment-terms`, {
      paymentTerms: 'prepaid'
    });
    expect(locked.status).toBe(422);
    expect((locked.body as { code: string }).code).toBe('PAYMENT_TERMS_LOCKED');
  });
});

describe('M8-OPER2 FIX 2: the evidence manual verification workflow', () => {
  it('verifies a pending PDF approval: rejected first keeps the gate closed, then confirmation completes it', async () => {
    const chain = await reachApprovalPending(`VERIFY-${nextTag()}`);
    const pending = await recordPendingPdfApproval({ chain, organization: 'customer' });
    expect(pending.approvalEvent.evidenceIdentifierStatus).toBe('pending_manual_verification');
    expect(pending.countsTowardDualApproval).toBe(false);
    expect((await recordTextApproval({ chain, organization: 'seven' })).dualApproved).toBe(false);

    // The gate read reports the pending approval to admin only.
    const adminGate = await getAs(adminToken, `/api/film-supply-orders/${chain.orderId}/approval-gate`);
    expect(adminGate.status).toBe(200);
    const adminPending = (adminGate.body as { pendingManualVerifications: Array<Record<string, unknown>> })
      .pendingManualVerifications;
    expect(adminPending).toHaveLength(1);
    expect(adminPending[0]).toMatchObject({
      approvalEventId: pending.approvalEvent.id,
      organization: 'customer',
      designKey: 'label-front',
      revisionNo: 1
    });
    expect(adminPending[0]?.evidenceIdentifier).toBeTruthy();
    const staffGate = await getAs(staffToken, `/api/film-supply-orders/${chain.orderId}/approval-gate`);
    expect((staffGate.body as { pendingManualVerifications: unknown[] }).pendingManualVerifications).toEqual([]);

    // The representative only: staff and viewer are refused, nothing is written.
    for (const [label, token] of [['staff', staffToken], ['viewer', viewerToken]] as const) {
      const refused = await postAs(token, `/api/artwork-approval-events/${pending.approvalEvent.id}/verification`, {
        result: 'confirmed',
        verifierName: `合成${label}検証`,
        verifiedAt: '2026-11-14T10:00:00.000Z',
        reasonNote: '原本PDFの署名ブロックを確認'
      });
      expect(refused.status).toBe(403);
    }
    expect(await db.select().from(evidenceManualVerifications)).toHaveLength(0);

    // Unknown approval event, invalid payloads.
    expect((await postAs(adminToken, '/api/artwork-approval-events/44444444-4444-7444-8444-00000000000a/verification', {
      result: 'confirmed', verifierName: '合成代表者', verifiedAt: '2026-11-14T10:00:00.000Z', reasonNote: '確認'
    })).status).toBe(404);
    expect((await postAs(adminToken, `/api/artwork-approval-events/${pending.approvalEvent.id}/verification`, {
      result: 'maybe', verifierName: '合成代表者', verifiedAt: '2026-11-14T10:00:00.000Z', reasonNote: '確認'
    })).status).toBe(422);
    expect((await postAs(adminToken, `/api/artwork-approval-events/${pending.approvalEvent.id}/verification`, {
      result: 'confirmed', verifiedAt: '2026-11-14T10:00:00.000Z', reasonNote: '確認'
    })).status).toBe(422);
    expect((await postAs(adminToken, `/api/artwork-approval-events/${pending.approvalEvent.id}/verification`, {
      result: 'confirmed', verifierName: '合成代表者', verifiedAt: '2026-11-14T10:00:00.000Z'
    })).status).toBe(422);

    // A rejected verification is recorded but keeps the gate closed.
    const rejected = await postAs(adminToken, `/api/artwork-approval-events/${pending.approvalEvent.id}/verification`, {
      result: 'rejected',
      verifierName: '合成代表者',
      verifiedAt: '2026-11-14T10:00:00.000Z',
      reasonNote: '原本PDFに識別子が見つからない'
    });
    expect(rejected.status).toBe(201);
    const rejectedBody = rejected.body as {
      verification: { result: string; approvalEventId: string };
      countsTowardDualApproval: boolean;
      orderStatus: string;
      dualApproved: boolean;
    };
    expect(rejectedBody.verification.result).toBe('rejected');
    expect(rejectedBody.countsTowardDualApproval).toBe(false);
    expect(rejectedBody.dualApproved).toBe(false);
    expect(rejectedBody.orderStatus).toBe('APPROVAL_PENDING');

    // The original approval event is never rewritten by a verification.
    const [approvalRow] = await db.select().from(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.id, pending.approvalEvent.id)).limit(1);
    expect(approvalRow?.evidenceIdentifierStatus).toBe('pending_manual_verification');

    // ...and a confirmation afterwards is the record that completes the gate.
    const confirmed = await postAs(adminToken, `/api/artwork-approval-events/${pending.approvalEvent.id}/verification`, {
      result: 'confirmed',
      verifierName: '合成代表者',
      verifiedAt: '2026-11-14T11:00:00.000Z',
      reasonNote: '原本PDFの署名ブロックに同一識別子を確認（再確認）'
    });
    expect(confirmed.status).toBe(201);
    const confirmedBody = confirmed.body as {
      verification: { result: string };
      countsTowardDualApproval: boolean;
      dualApproved: boolean;
      orderStatus: string;
    };
    expect(confirmedBody.countsTowardDualApproval).toBe(true);
    expect(confirmedBody.dualApproved).toBe(true);
    // The order advances to DUAL_APPROVED exactly like an approval-driven close.
    expect(confirmedBody.orderStatus).toBe('DUAL_APPROVED');
    const [orderRow] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, chain.orderId)).limit(1);
    expect(orderRow?.status).toBe('DUAL_APPROVED');

    // Two append-only rows exist; the latest (confirmed) is the one that counts.
    const verificationRows = await db.select().from(evidenceManualVerifications)
      .where(eq(evidenceManualVerifications.approvalEventId, pending.approvalEvent.id));
    expect(verificationRows).toHaveLength(2);

    // The audit trail: the verification is a NEW record of type evidence manual
    // verification naming the original approval event, never an UPDATE of it.
    const verifications = await db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'EVIDENCE_MANUAL_VERIFICATION_RECORDED'),
      eq(auditEvents.entityId, pending.approvalEvent.id)
    ));
    expect(verifications).toHaveLength(2);
    const lastAudit = verifications[verifications.length - 1]?.afterState as Record<string, unknown>;
    expect(lastAudit.result).toBe('confirmed');
    expect(lastAudit.verificationType).toBe('evidence_manual_verification');
    expect(lastAudit.approvalEventId).toBe(pending.approvalEvent.id);

    // A confirmed verification is final: nothing can flip it afterwards. The
    // append-only correction path for a wrong approval is the organization's
    // own REVOKE, not a second verification.
    const again = await postAs(adminToken, `/api/artwork-approval-events/${pending.approvalEvent.id}/verification`, {
      result: 'rejected',
      verifierName: '合成代表者',
      verifiedAt: '2026-11-14T12:00:00.000Z',
      reasonNote: '確認後の訂正はREVOKEとして記録すべき'
    });
    expect(again.status).toBe(422);
    expect((again.body as { code: string }).code).toBe('EVIDENCE_ALREADY_CONFIRMED');
  });

  it('refuses to verify an approval whose identifier was already verified in the document', async () => {
    const chain = await reachApprovalPending(`COUNTED-${nextTag()}`);
    const counted = await recordTextApproval({ chain, organization: 'customer' });
    expect(counted.approvalEvent.evidenceIdentifierStatus).toBe('verified_in_document');

    const refused = await postAs(adminToken, `/api/artwork-approval-events/${counted.approvalEvent.id}/verification`, {
      result: 'confirmed',
      verifierName: '合成代表者',
      verifiedAt: '2026-11-14T10:00:00.000Z',
      reasonNote: '自動検証済みの承認は手動確認の対象外'
    });
    expect(refused.status).toBe(422);
    expect((refused.body as { code: string }).code).toBe('EVIDENCE_NOT_PENDING_MANUAL_VERIFICATION');
  });

  it('keeps the verification rows append-only at the database level', async () => {
    const chain = await reachApprovalPending(`APPEND-${nextTag()}`);
    const pending = await recordPendingPdfApproval({ chain, organization: 'customer' });
    await postAs(adminToken, `/api/artwork-approval-events/${pending.approvalEvent.id}/verification`, {
      result: 'confirmed',
      verifierName: '合成代表者',
      verifiedAt: '2026-11-14T10:00:00.000Z',
      reasonNote: '原本PDFの署名ブロックを確認'
    });
    const [row] = await db.select().from(evidenceManualVerifications)
      .where(eq(evidenceManualVerifications.approvalEventId, pending.approvalEvent.id)).limit(1);
    expect(row).toBeTruthy();

    await expect(db.update(evidenceManualVerifications)
      .set({ reasonNote: '書き換え' })
      .where(eq(evidenceManualVerifications.id, row!.id))).rejects.toThrow(/append-only/);
    await expect(db.delete(evidenceManualVerifications)
      .where(eq(evidenceManualVerifications.id, row!.id))).rejects.toThrow(/append-only/);
  });
});

describe('M8-OPER2 FIX 3: maker-PO history past MAKER_PO_ACCEPTED', () => {
  it('an order in production keeps answering its maker-PO history read', async () => {
    const chain = await reachProduction(`HIST-${nextTag()}`);

    const [orderRow] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, chain.orderId)).limit(1);
    expect(orderRow?.status).toBe('FILM_IN_PRODUCTION');

    for (const token of [adminToken, staffToken, viewerToken]) {
      const list = await getAs(token, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`);
      expect(list.status).toBe(200);
      const rows = (list.body as { makerPurchaseOrders: Array<{ id: string; status: string }> }).makerPurchaseOrders;
      expect(rows.map((row) => row.id)).toContain(chain.poId);
      expect(rows.find((row) => row.id === chain.poId)?.status).toBe('MAKER_PO_ACCEPTED');
    }

    const detail = await getAs(viewerToken, `/api/maker-purchase-orders/${chain.poId}`);
    expect(detail.status).toBe(200);
    const events = (detail.body as { events: Array<{ eventType: string }> }).events;
    const eventTypes = events.map((event) => event.eventType);
    expect(eventTypes).toContain('CEO_APPROVED');
    expect(eventTypes).toContain('SEND_EVIDENCE_REGISTERED');
    expect(eventTypes).toContain('ACCEPT_EVIDENCE_REGISTERED');

    // The finished paper has no further recording step to reach for: the
    // approval / send / acceptance endpoints refuse a paper that is already
    // accepted, so the history the screen shows stays the history that happened.
    const reApproval = await postAs(adminToken, `/api/maker-purchase-orders/${chain.poId}/ceo-approval`, {});
    expect(reApproval.status).toBe(422);
    expect((reApproval.body as { code: string }).code).toBe('MAKER_PO_TRANSITION_BLOCKED');
    const reSend = await postAs(staffToken, `/api/maker-purchase-orders/${chain.poId}/send-evidence`, {
      evidenceDocumentVersionId: '44444444-4444-7444-8444-00000000000b',
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-15T09:00:00.000Z'
    });
    expect(reSend.status).toBe(422);
    const [poRowAfter] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, chain.poId)).limit(1);
    expect(poRowAfter?.status).toBe('MAKER_PO_ACCEPTED');
    const poEventRows = await db.select().from(makerPoEvents)
      .where(eq(makerPoEvents.makerPurchaseOrderId, chain.poId));
    expect(poEventRows.filter((event) => event.eventType === 'CEO_APPROVED')).toHaveLength(1);
    expect(poEventRows.filter((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED')).toHaveLength(1);
    expect(poEventRows.filter((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED')).toHaveLength(1);
  });
});
