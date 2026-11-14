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
 * M8-OPER3 regression tests: the real-time dual-approval re-verification at the
 * maker-PO boundary (CEO final safety gate).
 *
 * A REVOKE is an append-only approval event and never rewrites the order
 * status. An order that reached MAKER_PO_READY on a valid dual approval keeps
 * that status after one organization withdraws, and the four maker-PO endpoints
 * (create, CEO approval, send evidence, accept evidence) were the doors that
 * never re-read the gate: the paper could still be frozen, certified and sent
 * on an approval that no longer exists.
 *
 * Pinned here:
 * 1. after a REVOKE, create / CEO approval / send evidence answer 422
 *    DUAL_APPROVAL_NO_LONGER_VALID, write nothing, and every attempt leaves its
 *    own MAKER_PO_DUAL_APPROVAL_RECHECK audit row with result 'blocked';
 * 2. a fresh approval from the withdrawn organization re-opens the gate and the
 *    boundary lets the work proceed again (the re-check is live, not a ban);
 * 3. the happy path still succeeds end to end on a valid dual approval:
 *    proven send (VERIFIED) → acceptance → FILM_IN_PRODUCTION, every re-check
 *    recorded with result 'passed';
 * 4. paper whose send is already proven is never retroactively blocked: a
 *    REVOKE recorded after the VERIFIED send does not refuse the acceptance —
 *    the re-check is recorded
 *    ('gate_closed_after_proven_send_recorded_not_enforced') and the order can
 *    still reach FILM_IN_PRODUCTION.
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

