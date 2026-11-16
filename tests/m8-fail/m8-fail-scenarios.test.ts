import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { buildMakerPoEml, plausibleTestSentAt, sendMakerPoEmlEvidence } from '../helpers/maker-po-evidence.js';

/**
 * M8-HARDEN regression tests: the four CEO-directed failure scenarios, pinned
 * against the hardened behavior. M8-FAIL first characterized what the endpoints
 * really did when the flow was abused (FINDING A3, B2, C1, C2); this file now
 * asserts the fixes the CEO approved for those findings.
 *
 * A — approval reuse across revisions (FIX A3): the current revision holding no
 *     valid approval from BOTH organizations blocks every pre-send maker-PO
 *     boundary act with 422 DUAL_APPROVAL_NO_LONGER_VALID — including the
 *     superseded-revision case that used to pass — and recovery is both
 *     organizations approving the new revision. A send that is already proven
 *     stays history (the carve-out), and the G10 snapshot-void machinery is
 *     unchanged (tests/m4/m4-maker-po.test.ts 'T-23/T-24').
 * B — one active maker PO per film order (FIX B2): the second create is refused
 *     with the existing PO named, two parallel creates freeze exactly one paper,
 *     and replacement is the explicit cancel (history preserved) then create.
 *     Acceptance evidence is bound to one maker PO, so one document can no
 *     longer close two papers of the same order.
 * C — send evidence is the production-order EMAIL (FIX C1) and the recorded
 *     times must be possible (FIX C2): a plain text file, a PDF, an EML without
 *     a Message-ID and an EML headed elsewhere are PENDING_MANUAL_VERIFICATION,
 *     never VERIFIED; a sentAt in the future is refused; a send recorded before
 *     its own approval — or contradicting the EML Date — is pending too.
 * D — acceptance gates: no send, no acceptance; foreign paperwork and paperwork
 *     bound to another maker PO are both refused.
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
    body: body === undefined ? undefined : JSON.stringify(body)
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
    documentNumber: `PO-2026-FAIL-${nextTag()}`,
    issueDateRecorded: true,
    issueDate: '2026-11-14',
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
  const content = input.content ?? `composite m8-fail document bytes ${tag}\n`;
  const response = await postAs(staffToken, `/api/projects/${projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `m8fail-doc-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: toBase64(content),
    ...(input.poId ? { sevenPurchaseOrderId: input.poId } : {}),
    ...(input.orderId ? { filmSupplyOrderId: input.orderId } : {}),
    // M8-HARDEN FIX B2 (d): the maker PO an acceptance evidence is for.
    ...(input.makerPoId ? { makerPurchaseOrderId: input.makerPoId } : {}),
    ...(input.designKey ? { designKey: input.designKey } : {})
  });
  expect(response.status).toBe(201);
  return response.body as { document: { id: string }; version: { id: string; sha256: string } };
}

/** An order at APPROVAL_PENDING with one registered design and no approval yet. */
async function reachApprovalPending(tag: string) {
  const createdPo = await postAs(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, {
    poNumber: `SEVEN-FAIL-${tag}`,
    officialRegisteredAt: '2026-11-13T09:00:00.000Z'
  });
  expect(createdPo.status).toBe(201);
  const po = createdPo.body as { id: string };

  expect((await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/verification-checklist`, fullChecklist())).status).toBe(200);
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/register-official`, {
    officialRegisteredAt: '2026-11-13T09:00:00.000Z'
  })).status).toBe(200);

  const createdOrder = await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/supply-orders`, {
    code: `FSO-FAIL-${tag}`,
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
  // hash, so a send evidence attachment carrying exactly them is the strong
  // match FIX C1 records.
  const artworkBytes = `composite m8-fail artwork bytes ${tag}\n`;
  const proof = await uploadDocument({
    documentType: 'proof',
    issuerEntity: 'kanei',
    designKey: 'label-front',
    orderId: order.id,
    poId: po.id,
    content: artworkBytes
  });
  const revision = await postAs(staffToken, `/api/film-supply-orders/${order.id}/artwork-revisions`, {
    designKey: 'label-front',
    fileDocumentVersionId: proof.version.id
  });
  expect(revision.status).toBe(201);

  return {
    poId: po.id,
    orderId: order.id,
    // The order code is the identifier the send evidence's subject must carry.
    orderCode: `FSO-FAIL-${tag}`,
    /** The exact bytes the approved artwork revision freezes (its sha256). */
    artworkBytes,
    revisionId: (revision.body as { id: string }).id
  };
}

/** Records one counted TEXT approval whose evidence quotes its identifier. */
async function recordTextApproval(input: {
  chain: Awaited<ReturnType<typeof reachApprovalPending>>;
  organization: 'customer' | 'seven';
  /** Overrides the revision the approval is recorded on (the FIX A3 recovery). */
  revisionId?: string;
}) {
  const identifier = `MSG-FAIL-${input.organization.toUpperCase()}-${nextTag()}`;
  const evidence = await uploadDocument({
    documentType: 'approval_evidence',
    issuerEntity: input.organization === 'seven' ? 'seven' : 'customer_generated',
    designKey: 'label-front',
    orderId: input.chain.orderId,
    poId: input.chain.poId,
    content: `composite m8-fail approval evidence\nidentifier: ${identifier}\n`
  });
  const approval = await postAs(staffToken, `/api/artwork-revisions/${input.revisionId ?? input.chain.revisionId}/approvals`, {
    organization: input.organization,
    decision: 'APPROVE',
    evidenceSource: 'email',
    eventTime: '2026-11-14T10:00:00.000Z',
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

/** Cancels a maker PO as the representative: the explicit replacement step. */
async function cancelMakerPo(poId: string, note = '発注内容の訂正のため再発注します') {
  return await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note });
}

/** Registers the send as the original .eml of the production-order mail. */
async function sendMakerPoEml(poId: string, orderCode: string, overrides: Parameters<typeof buildMakerPoEml>[0] = {}) {
  return await sendMakerPoEmlEvidence((url, body) => postAs(staffToken, url, body), poId, {
    orderCode,
    ...overrides
  });
}

interface MakerPoBody {
  id: string;
  status: string;
  snapshotSha256: string;
  snapshot: {
    specs: { artworkFiles: Array<{ designKey: string; revisionNo: number; fileSha256: string }> };
  };
}

interface SendEventRow {
  id: string;
  eventType: string;
  evidenceDocumentVersionId: string | null;
  senderAddress: string | null;
  recipients: Array<string> | null;
  sentAt: string | null;
  attachmentHashes: Array<string> | null;
  verificationStatus: string;
  /** M8-HARDEN FIX C1: how the evidence was verified and what it checked. */
  verificationMethod: string | null;
  verificationChecks: Array<{ key: string; status: string; detail: string | null }> | null;
  verificationNote: string | null;
}

async function poEvents(poId: string) {
  return await db.select().from(makerPoEvents)
    .where(eq(makerPoEvents.makerPurchaseOrderId, poId))
    .orderBy(makerPoEvents.recordedAt, makerPoEvents.id) as unknown as SendEventRow[];
}

async function orderRow(orderId: string) {
  const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
  return row;
}

/** The dual-approval re-check audit rows written for one order / maker PO pair. */
async function recheckRows(entityIds: string[]) {
  return await db.select().from(auditEvents).where(and(
    eq(auditEvents.action, 'MAKER_PO_DUAL_APPROVAL_RECHECK'),
    inArray(auditEvents.entityId, entityIds)
  ));
}

function recheckState(row: { afterState: unknown }) {
  return row.afterState as {
    result: string;
    stage: string;
    reason: string;
    gate: { dualApproved: boolean; missingApprovals: Array<{ designKey: string; organization: string }> };
  };
}

/** Registers a SECOND artwork revision of the same design from a fresh proof. */
async function registerNextRevision(chain: Awaited<ReturnType<typeof reachApprovalPending>>) {
  const proof = await uploadDocument({
    documentType: 'proof',
    issuerEntity: 'kanei',
    designKey: 'label-front',
    orderId: chain.orderId,
    poId: chain.poId
  });
  const revision = await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, {
    designKey: 'label-front',
    fileDocumentVersionId: proof.version.id
  });
  expect(revision.status).toBe(201);
  return {
    proofSha256: proof.version.sha256,
    body: revision.body as { id: string; revisionNo: number; status: string; invalidatedApprovals: boolean }
  };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-m8-fail-'));
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
    { id: adminId, username: 'admin_fail_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者FAIL', role: 'admin' },
    { id: staffId, username: 'staff_fail_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者FAIL', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成FAILエンドカスタマー', role: 'end_customer', externalCode: 'TEST-FAIL-CUST' },
    { id: sevenAccountId, name: '合成FAILセブン', role: 'seven', externalCode: 'TEST-FAIL-SEVEN' },
    { id: makerAccountId, name: '合成FAILメーカー', role: 'maker', externalCode: 'TEST-FAIL-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'TEST-FAIL-PROJECT',
    name: '合成FAIL案件',
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

describe('M8-FAIL A: approval reuse across revisions', () => {
  it('stops the old approvals from counting and refuses new paper — via MAKER_PO_NOT_READY, not DUAL_APPROVAL_NO_LONGER_VALID', async () => {
    const chain = await reachMakerPoReady(`A1-${nextTag()}`);

    // The dual approval is valid and the order sits at MAKER_PO_READY.
    const gateBefore = await getAs(adminToken, `/api/film-supply-orders/${chain.orderId}/approval-gate`);
    expect(gateBefore.status).toBe(200);
    expect((gateBefore.body as { dualApproved: boolean }).dualApproved).toBe(true);

    // The failure: a NEW artwork revision is registered after the approvals.
    const next = await registerNextRevision(chain);
    expect(next.body.revisionNo).toBe(2);
    expect(next.body.invalidatedApprovals).toBe(true);
    // T-11: the order enters change review, it never keeps MAKER_PO_READY.
    expect(next.body.status).toBe('CHANGE_REVIEW');

    // The old approvals stop counting: the gate is closed while the approval
    // events themselves stay readable as history (latest decision APPROVE).
    const gateAfter = await getAs(adminToken, `/api/film-supply-orders/${chain.orderId}/approval-gate`);
    const gate = gateAfter.body as {
      dualApproved: boolean;
      missingApprovals: Array<{ designKey: string; organization: string }>;
      designs: Array<{
        currentRevisionNo: number;
        customer: { valid: boolean; latestDecision: string | null; invalidatedByNewerRevision: boolean };
        seven: { valid: boolean; latestDecision: string | null; invalidatedByNewerRevision: boolean };
      }>;
    };
    expect(gate.dualApproved).toBe(false);
    expect(gate.missingApprovals).toEqual([
      { designKey: 'label-front', organization: 'customer' },
      { designKey: 'label-front', organization: 'seven' }
    ]);
    expect(gate.designs[0]?.currentRevisionNo).toBe(2);
    expect(gate.designs[0]?.customer).toMatchObject({ valid: false, latestDecision: null, invalidatedByNewerRevision: false });
    expect(gate.designs[0]?.seven).toMatchObject({ valid: false, latestDecision: null, invalidatedByNewerRevision: false });
    // FINDING A1 (documentation, no fix): the invalidation is carried by the
    // revision scoping of the derivation, NOT by invalidatedByNewerRevision.
    // The flag reads false because the derivation only replays events of the
    // current revision id — the superseded approvals are simply never seen, so
    // the flag can only fire for a hash change inside one revision id.

    // The maker-PO boundary refuses to freeze new paper. FINDING A2 (expected
    // code per the CEO brief was DUAL_APPROVAL_NO_LONGER_VALID): the refusal
    // comes from the creation state gate instead, because CHANGE_REVIEW is not
    // MAKER_PO_READY — the re-check is never even consulted for this attempt.
    const createAttempt = await createMakerPo(chain.orderId);
    expect(createAttempt.status).toBe(422);
    expect((createAttempt.body as { code: string }).code).toBe('MAKER_PO_NOT_READY');

    // Nothing was frozen and no re-check ran for the refused attempt.
    expect(await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, chain.orderId))).toHaveLength(0);
    expect(await recheckRows([chain.orderId])).toHaveLength(0);
  });

  it('M8-HARDEN FIX A3: a still-draft maker PO is no longer certifiable over a superseded revision', async () => {
    const chain = await reachMakerPoReady(`A3-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = ((created.body as MakerPoBody).id);
    const approvedSha = (created.body as MakerPoBody).snapshotSha256;

    // The failure lands while the paper is an unapproved draft.
    const next = await registerNextRevision(chain);
    expect(next.body.status).toBe('CHANGE_REVIEW');

    // FIX A3 (was FINDING A3): the CEO approval is refused — the current
    // revision holds no valid approval from either organization, and certifying
    // the paper over artwork nobody approved is exactly the leak that was
    // closed. The refusal names both missing approvals.
    const approval = await approveMakerPo(poId);
    expect(approval.status).toBe(422);
    const refusal = approval.body as {
      code: string;
      error: string;
      missingApprovals: Array<{ designKey: string; organization: string }>;
    };
    expect(refusal.code).toBe('DUAL_APPROVAL_NO_LONGER_VALID');
    expect(refusal.error).toContain('二重承認');
    expect(refusal.missingApprovals).toEqual([
      { designKey: 'label-front', organization: 'customer' },
      { designKey: 'label-front', organization: 'seven' }
    ]);

    // Nothing was certified: the paper stays a draft with an empty event log,
    // and the snapshot digest it froze is still the one nobody has approved
    // over.
    const [poRow] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, poId)).limit(1);
    expect(poRow?.status).toBe('DRAFT');
    expect(poRow?.ceoApprovedAt).toBeNull();
    expect(poRow?.snapshotSha256).toBe(approvedSha);
    expect((await poEvents(poId))).toHaveLength(0);
    // Sending unapproved paper is refused by the same re-check.
    const sendAttempt = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      sentAt: '2026-11-15T09:00:00.000Z'
    });
    expect(sendAttempt.status).toBe(422);
    expect((sendAttempt.body as { code: string }).code).toBe('DUAL_APPROVAL_NO_LONGER_VALID');

    // The audit trail names exactly what happened: the re-check blocked on the
    // superseded revision — the case that used to pass with the
    // snapshot-void-governs reason.
    const rows = await recheckRows([chain.orderId, poId]);
    const approveRecheck = rows.map(recheckState).find((state) => state.stage === 'maker_po:ceo_approve');
    expect(approveRecheck?.result).toBe('blocked');
    expect(approveRecheck?.reason).toBe('gate_closed_current_revision_missing_dual_approval');
    expect(approveRecheck?.gate.dualApproved).toBe(false);
  });

  it('M8-HARDEN FIX A3 recovery: both organizations approving the new revision reopens the boundary', async () => {
    const chain = await reachMakerPoReady(`A3REC-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as MakerPoBody).id;

    const next = await registerNextRevision(chain);
    expect(next.body.status).toBe('CHANGE_REVIEW');
    expect((await approveMakerPo(poId)).status).toBe(422);

    // The recovery: both organizations approve the NEW revision.
    expect((await recordTextApproval({ chain, organization: 'customer', revisionId: next.body.id })).dualApproved)
      .toBe(false);
    expect((await recordTextApproval({ chain, organization: 'seven', revisionId: next.body.id })).dualApproved)
      .toBe(true);

    // The change review resolves back into the maker chain: the gate is open
    // again, so the paper is certifiable and the approval re-freezes revision 2.
    expect((await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, {
      to: 'APPROVAL_PENDING'
    })).status).toBe(200);
    expect((await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, {
      to: 'DUAL_APPROVED'
    })).status).toBe(200);
    expect((await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, {
      to: 'MAKER_PO_READY'
    })).status).toBe(200);

    const approval = await approveMakerPo(poId);
    expect(approval.status).toBe(200);
    const approved = approval.body as { purchaseOrder: MakerPoBody };
    expect(approved.purchaseOrder.status).toBe('APPROVED_FOR_MANUAL_SEND');
    expect(approved.purchaseOrder.snapshot.specs.artworkFiles[0]).toEqual({
      designKey: 'label-front',
      revisionNo: 2,
      fileSha256: next.proofSha256
    });

    // The re-check that allowed it read the reopened gate.
    const rows = await recheckRows([chain.orderId, poId]);
    const approveRechecks = rows.map(recheckState).filter((state) => state.stage === 'maker_po:ceo_approve');
    expect(approveRechecks).toHaveLength(2);
    expect(approveRechecks[0]?.result).toBe('blocked');
    expect(approveRechecks[1]?.result).toBe('passed');
    expect(approveRechecks[1]?.reason).toBe('gate_open');

    // And the send that follows is provable again.
    const sent = await sendMakerPoEml(poId, chain.orderCode);
    expect(sent.status).toBe(200);
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');
  });
});

describe('M8-FAIL B: duplicate send and duplicate paper', () => {
  it('refuses a re-send of proven paper with MAKER_PO_TRANSITION_BLOCKED and records no second send event', async () => {
    const chain = await reachMakerPoReady(`B1-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as MakerPoBody).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    const evidence = await uploadDocument({
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId
    });
    const sentAt = plausibleTestSentAt();
    const sent = await sendMakerPoEml(poId, chain.orderCode, { sentAtIso: sentAt });
    expect(sent.status).toBe(200);
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');
    expect(await poEvents(poId)).toHaveLength(2); // CEO_APPROVED + SEND_EVIDENCE_REGISTERED

    // The failure: the same maker PO is submitted as sent again — first with
    // the very evidence version already on the trail, then with a fresh one.
    const sameEvidenceResend = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: evidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-15T10:00:00.000Z'
    });
    expect(sameEvidenceResend.status).toBe(422);
    expect(sameEvidenceResend.body).toMatchObject({
      code: 'MAKER_PO_TRANSITION_BLOCKED',
      from: 'MAKER_PO_SENT_MANUALLY'
    });

    const otherEvidence = await uploadDocument({
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId
    });
    const freshResend = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: otherEvidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-15T11:00:00.000Z'
    });
    expect(freshResend.status).toBe(422);
    expect((freshResend.body as { code: string }).code).toBe('MAKER_PO_TRANSITION_BLOCKED');

    // Neither attempt overwrote the proven send nor added a second one.
    const events = await poEvents(poId);
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED')).toHaveLength(1);
    expect(events.find((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED')?.sentAt)
      .toEqual(new Date(sentAt));
    expect((await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)).limit(1))[0]?.status)
      .toBe('MAKER_PO_SENT_MANUALLY');
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');
  });

  it('M8-HARDEN FIX B2: a second maker PO is refused with the existing one named, and replacement is cancel-then-create', async () => {
    const chain = await reachMakerPoReady(`B2-${nextTag()}`);
    const first = await createMakerPo(chain.orderId);
    expect(first.status).toBe(201);
    const po1 = (first.body as MakerPoBody).id;

    // FIX B2 (was FINDING B2): the second paper is refused while the first one
    // holds the order, and the refusal names it so the operator can act.
    const second = await createMakerPo(chain.orderId);
    expect(second.status).toBe(422);
    const refused = second.body as {
      code: string;
      error: string;
      existingMakerPurchaseOrderId: string;
      existingStatus: string;
    };
    expect(refused.code).toBe('MAKER_PO_ALREADY_EXISTS');
    expect(refused.error).toContain('既に有効なメーカー発注書');
    expect(refused.existingMakerPurchaseOrderId).toBe(po1);

    // Cancelling is the representative's decision; staff cannot free the order.
    const staffCancel = await postAs(staffToken, `/api/maker-purchase-orders/${po1}/cancel`, { note: '訂正' });
    expect(staffCancel.status).toBe(403);
    const noReason = await postAs(adminToken, `/api/maker-purchase-orders/${po1}/cancel`, {});
    expect(noReason.status).toBe(422);
    expect((noReason.body as { code: string }).code).toBe('MAKER_PO_CANCEL_REASON_REQUIRED');

    // The replacement step itself: cancel (history preserved, nothing deleted),
    // then create the new paper.
    const cancelled = await cancelMakerPo(po1, '宛先と金額の訂正のため再発注します');
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { status: string }).status).toBe('CANCELLED');
    const events = await poEvents(po1);
    expect(events.map((event) => event.eventType)).toEqual(['MAKER_PO_CANCELLED']);
    const [cancelledRow] = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.id, po1)).limit(1);
    expect(cancelledRow?.status).toBe('CANCELLED');

    // The cancelled paper does not hold the order any more.
    const replacement = await createMakerPo(chain.orderId);
    expect(replacement.status).toBe(201);
    const po2 = (replacement.body as MakerPoBody).id;
    expect(po2).not.toBe(po1);

    // The trail keeps both papers: the cancelled one is history, never a row
    // that disappeared.
    const rows = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, chain.orderId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual(['CANCELLED', 'DRAFT']);
    expect(await db.select().from(makerPoEvents).where(inArray(makerPoEvents.makerPurchaseOrderId, [po1, po2])))
      .toHaveLength(1);
  });

  it('M8-HARDEN FIX B2: two parallel creates freeze exactly one maker PO for the order', async () => {
    const chain = await reachMakerPoReady(`B2RACE-${nextTag()}`);
    const [one, two] = await Promise.all([
      createMakerPo(chain.orderId),
      createMakerPo(chain.orderId)
    ]);

    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([201, 422]);
    const loser = one.status === 201 ? two : one;
    const winner = one.status === 201 ? one : two;
    expect((loser.body as { code: string }).code).toBe('MAKER_PO_ALREADY_EXISTS');
    expect((winner.body as { status: string }).status).toBe('DRAFT');

    // Exactly one row, and it is the one the winner answered with.
    const rows = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, chain.orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe((winner.body as MakerPoBody).id);

    // Freezing a paper records a MAKER_PO_CREATED audit row and nothing else:
    // maker_po_events starts at the CEO approval, so a bare create leaves it
    // empty. The loser's refusal is on the boundary, not in the paper's history.
    const created = await db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'MAKER_PO_CREATED'),
      eq(auditEvents.entityId, rows[0]!.id)
    ));
    expect(created).toHaveLength(1);
    expect(await db.select().from(makerPoEvents).where(inArray(makerPoEvents.makerPurchaseOrderId, [rows[0]!.id])))
      .toHaveLength(0);
  });
});

