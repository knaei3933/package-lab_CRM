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

/**
 * M8-FAIL regression tests: the four CEO-directed failure scenarios, verified
 * against the behavior that actually ships. No new feature is introduced here —
 * each test pins what the endpoints really do when the flow is abused, and the
 * findings that need a product decision are marked FINDING in the comments.
 *
 * A — approval reuse across revisions: a new artwork revision after a valid
 *     dual approval must stop the old approvals from counting, and the
 *     maker-PO boundary must refuse. Coverage that already existed:
 *     tests/m3/core-rules.test.ts 'T-11 never transfers an approval to a new
 *     revision…' (pure), tests/m8-oper2/m8-oper2-core-rules.test.ts 'reads the
 *     hash mismatch…' (pure invalidatedByNewerRevision), tests/m4/
 *     m4-maker-po.test.ts 'T-24 an artwork change voids the approved snapshot…'
 *     (send refused on drifted paper). Missing and pinned here: the boundary
 *     answer after a new revision, and what the re-check records for it.
 * B — duplicate send / re-send of proven paper: no test sent the same maker PO
 *     twice after a VERIFIED send, and none asked whether a second maker PO can
 *     exist for one order. Pinned here.
 * C — invalid send evidence: content that proves nothing, a future sentAt, and
 *     a missing/empty evidence id. tests/m4/core-rules.test.ts covers the
 *     UNVERIFIED and malformed-request shapes purely; the API-level content and
 *     time cases were missing. Pinned here with the exact outcome per case.
 * D — acceptance without proven send: already covered by tests/m4/
 *     m4-maker-po.test.ts 'T-21 … blocks every further transition' (acceptance
 *     from SEND_UNVERIFIED) and tests/m4/core-rules.test.ts 'rejects foreign,
 *     mistyped or humanly-unverified acceptance documents' (pure order
 *     mismatch). Missing and pinned here: the API-level acceptance from an
 *     order whose paper never recorded any send, and acceptance evidence bound
 *     to another order of the same project.
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

/** Records one counted TEXT approval whose evidence quotes its identifier. */
async function recordTextApproval(input: {
  chain: Awaited<ReturnType<typeof reachApprovalPending>>;
  organization: 'customer' | 'seven';
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
  const approval = await postAs(staffToken, `/api/artwork-revisions/${input.chain.revisionId}/approvals`, {
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

  it('FINDING A3: certifies a still-draft maker PO over the superseded revision without fresh approvals', async () => {
    const chain = await reachMakerPoReady(`A3-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = ((created.body as MakerPoBody).id);
    const approvedSha = (created.body as MakerPoBody).snapshotSha256;

    // The failure lands while the paper is an unapproved draft.
    const next = await registerNextRevision(chain);
    expect(next.body.status).toBe('CHANGE_REVIEW');

    // FINDING A3 (characterized, no fix): the CEO approval is answered 200 —
    // the re-check classifies a superseding revision as the change-review flow
    // ('gate_closed_superseded_revision_snapshot_void_governs') and declines to
    // block, and the approval re-freezes the snapshot over the NEW revision.
    // The paper is certified although no organization approved its artwork.
    const approval = await approveMakerPo(poId);
    expect(approval.status).toBe(200);
    const approved = approval.body as { purchaseOrder: MakerPoBody };
    expect(approved.purchaseOrder.status).toBe('APPROVED_FOR_MANUAL_SEND');
    expect(approved.purchaseOrder.snapshot.specs.artworkFiles[0]).toEqual({
      designKey: 'label-front',
      revisionNo: 2,
      fileSha256: next.proofSha256
    });
    expect(approved.purchaseOrder.snapshotSha256).not.toBe(approvedSha);

    // The PO advanced while the order itself stayed in change review: the two
    // chains are no longer describing the same artwork.
    expect((await orderRow(chain.orderId))?.status).toBe('CHANGE_REVIEW');

    // The audit trail names exactly what happened: the re-check passed on a
    // closed gate, with the superseded-revision reason, not a withdrawal.
    const rows = await recheckRows([chain.orderId, poId]);
    const approveRecheck = rows.map(recheckState).find((state) => state.stage === 'maker_po:ceo_approve');
    expect(approveRecheck?.result).toBe('passed');
    expect(approveRecheck?.reason).toBe('gate_closed_superseded_revision_snapshot_void_governs');
    expect(approveRecheck?.gate.dualApproved).toBe(false);
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
    const sent = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: evidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-15T09:00:00.000Z'
    });
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
      .toEqual(new Date('2026-11-15T09:00:00.000Z'));
    expect((await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)).limit(1))[0]?.status)
      .toBe('MAKER_PO_SENT_MANUALLY');
    expect((await orderRow(chain.orderId))?.status).toBe('MAKER_PO_SENT_MANUALLY');
  });

  it('FINDING B2: a second maker PO is freezable while the first is a draft, and can travel the whole chain beside it', async () => {
    const chain = await reachMakerPoReady(`B2-${nextTag()}`);
    const first = await createMakerPo(chain.orderId);
    expect(first.status).toBe(201);
    const po1 = (first.body as MakerPoBody).id;

    // FINDING B2 (characterized, no fix): the creation gate reads the ORDER
    // status only, and the order stays MAKER_PO_READY until the first paper is
    // CEO-approved — so a second maker PO freezes for the same order while the
    // first is still a draft (no unique constraint guards this either).
    const second = await createMakerPo(chain.orderId);
    expect(second.status).toBe(201);
    const po2 = (second.body as MakerPoBody).id;
    expect(po2).not.toBe(po1);

    // Once the first paper is certified the door closes for new paper.
    expect((await approveMakerPo(po1)).status).toBe(200);
    const third = await createMakerPo(chain.orderId);
    expect(third.status).toBe(422);
    expect((third.body as { code: string }).code).toBe('MAKER_PO_NOT_READY');

    // The duplicate draft certifies too, and both papers then register a
    // VERIFIED send for the same order.
    expect((await approveMakerPo(po2)).status).toBe(200);
    for (const poId of [po1, po2]) {
      const evidence = await uploadDocument({
        documentType: 'send_evidence',
        issuerEntity: 'kanei',
        orderId: chain.orderId,
        poId: chain.poId
      });
      const sent = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
        evidenceDocumentVersionId: evidence.version.id,
        senderAddress: 'staff@kanei.example',
        recipients: ['maker-po@example.com'],
        sentAt: '2026-11-15T12:00:00.000Z'
      });
      expect(sent.status).toBe(200);
      expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');
    }

    // FINDING B2/D-linkage: acceptance evidence is bound to the ORDER only, so
    // one acceptance document of this order closes BOTH papers.
    const acceptanceEvidence = await uploadDocument({
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId
    });
    expect((await postAs(staffToken, `/api/documents/${acceptanceEvidence.document.id}/verify`, {
      verificationStatus: 'verified'
    })).status).toBe(200);
    for (const poId of [po1, po2]) {
      const accepted = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
        evidenceDocumentVersionId: acceptanceEvidence.version.id,
        acceptedAt: '2026-11-15T13:00:00.000Z'
      });
      expect(accepted.status).toBe(200);
      expect((accepted.body as { purchaseOrder: { status: string } }).purchaseOrder.status).toBe('MAKER_PO_ACCEPTED');
    }

    const rows = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, chain.orderId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status)).toEqual(['MAKER_PO_ACCEPTED', 'MAKER_PO_ACCEPTED']);
    const acceptEvents = await db.select().from(makerPoEvents).where(and(
      eq(makerPoEvents.eventType, 'ACCEPT_EVIDENCE_REGISTERED'),
      inArray(makerPoEvents.makerPurchaseOrderId, [po1, po2])
    ));
    expect(acceptEvents).toHaveLength(2);
    expect(new Set(acceptEvents.map((event) => event.evidenceDocumentVersionId)))
      .toEqual(new Set([acceptanceEvidence.version.id]));
  });
});

describe('M8-FAIL C: invalid send evidence', () => {
  it('FINDING C1: evidence whose content proves nothing of the send is still registered VERIFIED', async () => {
    const chain = await reachMakerPoReady(`C1-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as MakerPoBody).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    // The evidence file carries none of the send facts: no tracking/reference
    // number, no recipient address, no timestamp — the linkage the API actually
    // uses is metadata only (document type, order binding, proven recipients).
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
      sentAt: '2026-11-15T09:00:00.000Z'
    });

    // FINDING C1 (characterized, no fix): the send is VERIFIED and the paper
    // leaves the company, although the cited file proves nothing it claims.
    // Contrast: approval evidence IS content-checked (the per-organization
    // evidenceIdentifier must be quoted in the file). Expected per the brief
    // was SEND_UNVERIFIED at best.
    expect(sent.status).toBe(200);
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');
    expect((sent.body as { status: string }).status).toBe('MAKER_PO_SENT_MANUALLY');
    const event = (await poEvents(poId)).find((row) => row.eventType === 'SEND_EVIDENCE_REGISTERED');
    expect(event?.evidenceDocumentVersionId).toBe(evidence.version.id);
    expect(event?.attachmentHashes).toContain(evidence.version.sha256);
  });

  it('FINDING C2: a sentAt in the future is registered VERIFIED, and a recipient mismatch is the only send-fact refusal', async () => {
    const chain = await reachMakerPoReady(`C2-${nextTag()}`);
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as MakerPoBody).id;
    expect((await approveMakerPo(poId)).status).toBe(200);

    // The one send-fact check that exists: proven recipients must include the
    // frozen recipient address, otherwise the send is recorded SEND_REJECTED.
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
      sentAt: '2026-11-15T09:00:00.000Z'
    });
    expect(mismatch.status).toBe(422);
    expect((mismatch.body as { code: string }).code).toBe('SEND_RECIPIENT_MISMATCH');
    expect((mismatch.body as { status: string }).status).toBe('APPROVED_FOR_MANUAL_SEND');
    expect((await poEvents(poId)).map((event) => event.eventType)).toContain('SEND_REJECTED');

    // FINDING C2 (characterized, no fix): a send claimed for a future instant
    // passes every check and is registered VERIFIED — no guard asks whether the
    // timestamp is even possible yet.
    const futureEvidence = await uploadDocument({
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId
    });
    const future = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: futureEvidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2027-01-01T00:00:00.000Z'
    });
    expect(future.status).toBe(200);
    expect((future.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');
    const event = (await poEvents(poId)).find((row) => row.eventType === 'SEND_EVIDENCE_REGISTERED');
    expect(event?.sentAt).toEqual(new Date('2027-01-01T00:00:00.000Z'));
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

describe('M8-FAIL D: acceptance gates', () => {
  it('refuses acceptance with no send recorded at all, and acceptance evidence bound to another order', async () => {
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
      poId: chain.poId
    });
    const neverSent = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: correctEvidence.version.id,
      acceptedAt: '2026-11-15T09:00:00.000Z'
    });
    expect(neverSent.status).toBe(422);
    expect(neverSent.body).toMatchObject({ code: 'MAKER_PO_TRANSITION_BLOCKED', from: 'APPROVED_FOR_MANUAL_SEND' });
    expect((await poEvents(poId)).filter((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED')).toHaveLength(0);

    // The proven send opens the acceptance — but only for paperwork of THIS
    // order: acceptance evidence bound to another order of the same project is
    // refused as a foreign document (API level; the pure rule is pinned in
    // tests/m4/core-rules.test.ts 'rejects foreign, mistyped or
    // humanly-unverified acceptance documents').
    const foreignChain = await reachMakerPoReady(`D2-${nextTag()}`);
    const foreignEvidence = await uploadDocument({
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: foreignChain.orderId,
      poId: foreignChain.poId
    });
    const foreign = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: foreignEvidence.version.id,
      acceptedAt: '2026-11-15T10:00:00.000Z'
    });
    expect(foreign.status).toBe(422);
    expect((foreign.body as { code: string }).code).toBe('ACCEPT_EVIDENCE_ORDER_MISMATCH');
    expect((await poEvents(poId)).filter((event) => event.eventType === 'ACCEPT_EVIDENCE_REGISTERED')).toHaveLength(0);
    expect((await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, poId)).limit(1))[0]?.status)
      .toBe('MAKER_PO_SENT_MANUALLY');

    // The genuine paperwork of this order still closes the paper normally.
    expect((await postAs(staffToken, `/api/documents/${correctEvidence.document.id}/verify`, {
      verificationStatus: 'verified'
    })).status).toBe(200);
    const accepted = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: correctEvidence.version.id,
      acceptedAt: '2026-11-15T11:00:00.000Z'
    });
    expect(accepted.status).toBe(200);
    expect((accepted.body as { purchaseOrder: { status: string } }).purchaseOrder.status).toBe('MAKER_PO_ACCEPTED');
  });
});