async function requestAs(token: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
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

function fullChecklist() {
  return {
    issuerNameRecorded: true,
    issuerName: '合成セブン化学事業',
    documentNumberRecorded: true,
    documentNumber: `PO-2026-OPER3-${nextTag()}`,
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
  const content = input.content ?? `composite m8-oper3 document bytes ${tag}\n`;
  const response = await postAs(staffToken, `/api/projects/${projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `m8oper3-doc-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: toBase64(content),
    ...(input.poId ? { sevenPurchaseOrderId: input.poId } : {}),
    ...(input.orderId ? { filmSupplyOrderId: input.orderId } : {}),
    ...(input.designKey ? { designKey: input.designKey } : {})
  });
  expect(response.status).toBe(201);
  return response.body as { document: { id: string }; version: { id: string; sha256: string } };
}

/**
 * An order at APPROVAL_PENDING with one registered design and no approval yet.
 */
async function reachApprovalPending(tag: string) {
  const createdPo = await postAs(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, {
    poNumber: `SEVEN-OPER3-${tag}`,
    officialRegisteredAt: '2026-11-13T09:00:00.000Z'
  });
  expect(createdPo.status).toBe(201);
  const po = createdPo.body as { id: string };

  expect((await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/verification-checklist`, fullChecklist())).status).toBe(200);
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/register-official`, {
    officialRegisteredAt: '2026-11-13T09:00:00.000Z'
  })).status).toBe(200);

  const createdOrder = await postAs(staffToken, `/api/seven-purchase-orders/${po.id}/supply-orders`, {
    code: `FSO-OPER3-${tag}`,
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
  const identifier = `MSG-OPER3-${input.organization.toUpperCase()}-${nextTag()}`;
  const evidence = await uploadDocument({
    documentType: 'approval_evidence',
    issuerEntity: input.organization === 'seven' ? 'seven' : 'customer_generated',
    designKey: 'label-front',
    orderId: input.chain.orderId,
    poId: input.chain.poId,
    content: `composite m8-oper3 approval evidence\nidentifier: ${identifier}\n`
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
  return approval.body as {
    approvalEvent: { id: string; decision: string };
    countsTowardDualApproval: boolean;
    dualApproved: boolean;
    orderStatus: string;
  };
}

/** Records one REVOKE whose own evidence quotes its own identifier. */
async function revokeApproval(input: {
  chain: Awaited<ReturnType<typeof reachApprovalPending>>;
  organization: 'customer' | 'seven';
}) {
  const identifier = `REVOKE-OPER3-${input.organization.toUpperCase()}-${nextTag()}`;
  const evidence = await uploadDocument({
    documentType: 'approval_evidence',
    issuerEntity: input.organization === 'seven' ? 'seven' : 'customer_generated',
    designKey: 'label-front',
    orderId: input.chain.orderId,
    poId: input.chain.poId,
    content: `composite m8-oper3 revocation evidence\nidentifier: ${identifier}\n`
  });
  const revoke = await postAs(staffToken, `/api/artwork-revisions/${input.chain.revisionId}/approvals`, {
    organization: input.organization,
    decision: 'REVOKE',
    evidenceSource: 'email',
    eventTime: '2026-11-14T11:00:00.000Z',
    evidenceIdentifier: identifier,
    evidenceDocumentVersionId: evidence.version.id
  });
  expect(revoke.status).toBe(201);
  return revoke.body as {
    approvalEvent: { id: string; decision: string };
    countsTowardDualApproval: boolean;
    dualApproved: boolean;
    orderStatus: string;
  };
}

/**
 * Drives an order to MAKER_PO_READY through a valid dual approval and returns
 * the chain.
 */
async function reachMakerPoReady(tag: string) {
  const chain = await reachApprovalPending(tag);
  expect((await recordTextApproval({ chain, organization: 'customer' })).countsTowardDualApproval).toBe(true);
  expect((await recordTextApproval({ chain, organization: 'seven' })).dualApproved).toBe(true);
  const ready = await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'MAKER_PO_READY' });
  expect(ready.status).toBe(200);
  return chain;
}

async function createMakerPo(orderId: string) {
  return await postAs(adminToken, `/api/film-supply-orders/${orderId}/maker-purchase-orders`, {
    recipientAddress: 'maker-po@example.com'
  });
}

/** The re-check audit rows written for one order / maker PO pair. */
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
    provenSendExists: boolean;
    gate: { dualApproved: boolean; missingApprovals: Array<{ designKey: string; organization: string }> };
  };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-m8-oper3-'));
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
    { id: adminId, username: 'admin_oper3_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者OPER3', role: 'admin' },
    { id: staffId, username: 'staff_oper3_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者OPER3', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成OPER3エンドカスタマー', role: 'end_customer', externalCode: 'TEST-OPER3-CUST' },
    { id: sevenAccountId, name: '合成OPER3セブン', role: 'seven', externalCode: 'TEST-OPER3-SEVEN' },
    { id: makerAccountId, name: '合成OPER3メーカー', role: 'maker', externalCode: 'TEST-OPER3-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId,
    code: 'TEST-OPER3-PROJECT',
    name: '合成OPER3案件',
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

describe('M8-OPER3: a withdrawal closes the maker-PO boundary in real time', () => {
  it('refuses create, CEO approval and send evidence after a REVOKE, writing nothing and auditing every refusal', async () => {
    const chain = await reachMakerPoReady(`CLOSE-${nextTag()}`);

    // The maker PO that already exists when the withdrawal lands: the attempts
    // below act on real paper instead of on nothing.
    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;

    const revoked = await revokeApproval({ chain, organization: 'customer' });
    expect(revoked.approvalEvent.decision).toBe('REVOKE');
    expect(revoked.dualApproved).toBe(false);
    // The REVOKE never rewrites the status: this is exactly why the boundary
    // has to re-read the gate instead of trusting the status column.
    const [orderRow] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, chain.orderId)).limit(1);
    expect(orderRow?.status).toBe('MAKER_PO_READY');

    // (a) freezing new paper is refused.
    const createAttempt = await createMakerPo(chain.orderId);
    expect(createAttempt.status).toBe(422);
    const createBody = createAttempt.body as {
      error: string;
      code: string;
      missingApprovals: Array<{ designKey: string; organization: string }>;
    };
    expect(createBody.code).toBe('DUAL_APPROVAL_NO_LONGER_VALID');
    expect(createBody.error).toContain('二重承認');
    expect(createBody.missingApprovals).toEqual([
      { designKey: 'label-front', organization: 'customer' }
    ]);

    // (b) certifying the existing paper is refused.
    const approvalAttempt = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {});
    expect(approvalAttempt.status).toBe(422);
    expect((approvalAttempt.body as { code: string }).code).toBe('DUAL_APPROVAL_NO_LONGER_VALID');

    // (c) sending the paper is refused — nothing has shipped yet.
    const sendEvidence = await uploadDocument({
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId
    });
    const sendAttempt = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: sendEvidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-15T09:00:00.000Z'
    });
    expect(sendAttempt.status).toBe(422);
    expect((sendAttempt.body as { code: string }).code).toBe('DUAL_APPROVAL_NO_LONGER_VALID');

    // Nothing was written by any of the three attempts: no second PO, the
    // existing PO is still an unapproved draft with an empty event log.
    const poRows = await db.select().from(makerPurchaseOrders)
      .where(eq(makerPurchaseOrders.filmSupplyOrderId, chain.orderId));
    expect(poRows).toHaveLength(1);
    expect(poRows[0]?.status).toBe('DRAFT');
    expect(poRows[0]?.ceoApprovedAt).toBeNull();
    expect(await db.select().from(makerPoEvents)
      .where(eq(makerPoEvents.makerPurchaseOrderId, poId))).toHaveLength(0);

    // Every re-check decision — the one pass before the withdrawal and the
    // three blocks after it — is its own append-only audit row naming the
    // stage, the reason and the gate snapshot.
    const rows = await recheckRows([chain.orderId, poId]);
    expect(rows).toHaveLength(4);
    const passedRows = rows.filter((row) => recheckState(row).result === 'passed');
    expect(passedRows).toHaveLength(1);
    expect(recheckState(passedRows[0!]).stage).toBe('maker_po:create');
    expect(recheckState(passedRows[0!]).reason).toBe('gate_open');

    const blockedRows = rows.filter((row) => recheckState(row).result === 'blocked');
    expect(blockedRows).toHaveLength(3);
    const byStage = new Map(blockedRows.map((row) => [recheckState(row).stage, recheckState(row)]));
    expect([...byStage.keys()].sort()).toEqual([
      'maker_po:ceo_approve',
      'maker_po:create',
      'maker_po:send_evidence'
    ]);
    for (const state of byStage.values()) {
      expect(state.reason).toBe('gate_closed_approval_withdrawn');
      expect(state.provenSendExists).toBe(false);
      expect(state.gate.dualApproved).toBe(false);
      expect(state.gate.missingApprovals).toContainEqual({
        designKey: 'label-front',
        organization: 'customer'
      });
    }
    // The refusal audit rows carry the withdrawal reason in the gate snapshot.
    const createRow = blockedRows.find((row) => recheckState(row).stage === 'maker_po:create');
    const gateDesigns = ((createRow?.afterState as { gate: { designs: Array<Record<string, unknown>> } }).gate).designs;
    expect(gateDesigns[0]).toMatchObject({
      designKey: 'label-front',
      customer: { valid: false, revoked: true, latestDecision: 'REVOKE' },
      seven: { valid: true, revoked: false, latestDecision: 'APPROVE' }
    });
  });

  it('re-opens the boundary when the withdrawn organization approves again', async () => {
    const chain = await reachMakerPoReady(`REOPEN-${nextTag()}`);

    expect((await revokeApproval({ chain, organization: 'seven' })).dualApproved).toBe(false);
    const refused = await createMakerPo(chain.orderId);
    expect(refused.status).toBe(422);
    expect((refused.body as { code: string }).code).toBe('DUAL_APPROVAL_NO_LONGER_VALID');

    // The recovery is the organization's own fresh approval, not a staff edit.
    const again = await recordTextApproval({ chain, organization: 'seven' });
    expect(again.countsTowardDualApproval).toBe(true);
    expect(again.dualApproved).toBe(true);

    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;

    // The re-check answered 'passed' for the reopened gate — and the refused
    // attempt before it is still on the trail.
    const rows = await recheckRows([chain.orderId, poId]);
    const blockedRows = rows.filter((row) => recheckState(row).result === 'blocked');
    const passedRows = rows.filter((row) => recheckState(row).result === 'passed');
    expect(blockedRows).toHaveLength(1);
    expect(passedRows).toHaveLength(1);
    expect(recheckState(passedRows[0!]).reason).toBe('gate_open');
    expect(recheckState(passedRows[0!]).gate.dualApproved).toBe(true);
  });
});

