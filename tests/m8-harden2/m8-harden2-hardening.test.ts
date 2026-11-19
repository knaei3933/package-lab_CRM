import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  artworkRevisions,
  auditEvents,
  createDatabase,
  documents,
  filmSupplyOrders,
  makerPoEvents,
  makerPoSendManualVerifications,
  makerPurchaseOrders,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import {
  classifyMakerPoCancellation,
  evaluateMakerPoCancellationAckGate,
  MAKER_PO_EVENT_TYPES,
  validateMakerPoEventType
} from '@kanei/core';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../../apps/api/src/auth.js';
import { sendMakerPoEmlEvidence, plausibleTestSentAt } from '../helpers/maker-po-evidence.js';

/**
 * M8-HARDEN2 regression tests: the three CEO-approved follow-up fixes.
 *
 * FIX 1 — the EML attachment match becomes the gate: a send reaches VERIFIED
 *     only when the message carries at least one attachment whose sha256 is one
 *     of the approved artifact hashes the frozen paper names. Header-clean mail
 *     with no attachment, with attachments matching nothing approved (a
 *     re-exported PDF among them) or pointing at a download link stays
 *     PENDING_MANUAL_VERIFICATION with attachment_missing /
 *     attachment_hash_mismatch / attachment_link_only on the event.
 * FIX 2 — cancellation/re-order safety after a proven send: an internal cancel
 *     (no verified send) frees the order immediately, but cancelling paper whose
 *     send was proven records the same append-only events AND closes the
 *     ordering step until the representative records a
 *     MAKER_CANCELLATION_ACKNOWLEDGED event for that paper — a new maker PO is
 *     refused with 422 MAKER_PO_CANCELLATION_ACK_REQUIRED until then, so a sent
 *     paper and its replacement can never both be in production at once.
 * FIX 3 — what happens after a PENDING_MANUAL_VERIFICATION send is manually
 *     confirmed: the confirmation carries the paper to MAKER_PO_SENT_MANUALLY
 *     exactly like a VERIFIED send does, so acceptance becomes reachable, while
 *     a still-pending send keeps acceptance blocked and a rejected confirmation
 *     moves nothing. A second confirmation of the same event is refused.
 *
 * Nowhere does an EML header check claim an actual delivery: VERIFIED (and the
 * confirmed manual verification) say the email content and recipient were
 * verified against the frozen paper; the delivery assertion is the
 * representative's manual record alone.
 */

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const projectId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();

let adminToken = '';
let staffToken = '';
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