describe('M8-FAIL C: invalid send evidence', () => {
  it('M8-HARDEN FIX C1 (was FINDING C1): content that proves nothing of the send is pending, never VERIFIED', async () => {
    const chain = await reachMakerPoReady(`C1-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as MakerPoBody).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    // The evidence file carries none of the send facts: no Message-ID, no
    // recipient, no date — and it is not an email at all.
    const evidence = await uploadDocument({
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId,
      content: 'このファイルには送信事実が一切含まれていません。追跡番号も宛先も日時もありません。\n'
    });
    const sent = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: evidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: plausibleTestSentAt()
    });

    // M8-HARDEN FIX C1 (was FINDING C1): the send is never VERIFIED. The cited
    // bytes are read as an email, fail every header check, and the event is
    // recorded PENDING_MANUAL_VERIFICATION with its check list — while the paper
    // stays where it is, so a corrected .eml can still be registered.
    expect(sent.status).toBe(200);
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    expect((sent.body as { verificationMethod: string | null }).verificationMethod).toBe('eml_header_check');
    expect((sent.body as { pendingCode: string }).pendingCode).toBe('EML_UNPARSABLE');
    expect((sent.body as { status: string }).status).toBe('APPROVED_FOR_MANUAL_SEND');
    const event = (await poEvents(poId)).find((row) => row.eventType === 'SEND_EVIDENCE_REGISTERED');
    expect(event?.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    expect(event?.evidenceDocumentVersionId).toBe(evidence.version.id);
    expect(event?.verificationNote).toContain('.eml');
    expect(event?.verificationChecks?.map((check) => check.key)).toContain('eml_parse');
    expect(event?.verificationChecks?.find((check) => check.key === 'eml_parse')?.status).toBe('failed');

    // The human half of FIX C1: only the representative asserts a delivery, on
    // the pending event, with name, time, result and reason.
    const staffVerification = await postAs(staffToken, `/api/maker-po-events/${event?.id}/send-manual-verification`, {
      result: 'confirmed',
      verifierName: '合成担当者',
      verifiedAt: new Date().toISOString(),
      reasonNote: '担当者は確認できません'
    });
    expect(staffVerification.status).toBe(403);
    const adminVerification = await postAs(adminToken, `/api/maker-po-events/${event?.id}/send-manual-verification`, {
      result: 'confirmed',
      verifierName: '合成代表者',
      verifiedAt: new Date().toISOString(),
      reasonNote: 'メーカー宛の送信を原本で確認した'
    });
    expect(adminVerification.status).toBe(201);
    expect((adminVerification.body as { deliveryAsserted: boolean }).deliveryAsserted).toBe(true);
    // An already-confirmed event is final: a retraction is a new record, never
    // an edit of the human decision.
    const notPending = await postAs(adminToken, `/api/maker-po-events/${event?.id}/send-manual-verification`, {
      result: 'confirmed',
      verifierName: '合成代表者',
      verifiedAt: new Date().toISOString(),
      reasonNote: '二度目の確認'
    });
    expect(notPending.status).toBe(422);
    expect((notPending.body as { code: string }).code).toBe('MAKER_PO_SEND_ALREADY_CONFIRMED');
  });

  it('M8-HARDEN FIX C1: only the original EML of the production-order mail reaches VERIFIED', async () => {
    const chain = await reachMakerPoReady(`C1EML-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as MakerPoBody).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    // (a) a PDF instead of an EML: stored, but never an email.
    const pdf = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      contentBase64: Buffer.from('%PDF-1.7\n% not an email at all\n', 'utf8').toString('base64'),
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: plausibleTestSentAt()
    });
    expect(pdf.status).toBe(200);
    expect((pdf.body as { verificationStatus: string }).verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    expect((pdf.body as { pendingCode: string }).pendingCode).toBe('EML_UNPARSABLE');

    // (b) an EML without a Message-ID: not an export of a sent mail.
    const noMessageId = await sendMakerPoEml(poId, chain.orderCode, {
      headers: { 'Message-ID': null }
    });
    expect(noMessageId.status).toBe(200);
    expect((noMessageId.body as { pendingCode: string }).pendingCode).toBe('EML_MESSAGE_ID_MISSING');

    // (c) an EML whose To: names someone else: the content contradicts the
    // frozen recipient, whatever the request declares.
    const wrongRecipient = await sendMakerPoEml(poId, chain.orderCode, {
      recipientAddress: 'someone-else@example.com',
      requestRecipients: ['maker-po@example.com']
    });
    expect(wrongRecipient.status).toBe(200);
    expect((wrongRecipient.body as { pendingCode: string }).pendingCode).toBe('EML_RECIPIENT_MISMATCH');

    // (d) an EML whose subject names another order.
    const wrongSubject = await sendMakerPoEml(poId, chain.orderCode, {
      subject: '製造先発注書 FSO-OTHER-9999'
    });
    expect(wrongSubject.status).toBe(200);
    expect((wrongSubject.body as { pendingCode: string }).pendingCode).toBe('EML_SUBJECT_IDENTIFIER_MISSING');

    // None of the four attempts moved the paper, and every one is on the trail.
    expect((await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)).limit(1))[0]?.status)
      .toBe('APPROVED_FOR_MANUAL_SEND');
    expect((await poEvents(poId)).filter((row) => row.eventType === 'SEND_EVIDENCE_REGISTERED')).toHaveLength(4);

    // (e) the genuine export: matching headers, the frozen recipient, the order
    // code in the subject, and the approved artwork attached by hash.
    const sent = await sendMakerPoEml(poId, chain.orderCode, { attachmentBytes: chain.artworkBytes });
    expect(sent.status).toBe(200);
    const sentBody = sent.body as {
      status: string;
      verificationStatus: string;
      verificationMethod: string | null;
      verificationChecks: Array<{ key: string; status: string; detail: string | null }>;
      event: SendEventRow;
    };
    expect(sentBody.verificationStatus).toBe('VERIFIED');
    expect(sentBody.verificationMethod).toBe('eml_header_check');
    expect(sentBody.status).toBe('MAKER_PO_SENT_MANUALLY');
    const byKey = new Map(sentBody.verificationChecks.map((check) => [check.key, check]));
    expect(byKey.get('message_id')?.status).toBe('passed');
    expect(byKey.get('from_header')?.status).toBe('passed');
    expect(byKey.get('recipient_address')?.status).toBe('passed');
    expect(byKey.get('date_header')?.status).toBe('passed');
    expect(byKey.get('date_sent_at_consistency')?.status).toBe('passed');
    expect(byKey.get('subject_identifier')?.status).toBe('passed');
    expect(byKey.get('sent_at_plausibility')?.status).toBe('passed');
    // The strong signal: the attached bytes are the approved artwork.
    expect(byKey.get('attachment_hash')?.status).toBe('passed');
    expect(sentBody.event.attachmentHashes).toContain(sent.built.attachmentSha256);
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');

    // Storing and verifying the EML is still not proof of delivery: the answer
    // says the representative's manual confirmation is what asserts delivery.
    expect((sent.body as { deliveryAssertedByManualVerification: boolean }).deliveryAssertedByManualVerification)
      .toBe(false);
  });

  it('M8-HARDEN FIX C2: a sentAt in the future is refused, and an impossible send time stays unverified', async () => {
    const chain = await reachMakerPoReady(`C2-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as MakerPoBody).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    // The one send-fact refusal that was already there: proven recipients must
    // include the frozen recipient address, otherwise SEND_REJECTED.
    const mismatchEvidence = await uploadDocument({
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId
    });
    const mismatch = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: mismatchEvidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['someone-else@example.com'],
      sentAt: plausibleTestSentAt()
    });
    expect(mismatch.status).toBe(422);
    expect((mismatch.body as { code: string }).code).toBe('SEND_RECIPIENT_MISMATCH');
    expect((mismatch.body as { status: string }).status).toBe('APPROVED_FOR_MANUAL_SEND');
    expect((await poEvents(poId)).map((event) => event.eventType)).toContain('SEND_REJECTED');

    // FIX C2 (was FINDING C2): a send claimed more than ten minutes ahead of the
    // server clock is impossible and is refused before anything is written.
    const future = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      contentBase64: buildMakerPoEml({ orderCode: chain.orderCode }).contentBase64,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });
    expect(future.status).toBe(422);
    expect((future.body as { code: string }).code).toBe('SENT_AT_IN_FUTURE');
    expect(typeof (future.body as { serverNow: string }).serverNow).toBe('string');
    expect((await poEvents(poId)).filter((row) => row.eventType === 'SEND_EVIDENCE_REGISTERED')).toHaveLength(0);
    expect((await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)).limit(1))[0]?.status)
      .toBe('APPROVED_FOR_MANUAL_SEND');

    // Inside the tolerance the send is registrable again.
    const withinTolerance = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      contentBase64: buildMakerPoEml({ orderCode: chain.orderCode, messageId: '<within-tolerance@mail.kanei.example>' })
        .contentBase64,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    });
    expect(withinTolerance.status).toBe(200);
    expect((withinTolerance.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');

    // A send recorded before the CEO approved it is not hard-failed: it is
    // downgraded to PENDING_MANUAL_VERIFICATION with the reason on the event.
    const beforeApproval = await reachMakerPoReady(`C2PRE-${nextTag()}`);
    const secondPo = await createMakerPo(beforeApproval.orderId);
    expect(secondPo.status).toBe(201);
    const secondPoId = (secondPo.body as MakerPoBody).id;
    expect((await approveMakerPo(secondPoId)).status).toBe(200);
    const preApproval = await sendMakerPoEml(secondPoId, beforeApproval.orderCode, {
      sentAtIso: '2026-11-01T09:00:00.000Z'
    });
    expect(preApproval.status).toBe(200);
    expect((preApproval.body as { verificationStatus: string }).verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    expect((preApproval.body as { pendingCode: string }).pendingCode).toBe('SENT_AT_PRECEDES_CEO_APPROVAL');
    expect((preApproval.body as { verificationNote: string | null }).verificationNote).toContain('代表者承認');
    expect((await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, secondPoId)).limit(1))[0]?.status)
      .toBe('APPROVED_FOR_MANUAL_SEND');

    // And the EML Date contradicting the recorded sentAt downgrades too.
    const conflict = await sendMakerPoEml(secondPoId, beforeApproval.orderCode, {
      messageId: '<date-conflict@mail.kanei.example>',
      dateHeaderIso: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    });
    // The registration above left the paper where it was, so this one runs.
    expect(conflict.status).toBe(200);
    const conflictBody = conflict.body as { pendingCode: string; verificationStatus: string };
    expect(conflictBody.pendingCode).toBe('EML_DATE_SENT_AT_CONFLICT');
    expect(conflictBody.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
  });

  it('registers a missing or empty evidence id as UNVERIFIED at best, and requires sentAt with it', async () => {
    const chain = await reachMakerPoReady(`C3-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as MakerPoBody).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    // (c-1) an evidence id without a timestamp is a malformed request: nothing
    // is persisted and the paper stays approvable-only.
    const noTimestamp = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: '00000000-0000-7000-8000-000000000000'
    });
    expect(noTimestamp.status).toBe(422);
    expect((noTimestamp.body as { code: string }).code).toBe('SENT_AT_REQUIRED');
    expect(await poEvents(poId)).toHaveLength(1); // only CEO_APPROVED

    // (c-2) an empty evidence id with a timestamp is the timestamp-only shape:
    // recorded UNVERIFIED, the PO parks in SEND_UNVERIFIED — never VERIFIED.
    const emptyId = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: '',
      sentAt: '2026-11-15T09:00:00.000Z'
    });
    expect(emptyId.status).toBe(200);
    expect(emptyId.body).toMatchObject({ status: 'SEND_UNVERIFIED', verificationStatus: 'UNVERIFIED' });
    const event = (await poEvents(poId)).find((row) => row.eventType === 'SEND_EVIDENCE_REGISTERED');
    expect(event?.verificationStatus).toBe('UNVERIFIED');
    expect(event?.evidenceDocumentVersionId).toBeNull();
    expect(event?.recipients).toBeNull();

    // (c-3) a missing evidence id behaves exactly like the empty one — but the
    // dead-end status now blocks every further registration (T-21).
    const missingId = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      sentAt: '2026-11-15T10:00:00.000Z'
    });
    expect(missingId.status).toBe(422);
    expect((missingId.body as { code: string }).code).toBe('MAKER_PO_TRANSITION_BLOCKED');
    expect(await poEvents(poId)).toHaveLength(2);
  });
});

