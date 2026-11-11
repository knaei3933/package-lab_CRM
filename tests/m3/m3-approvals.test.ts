import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  artworkApprovalEvents,
  artworkRevisions,
  auditEvents,
  createDatabase,
  documents,
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
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const customerAccountIdB = uuidv7();
const sevenAccountIdB = uuidv7();
const makerAccountIdB = uuidv7();
const projectIdA = uuidv7();
const projectIdB = uuidv7();

let staffToken = '';
let app: ReturnType<typeof createApp>;

let uniqueCounter = 0;
function uniqueTag(): string {
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

async function postJson(url: string, body: unknown) {
  const response = await app.request(url, jsonPost(staffToken, body));
  return { status: response.status, body: await response.json() };
}

async function getJson(url: string) {
  const response = await app.request(url, { method: 'GET', headers: cookieHeader(staffToken) });
  return { status: response.status, body: await response.json() };
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
    poNumber: `SEVEN-M3-${tag}`,
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

interface SupplyOrder {
  poId: string;
  orderId: string;
}

/** A supply order whose purchase order is verified and whose state sits in the approval chain. */
async function createApprovalReadyOrder(projectId: string, tag: string): Promise<SupplyOrder> {
  const po = await setupVerifiedPo(projectId, tag);
  const created = await postJson(`/api/seven-purchase-orders/${po.id}/supply-orders`, { code: `FSO-M3-${tag}` });
  expect(created.status).toBe(201);
  const order = created.body as { id: string };
  for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
    const transition = await postJson(`/api/film-supply-orders/${order.id}/transitions`, { to });
    expect(transition.status).toBe(200);
  }
  return { poId: po.id, orderId: order.id };
}

async function uploadBoundDocument(projectId: string, overrides: Record<string, unknown> = {}) {
  const tag = uniqueTag();
  const body = {
    documentType: 'proof',
    issuerEntity: 'kanei',
    filename: `m3-doc-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: toBase64(`composite m3 document bytes ${tag}\n`),
    ...overrides
  };
  const response = await postJson(`/api/projects/${projectId}/documents`, body);
  expect(response.status).toBe(201);
  return response.body as { document: { id: string }; version: { id: string; sha256: string } };
}

/** Registers the current revision of one design from a freshly uploaded proof. */
async function registerDesignRevision(order: SupplyOrder, projectId: string, designKey: string) {
  const proof = await uploadBoundDocument(projectId, {
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
    revision: registered.body as {
      id: string;
      designKey: string;
      revisionNo: number;
      status: string;
      invalidatedApprovals: boolean;
    }
  };
}

async function uploadApprovalEvidence(order: SupplyOrder, projectId: string, designKey: string, issuer: string) {
  return await uploadBoundDocument(projectId, {
    documentType: 'approval_evidence',
    issuerEntity: issuer,
    sevenPurchaseOrderId: order.poId,
    filmSupplyOrderId: order.orderId,
    designKey
  });
}

function approvalBody(overrides: Record<string, unknown> = {}) {
  return {
    organization: 'customer',
    decision: 'APPROVE',
    evidenceSource: 'email',
    eventTime: '2026-11-10T10:00:00.000Z',
    externalApproverName: '合成承認者',
    externalApproverOrg: '合成エンドカスタマー',
    ...overrides
  };
}

async function recordApproval(revisionId: string, overrides: Record<string, unknown> = {}) {
  return await postJson(`/api/artwork-revisions/${revisionId}/approvals`, approvalBody(overrides));
}

async function getGate(orderId: string) {
  return await getJson(`/api/film-supply-orders/${orderId}/approval-gate`);
}

/** Full approval flow for one design, in the given organization order. */
async function reachDualApproval(
  order: SupplyOrder,
  projectId: string,
  designKey: string,
  first: 'customer' | 'seven',
  second: 'customer' | 'seven'
) {
  const registered = await registerDesignRevision(order, projectId, designKey);
  const firstEvidence = await uploadApprovalEvidence(
    order,
    projectId,
    designKey,
    first === 'customer' ? 'customer_generated' : 'seven'
  );
  const firstApproval = await recordApproval(registered.revision.id, {
    organization: first,
    evidenceDocumentVersionId: firstEvidence.version.id
  });
  expect(firstApproval.status).toBe(201);

  const secondEvidence = await uploadApprovalEvidence(
    order,
    projectId,
    designKey,
    second === 'customer' ? 'customer_generated' : 'seven'
  );
  const secondApproval = await recordApproval(registered.revision.id, {
    organization: second,
    evidenceDocumentVersionId: secondEvidence.version.id
  });
  expect(secondApproval.status).toBe(201);

  return { registered, firstApproval: firstApproval.body, secondApproval: secondApproval.body };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-m3-approvals-'));
  app = createApp({ db });

  await db.execute(sql`
    truncate table audit_events, artwork_revisions, artwork_approval_events, documents, document_versions,
      pre_order_references, seven_purchase_orders, film_supply_orders, film_supply_order_lines,
      film_deliveries, filling_orders, filling_order_lines, filling_deliveries, commission_readiness,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  const now = new Date();
  await db.insert(users).values([
    { id: adminId, username: 'admin_m3_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者M3', role: 'admin' },
    { id: staffId, username: 'staff_m3_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者M3', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成M3エンドカスタマーA', role: 'end_customer', externalCode: 'TEST-M3-CUST-A' },
    { id: sevenAccountId, name: '合成M3セブンA', role: 'seven', externalCode: 'TEST-M3-SEVEN-A' },
    { id: makerAccountId, name: '合成M3メーカーA', role: 'maker', externalCode: 'TEST-M3-MAKER-A' },
    { id: customerAccountIdB, name: '合成M3エンドカスタマーB', role: 'end_customer', externalCode: 'TEST-M3-CUST-B' },
    { id: sevenAccountIdB, name: '合成M3セブンB', role: 'seven', externalCode: 'TEST-M3-SEVEN-B' },
    { id: makerAccountIdB, name: '合成M3メーカーB', role: 'maker', externalCode: 'TEST-M3-MAKER-B' }
  ]);
  await db.insert(projects).values([
    {
      id: projectIdA,
      code: 'TEST-M3-PROJECT-A',
      name: '合成M3案件A',
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
      id: projectIdB,
      code: 'TEST-M3-PROJECT-B',
      name: '合成M3案件B',
      businessUnit: 'F1' as const,
      route: 'F1' as const,
      leadSource: 'KANEI',
      status: 'DRAFT' as const,
      endCustomerAccountId: customerAccountIdB,
      sevenAccountId: sevenAccountIdB,
      makerAccountId: makerAccountIdB,
      createdByUserId: adminId,
      createdAt: now,
      updatedAt: now
    }
  ]);
  await db.insert(projectAssignments).values([
    { id: uuidv7(now), userId: staffId, projectId: projectIdA },
    { id: uuidv7(now), userId: staffId, projectId: projectIdB }
  ]);
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
});

afterAll(async () => {
  await pool.end();
});

describe('M3 proof revisions and dual approval', () => {
  it('T-09 reaches DUAL_APPROVED when customer approves first and seven second', async () => {
    const order = await createApprovalReadyOrder(projectIdA, 'T09');
    const flow = await reachDualApproval(order, projectIdA, 'label-front', 'customer', 'seven');

    expect(flow.firstApproval.dualApproved).toBe(false);
    expect(flow.firstApproval.orderStatus).toBe('APPROVAL_PENDING');
    expect(flow.secondApproval.dualApproved).toBe(true);
    expect(flow.secondApproval.orderStatus).toBe('DUAL_APPROVED');

    const gate = await getGate(order.orderId);
    expect(gate.status).toBe(200);
    expect(gate.body.dualApproved).toBe(true);
    expect(gate.body.orderStatus).toBe('DUAL_APPROVED');
    expect(gate.body.missingApprovals).toEqual([]);
    expect(gate.body.designs[0].currentRevisionNo).toBe(1);
    expect(gate.body.designs[0].customer.valid).toBe(true);
    expect(gate.body.designs[0].seven.valid).toBe(true);

    // The recorded_by user is the internal recorder; the external approver is
    // only ever recorded as text.
    const [event] = await db.select().from(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.id, flow.secondApproval.approvalEvent.id)).limit(1);
    expect(event?.recordedByUserId).toBe(staffId);
    expect(event?.externalApproverName).toBe('合成承認者');
    expect(event?.approvedFileSha256).toBe(flow.registered.fileSha256);
    expect(event?.supersedesEventId).toBeNull();

    const [audit] = await db.select().from(auditEvents)
      .where(and(
        eq(auditEvents.entityType, 'artwork_approval_event'),
        eq(auditEvents.entityId, flow.secondApproval.approvalEvent.id)
      )).limit(1);
    expect(audit?.action).toBe('ARTWORK_APPROVAL_RECORDED');
    expect(audit?.actorUserId).toBe(staffId);
  });

  it('T-10 reaches DUAL_APPROVED equally when seven approves first and customer second', async () => {
    const order = await createApprovalReadyOrder(projectIdA, 'T10');
    const flow = await reachDualApproval(order, projectIdA, 'label-front', 'seven', 'customer');

    expect(flow.firstApproval.dualApproved).toBe(false);
    expect(flow.secondApproval.dualApproved).toBe(true);

    const gate = await getGate(order.orderId);
    expect(gate.body.dualApproved).toBe(true);
    expect(gate.body.orderStatus).toBe('DUAL_APPROVED');

    const [orderRow] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.orderId)).limit(1);
    expect(orderRow?.status).toBe('DUAL_APPROVED');
  });

  it('T-07 and T-08 keep the gate closed while only one organization approved', async () => {
    const customerOnly = await createApprovalReadyOrder(projectIdA, 'T07');
    const registered = await registerDesignRevision(customerOnly, projectIdA, 'label-front');
    const evidence = await uploadApprovalEvidence(customerOnly, projectIdA, 'label-front', 'customer_generated');
    const approval = await recordApproval(registered.revision.id, { evidenceDocumentVersionId: evidence.version.id });
    expect(approval.status).toBe(201);
    expect(approval.body.dualApproved).toBe(false);
    expect(approval.body.orderStatus).toBe('APPROVAL_PENDING');

    const gate = await getGate(customerOnly.orderId);
    expect(gate.body.dualApproved).toBe(false);
    expect(gate.body.designs[0].customer.valid).toBe(true);
    expect(gate.body.designs[0].seven.valid).toBe(false);
    expect(gate.body.missingApprovals).toEqual([{ designKey: 'label-front', organization: 'seven' }]);

    const sevenOnly = await createApprovalReadyOrder(projectIdA, 'T08');
    const sevenRegistered = await registerDesignRevision(sevenOnly, projectIdA, 'label-front');
    const sevenEvidence = await uploadApprovalEvidence(sevenOnly, projectIdA, 'label-front', 'seven');
    const sevenApproval = await recordApproval(sevenRegistered.revision.id, {
      organization: 'seven',
      evidenceDocumentVersionId: sevenEvidence.version.id
    });
    expect(sevenApproval.status).toBe(201);
    expect(sevenApproval.body.dualApproved).toBe(false);

    const sevenGate = await getGate(sevenOnly.orderId);
    expect(sevenGate.body.dualApproved).toBe(false);
    expect(sevenGate.body.designs[0].customer.valid).toBe(false);
    expect(sevenGate.body.designs[0].seven.valid).toBe(true);
    expect(sevenGate.body.missingApprovals).toEqual([{ designKey: 'label-front', organization: 'customer' }]);
  });

  it('T-11 a new revision forces re-approval and records CHANGE_REVIEW, keeping prior events', async () => {
    const order = await createApprovalReadyOrder(projectIdA, 'T11');
    const flow = await reachDualApproval(order, projectIdA, 'label-front', 'customer', 'seven');
    expect(flow.secondApproval.dualApproved).toBe(true);

    const secondProof = await uploadBoundDocument(projectIdA, {
      documentType: 'proof',
      issuerEntity: 'kanei',
      sevenPurchaseOrderId: order.poId,
      filmSupplyOrderId: order.orderId,
      designKey: 'label-front'
    });
    const second = await postJson(`/api/film-supply-orders/${order.orderId}/artwork-revisions`, {
      designKey: 'label-front',
      fileDocumentVersionId: secondProof.version.id,
      lotMarking: 'LOT-M3-0002'
    });
    expect(second.status).toBe(201);
    expect(second.body.revisionNo).toBe(2);
    expect(second.body.invalidatedApprovals).toBe(true);
    expect(second.body.status).toBe('CHANGE_REVIEW');

    const [orderRow] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.orderId)).limit(1);
    expect(orderRow?.status).toBe('CHANGE_REVIEW');

    // The gate is bound to the new revision and is closed again.
    const gate = await getGate(order.orderId);
    expect(gate.body.dualApproved).toBe(false);
    expect(gate.body.designs[0].currentRevisionNo).toBe(2);
    expect(gate.body.designs[0].fileSha256).toBe(secondProof.version.sha256);
    expect(gate.body.designs[0].customer.valid).toBe(false);
    expect(gate.body.designs[0].seven.valid).toBe(false);

    // Prior approvals remain readable as audit history of the old revision.
    const history = await db.select({ eventId: artworkApprovalEvents.id, revisionNo: artworkRevisions.revisionNo })
      .from(artworkApprovalEvents)
      .innerJoin(artworkRevisions, eq(artworkRevisions.id, artworkApprovalEvents.artworkRevisionId))
      .where(and(
        eq(artworkRevisions.filmSupplyOrderId, order.orderId),
        eq(artworkRevisions.designKey, 'label-front')
      ));
    expect(history).toHaveLength(2);
    expect(history.every((row) => row.revisionNo === 1)).toBe(true);

    // Re-approval of the new revision re-opens the gate; the order stays in
    // change review until a person resolves it.
    const customerEvidence = await uploadApprovalEvidence(order, projectIdA, 'label-front', 'customer_generated');
    const customerApproval = await recordApproval(second.body.id, { evidenceDocumentVersionId: customerEvidence.version.id });
    expect(customerApproval.status).toBe(201);
    expect(customerApproval.body.dualApproved).toBe(false);
    const sevenEvidence = await uploadApprovalEvidence(order, projectIdA, 'label-front', 'seven');
    const sevenApproval = await recordApproval(second.body.id, {
      organization: 'seven',
      evidenceDocumentVersionId: sevenEvidence.version.id
    });
    expect(sevenApproval.status).toBe(201);
    expect(sevenApproval.body.dualApproved).toBe(true);
    expect(sevenApproval.body.orderStatus).toBe('CHANGE_REVIEW');

    // The re-approval supersedes nothing on this revision (it is its first).
    const [superseding] = await db.select().from(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.id, sevenApproval.body.approvalEvent.id)).limit(1);
    expect(superseding?.supersedesEventId).toBeNull();
  });

  it('T-12 rejects direct UPDATE and DELETE on approval events and revisions', async () => {
    const order = await createApprovalReadyOrder(projectIdA, 'T12');
    const registered = await registerDesignRevision(order, projectIdA, 'label-front');
    const evidence = await uploadApprovalEvidence(order, projectIdA, 'label-front', 'customer_generated');
    const approval = await recordApproval(registered.revision.id, { evidenceDocumentVersionId: evidence.version.id });
    expect(approval.status).toBe(201);
    const eventId = approval.body.approvalEvent.id as string;

    await expect(db.update(artworkApprovalEvents)
      .set({ decision: 'REVOKE' })
      .where(eq(artworkApprovalEvents.id, eventId)))
      .rejects.toThrow(/append-only/);
    await expect(db.delete(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.id, eventId)))
      .rejects.toThrow(/append-only/);

    // The recorded decision survived both attempts unchanged.
    const [event] = await db.select().from(artworkApprovalEvents).where(eq(artworkApprovalEvents.id, eventId)).limit(1);
    expect(event?.decision).toBe('APPROVE');

    const otherProof = await uploadBoundDocument(projectIdA, {
      documentType: 'proof',
      issuerEntity: 'kanei',
      sevenPurchaseOrderId: order.poId,
      filmSupplyOrderId: order.orderId,
      designKey: 'label-front'
    });
    await expect(db.update(artworkRevisions)
      .set({ fileDocumentVersionId: otherProof.version.id })
      .where(eq(artworkRevisions.id, registered.revision.id)))
      .rejects.toThrow(/append-only/);
    await expect(db.delete(artworkRevisions)
      .where(eq(artworkRevisions.id, registered.revision.id)))
      .rejects.toThrow(/append-only/);
    const [revision] = await db.select().from(artworkRevisions).where(eq(artworkRevisions.id, registered.revision.id)).limit(1);
    expect(revision?.fileDocumentVersionId).toBe(registered.proofVersionId);
  });

  it('T-13 a REVOKE invalidates only that organization, keeps past events, and closes the gate', async () => {
    const order = await createApprovalReadyOrder(projectIdA, 'T13');
    const flow = await reachDualApproval(order, projectIdA, 'label-front', 'customer', 'seven');
    expect(flow.secondApproval.dualApproved).toBe(true);

    const revokeEvidence = await uploadApprovalEvidence(order, projectIdA, 'label-front', 'customer_generated');
    const revoke = await recordApproval(flow.registered.revision.id, {
      decision: 'REVOKE',
      evidenceSource: 'signed_document',
      externalApproverName: '合成承認者（取消）',
      evidenceDocumentVersionId: revokeEvidence.version.id,
      eventTime: '2026-11-11T08:00:00.000Z'
    });
    expect(revoke.status).toBe(201);
    expect(revoke.body.dualApproved).toBe(false);
    // The status keeps its last approved position; the derived gate is what closes.
    expect(revoke.body.orderStatus).toBe('DUAL_APPROVED');

    const gate = await getGate(order.orderId);
    expect(gate.body.dualApproved).toBe(false);
    expect(gate.body.designs[0].customer.valid).toBe(false);
    expect(gate.body.designs[0].customer.revoked).toBe(true);
    expect(gate.body.designs[0].seven.valid).toBe(true);

    // Past events stay readable, including the revoked approval.
    const events = await db.select().from(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.artworkRevisionId, flow.registered.revision.id));
    expect(events).toHaveLength(3);
    expect(events.some((row) => row.id === flow.firstApproval.approvalEvent.id && row.decision === 'APPROVE')).toBe(true);
    expect(events.some((row) => row.decision === 'REVOKE' && row.organization === 'customer')).toBe(true);

    // The closed gate blocks the downstream maker ordering step.
    const transition = await postJson(`/api/film-supply-orders/${order.orderId}/transitions`, { to: 'MAKER_PO_READY' });
    expect(transition.status).toBe(422);
    expect(transition.body.code).toBe('DUAL_APPROVAL_REQUIRED');

    const sevenRevoke = await recordApproval(flow.registered.revision.id, {
      organization: 'seven',
      decision: 'REVOKE',
      evidenceDocumentVersionId: revokeEvidence.version.id,
      eventTime: '2026-11-11T09:00:00.000Z'
    });
    expect(sevenRevoke.status).toBe(201);
    expect(sevenRevoke.body.dualApproved).toBe(false);
    const closedGate = await getGate(order.orderId);
    expect(closedGate.body.missingApprovals).toEqual([
      { designKey: 'label-front', organization: 'customer' },
      { designKey: 'label-front', organization: 'seven' }
    ]);
  });

  it('T-35 rejects approval evidence referencing another order, design or company', async () => {
    const order = await createApprovalReadyOrder(projectIdA, 'T35A');
    const otherOrder = await createApprovalReadyOrder(projectIdA, 'T35B');
    const registered = await registerDesignRevision(order, projectIdA, 'label-front');

    const foreignCompanyPo = await setupVerifiedPo(projectIdB, 'T35-COMPANY');
    const foreignCompanyOrder = await (async () => {
      const created = await postJson(`/api/seven-purchase-orders/${foreignCompanyPo.id}/supply-orders`, { code: 'FSO-M3-T35-COMPANY' });
      expect(created.status).toBe(201);
      return created.body as { id: string };
    })();

    // Evidence of another order in the same project.
    const otherOrderEvidence = await uploadApprovalEvidence(otherOrder, projectIdA, 'label-front', 'customer_generated');
    const orderMismatch = await recordApproval(registered.revision.id, {
      evidenceDocumentVersionId: otherOrderEvidence.version.id
    });
    expect(orderMismatch.status).toBe(422);
    expect(orderMismatch.body.code).toBe('EVIDENCE_ORDER_MISMATCH');

    // Evidence of another design of the same order.
    const otherDesignEvidence = await uploadApprovalEvidence(order, projectIdA, 'label-back', 'customer_generated');
    const designMismatch = await recordApproval(registered.revision.id, {
      evidenceDocumentVersionId: otherDesignEvidence.version.id
    });
    expect(designMismatch.status).toBe(422);
    expect(designMismatch.body.code).toBe('EVIDENCE_DESIGN_MISMATCH');

    // Evidence of another company (another project with its own accounts).
    const foreignEvidence = await uploadApprovalEvidence(
      { poId: foreignCompanyPo.id, orderId: foreignCompanyOrder.id },
      projectIdB,
      'label-front',
      'customer_generated'
    );
    const companyMismatch = await recordApproval(registered.revision.id, {
      evidenceDocumentVersionId: foreignEvidence.version.id
    });
    expect(companyMismatch.status).toBe(422);
    expect(companyMismatch.body.code).toBe('EVIDENCE_PROJECT_MISMATCH');

    // A proof document is the artwork itself, never approval evidence.
    const proofAsEvidence = await uploadBoundDocument(projectIdA, {
      documentType: 'proof',
      issuerEntity: 'kanei',
      sevenPurchaseOrderId: order.poId,
      filmSupplyOrderId: order.orderId,
      designKey: 'label-front'
    });
    const typeMismatch = await recordApproval(registered.revision.id, {
      evidenceDocumentVersionId: proofAsEvidence.version.id
    });
    expect(typeMismatch.status).toBe(422);
    expect(typeMismatch.body.code).toBe('EVIDENCE_DOCUMENT_TYPE_INVALID');

    const missingEvidence = await recordApproval(registered.revision.id, { evidenceDocumentVersionId: undefined });
    expect(missingEvidence.status).toBe(422);
    expect(missingEvidence.body.code).toBe('EVIDENCE_DOCUMENT_VERSION_REQUIRED');

    const unknownEvidence = await recordApproval(registered.revision.id, {
      evidenceDocumentVersionId: '00000000-0000-7000-8000-000000000000'
    });
    expect(unknownEvidence.status).toBe(422);
    expect(unknownEvidence.body.code).toBe('EVIDENCE_DOCUMENT_VERSION_NOT_FOUND');

    // Nothing was persisted for this revision.
    const events = await db.select().from(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.artworkRevisionId, registered.revision.id));
    expect(events).toHaveLength(0);
  });

  it('T-34 keeps the order gate closed until every required design holds both approvals', async () => {
    const order = await createApprovalReadyOrder(projectIdA, 'T34');
    const front = await registerDesignRevision(order, projectIdA, 'label-front');
    const back = await registerDesignRevision(order, projectIdA, 'label-back');

    const frontCustomerEvidence = await uploadApprovalEvidence(order, projectIdA, 'label-front', 'customer_generated');
    const frontSevenEvidence = await uploadApprovalEvidence(order, projectIdA, 'label-front', 'seven');
    expect((await recordApproval(front.revision.id, { evidenceDocumentVersionId: frontCustomerEvidence.version.id })).status).toBe(201);
    const frontComplete = await recordApproval(front.revision.id, {
      organization: 'seven',
      evidenceDocumentVersionId: frontSevenEvidence.version.id
    });
    expect(frontComplete.status).toBe(201);
    // One design is fully approved, the other has nothing: the order stays closed.
    expect(frontComplete.body.dualApproved).toBe(false);
    expect(frontComplete.body.orderStatus).toBe('APPROVAL_PENDING');

    const backCustomerEvidence = await uploadApprovalEvidence(order, projectIdA, 'label-back', 'customer_generated');
    const backPartial = await recordApproval(back.revision.id, {
      evidenceDocumentVersionId: backCustomerEvidence.version.id
    });
    expect(backPartial.status).toBe(201);
    expect(backPartial.body.dualApproved).toBe(false);

    const midGate = await getGate(order.orderId);
    expect(midGate.body.dualApproved).toBe(false);
    expect(midGate.body.requiredDesignKeys).toEqual(['label-back', 'label-front']);
    expect(midGate.body.missingApprovals).toEqual([{ designKey: 'label-back', organization: 'seven' }]);

    const backSevenEvidence = await uploadApprovalEvidence(order, projectIdA, 'label-back', 'seven');
    const backComplete = await recordApproval(back.revision.id, {
      organization: 'seven',
      evidenceDocumentVersionId: backSevenEvidence.version.id
    });
    expect(backComplete.status).toBe(201);
    expect(backComplete.body.dualApproved).toBe(true);
    expect(backComplete.body.orderStatus).toBe('DUAL_APPROVED');

    const gate = await getGate(order.orderId);
    expect(gate.body.dualApproved).toBe(true);
    expect(gate.body.missingApprovals).toEqual([]);
  });

  it('rejects revision registration before SEVEN_PO_VERIFIED and persists nothing', async () => {
    const po = await setupVerifiedPo(projectIdA, 'T35-GATE');
    const created = await postJson(`/api/seven-purchase-orders/${po.id}/supply-orders`, { code: 'FSO-M3-GATE' });
    expect(created.status).toBe(201);
    const draftOrder = created.body as { id: string };

    const proof = await uploadBoundDocument(projectIdA, {
      documentType: 'proof',
      issuerEntity: 'kanei',
      sevenPurchaseOrderId: po.id,
      filmSupplyOrderId: draftOrder.id,
      designKey: 'label-front'
    });

    const gated = await postJson(`/api/film-supply-orders/${draftOrder.id}/artwork-revisions`, {
      designKey: 'label-front',
      fileDocumentVersionId: proof.version.id
    });
    expect(gated.status).toBe(422);
    expect(gated.body.code).toBe('ORDER_NOT_PAST_SEVEN_PO_VERIFIED');

    const stored = await db.select().from(artworkRevisions)
      .where(eq(artworkRevisions.filmSupplyOrderId, draftOrder.id));
    expect(stored).toHaveLength(0);
  });

  it('numbers revisions per design and rejects reusing a revision number', async () => {
    const order = await createApprovalReadyOrder(projectIdA, 'REVNO');
    const front = await registerDesignRevision(order, projectIdA, 'label-front');
    expect(front.revision.revisionNo).toBe(1);
    const back = await registerDesignRevision(order, projectIdA, 'label-back');
    expect(back.revision.revisionNo).toBe(1);

    const secondFront = await registerDesignRevision(order, projectIdA, 'label-front');
    expect(secondFront.revision.revisionNo).toBe(2);

    const missingDesign = await postJson(`/api/film-supply-orders/${order.orderId}/artwork-revisions`, {
      fileDocumentVersionId: front.proofVersionId
    });
    expect(missingDesign.status).toBe(422);
    expect(missingDesign.body.code).toBe('DESIGN_KEY_REQUIRED');

    const explicitClash = await postJson(`/api/film-supply-orders/${order.orderId}/artwork-revisions`, {
      designKey: 'label-front',
      fileDocumentVersionId: front.proofVersionId,
      revisionNo: 1
    });
    expect(explicitClash.status).toBe(422);
    expect(explicitClash.body.code).toBe('REVISION_NUMBER_EXISTS');
  });

  it('writes the audit row in the same transaction as every M3 write', async () => {
    const order = await createApprovalReadyOrder(projectIdA, 'AUDIT');
    const registered = await registerDesignRevision(order, projectIdA, 'label-front');
    const evidence = await uploadApprovalEvidence(order, projectIdA, 'label-front', 'customer_generated');
    const approval = await recordApproval(registered.revision.id, { evidenceDocumentVersionId: evidence.version.id });
    expect(approval.status).toBe(201);

    const [revisionAudit] = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.entityType, 'artwork_revision'), eq(auditEvents.entityId, registered.revision.id))).limit(1);
    expect(revisionAudit?.action).toBe('ARTWORK_REVISION_REGISTERED');
    expect(revisionAudit?.actorUserId).toBe(staffId);

    const events = await db.select().from(artworkApprovalEvents)
      .where(eq(artworkApprovalEvents.artworkRevisionId, registered.revision.id));
    expect(events).toHaveLength(1);
    const [eventAudit] = await db.select().from(auditEvents)
      .where(and(
        eq(auditEvents.entityType, 'artwork_approval_event'),
        eq(auditEvents.entityId, events[0]!.id)
      )).limit(1);
    expect(eventAudit?.action).toBe('ARTWORK_APPROVAL_RECORDED');

    // Documents uploaded outside the artwork flow keep a null binding, and an
    // evidence document carries the binding its approval is checked against.
    const unbound = await uploadBoundDocument(projectIdA, {
      documentType: 'film_quote_kanei',
      issuerEntity: 'kanei'
    });
    const [unboundRow] = await db.select({
      filmSupplyOrderId: documents.filmSupplyOrderId,
      designKey: documents.designKey
    }).from(documents).where(eq(documents.id, unbound.document.id)).limit(1);
    expect(unboundRow?.filmSupplyOrderId).toBeNull();
    expect(unboundRow?.designKey).toBeNull();

    const [evidenceRow] = await db.select({
      filmSupplyOrderId: documents.filmSupplyOrderId,
      designKey: documents.designKey
    }).from(documents).where(eq(documents.id, evidence.version.id)).limit(1);
    expect(evidenceRow?.filmSupplyOrderId).toBe(order.orderId);
    expect(evidenceRow?.designKey).toBe('label-front');
  });
});