async function requestAs(token: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  const response = await app.request(url, {
    method,
    headers: { 'content-type': 'application/json', ...cookieHeader(token) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

async function postAs(token: string, url: string, body: unknown = {}) {
  return await requestAs(token, 'POST', url, body);
}

async function getAs(token: string, url: string) {
  return await requestAs(token, 'GET', url);
}

function fullChecklist() {
  return {
    issuerNameRecorded: true,
    issuerName: '合成セブン化学事業',
    documentNumberRecorded: true,
    documentNumber: `PO-2026-H2-${nextTag()}`,
    issueDateRecorded: true,
    issueDate: '2026-11-15',
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
  content?: string;
  makerPoId?: string;
}) {
  const tag = nextTag();
  const content = input.content ?? `composite m8-harden2 document bytes ${tag}\n`;
  const response = await postAs(staffToken, `/api/projects/${projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `m8harden2-doc-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: toBase64(content),
    ...(input.poId ? { sevenPurchaseOrderId: input.poId } : {}),
    ...(input.orderId ? { filmSupplyOrderId: input.orderId } : {}),
    ...(input.makerPoId ? { makerPurchaseOrderId: input.makerPoId } : {}),
    ...(input.designKey ? { designKey: input.designKey } : {})
  });
  expect(response.status).toBe(201);
  return {
    ...(response.body as { document: { id: string }; version: { id: string; sha256: string } }),
    /** The bytes the version stores, so an EML can attach exactly them. */
    bytes: content
  };
}

/** An order at APPROVAL_PENDING with one registered design and no approval yet. */
async function reachApprovalPending(tag: string) {
  const createdPo = await postAs(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, {
    poNumber: `SEVEN-H2-${tag}`
  });
  expect(createdPo.status).toBe(201);
  const po = createdPo.body as { id: string };

  expect((await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/verification-checklist`, fullChecklist())).status).toBe(200);
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/register-official`, {
    officialRegisteredAt: '2026-11-14T09:00:00.000Z'
  })).status).toBe(200);

  const orderCode = `FSO-H2-${tag}`;
  const createdOrder = await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/supply-orders`, {
    code: orderCode,
    paymentTerms: 'prepaid',
    lines: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 100000, unit: 'sheets' }]
  });
  expect(createdOrder.status).toBe(201);
  const order = createdOrder.body as { id: string; status: string };
  expect(order.status).toBe('DRAFT');

  for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
    const transition = await postAs(staffToken, `/api/film-supply-orders/${order.id}/transitions`, { to });
    expect(transition.status).toBe(200);
  }

  // The proof bytes are the approved artwork the maker PO snapshot freezes by
  // hash, so a send evidence attachment carrying exactly them is what FIX 1
  // requires for a VERIFIED send.
  const artworkBytes = `composite m8-harden2 artwork bytes ${tag}\n`;
  const proof = await uploadDocument({
    documentType: 'proof',
    issuerEntity: 'kanei',
    designKey: 'label-front',
    orderId: order.id,
    poId: po.id,
    content: artworkBytes
  });
  expect(proof.bytes).toBe(artworkBytes);
  const revision = await postAs(staffToken, `/api/film-supply-orders/${order.id}/artwork-revisions`, {
    designKey: 'label-front',
    fileDocumentVersionId: proof.version.id
  });
  expect(revision.status).toBe(201);

  return {
    poId: po.id,
    orderId: order.id,
    orderCode,
    /** The exact bytes the approved artwork revision freezes (its sha256). */
    artworkBytes,
    revisionId: (revision.body as { id: string }).id
  };
}

/** Records one counted TEXT approval whose evidence quotes its identifier. */
async function recordTextApproval(input: {
  chain: Awaited<ReturnType<typeof reachApprovalPending>>;
  organization: 'customer' | 'seven';
}) {
  const identifier = `MSG-H2-${input.organization.toUpperCase()}-${nextTag()}`;
  const evidence = await uploadDocument({
    documentType: 'approval_evidence',
    issuerEntity: input.organization === 'seven' ? 'seven' : 'customer_generated',
    designKey: 'label-front',
    orderId: input.chain.orderId,
    poId: input.chain.poId,
    content: `composite m8-harden2 approval evidence\nidentifier: ${identifier}\n`
  });
  const approval = await postAs(staffToken, `/api/artwork-revisions/${input.chain.revisionId}/approvals`, {
    organization: input.organization,
    decision: 'APPROVE',
    evidenceSource: 'email',
    eventTime: '2026-11-15T10:00:00.000Z',
    evidenceIdentifier: identifier,
    evidenceDocumentVersionId: evidence.version.id
  });
  expect(approval.status).toBe(201);
  return approval.body as { countsTowardDualApproval: boolean; dualApproved: boolean };
}

/** Drives an order to MAKER_PO_READY through a valid dual approval. */
async function reachMakerPoReady(tag: string) {
  const chain = await reachApprovalPending(tag);
  expect((await recordTextApproval({ chain, organization: 'customer' })).countsTowardDualApproval).toBe(true);
  expect((await recordTextApproval({ chain, organization: 'seven' })).dualApproved).toBe(true);
  const ready = await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'MAKER_PO_READY' });
  expect(ready.status).toBe(200);
  return chain;
}

function createMakerPo(orderId: string) {
  return postAs(adminToken, `/api/film-supply-orders/${orderId}/maker-purchase-orders`, {
    recipientAddress: 'maker-po@example.com'
  });
}

async function approveMakerPo(poId: string) {
  return await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {});
}

async function cancelMakerPo(poId: string, note = '発注内容の訂正のため再発注します') {
  return await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note });
}

/** Registers the send as the original .eml, with the approved artwork attached. */
async function sendVerifiedEml(poId: string, orderCode: string, artworkBytes: string) {
  return await sendMakerPoEmlEvidence((url, body) => postAs(staffToken, url, body), poId, {
    orderCode,
    attachmentBytes: artworkBytes
  });
}

/** Registers a header-clean .eml whose attachments say what `attachment` tells. */
async function sendHeaderCleanEml(
  poId: string,
  orderCode: string,
  attachment: { kind: 'approved' | 'wrong' | 'none'; artworkBytes: string }
) {
  return await sendMakerPoEmlEvidence((url, body) => postAs(staffToken, url, body), poId, {
    orderCode,
    ...(attachment.kind === 'approved' ? { attachmentBytes: attachment.artworkBytes } : {}),
    ...(attachment.kind === 'wrong' ? { attachmentBytes: 'composite re-exported pdf bytes\n' } : {})
  });
}

interface HardenedPoEventRow {
  id: string;
  eventType: string;
  evidenceDocumentVersionId: string | null;
  verificationStatus: string;
  verificationNote: string | null;
  verificationChecks: Array<{ key: string; status: string; detail: string | null }> | null;
  recordedAt: Date;
}

async function poEvents(poId: string) {
  return await db.select().from(makerPoEvents)
    .where(eq(makerPoEvents.makerPurchaseOrderId, poId))
    .orderBy(makerPoEvents.recordedAt, makerPoEvents.id) as unknown as HardenedPoEventRow[];
}

async function poRow(poId: string) {
  const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)).limit(1);
  return row;
}

async function orderRow(orderId: string) {
  const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
  return row;
}

/** The live (non-cancelled) maker PO rows of one order — the slot FIX 2 guards. */
async function activePoRows(orderId: string) {
  return await db.select().from(makerPurchaseOrders).where(and(
    eq(makerPurchaseOrders.filmSupplyOrderId, orderId),
    ne(makerPurchaseOrders.status, 'CANCELLED')
  ));
}

async function auditByAction(action: string, entityIds: string[]) {
  return await db.select().from(auditEvents).where(and(
    eq(auditEvents.action, action),
    inArray(auditEvents.entityId, entityIds)
  ));
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-m8-harden2-'));
  app = createApp({ db });

  await db.execute(sql`
    truncate table audit_events, maker_po_events, maker_po_send_manual_verifications,
      maker_purchase_orders, artwork_revisions, artwork_approval_events,
      evidence_manual_verifications, documents, document_versions, pre_order_references,
      seven_purchase_orders, film_supply_orders, film_supply_order_lines, film_deliveries,
      filling_orders, filling_order_lines, filling_deliveries, commission_readiness,
      delivery_confirmations, project_assignments, projects, sessions, accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'admin_h2_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者H2', role: 'admin' },
    { id: staffId, username: 'staff_h2_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者H2', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成H2エンドカスタマー', role: 'end_customer', externalCode: 'TEST-H2-CUST' },
    { id: sevenAccountId, name: '合成H2セブン', role: 'seven', externalCode: 'TEST-H2-SEVEN' },
    { id: makerAccountId, name: '合成H2メーカー', role: 'maker', externalCode: 'TEST-H2-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'TEST-H2-PROJECT',
    name: '合成H2案件',
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
    { id: uuidv7(), userId: staffId, projectId }
  ]);
  for (const [userId, key] of [
    [adminId, 'admin'],
    [staffId, 'staff']
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
  }
});

afterAll(async () => {
  await pool.end();
});

describe('M8-HARDEN2 FIX 1: the EML attachment match is the gate', () => {
  it('keeps a header-clean mail with a wrong attachment pending, naming the mismatch', async () => {
    const chain = await reachMakerPoReady(`F1W-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    // Correct headers everywhere — and attached bytes nobody approved (the
    // re-export of the approved PO is exactly this case).
    const sent = await sendHeaderCleanEml(poId, chain.orderCode, { kind: 'wrong', artworkBytes: chain.artworkBytes });
    expect(sent.status).toBe(200);
    const body = sent.body as {
      status: string;
      verificationStatus: string;
      pendingCode: string;
      verificationNote: string | null;
      verificationChecks: Array<{ key: string; status: string; detail: string | null }>;
    };
    expect(body.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    expect(body.pendingCode).toBe('attachment_hash_mismatch');
    expect(body.verificationNote).toContain('ハッシュ');
    // The paper stays where it is: a corrected .eml can still be registered.
    expect(body.status).toBe('APPROVED_FOR_MANUAL_SEND');
    expect((await poRow(poId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');
    // The order mirror moved at the approval and a pending send does not touch it.
    expect((await orderRow(chain.orderId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');

    const event = (await poEvents(poId)).find((row) => row.eventType === 'SEND_EVIDENCE_REGISTERED');
    expect(event?.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    expect(event?.verificationNote).toContain('添付ファイル');
    const byKey = new Map((event?.verificationChecks ?? []).map((check) => [check.key, check.status]));
    expect(byKey.get('message_id')).toBe('passed');
    expect(byKey.get('from_header')).toBe('passed');
    expect(byKey.get('recipient_address')).toBe('passed');
    expect(byKey.get('subject_identifier')).toBe('passed');
    expect(byKey.get('attachment_hash')).toBe('not_matched');
    expect(byKey.get('attachment_gate')).toBe('failed');
    // The audit records why the send waits for a human.
    const audits = await auditByAction('MAKER_PO_SEND_PENDING_MANUAL_VERIFICATION', [event!.id]);
    expect(audits).toHaveLength(1);

    // And the answer still says the EML proves no delivery by itself.
    expect((sent.body as { deliveryAssertedByManualVerification: boolean }).deliveryAssertedByManualVerification)
      .toBe(false);
  });

  it('verifies the export whose attachment is the approved artifact', async () => {
    const chain = await reachMakerPoReady(`F1V-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    const sent = await sendVerifiedEml(poId, chain.orderCode, chain.artworkBytes);
    expect(sent.status).toBe(200);
    const body = sent.body as {
      status: string;
      verificationStatus: string;
      verificationChecks: Array<{ key: string; status: string }>;
    };
    expect(body.verificationStatus).toBe('VERIFIED');
    expect(body.status).toBe('MAKER_PO_SENT_MANUALLY');
    const byKey = new Map(body.verificationChecks.map((check) => [check.key, check.status]));
    expect(byKey.get('attachment_gate')).toBe('passed');
    expect(byKey.get('attachment_hash')).toBe('passed');
    expect((await poRow(poId))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    // Still not a delivery assertion: the manual verification owns that.
    expect((sent.body as { deliveryAssertedByManualVerification: boolean }).deliveryAssertedByManualVerification)
      .toBe(false);
  });

  it('keeps a mail with no attachment pending as attachment_missing, and a link-only mail as attachment_link_only', async () => {
    const chain = await reachMakerPoReady(`F1N-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    const noAttachment = await sendHeaderCleanEml(poId, chain.orderCode, { kind: 'none', artworkBytes: chain.artworkBytes });
    expect(noAttachment.status).toBe(200);
    expect((noAttachment.body as { pendingCode: string }).pendingCode).toBe('attachment_missing');
    expect((noAttachment.body as { verificationNote: string | null }).verificationNote).toContain('添付ファイルがない');

    // The same paper, now with a download link instead of the document.
    const linkOnly = await sendMakerPoEmlEvidence((url, body) => postAs(staffToken, url, body), poId, {
      orderCode: chain.orderCode,
      bodyText: '発注書はこちら: https://files.example.com/d/xyz789 をご確認ください。'
    });
    expect(linkOnly.status).toBe(200);
    expect((linkOnly.body as { pendingCode: string }).pendingCode).toBe('attachment_link_only');
    expect((linkOnly.body as { verificationNote: string | null }).verificationNote).toContain('ダウンロードリンク');

    // Neither moved the paper, and both are on the trail with their reason.
    expect((await poRow(poId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');
    const sendEvents = (await poEvents(poId)).filter((row) => row.eventType === 'SEND_EVIDENCE_REGISTERED');
    expect(sendEvents).toHaveLength(2);
    expect(sendEvents[0]?.verificationNote).toContain('添付ファイルがない');
    expect(sendEvents[1]?.verificationNote).toContain('ダウンロードリンク');
    expect(sendEvents.map((row) => row.verificationStatus).filter((status) => status === 'VERIFIED')).toHaveLength(0);
  });
});

describe('M8-HARDEN2 FIX 2: replacement after a proven send needs the acknowledgement', () => {
  it('the pure rules: classification, vocabulary and the gate', () => {
    expect(classifyMakerPoCancellation({ verifiedSend: false })).toEqual({
      kind: 'INTERNAL_CANCEL',
      verifiedSend: false,
      acknowledgementRequired: false
    });
    expect(classifyMakerPoCancellation({ verifiedSend: true })).toEqual({
      kind: 'MAKER_PO_CANCELLED',
      verifiedSend: true,
      acknowledgementRequired: true
    });
    expect(MAKER_PO_EVENT_TYPES).toContain('MAKER_CANCELLATION_ACKNOWLEDGED');
    expect(validateMakerPoEventType('MAKER_CANCELLATION_ACKNOWLEDGED').ok).toBe(true);

    const gate = evaluateMakerPoCancellationAckGate([
      { id: 'po-internal', verifiedSend: false, acknowledged: false },
      { id: 'po-sent', verifiedSend: true, acknowledged: false }
    ]);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('MAKER_PO_CANCELLATION_ACK_REQUIRED');
      expect(gate.pendingMakerPurchaseOrderId).toBe('po-sent');
      expect(gate.message).toContain('po-sent');
    }
    // An acknowledged paper holds nothing back, and neither does an unsent one.
    expect(evaluateMakerPoCancellationAckGate([
      { id: 'po-sent', verifiedSend: true, acknowledged: true }
    ]).ok).toBe(true);
    expect(evaluateMakerPoCancellationAckGate([]).ok).toBe(true);
  });

  it('an internal cancel (no verified send) frees the order for a new maker PO immediately', async () => {
    const chain = await reachMakerPoReady(`F2I-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;

    const cancelled = await cancelMakerPo(poId, '宛先の訂正のため再発注します');
    expect(cancelled.status).toBe(200);
    const cancelBody = cancelled.body as {
      status: string;
      cancellationKind: string;
      newMakerPoRequiresCancellationAcknowledgement: boolean;
    };
    expect(cancelBody.status).toBe('CANCELLED');
    expect(cancelBody.cancellationKind).toBe('INTERNAL_CANCEL');
    expect(cancelBody.newMakerPoRequiresCancellationAcknowledgement).toBe(false);
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_READY');

    // The append-only record of the cancellation, and no acknowledgement needed.
    expect((await poEvents(poId)).map((event) => event.eventType)).toEqual(['MAKER_PO_CANCELLED']);
    const replacement = await createMakerPo(chain.orderId);
    expect(replacement.status).toBe(201);
    expect(await activePoRows(chain.orderId)).toHaveLength(1);
  });

  it('a cancelled paper whose send was proven refuses a new maker PO until the acknowledgement', async () => {
    const chain = await reachMakerPoReady(`F2S-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);
    const sent = await sendVerifiedEml(poId, chain.orderCode, chain.artworkBytes);
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');

    // The cancellation records the same append-only events, and names itself.
    const cancelled = await cancelMakerPo(poId, 'メーカー宛の返答で数量変更のため再発注します');
    expect(cancelled.status).toBe(200);
    const cancelBody = cancelled.body as {
      cancellationKind: string;
      newMakerPoRequiresCancellationAcknowledgement: boolean;
    };
    expect(cancelBody.cancellationKind).toBe('MAKER_PO_CANCELLED');
    expect(cancelBody.newMakerPoRequiresCancellationAcknowledgement).toBe(true);
    const cancelAudit = (await auditByAction('MAKER_PO_CANCELLED', [(await poEvents(poId)).at(-1)!.id]))[0];
    expect((cancelAudit?.afterState as { cancellationKind: string }).cancellationKind).toBe('MAKER_PO_CANCELLED');

    // THE INVARIANT: while the acknowledgement is missing, the sent-and-cancelled
    // paper is the only paper of the order and no new one may freeze beside it.
    const refused = await createMakerPo(chain.orderId);
    expect(refused.status).toBe(422);
    const refusal = refused.body as {
      code: string;
      error: string;
      pendingMakerPurchaseOrderId: string;
    };
    expect(refusal.code).toBe('MAKER_PO_CANCELLATION_ACK_REQUIRED');
    expect(refusal.pendingMakerPurchaseOrderId).toBe(poId);
    expect(refusal.error).toContain(poId);
    expect(refusal.error).toContain('取り消し承認');

    // The audit/events prove the order-level invariant held: exactly one paper,
    // cancelled, still carrying its trail, and no second paper created.
    expect(await activePoRows(chain.orderId)).toHaveLength(0);
    const rows = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, chain.orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(poId);
    expect(rows[0]?.status).toBe('CANCELLED');
    expect((await poEvents(poId)).map((event) => event.eventType).sort())
      .toEqual(['CEO_APPROVED', 'MAKER_PO_CANCELLED', 'SEND_EVIDENCE_REGISTERED']);
    const createdAudits = await auditByAction('MAKER_PO_CREATED', (await db.select({ id: makerPurchaseOrders.id })
      .from(makerPurchaseOrders).where(eq(makerPurchaseOrders.filmSupplyOrderId, chain.orderId)))
      .map((row) => row.id));
    expect(createdAudits).toHaveLength(1);

    // Staff cannot record the acknowledgement: freeing the order is the
    // representative's decision, exactly like cancelling was.
    const staffAck = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: '担当者は確認できません'
    });
    expect(staffAck.status).toBe(403);
    const noReason = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {});
    expect(noReason.status).toBe(422);
    expect((noReason.body as { code: string }).code).toBe('MAKER_CANCELLATION_ACK_REASON_REQUIRED');

    // The acknowledgement: append-only, bound to the cancelled paper, audited.
    const acked = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'メーカーより取消の受領を確認（メール）',
      acknowledgedAt: new Date().toISOString()
    });
    expect(acked.status).toBe(201);
    const ackBody = acked.body as { event: { id: string; eventType: string; verificationNote: string | null } };
    expect(ackBody.event.eventType).toBe('MAKER_CANCELLATION_ACKNOWLEDGED');
    expect(ackBody.event.verificationNote).toContain('メーカーより取消の受領を確認');
    const ackAudit = (await auditByAction('MAKER_CANCELLATION_ACKNOWLEDGED', [ackBody.event.id]))[0];
    expect(ackAudit?.entityType).toBe('maker_po_event');
    expect((ackAudit?.afterState as { replacementAllowed: boolean }).replacementAllowed).toBe(true);

    // Double-processing is refused: the acknowledgement is append-only.
    const again = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: '二度目の承認'
    });
    expect(again.status).toBe(422);
    expect((again.body as { code: string }).code).toBe('MAKER_CANCELLATION_ACK_ALREADY_RECORDED');

    // The ordering step is open again: the replacement paper freezes, and the
    // history of the old one is intact.
    const replacement = await createMakerPo(chain.orderId);
    expect(replacement.status).toBe(201);
    const replacementId = (replacement.body as { id: string }).id;
    expect(replacementId).not.toBe(poId);
    expect((await poEvents(poId)).map((event) => event.eventType)).toContain('MAKER_CANCELLATION_ACKNOWLEDGED');
    expect(await db.select().from(makerPoEvents).where(eq(makerPoEvents.makerPurchaseOrderId, replacementId)))
      .toHaveLength(0);
    expect(await activePoRows(chain.orderId)).toHaveLength(1);
  });

  it('an acknowledgement is only recordable on cancelled paper that really was sent', async () => {
    const chain = await reachMakerPoReady(`F2G-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;

    // Live paper: nothing to acknowledge.
    const live = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'まだ取り消されていません'
    });
    expect(live.status).toBe(422);
    expect((live.body as { code: string }).code).toBe('MAKER_PO_NOT_CANCELLED');

    // Cancelled without a proven send: no acknowledgement is needed, so none is
    // recordable.
    expect((await cancelMakerPo(poId, '宛先訂正')).status).toBe(200);
    // Medium-2 decision: internal cancellations also accept a record-only
    // post-delivery confirmation, but it never reopens the ordering step.
    const postDelivery = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'after cancellation, the maker reported receipt before closure',
      acknowledgedAt: new Date().toISOString()
    });
    expect(postDelivery.status).toBe(201);
    expect(postDelivery.body).toMatchObject({
      acknowledgementKind: 'POST_DELIVERY_CONFIRMATION',
      replacementPaperLive: false
    });
    expect((await poEvents(poId)).filter((event) => event.eventType === 'MAKER_CANCELLATION_ACKNOWLEDGED')).toHaveLength(1);
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_READY');
    expect(await activePoRows(chain.orderId)).toHaveLength(0);
  });
});

describe('M8-HARDEN2 FIX 2 recovery: explicit reverse reopen is atomic and gated', () => {
  it('does not rewind a live order when acknowledgement is refused', async () => {
    const chain = await reachMakerPoReady(`F2R-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    // A live, never-cancelled paper is refused; the 422 must be write-neutral.
    const refusedNoSend = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'wrong paper selected'
    });
    expect(refusedNoSend.status).toBe(422);
    // The live-paper guard runs before the proven-send guard.
    expect(refusedNoSend.body).toMatchObject({ code: 'MAKER_PO_NOT_CANCELLED' });
    expect((await orderRow(chain.orderId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');
    expect((await poRow(poId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');

    const sent = await sendVerifiedEml(poId, chain.orderCode, chain.artworkBytes);
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');
    const refusedLive = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'ack requested for a live paper'
    });
    expect(refusedLive.status).toBe(422);
    expect(refusedLive.body).toMatchObject({ code: 'MAKER_PO_NOT_CANCELLED' });
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((await poRow(poId))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((await auditByAction('FILM_SUPPLY_ORDER_TRANSITIONED', [chain.orderId]))
      .filter((row) => (row.requestMetadata as { operation?: string }).operation === 'maker_po:cancellation_acknowledgement'))
      .toHaveLength(0);
  });

  it('opens a live approved step immediately after an internal cancel', async () => {
    const chain = await reachMakerPoReady(`F2I-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    const cancelled = await cancelMakerPo(poId, '宛先訂正のため再発注します');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      cancellationKind: 'INTERNAL_CANCEL',
      newMakerPoRequiresCancellationAcknowledgement: false
    });
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_READY');
    expect(await activePoRows(chain.orderId)).toHaveLength(0);

    const replacement = await createMakerPo(chain.orderId);
    expect(replacement.status).toBe(201);
    expect(await activePoRows(chain.orderId)).toHaveLength(1);
  });

  it('requires acknowledgement after a manually confirmed send, then atomically reopens', async () => {
    const chain = await reachMakerPoReady(`F2M-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);
    const pending = await sendHeaderCleanEml(poId, chain.orderCode, { kind: 'none', artworkBytes: chain.artworkBytes });
    const pendingBody = pending.body as { verificationStatus: string; event: { id: string } };
    expect(pendingBody.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    const confirmed = await postAs(adminToken, `/api/maker-po-events/${pendingBody.event.id}/send-manual-verification`, {
      result: 'confirmed',
      verifierName: '合成代表者',
      verifiedAt: new Date().toISOString(),
      reasonNote: 'メーカー宛の送信を原本で確認した'
    });
    expect(confirmed.status).toBe(201);
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');

    const cancelled = await cancelMakerPo(poId, '送信済み発注の取り消しを確認しました');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      cancellationKind: 'MAKER_PO_CANCELLED',
      newMakerPoRequiresCancellationAcknowledgement: true
    });
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    const beforeAck = await createMakerPo(chain.orderId);
    expect(beforeAck.status).toBe(422);
    expect(beforeAck.body).toMatchObject({ code: 'MAKER_PO_CANCELLATION_ACK_REQUIRED' });

    const acknowledged = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'maker accepted the cancellation'
    });
    expect(acknowledged.status).toBe(201);
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_READY');
    const reopenAudits = (await auditByAction('FILM_SUPPLY_ORDER_TRANSITIONED', [chain.orderId]))
      .filter((row) => (row.requestMetadata as { operation?: string }).operation === 'maker_po:cancellation_acknowledgement');
    expect(reopenAudits).toHaveLength(1);
    expect(reopenAudits[0]?.beforeState).toMatchObject({ status: 'MAKER_PO_SENT_MANUALLY' });
    expect(reopenAudits[0]?.afterState).toMatchObject({ status: 'MAKER_PO_READY' });

    const replacement = await createMakerPo(chain.orderId);
    expect(replacement.status).toBe(201);
  });

  it('keeps frozen states unchanged and resumes a cleaned hold origin to READY', async () => {
    const chain = await reachMakerPoReady(`F2H-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);
    expect((await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, {
      to: 'ON_HOLD', holdReason: 'supplier clarification'
    })).status).toBe(200);

    const cancelled = await cancelMakerPo(poId, 'obsolete paper cleanup during hold');
    expect(cancelled.status).toBe(200);
    expect((await orderRow(chain.orderId))?.status).toBe('ON_HOLD');
    expect((await postAs(adminToken, `/api/film-supply-orders/${chain.orderId}/hold-release`, {
      reason: 'clarification complete; no live paper remains'
    })).body).toMatchObject({ status: 'MAKER_PO_READY' });
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_READY');
  });

  it('rolls a progressive mirror back when a race freezes the order before the transaction', async () => {
    const chain = await reachMakerPoReady(`F2X-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;

    const originalTransaction = db.transaction.bind(db);
    let injectFreeze = true;
    (db as unknown as { transaction: unknown }).transaction = async (
      callback: Parameters<typeof originalTransaction>[0],
      ...rest: unknown[]
    ) => {
      if (injectFreeze) {
        injectFreeze = false;
        await db.update(filmSupplyOrders).set({
          status: 'ON_HOLD',
          holdReason: 'race injected before maker mirror',
          updatedAt: new Date()
        }).where(eq(filmSupplyOrders.id, chain.orderId));
      }
      return originalTransaction(callback, ...rest as []);
    };

    let approval;
    try {
      approval = await approveMakerPo(poId);
    } finally {
      (db as unknown as { transaction: unknown }).transaction = originalTransaction;
    }

    expect(approval?.status).toBe(422);
    expect(approval?.body).toMatchObject({ code: 'MAKER_PO_STATE_CHANGED' });
    expect((await orderRow(chain.orderId))?.status).toBe('ON_HOLD');
    expect((await poRow(poId))?.status).toBe('DRAFT');
    expect((await poEvents(poId)).filter((event) => event.eventType === 'CEO_APPROVED')).toHaveLength(0);
  });

  it('answers an artwork revision race with 409 and writes nothing', async () => {
    const chain = await reachMakerPoReady(`F2A-${nextTag()}`);
    const proof = await uploadDocument({
      documentType: 'proof',
      issuerEntity: 'kanei',
      designKey: 'label-front',
      orderId: chain.orderId,
      poId: chain.poId,
      content: `race proof ${nextTag()}\n`
    });
    const changeEvidence = await uploadDocument({
      documentType: 'approval_evidence',
      issuerEntity: 'customer_generated',
      designKey: 'label-front',
      orderId: chain.orderId,
      poId: chain.poId,
      content: `race change request evidence ${nextTag()}\n`
    });
    const revisionCountBefore = (await db.select().from(artworkRevisions)
      .where(eq(artworkRevisions.filmSupplyOrderId, chain.orderId))).length;

    const originalTransaction = db.transaction.bind(db);
    let injectCancel = true;
    (db as unknown as { transaction: unknown }).transaction = async (
      callback: Parameters<typeof originalTransaction>[0],
      ...rest: unknown[]
    ) => {
      if (injectCancel) {
        injectCancel = false;
        await db.update(filmSupplyOrders).set({ status: 'CANCELLED', updatedAt: new Date() })
          .where(eq(filmSupplyOrders.id, chain.orderId));
      }
      return originalTransaction(callback, ...rest as []);
    };

    let revision;
    try {
      revision = await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, {
        designKey: 'label-front',
        fileDocumentVersionId: proof.version.id,
        lotMarking: `LOT-RACE-${nextTag()}`,
        changeRequest: {
          requestedOrganization: 'customer',
          reason: 'race replacement artwork',
          evidenceDocumentVersionId: changeEvidence.version.id,
          impactSchedule: 'なし',
          impactQuantity: 0,
          impactAmount: 0,
          actualCost: 0
        }
      });
    } finally {
      (db as unknown as { transaction: unknown }).transaction = originalTransaction;
    }

    expect(revision?.status).toBe(409);
    expect(revision?.body).toMatchObject({ code: 'FILM_ORDER_STATE_CHANGED' });
    expect((await orderRow(chain.orderId))?.status).toBe('CANCELLED');
    expect(await db.select().from(artworkRevisions)
      .where(eq(artworkRevisions.filmSupplyOrderId, chain.orderId))).toHaveLength(revisionCountBefore);
  });

  it('binds cited acknowledgement evidence and rejects invisible-only or oversized notes', async () => {
    const chain = await reachMakerPoReady(`F2E-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);
    await sendVerifiedEml(poId, chain.orderCode, chain.artworkBytes);
    expect((await cancelMakerPo(poId, '発注内容を訂正します')).status).toBe(200);

    const invisible = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: '​\u200b'
    });
    expect(invisible.status).toBe(422);
    expect(invisible.body).toMatchObject({ code: 'MAKER_CANCELLATION_ACK_REASON_REQUIRED' });
    const tooLong = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'a'.repeat(1001)
    });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body).toMatchObject({ code: 'MAKER_CANCELLATION_ACK_REASON_TOO_LONG' });
    const invalidEvidence = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'maker accepted',
      evidenceDocumentVersionId: 'not-a-uuid'
    });
    expect(invalidEvidence.status).toBe(422);
    expect(invalidEvidence.body).toMatchObject({ code: 'MAKER_CANCELLATION_ACK_EVIDENCE_INVALID' });

    const evidence = await uploadDocument({
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId,
      makerPoId: poId,
      content: 'maker accepted cancellation\n'
    });
    const [otherPaper] = await db.select({ id: makerPurchaseOrders.id })
      .from(makerPurchaseOrders)
      .where(ne(makerPurchaseOrders.id, poId))
      .limit(1);
    expect(otherPaper).toBeDefined();
    await db.update(documents).set({ makerPurchaseOrderId: otherPaper!.id })
      .where(eq(documents.id, evidence.document.id));
    const mismatch = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'maker accepted',
      evidenceDocumentVersionId: evidence.version.id
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({ code: 'MAKER_CANCELLATION_ACK_EVIDENCE_MISMATCH' });
    expect((await poEvents(poId)).filter((event) => event.eventType === 'MAKER_CANCELLATION_ACKNOWLEDGED'))
      .toHaveLength(0);
  });
});