describe('M8-OPER3: a valid dual approval still carries the full maker chain', () => {
  it('creates, CEO-approves, proves the send, accepts and reaches FILM_IN_PRODUCTION', async () => {
    const chain = await reachMakerPoReady(`E2E-${nextTag()}`);

    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;
    expect((created.body as { status: string }).status).toBe('DRAFT');

    const approved = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {});
    expect(approved.status).toBe(200);
    expect((approved.body as { purchaseOrder: { status: string } }).purchaseOrder.status)
      .toBe('APPROVED_FOR_MANUAL_SEND');

    // The proven send: a send_evidence document version is cited, so the send
    // is registered VERIFIED and the PO leaves the company for real.
    const sendEvidence = await uploadDocument({
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId
    });
    const sent = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: sendEvidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-15T10:00:00.000Z'
    });
    expect(sent.status).toBe(200);
    expect((sent.body as { status: string; verificationStatus: string }).status).toBe('MAKER_PO_SENT_MANUALLY');
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');

    const acceptanceEvidence = await uploadDocument({
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId
    });
    expect((await postAs(staffToken, `/api/documents/${acceptanceEvidence.document.id}/verify`, {
      verificationStatus: 'verified'
    })).status).toBe(200);
    const accepted = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: acceptanceEvidence.version.id,
      acceptedAt: '2026-11-15T12:00:00.000Z'
    });
    expect(accepted.status).toBe(200);
    expect((accepted.body as { purchaseOrder: { status: string } }).purchaseOrder.status).toBe('MAKER_PO_ACCEPTED');

    const production = await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, {
      to: 'FILM_IN_PRODUCTION'
    });
    expect(production.status).toBe(200);
    const [orderRow] = await db.select().from(filmSupplyOrders)
      .where(eq(filmSupplyOrders.id, chain.orderId)).limit(1);
    expect(orderRow?.status).toBe('FILM_IN_PRODUCTION');

    // All four boundary acts passed the live re-check on the open gate.
    const rows = await recheckRows([chain.orderId, poId]);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => [recheckState(row).stage, recheckState(row).result]).sort())
      .toEqual([
        ['maker_po:accept_evidence', 'passed'],
        ['maker_po:ceo_approve', 'passed'],
        ['maker_po:create', 'passed'],
        ['maker_po:send_evidence', 'passed']
      ]);
    for (const row of rows) {
      expect(recheckState(row).reason).toBe('gate_open');
      expect(recheckState(row).gate.dualApproved).toBe(true);
    }

    // The maker paper lifecycle is exactly the three events, no refusals.
    const poEventRows = await db.select().from(makerPoEvents)
      .where(eq(makerPoEvents.makerPurchaseOrderId, poId));
    expect(poEventRows.map((event) => event.eventType).sort()).toEqual([
      'ACCEPT_EVIDENCE_REGISTERED',
      'CEO_APPROVED',
      'SEND_EVIDENCE_REGISTERED'
    ]);
    expect(poEventRows.find((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED')?.verificationStatus)
      .toBe('VERIFIED');
  });
});