describe('M8-HARDEN D: acceptance gates', () => {
  it('refuses acceptance with no send, acceptance evidence of another order, and evidence of another maker PO', async () => {
    // Acceptance without proven send on the SEND_UNVERIFIED path is already
    // pinned by tests/m4/m4-maker-po.test.ts 'T-21 … blocks every further
    // transition'. Pinned here: the paper that recorded NO send whatsoever.
    const chain = await reachMakerPoReady(`D1-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as MakerPoBody).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    const correctEvidence = await uploadDocument({
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId,
      makerPoId: poId
    });
    const neverSent = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: correctEvidence.version.id,
      acceptedAt: plausibleTestSentAt()
    });
    expect(neverSent.status).toBe(422);
    expect(neverSent.body).toMatchObject({ code: 'MAKER_PO_TRANSITION_BLOCKED', from: 'APPROVED_FOR_MANUAL_SEND' });
    expect((await poEvents(poId)).filter((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED')).toHaveLength(0);

    // The proven send opens the acceptance gate: the original .eml is
    // registered, verified as an email, and the PO leaves the company for real.
    const sent = await sendMakerPoEml(poId, chain.orderCode);
    expect(sent.status).toBe(200);
    expect((sent.body as { status: string }).status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');

    // …but only for paperwork of THIS order: acceptance evidence bound to
    // another order of the same project is refused as a foreign document
    // (API level; the pure rule is pinned in tests/m4/core-rules.test.ts
    // 'rejects foreign, mistyped or humanly-unverified acceptance documents').
    const foreignChain = await reachMakerPoReady(`D2-${nextTag()}`);
    const foreignPoId = ((await createMakerPo(foreignChain.orderId)).body as MakerPoBody).id;
    const foreignEvidence = await uploadDocument({
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: foreignChain.orderId,
      poId: foreignChain.poId,
      makerPoId: foreignPoId
    });
    const foreign = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: foreignEvidence.version.id,
      acceptedAt: plausibleTestSentAt()
    });
    expect(foreign.status).toBe(422);
    expect((foreign.body as { code: string }).code).toBe('ACCEPT_EVIDENCE_ORDER_MISMATCH');
    expect((await poEvents(poId)).filter((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED')).toHaveLength(0);
    expect((await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)).limit(1))[0]?.status)
      .toBe('MAKER_PO_SENT_MANUALLY');

    // M8-HARDEN FIX B2 (d): the order linkage alone is no longer enough. One
    // order can hold a cancelled and a live maker PO, so the acceptance evidence
    // names the paper it closes and never closes the other one. The replacement
    // chain below is the realistic shape: cancel the old paper (which re-opens
    // the ordering step), freeze a new one, and watch the old document be
    // refused on the new paper.
    const cancelForReplacement = await cancelMakerPo(poId, '数量訂正のため再発注');
    expect(cancelForReplacement.status).toBe(200);
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_READY');
    const replaced = await createMakerPo(chain.orderId);
    expect(replaced.status).toBe(201);
    const poId2 = (replaced.body as MakerPoBody).id;
    expect((await approveMakerPo(poId2)).status).toBe(200);
    expect((await sendMakerPoEml(poId2, chain.orderCode)).status).toBe(200);

    const staleEvidence = await uploadDocument({
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId,
      makerPoId: poId
    });
    expect((await postAs(staffToken, `/api/documents/${staleEvidence.document.id}/verify`, {
      verificationStatus: 'verified'
    })).status).toBe(200);
    const crossPo = await postAs(adminToken, `/api/maker-purchase-orders/${poId2}/accept-evidence`, {
      evidenceDocumentVersionId: staleEvidence.version.id,
      acceptedAt: plausibleTestSentAt()
    });
    expect(crossPo.status).toBe(422);
    expect((crossPo.body as { code: string }).code).toBe('ACCEPT_EVIDENCE_PO_MISMATCH');
    expect((await poEvents(poId2)).filter((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED')).toHaveLength(0);

    // The genuine paperwork of THIS paper still closes it normally.
    const ownEvidence = await uploadDocument({
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId,
      makerPoId: poId2
    });
    expect((await postAs(staffToken, `/api/documents/${ownEvidence.document.id}/verify`, {
      verificationStatus: 'verified'
    })).status).toBe(200);
    const accepted = await postAs(adminToken, `/api/maker-purchase-orders/${poId2}/accept-evidence`, {
      evidenceDocumentVersionId: ownEvidence.version.id,
      acceptedAt: plausibleTestSentAt()
    });
    expect(accepted.status).toBe(200);
    expect((accepted.body as { purchaseOrder: { status: string } }).purchaseOrder.status).toBe('MAKER_PO_ACCEPTED');
    expect((await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)).limit(1))[0]?.status)
      .toBe('CANCELLED');
  });
});