describe('M8-HARDEN2 FIX 3: the confirmed manual verification carries the chain to acceptance', () => {
  it('keeps acceptance blocked while the send is only pending, then opens it like a VERIFIED send', async () => {
    const chain = await reachMakerPoReady(`F3A-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    // A header-clean mail with no attachment: the send is registered, the paper
    // stays where it is, and the acceptance gate is shut.
    const pending = await sendHeaderCleanEml(poId, chain.orderCode, { kind: 'none', artworkBytes: chain.artworkBytes });
    const pendingBody = pending.body as {
      verificationStatus: string;
      event: { id: string };
    };
    expect(pendingBody.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    expect((await poRow(poId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');

    const acceptance = await uploadDocument({
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId,
      makerPoId: poId
    });
    expect((await postAs(staffToken, `/api/documents/${acceptance.document.id}/verify`, {
      verificationStatus: 'verified'
    })).status).toBe(200);
    const blockedWhilePending = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: acceptance.version.id,
      acceptedAt: plausibleTestSentAt()
    });
    // The mirror of the SEND_UNVERIFIED block: a pending send is not a proven
    // send, so the paper cannot be accepted.
    expect(blockedWhilePending.status).toBe(422);
    expect(blockedWhilePending.body).toMatchObject({
      code: 'MAKER_PO_TRANSITION_BLOCKED',
      from: 'APPROVED_FOR_MANUAL_SEND'
    });
    expect((await poEvents(poId)).filter((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED'))
      .toHaveLength(0);

    // The representative confirms the send: staff cannot.
    const staffVerification = await postAs(staffToken, `/api/maker-po-events/${pendingBody.event.id}/send-manual-verification`, {
      result: 'confirmed',
      verifierName: '合成担当者',
      verifiedAt: new Date().toISOString(),
      reasonNote: '担当者は確認できません'
    });
    expect(staffVerification.status).toBe(403);

    const confirmed = await postAs(adminToken, `/api/maker-po-events/${pendingBody.event.id}/send-manual-verification`, {
      result: 'confirmed',
      verifierName: '合成代表者',
      verifiedAt: new Date().toISOString(),
      reasonNote: 'メーカー宛の送信を原本で確認した'
    });
    expect(confirmed.status).toBe(201);
    const confirmBody = confirmed.body as {
      deliveryAsserted: boolean;
      purchaseOrderStatusChanged: { from: string; to: string } | null;
      purchaseOrder: { status: string };
    };
    expect(confirmBody.deliveryAsserted).toBe(true);
    expect(confirmBody.purchaseOrderStatusChanged).toEqual({
      from: 'APPROVED_FOR_MANUAL_SEND',
      to: 'MAKER_PO_SENT_MANUALLY'
    });
    expect(confirmBody.purchaseOrder.status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((await poRow(poId))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');

    // The send event itself keeps its pending status: maker_po_events are
    // append-only, and the human record is a separate table row.
    const sendEvent = (await poEvents(poId)).find((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED');
    expect(sendEvent?.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    const verifications = await db.select().from(makerPoSendManualVerifications)
      .where(eq(makerPoSendManualVerifications.makerPoEventId, sendEvent!.id));
    expect(verifications).toHaveLength(1);
    expect(verifications[0]?.result).toBe('confirmed');

    // The status move is on the audit trail beside the verification record.
    const statusAudits = await auditByAction('MAKER_PO_STATUS_CHANGED', [poId]);
    const manualMove = statusAudits.find((row) =>
      ((row.afterState as { reason?: string }).reason) === 'send_manual_verification_confirmed');
    expect(manualMove).toBeDefined();

    // Re-sending stays blocked (M8-FAIL B holds): the paper is sent exactly once.
    const resend = await sendVerifiedEml(poId, chain.orderCode, chain.artworkBytes);
    expect(resend.status).toBe(422);
    expect((resend.body as { code: string }).code).toBe('MAKER_PO_TRANSITION_BLOCKED');
    expect((resend.body as { from: string }).from).toBe('MAKER_PO_SENT_MANUALLY');

    // Double-processing is refused, not idempotent: the confirmation is final.
    const again = await postAs(adminToken, `/api/maker-po-events/${sendEvent!.id}/send-manual-verification`, {
      result: 'confirmed',
      verifierName: '合成代表者',
      verifiedAt: new Date().toISOString(),
      reasonNote: '二度目の確認'
    });
    expect(again.status).toBe(422);
    expect((again.body as { code: string }).code).toBe('MAKER_PO_SEND_ALREADY_CONFIRMED');

    // The acceptance gate is open, exactly as after a VERIFIED send.
    const accepted = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: acceptance.version.id,
      acceptedAt: plausibleTestSentAt()
    });
    expect(accepted.status).toBe(200);
    expect((accepted.body as { purchaseOrder: { status: string } }).purchaseOrder.status).toBe('MAKER_PO_ACCEPTED');
    expect((await poRow(poId))?.status).toBe('MAKER_PO_ACCEPTED');
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_ACCEPTED');
  });

  it('a rejected manual verification asserts no delivery and moves nothing', async () => {
    const chain = await reachMakerPoReady(`F3R-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    const pending = await sendHeaderCleanEml(poId, chain.orderCode, { kind: 'wrong', artworkBytes: chain.artworkBytes });
    const pendingBody = pending.body as { verificationStatus: string; event: { id: string } };
    expect(pendingBody.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');

    const rejected = await postAs(adminToken, `/api/maker-po-events/${pendingBody.event.id}/send-manual-verification`, {
      result: 'rejected',
      verifierName: '合成代表者',
      verifiedAt: new Date().toISOString(),
      reasonNote: '原本を確認できず、送信とは断定できない'
    });
    expect(rejected.status).toBe(201);
    const rejectedBody = rejected.body as {
      deliveryAsserted: boolean;
      purchaseOrderStatusChanged: { from: string; to: string } | null;
      purchaseOrder: { status: string };
    };
    expect(rejectedBody.deliveryAsserted).toBe(false);
    expect(rejectedBody.purchaseOrderStatusChanged).toBeNull();
    expect(rejectedBody.purchaseOrder.status).toBe('APPROVED_FOR_MANUAL_SEND');
    expect((await poRow(poId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');
    expect((await orderRow(chain.orderId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');

    // And the chain stays blocked: nothing was ever proven to have been sent.
    const stillBlocked = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: '44444444-4444-7444-8444-00000000000a',
      acceptedAt: plausibleTestSentAt()
    });
    expect(stillBlocked.status).toBe(422);
    expect((stillBlocked.body as { code: string }).code).toBe('MAKER_PO_TRANSITION_BLOCKED');
  });
});

describe('sixth recheck server residual fixes', () => {
  it('refuses late manual confirmation of a cancelled pending send', async () => {
    const chain = await reachMakerPoReady(`R6A-${nextTag()}`);
    const cancelledPoId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(cancelledPoId)).status).toBe(200);
    const pending = await sendHeaderCleanEml(cancelledPoId, chain.orderCode, { kind: 'none', artworkBytes: chain.artworkBytes });
    const pendingBody = pending.body as { verificationStatus: string; event: { id: string } };
    expect(pendingBody.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    expect((await cancelMakerPo(cancelledPoId, 'obsolete paper cleanup')).status).toBe(200);

    const replacement = await createMakerPo(chain.orderId);
    expect(replacement.status).toBe(201);
    const replacementId = (replacement.body as { id: string }).id;
    expect((await approveMakerPo(replacementId)).status).toBe(200);

    const lateConfirmation = await postAs(adminToken, `/api/maker-po-events/${pendingBody.event.id}/send-manual-verification`, {
      result: 'confirmed',
      verifierName: '合成代表者',
      verifiedAt: new Date().toISOString(),
      reasonNote: '取り消し後の遅延確認'
    });
    expect(lateConfirmation.status).toBe(409);
    expect(lateConfirmation.body).toMatchObject({ code: 'MAKER_PO_CANCELLED_SEND_CONFIRMATION_BLOCKED' });
    expect(await db.select().from(makerPoSendManualVerifications)
      .where(eq(makerPoSendManualVerifications.makerPoEventId, pendingBody.event.id))).toHaveLength(0);
    expect((await poRow(cancelledPoId))?.status).toBe('CANCELLED');
    expect((await poRow(replacementId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');

    // The live replacement is the only paper that can advance production.
    const sent = await sendVerifiedEml(replacementId, chain.orderCode, chain.artworkBytes);
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    expect(await activePoRows(chain.orderId)).toHaveLength(1);
  });

  it('maps a manual-confirmation order race to 422 and writes nothing', async () => {
    const chain = await reachMakerPoReady(`R6R-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);
    const pending = await sendHeaderCleanEml(poId, chain.orderCode, { kind: 'none', artworkBytes: chain.artworkBytes });
    const pendingBody = pending.body as { verificationStatus: string; event: { id: string } };
    expect(pendingBody.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');

    const originalTransaction = db.transaction.bind(db);
    let injectReview = true;
    (db as unknown as { transaction: unknown }).transaction = async (
      callback: Parameters<typeof originalTransaction>[0],
      ...rest: unknown[]
    ) => {
      if (injectReview) {
        injectReview = false;
        await db.update(filmSupplyOrders).set({
          status: 'CANCELLATION_REVIEW',
          updatedAt: new Date()
        }).where(eq(filmSupplyOrders.id, chain.orderId));
      }
      return originalTransaction(callback, ...rest as []);
    };
    let confirmation;
    try {
      confirmation = await postAs(adminToken, `/api/maker-po-events/${pendingBody.event.id}/send-manual-verification`, {
        result: 'confirmed',
        verifierName: '合成代表者',
        verifiedAt: new Date().toISOString(),
        reasonNote: 'concurrent review'
      });
    } finally {
      (db as unknown as { transaction: unknown }).transaction = originalTransaction;
    }

    expect(confirmation?.status).toBe(422);
    expect(confirmation?.body).toMatchObject({ code: 'MAKER_PO_STATE_CHANGED' });
    expect(await db.select().from(makerPoSendManualVerifications)
      .where(eq(makerPoSendManualVerifications.makerPoEventId, pendingBody.event.id))).toHaveLength(0);
    expect((await poRow(poId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');
    expect((await orderRow(chain.orderId))?.status).toBe('CANCELLATION_REVIEW');
  });

  it('locks non-verified send registration and provisional acceptance before persistence', async () => {
    const chain = await reachMakerPoReady(`R6S-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    const originalTransaction = db.transaction.bind(db);
    let injectCancel = true;
    (db as unknown as { transaction: unknown }).transaction = async (
      callback: Parameters<typeof originalTransaction>[0],
      ...rest: unknown[]
    ) => {
      if (injectCancel) {
        injectCancel = false;
        await db.update(filmSupplyOrders).set({ status: 'CANCELLED', updatedAt: new Date() })
          .where(eq(filmSupplyOrders.id, chain.orderId));
      }
      return originalTransaction(callback, ...rest as []);
    };
    let pendingSend;
    try {
      pendingSend = await sendHeaderCleanEml(poId, chain.orderCode, { kind: 'none', artworkBytes: chain.artworkBytes });
    } finally {
      (db as unknown as { transaction: unknown }).transaction = originalTransaction;
    }
    expect(pendingSend?.status).toBe(422);
    expect(pendingSend?.body).toMatchObject({ code: 'MAKER_PO_STATE_CHANGED' });
    expect((await poEvents(poId)).filter((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED')).toHaveLength(0);
    expect((await poRow(poId))?.status).toBe('APPROVED_FOR_MANUAL_SEND');
    expect((await orderRow(chain.orderId))?.status).toBe('CANCELLED');

    // The proven-send provisional path is progressive work too: a concurrent
    // freeze must roll back its append-only acceptance record.
    const provenChain = await reachMakerPoReady(`R6P-${nextTag()}`);
    const provenPoId = ((await createMakerPo(provenChain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(provenPoId)).status).toBe(200);
    await sendVerifiedEml(provenPoId, provenChain.orderCode, provenChain.artworkBytes);

    const provenTransaction = db.transaction.bind(db);
    let injectHold = true;
    (db as unknown as { transaction: unknown }).transaction = async (
      callback: Parameters<typeof provenTransaction>[0],
      ...rest: unknown[]
    ) => {
      if (injectHold) {
        injectHold = false;
        await db.update(filmSupplyOrders).set({
          status: 'ON_HOLD',
          holdReason: 'race before provisional acceptance',
          updatedAt: new Date()
        }).where(eq(filmSupplyOrders.id, provenChain.orderId));
      }
      return provenTransaction(callback, ...rest as []);
    };
    let provisional;
    try {
      provisional = await postAs(staffToken, `/api/maker-purchase-orders/${provenPoId}/provisional-acceptance`, {
        acceptedAt: new Date().toISOString()
      });
    } finally {
      (db as unknown as { transaction: unknown }).transaction = originalTransaction;
    }
    expect(provisional?.status).toBe(422);
    expect(provisional?.body).toMatchObject({ code: 'MAKER_PO_STATE_CHANGED' });
    expect((await poEvents(provenPoId))
      .filter((event) => event.eventType === 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL')).toHaveLength(0);
    expect((await orderRow(provenChain.orderId))?.status).toBe('ON_HOLD');
  });

  it('validates acknowledgement time, evidence type/verification, and path UUIDs', async () => {
    const chain = await reachMakerPoReady(`R6V-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);
    await sendVerifiedEml(poId, chain.orderCode, chain.artworkBytes);
    expect((await cancelMakerPo(poId, 'proven-send correction')).status).toBe(200);

    const badPaths = await Promise.all([
      postAs(adminToken, '/api/maker-purchase-orders/not-a-uuid/cancel', { note: 'n' }),
      postAs(adminToken, '/api/maker-purchase-orders/not-a-uuid/cancellation-acknowledgement', { note: 'n' }),
      postAs(adminToken, `/api/film-supply-orders/not-a-uuid/hold-release`, { reason: 'n' })
    ]);
    expect(badPaths.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(badPaths.map((response) => (response.body as { code: string }).code))
      .toEqual(['INVALID_PATH_PARAMETER', 'INVALID_PATH_PARAMETER', 'INVALID_PATH_PARAMETER']);

    const future = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'maker accepted',
      acknowledgedAt: '2099-01-01T00:00:00.000Z'
    });
    expect(future.status).toBe(422);
    expect(future.body).toMatchObject({ code: 'MAKER_CANCELLATION_ACK_TIME_IN_FUTURE' });
    const tooOld = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'maker accepted',
      acknowledgedAt: '1999-12-31T00:00:00.000Z'
    });
    expect(tooOld.status).toBe(422);
    expect(tooOld.body).toMatchObject({ code: 'MAKER_CANCELLATION_ACK_TIME_OUT_OF_RANGE' });
    const numericEvidence = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'maker accepted',
      evidenceDocumentVersionId: 123
    });
    expect(numericEvidence.status).toBe(422);
    expect(numericEvidence.body).toMatchObject({ code: 'MAKER_CANCELLATION_ACK_EVIDENCE_INVALID' });
    const emptyEvidence = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'maker accepted',
      evidenceDocumentVersionId: ''
    });
    expect(emptyEvidence.status).toBe(422);
    expect(emptyEvidence.body).toMatchObject({ code: 'MAKER_CANCELLATION_ACK_EVIDENCE_INVALID' });

    const evidence = await uploadDocument({
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId,
      makerPoId: poId,
      content: 'maker accepted cancellation\n'
    });
    const unverified = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'maker accepted',
      evidenceDocumentVersionId: evidence.version.id,
      acknowledgedAt: new Date().toISOString()
    });
    expect(unverified.status).toBe(422);
    expect(unverified.body).toMatchObject({ code: 'MAKER_CANCELLATION_ACK_EVIDENCE_NOT_VERIFIED' });

    expect((await postAs(staffToken, `/api/documents/${evidence.document.id}/verify`, {
      verificationStatus: 'verified'
    })).status).toBe(200);
    const acknowledged = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'maker accepted',
      evidenceDocumentVersionId: evidence.version.id,
      acknowledgedAt: new Date().toISOString()
    });
    expect(acknowledged.status).toBe(201);
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_READY');
  });

  it('accepts origin and effective READY consistently for cleaned hold/CR recovery', async () => {
    const holdChain = await reachMakerPoReady(`R6H-${nextTag()}`);
    const holdPoId = ((await createMakerPo(holdChain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(holdPoId)).status).toBe(200);
    expect((await postAs(staffToken, `/api/film-supply-orders/${holdChain.orderId}/transitions`, {
      to: 'ON_HOLD', holdReason: 'supplier clarification'
    })).status).toBe(200);
    expect((await cancelMakerPo(holdPoId, 'cleanup during hold')).status).toBe(200);
    const holdRelease = await postAs(adminToken, `/api/film-supply-orders/${holdChain.orderId}/hold-release`, {
      reason: 'resolved; paper cleaned',
      resumeStatus: 'APPROVED_FOR_MANUAL_SEND'
    });
    expect(holdRelease.status).toBe(200);
    expect(holdRelease.body).toMatchObject({ status: 'MAKER_PO_READY' });
    const creationGate = await createMakerPo(holdChain.orderId);
    // This paper was pending-only and was cancelled without a delivery
    // assertion, so it is an internal cancel and replacement work is open.
    expect(creationGate.status).toBe(201);

    const reviewChain = await reachMakerPoReady(`R6C-${nextTag()}`);
    const reviewPoId = ((await createMakerPo(reviewChain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(reviewPoId)).status).toBe(200);
    await sendVerifiedEml(reviewPoId, reviewChain.orderCode, reviewChain.artworkBytes);
    expect((await postAs(staffToken, `/api/film-supply-orders/${reviewChain.orderId}/transitions`, {
      to: 'CANCELLATION_REVIEW'
    })).status).toBe(200);
    expect((await cancelMakerPo(reviewPoId, 'cleanup during review')).status).toBe(200);
    const reviewResolved = await postAs(adminToken, `/api/film-supply-orders/${reviewChain.orderId}/cancellation-review-resolve`, {
      outcome: 'resume',
      reason: 'review resolved; paper cleaned',
      resumeStatus: 'MAKER_PO_READY'
    });
    expect(reviewResolved.status).toBe(200);
    expect(reviewResolved.body).toMatchObject({ status: 'MAKER_PO_READY' });
    const replacementGate = await createMakerPo(reviewChain.orderId);
    expect(replacementGate.status).toBe(422);
    expect((replacementGate.body as { code: string }).code).toBe('MAKER_PO_CANCELLATION_ACK_REQUIRED');
  });

  it('maps a PostgreSQL lock deadlock to a 409 API contract response', async () => {
    const chain = await reachMakerPoReady(`R6D-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    const originalTransaction = db.transaction.bind(db);
    (db as unknown as { transaction: unknown }).transaction = async () => {
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    };
    let cancelled;
    try {
      cancelled = await cancelMakerPo(poId, 'deadlock response contract');
    } finally {
      (db as unknown as { transaction: unknown }).transaction = originalTransaction;
    }
    expect(cancelled?.status).toBe(409);
    expect(cancelled?.body).toMatchObject({ code: 'MAKER_PO_LOCK_CONFLICT' });
    expect((await poRow(poId))?.status).toBe('DRAFT');
    expect((await poEvents(poId)).filter((event) => event.eventType === 'MAKER_PO_CANCELLED')).toHaveLength(0);
  });
});

describe('seventh recheck server hardening', () => {
  it('blocks paper creation when the order races to CANCELLED before the transaction', async () => {
    const chain = await reachMakerPoReady(`R8Q2-${nextTag()}`);
    const originalTransaction = db.transaction.bind(db);
    let injectCancel = true;
    (db as unknown as { transaction: unknown }).transaction = async (
      callback: Parameters<typeof originalTransaction>[0],
      ...rest: unknown[]
    ) => {
      if (injectCancel) {
        injectCancel = false;
        await db.update(filmSupplyOrders).set({ status: 'CANCELLED', updatedAt: new Date() })
          .where(eq(filmSupplyOrders.id, chain.orderId));
      }
      return originalTransaction(callback, ...rest as []);
    };
    let created;
    try {
      created = await createMakerPo(chain.orderId);
    } finally {
      (db as unknown as { transaction: unknown }).transaction = originalTransaction;
    }
    expect(created?.status).toBe(422);
    expect(created?.body).toMatchObject({ code: 'MAKER_PO_STATE_CHANGED' });
    expect(await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, chain.orderId))).toHaveLength(0);
  });

  it('rechecks an active paper inside the creation transaction', async () => {
    const chain = await reachMakerPoReady(`R8Q1-${nextTag()}`);
    const racingPaperId = uuidv7();
    const originalTransaction = db.transaction.bind(db);
    let injectPaper = true;
    (db as unknown as { transaction: unknown }).transaction = async (
      callback: Parameters<typeof originalTransaction>[0],
      ...rest: unknown[]
    ) => {
      if (injectPaper) {
        injectPaper = false;
        await db.insert(makerPurchaseOrders).values({
          id: racingPaperId,
          filmSupplyOrderId: chain.orderId,
          snapshot: { order: { id: chain.orderId }, items: [], artworkFiles: [], amounts: [] },
          snapshotSha256: 'a'.repeat(64),
          status: 'DRAFT',
          createdByUserId: adminId,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }
      return originalTransaction(callback, ...rest as []);
    };
    let created;
    try {
      created = await createMakerPo(chain.orderId);
    } finally {
      (db as unknown as { transaction: unknown }).transaction = originalTransaction;
    }
    expect(created?.status).toBe(422);
    expect(created?.body).toMatchObject({
      code: 'MAKER_PO_ALREADY_EXISTS',
      existingMakerPurchaseOrderId: racingPaperId
    });
    expect(await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, chain.orderId))).toHaveLength(1);
  });

  it('returns a warning flag when a post-delivery ack races beside a live replacement', async () => {
    const chain = await reachMakerPoReady(`R8M2-${nextTag()}`);
    const cancelledPoId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(cancelledPoId)).status).toBe(200);
    await sendHeaderCleanEml(cancelledPoId, chain.orderCode, { kind: 'none', artworkBytes: chain.artworkBytes });
    expect((await cancelMakerPo(cancelledPoId, 'obsolete pending paper')).status).toBe(200);
    const replacementId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect(replacementId).not.toBe(cancelledPoId);

    const acknowledgement = await postAs(adminToken, `/api/maker-purchase-orders/${cancelledPoId}/cancellation-acknowledgement`, {
      note: 'after cancellation, the maker reported delivery',
      acknowledgedAt: new Date().toISOString()
    });
    expect(acknowledgement.status).toBe(201);
    expect(acknowledgement.body).toMatchObject({
      acknowledgementKind: 'POST_DELIVERY_CONFIRMATION',
      replacementPaperLive: true
    });
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_READY');
    expect((await poRow(cancelledPoId))?.status).toBe('CANCELLED');
    expect((await poRow(replacementId))?.status).toBe('DRAFT');
  });

  it('rejects a racing duplicate confirmed manual verification inside the transaction', async () => {
    const chain = await reachMakerPoReady(`R8L1-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);
    const pending = await sendHeaderCleanEml(poId, chain.orderCode, { kind: 'none', artworkBytes: chain.artworkBytes });
    const pendingBody = pending.body as { verificationStatus: string; event: { id: string } };
    expect(pendingBody.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');

    const originalTransaction = db.transaction.bind(db);
    let injectDuplicate = true;
    (db as unknown as { transaction: unknown }).transaction = async (
      callback: Parameters<typeof originalTransaction>[0],
      ...rest: unknown[]
    ) => {
      if (injectDuplicate) {
        injectDuplicate = false;
        await db.insert(makerPoSendManualVerifications).values({
          id: uuidv7(), makerPoEventId: pendingBody.event.id, makerPurchaseOrderId: poId,
          result: 'confirmed', verifierName: '先行確認', verifiedAt: new Date(),
          reasonNote: 'race winner', recordedByUserId: adminId, recordedAt: new Date()
        });
      }
      return originalTransaction(callback, ...rest as []);
    };
    let confirmation;
    try {
      confirmation = await postAs(adminToken, `/api/maker-po-events/${pendingBody.event.id}/send-manual-verification`, {
        result: 'confirmed', verifierName: '合成代表者', verifiedAt: new Date().toISOString(), reasonNote: 'racing loser'
      });
    } finally {
      (db as unknown as { transaction: unknown }).transaction = originalTransaction;
    }
    expect(confirmation?.status).toBe(422);
    expect(confirmation?.body).toMatchObject({ code: 'MAKER_PO_SEND_ALREADY_CONFIRMED' });
    expect(await db.select().from(makerPoSendManualVerifications)
      .where(eq(makerPoSendManualVerifications.makerPoEventId, pendingBody.event.id))).toHaveLength(1);
  });

  it('rejects non-UUID evidence IDs before boundary recheck writes', async () => {
    const chain = await reachMakerPoReady(`R8L2-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);
    const auditCount = (await db.select().from(auditEvents)).length;
    const sent = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: 'not-a-uuid',
      sentAt: new Date().toISOString()
    });
    const accepted = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: 'not-a-uuid',
      acceptedAt: new Date().toISOString()
    });
    expect(sent.status).toBe(422);
    expect(sent.body).toMatchObject({ code: 'SEND_EVIDENCE_DOCUMENT_VERSION_INVALID' });
    expect(accepted.status).toBe(422);
    expect(accepted.body).toMatchObject({ code: 'ACCEPT_EVIDENCE_DOCUMENT_VERSION_INVALID' });
    expect((await db.select().from(auditEvents)).length).toBe(auditCount);
  });

  it('returns 400 for representative non-UUID paths', async () => {
    const responses = await Promise.all([
      postAs(adminToken, '/api/film-supply-orders/not-a-uuid/transitions', { to: 'DRAFT' }),
      postAs(adminToken, '/api/film-supply-orders/not-a-uuid/maker-purchase-orders', { recipientAddress: 'x' }),
      getAs(adminToken, '/api/maker-purchase-orders/not-a-uuid')
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(responses.map((response) => (response.body as { code: string }).code))
      .toEqual(['INVALID_PATH_PARAMETER', 'INVALID_PATH_PARAMETER', 'INVALID_PATH_PARAMETER']);
  });

  it('requires strict post-cancellation acknowledgement time', async () => {
    const chain = await reachMakerPoReady(`R8L4-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    await sendVerifiedEml(poId, chain.orderCode, chain.artworkBytes);
    expect((await cancelMakerPo(poId, 'proven send correction')).status).toBe(200);
    const badFormats = await Promise.all([
      postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, { note: 'n', acknowledgedAt: '1' }),
      postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, { note: 'n', acknowledgedAt: 'Nov 18' }),
      postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, { note: 'n', acknowledgedAt: '2026-11-18T10:00:00' }),
      postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, { note: 'n', acknowledgedAt: '2001-01-02T00:00:00Z' })
    ]);
    expect(badFormats.map((response) => response.status)).toEqual([422, 422, 422, 422]);
    expect(badFormats.map((response) => (response.body as { code: string }).code)).toEqual([
      'MAKER_CANCELLATION_ACK_TIME_FORMAT_INVALID',
      'MAKER_CANCELLATION_ACK_TIME_FORMAT_INVALID',
      'MAKER_CANCELLATION_ACK_TIME_FORMAT_INVALID',
      'MAKER_CANCELLATION_ACK_TIME_BEFORE_CANCELLATION'
    ]);
  });

  it('rejects future manual verification times', async () => {
    const chain = await reachMakerPoReady(`R8L5-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);
    const pending = await sendHeaderCleanEml(poId, chain.orderCode, { kind: 'none', artworkBytes: chain.artworkBytes });
    const pendingBody = pending.body as { verificationStatus: string; event: { id: string } };
    const response = await postAs(adminToken, `/api/maker-po-events/${pendingBody.event.id}/send-manual-verification`, {
      result: 'confirmed', verifierName: '合成代表者', verifiedAt: '2099-01-01T00:00:00.000Z', reasonNote: 'future'
    });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'VERIFIED_AT_IN_FUTURE' });
    expect(await db.select().from(makerPoSendManualVerifications)
      .where(eq(makerPoSendManualVerifications.makerPoEventId, pendingBody.event.id))).toHaveLength(0);
  });

  it('rechecks acknowledgement evidence under a shared lock before recording', async () => {
    const chain = await reachMakerPoReady(`R8L6-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    await sendVerifiedEml(poId, chain.orderCode, chain.artworkBytes);
    expect((await cancelMakerPo(poId, 'proven send correction')).status).toBe(200);
    const evidence = await uploadDocument({
      documentType: 'acceptance_evidence', issuerEntity: 'kanei', orderId: chain.orderId,
      poId: chain.poId, makerPoId: poId, content: 'ack evidence\n'
    });
    expect((await postAs(staffToken, `/api/documents/${evidence.document.id}/verify`, {
      verificationStatus: 'verified'
    })).status).toBe(200);

    const originalTransaction = db.transaction.bind(db);
    let invalidateEvidence = true;
    (db as unknown as { transaction: unknown }).transaction = async (
      callback: Parameters<typeof originalTransaction>[0],
      ...rest: unknown[]
    ) => {
      if (invalidateEvidence) {
        invalidateEvidence = false;
        await db.update(documents).set({ verificationStatus: 'mismatch', updatedAt: new Date() })
          .where(eq(documents.id, evidence.document.id));
      }
      return originalTransaction(callback, ...rest as []);
    };
    let acknowledgement;
    try {
      acknowledgement = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
        note: 'maker accepted', evidenceDocumentVersionId: evidence.version.id,
        acknowledgedAt: new Date().toISOString()
      });
    } finally {
      (db as unknown as { transaction: unknown }).transaction = originalTransaction;
    }
    expect(acknowledgement?.status).toBe(422);
    expect(acknowledgement?.body).toMatchObject({ code: 'MAKER_CANCELLATION_ACK_EVIDENCE_MISMATCH' });
    expect((await poEvents(poId)).filter((event) => event.eventType === 'MAKER_CANCELLATION_ACKNOWLEDGED')).toHaveLength(0);
  });

  it('returns Japanese hold reason errors with stable codes', async () => {
    const chain = await reachMakerPoReady(`R8L7-${nextTag()}`);
    const missing = await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'ON_HOLD' });
    const tooLong = await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, {
      to: 'ON_HOLD', holdReason: 'a'.repeat(1001)
    });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: 'HOLD_REASON_REQUIRED', error: '保留理由（holdReason）は必須です' });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body).toMatchObject({ code: 'HOLD_REASON_TOO_LONG', error: '保留理由（holdReason）は1000文字以下で入力してください' });
  });

  it('logs unexpected errors and returns a JSON 500 contract', async () => {
    const originalTransaction = db.transaction.bind(db);
    (db as unknown as { transaction: unknown }).transaction = async () => {
      throw new Error('unexpected operational failure');
    };
    let created;
    try {
      created = await postAs(adminToken, '/api/projects', {
        route: 'F1',
        code: `INTERNAL-${nextTag()}`,
        name: 'unexpected error probe',
        endCustomerAccountId: customerAccountId,
        sevenAccountId: sevenAccountId,
        makerAccountId: makerAccountId
      });
    } finally {
      (db as unknown as { transaction: unknown }).transaction = originalTransaction;
    }
    expect(created?.status).toBe(500);
    expect(created?.body).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('eighth recheck server regressions', () => {
  it('never rewinds the order for a record-only post-delivery acknowledgement', async () => {
    // A pending paper was cancelled internally; its replacement was then proven
    // sent and cancelled with an acknowledgement outstanding.
    const pendingChain = await reachMakerPoReady(`R8A-${nextTag()}`);
    const pendingPoId = ((await createMakerPo(pendingChain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(pendingPoId)).status).toBe(200);
    const pending = await sendHeaderCleanEml(pendingPoId, pendingChain.orderCode, { kind: 'none', artworkBytes: pendingChain.artworkBytes });
    expect((pending.body as { verificationStatus: string }).verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    expect((await cancelMakerPo(pendingPoId, 'obsolete pending paper')).status).toBe(200);
    expect((await orderRow(pendingChain.orderId))?.status).toBe('MAKER_PO_READY');

    const provenPoId = ((await createMakerPo(pendingChain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(provenPoId)).status).toBe(200);
    await sendVerifiedEml(provenPoId, pendingChain.orderCode, pendingChain.artworkBytes);
    expect((await cancelMakerPo(provenPoId, 'proven-send correction')).status).toBe(200);
    expect((await orderRow(pendingChain.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');

    const transitionAuditsBefore = (await auditByAction('FILM_SUPPLY_ORDER_TRANSITIONED', [pendingChain.orderId]))
      .filter((row) => (row.requestMetadata as { operation?: string }).operation === 'maker_po:cancellation_acknowledgement');
    const postDelivery = await postAs(adminToken, `/api/maker-purchase-orders/${pendingPoId}/cancellation-acknowledgement`, {
      note: 'after cancellation, the maker reported receipt',
      acknowledgedAt: new Date().toISOString()
    });

    expect(postDelivery.status).toBe(201);
    expect(postDelivery.body).toMatchObject({
      acknowledgementKind: 'POST_DELIVERY_CONFIRMATION',
      replacementPaperLive: false
    });
    expect((await orderRow(pendingChain.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');
    const transitionAuditsAfter = (await auditByAction('FILM_SUPPLY_ORDER_TRANSITIONED', [pendingChain.orderId]))
      .filter((row) => (row.requestMetadata as { operation?: string }).operation === 'maker_po:cancellation_acknowledgement');
    expect(transitionAuditsAfter).toHaveLength(transitionAuditsBefore.length);
    const creationGate = await createMakerPo(pendingChain.orderId);
    expect(creationGate.status).toBe(422);
    expect((creationGate.body as { code: string }).code).toBe('MAKER_PO_CANCELLATION_ACK_REQUIRED');
  });

  it('rejects lenient manual verification and acknowledgement dates', async () => {
    const chain = await reachMakerPoReady(`R8DATE-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);
    const pending = await sendHeaderCleanEml(poId, chain.orderCode, { kind: 'none', artworkBytes: chain.artworkBytes });
    const pendingBody = pending.body as { verificationStatus: string; event: { id: string } };
    const badVerifiedAt = await postAs(adminToken, `/api/maker-po-events/${pendingBody.event.id}/send-manual-verification`, {
      result: 'confirmed', verifierName: '合成代表者', verifiedAt: '2026-02-30T10:00:00.000Z', reasonNote: 'invalid calendar'
    });
    expect(badVerifiedAt.status).toBe(422);
    expect(await db.select().from(makerPoSendManualVerifications)
      .where(eq(makerPoSendManualVerifications.makerPoEventId, pendingBody.event.id))).toHaveLength(0);

    expect((await cancelMakerPo(poId, 'date contract check')).status).toBe(200);
    const badAcknowledgedAt = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'post delivery', acknowledgedAt: '2026-02-30T10:00:00.000Z'
    });
    expect(badAcknowledgedAt.status).toBe(422);
    expect((await poEvents(poId)).filter((event) => event.eventType === 'MAKER_CANCELLATION_ACKNOWLEDGED')).toHaveLength(0);
  });

  it('accepts calendar dates named by non-UTC offsets', async () => {
    const chain = await reachMakerPoReady(`R9JST-${nextTag()}`);
    const poId = ((await createMakerPo(chain.orderId)).body as { id: string }).id;
    expect((await approveMakerPo(poId)).status).toBe(200);
    const pending = await sendHeaderCleanEml(poId, chain.orderCode, { kind: 'none', artworkBytes: chain.artworkBytes });
    const pendingBody = pending.body as { verificationStatus: string; event: { id: string } };

    // A UTC suffix must stay valid. Recording rejected first also proves the
    // rejected-correctable path still works before the JST confirmation.
    const utcZ = await postAs(adminToken, `/api/maker-po-events/${pendingBody.event.id}/send-manual-verification`, {
      result: 'rejected',
      verifierName: '合成代表者',
      verifiedAt: '2026-11-18T02:00:00.000Z',
      reasonNote: 'UTC suffix regression'
    });
    expect(utcZ.status).toBe(201);

    const jstAfterMidnight = await postAs(adminToken, `/api/maker-po-events/${pendingBody.event.id}/send-manual-verification`, {
      result: 'confirmed',
      verifierName: '合成代表者',
      verifiedAt: '2026-11-18T00:30:00.000+09:00',
      reasonNote: 'JST calendar date differs from UTC date'
    });
    expect(jstAfterMidnight.status).toBe(201);
    const [recorded] = await db.select().from(makerPoSendManualVerifications)
      .where(eq(makerPoSendManualVerifications.makerPoEventId, pendingBody.event.id));
    expect(recorded?.verifiedAt.toISOString()).toBe('2026-11-18T02:00:00.000Z');

  });
});