describe('M8-OPER3: paper whose send is already proven is never retroactively blocked', () => {
  it('accepts and reaches production after a withdrawal that followed the VERIFIED send', async () => {
    const chain = await reachMakerPoReady(`SHIPPED-${nextTag()}`);

    const created = await createMakerPo(chain.orderId);
    expect(created.status).toBe(201);
    const poId = (created.body as { id: string }).id;
    expect((await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {})).status).toBe(200);

    const sendEvidence = await uploadDocument({
      documentType: 'send_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId
    });
    const sent = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {
      evidenceDocumentVersionId: sendEvidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'],
      sentAt: '2026-11-15T13:00:00.000Z'
    });
    expect(sent.status).toBe(200);
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');

    // The withdrawal lands after the paper has left the company.
    expect((await revokeApproval({ chain, organization: 'customer' })).dualApproved).toBe(false);

    // The acceptance is answered normally: un-shipping is not a thing the gate
    // can do, so the re-check records instead of refusing.
    const acceptanceEvidence = await uploadDocument({
      documentType: 'acceptance_evidence',
      issuerEntity: 'kanei',
      orderId: chain.orderId,
      poId: chain.poId
    });
    expect((await postAs(staffToken, `/api/documents/${acceptanceEvidence.document.id}/verify`, {
      verificationStatus: 'verified'
    })).status).toBe(200);
    const accepted = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/accept-evidence`, {
      evidenceDocumentVersionId: acceptanceEvidence.version.id,
      acceptedAt: '2026-11-15T14:00:00.000Z'
    });
    expect(accepted.status).toBe(200);
    expect((accepted.body as { purchaseOrder: { status: string } }).purchaseOrder.status).toBe('MAKER_PO_ACCEPTED');

    const production = await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, {
      to: 'FILM_IN_PRODUCTION'
    });
    expect(production.status).toBe(200);

    const rows = await recheckRows([chain.orderId, poId]);
    const byStage = new Map(rows.map((row) => [recheckState(row).stage, recheckState(row)]));
    expect(byStage.get('maker_po:create')?.result).toBe('passed');
    expect(byStage.get('maker_po:ceo_approve')?.result).toBe('passed');
    expect(byStage.get('maker_po:send_evidence')?.result).toBe('passed');
    const acceptRecheck = byStage.get('maker_po:accept_evidence');
    expect(acceptRecheck?.result).toBe('passed');
    expect(acceptRecheck?.reason).toBe('gate_closed_after_proven_send_recorded_not_enforced');
    expect(acceptRecheck?.provenSendExists).toBe(true);
    expect(acceptRecheck?.gate.dualApproved).toBe(false);
  });
});
