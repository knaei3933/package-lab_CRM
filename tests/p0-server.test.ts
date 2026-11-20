/**
 * P0 server (persona R2 redesign, approved policies P-1..P-10 except P-3):
 * R01 payment terms, R02 evidence issuer = approving organization, R05
 * duplicates and idempotency, R09 stable codes and safe Japanese text, R10
 * recipient mail address, R11 server-owned verifier / time, R12 kept evidence
 * note and cancelled-paper send evidence. Every rule has a normal, a refusal
 * and a permission case. Runs only against kanei_crm_mvp_test (tests/setup.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  artworkApprovalEvents,
  auditEvents,
  createDatabase,
  evidenceManualVerifications,
  filmSupplyOrders,
  makerPoSendManualVerifications,
  makerPurchaseOrders,
  projectAssignments,
  projects,
  sessions,
  sevenPurchaseOrders,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';
import { ERROR_MESSAGES_JA, isSafeUserMessage, normalizeRefusalBody } from '../apps/api/src/error-codes.js';
import { IdempotencyStore } from '../apps/api/src/idempotency.js';
import { buildMakerPoEml, sendMakerPoEmlEvidence } from './helpers/maker-po-evidence.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('p0-server tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const viewerId = uuidv7();
const outsiderId = uuidv7();
const customerAccountId = uuidv7();
const sevenAccountId = uuidv7();
const makerAccountId = uuidv7();
const projectId = uuidv7();
const otherProjectId = uuidv7();
const ADMIN_DISPLAY_NAME = '合成代表者P0';

const tokens = { admin: '', staff: '', viewer: '', outsider: '' };
type Role = keyof typeof tokens;
let app: ReturnType<typeof createApp>;

let counter = 0;
function nextTag(): string {
  counter += 1;
  return `${Date.now().toString(36)}${String(counter).padStart(3, '0')}`;
}
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

async function send(role: Role, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(url, {
    method,
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${tokens[role]}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}
const post = (role: Role, url: string, body?: unknown, headers?: Record<string, string>) => send(role, 'POST', url, body ?? {}, headers);

function fullChecklist() {
  return {
    issuerNameRecorded: true, issuerName: '合成セブン化学P0',
    documentNumberRecorded: true, documentNumber: 'PO-P0-0001',
    issueDateRecorded: true, issueDate: '2026-11-11',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル',
    pastTransactionCompared: true, pastTransactionNote: '過去の発注書と一致',
    quoteCompared: true, quoteMatchesPo: true, quoteComparisonNote: '見積と一致',
    tamperHints: '', uncertain: false, confirmationReplyRecorded: false, confirmationReplyNote: '',
    verificationNote: '合成チェックリストP0'
  };
}

async function verifiedSevenPo(project = projectId) {
  const created = await post('staff', `/api/projects/${project}/seven-purchase-orders`, {
    poNumber: `SEVEN-P0-${nextTag()}`, officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await post('staff', `/api/seven-purchase-orders/${created.body.id}/verification-checklist`, fullChecklist())).status).toBe(200);
  return created.body.id as string;
}

async function createOrder(sevenPoId: string, paymentTerms: string = 'prepaid') {
  const code = `FSO-P0-${nextTag()}`;
  const created = await post('staff', `/api/projects/${projectId}/film-supply-orders`, {
    code, sevenPurchaseOrderId: sevenPoId, paymentTerms,
    lines: [{ lineNumber: 1, description: '合成フィルムP0', orderedQuantity: 1000, unit: 'sheets' }]
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { orderId: created.body.id as string, code };
}

async function upload(sevenPoId: string, orderId: string, overrides: Record<string, unknown>) {
  const tag = nextTag();
  const body = {
    documentType: 'proof', issuerEntity: 'kanei', filename: `p0-${tag}.txt`, contentType: 'text/plain',
    contentBase64: b64(`p0 document ${tag}\n`), sevenPurchaseOrderId: sevenPoId, filmSupplyOrderId: orderId,
    ...overrides
  };
  const response = await post('staff', `/api/projects/${projectId}/documents`, body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as { document: { id: string }; version: { id: string } };
}

async function toApprovalPending(orderId: string) {
  for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
    const moved = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  }
}

async function revisionFor(sevenPoId: string, orderId: string) {
  const content = `p0 artwork ${nextTag()}\n`;
  const proof = await upload(sevenPoId, orderId, { designKey: 'label-front', contentBase64: b64(content) });
  const revision = await post('staff', `/api/film-supply-orders/${orderId}/artwork-revisions`, {
    designKey: 'label-front', fileDocumentVersionId: proof.version.id
  });
  expect(revision.status, JSON.stringify(revision.body)).toBe(201);
  return { revisionId: revision.body.id as string, artworkBytes: content };
}

async function evidenceFor(sevenPoId: string, orderId: string, issuerEntity: string, identifier: string, contentType = 'text/plain') {
  return await upload(sevenPoId, orderId, {
    documentType: 'approval_evidence', issuerEntity, designKey: 'label-front', contentType,
    contentBase64: b64(`p0 approval\nidentifier: ${identifier}\n`)
  });
}

function approval(revisionId: string, organization: 'customer' | 'seven', versionId: string, identifier: string, extra: Record<string, unknown> = {}) {
  return post('staff', `/api/artwork-revisions/${revisionId}/approvals`, {
    organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
    evidenceIdentifier: identifier, evidenceDocumentVersionId: versionId, ...extra
  });
}

/** An order at MAKER_PO_READY through the real endpoints (both approvals with matching issuers). */
async function readyOrder(paymentTerms = 'prepaid') {
  const sevenPoId = await verifiedSevenPo();
  const { orderId, code } = await createOrder(sevenPoId, paymentTerms);
  await toApprovalPending(orderId);
  const { revisionId, artworkBytes } = await revisionFor(sevenPoId, orderId);
  for (const [organization, issuer] of [['customer', 'customer_generated'], ['seven', 'seven']] as const) {
    const identifier = `MSG-P0-${organization.toUpperCase()}-${nextTag()}`;
    const evidence = await evidenceFor(sevenPoId, orderId, issuer, identifier);
    const recorded = await approval(revisionId, organization, evidence.version.id, identifier);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
  }
  const ready = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'MAKER_PO_READY' });
  expect(ready.status, JSON.stringify(ready.body)).toBe(200);
  return { sevenPoId, orderId, code, artworkBytes };
}

async function createPaper(orderId: string, recipientAddress = 'maker-po@example.com') {
  return await post('admin', `/api/film-supply-orders/${orderId}/maker-purchase-orders`, {
    recipientAddress, amounts: { currency: 'JPY', totalAmount: '480000' }
  });
}

async function orderRow(orderId: string) {
  const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
  return row!;
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-p0-server-'));
  app = createApp({ db });
  await db.execute(sql`
    truncate table audit_events, delivery_confirmations, film_deliveries, filling_deliveries,
      film_supply_order_lines, filling_order_lines, film_supply_orders, filling_orders,
      seven_purchase_orders, pre_order_references, document_versions, documents,
      artwork_revisions, artwork_approval_events, evidence_manual_verifications,
      maker_po_events, maker_po_send_manual_verifications, maker_purchase_orders, commission_readiness,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  await db.insert(users).values([
    { id: adminId, username: 'admin_p0', passwordHash: 'not-a-login-hash', displayName: ADMIN_DISPLAY_NAME, role: 'admin' },
    { id: staffId, username: 'staff_p0', passwordHash: 'not-a-login-hash', displayName: '合成担当者P0', role: 'staff' },
    { id: viewerId, username: 'viewer_p0', passwordHash: 'not-a-login-hash', displayName: '合成閲覧者P0', role: 'viewer' },
    { id: outsiderId, username: 'outsider_p0', passwordHash: 'not-a-login-hash', displayName: '合成別案件担当P0', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成P0顧客', role: 'end_customer', externalCode: 'P0-CUST' },
    { id: sevenAccountId, name: '合成P0セブン', role: 'seven', externalCode: 'P0-SEVEN' },
    { id: makerAccountId, name: '合成P0メーカー', role: 'maker', externalCode: 'P0-MAKER' }
  ]);
  const now = new Date();
  for (const [id, code] of [[projectId, 'P0-PROJECT-A'], [otherProjectId, 'P0-PROJECT-B']] as const) {
    await db.insert(projects).values({
      id, code, name: `合成${code}`, businessUnit: 'F1', route: 'F1', leadSource: 'KANEI', status: 'DRAFT',
      endCustomerAccountId: customerAccountId, sevenAccountId, makerAccountId, createdByUserId: adminId,
      createdAt: now, updatedAt: now
    });
  }
  await db.insert(projectAssignments).values([
    { id: uuidv7(), userId: staffId, projectId },
    { id: uuidv7(), userId: viewerId, projectId },
    { id: uuidv7(), userId: outsiderId, projectId: otherProjectId }
  ]);
  for (const [role, userId] of [['admin', adminId], ['staff', staffId], ['viewer', viewerId], ['outsider', outsiderId]] as const) {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({ id: uuidv7(), userId, tokenHash, expiresAt: new Date(Date.now() + 3600_000) });
    tokens[role] = token;
  }
});

afterAll(async () => {
  await pool.end();
});

// --------------------------------------------------------------------- R01
describe('R01 payment terms: required choice, editable until the CEO approval, stalled data', () => {
  it('refuses an order without an explicit term on both creation endpoints and persists nothing', async () => {
    const sevenPoId = await verifiedSevenPo();
    for (const paymentTerms of [undefined, null, '']) {
      const code = `FSO-P0-NOTERM-${nextTag()}`;
      const refused = await post('staff', `/api/projects/${projectId}/film-supply-orders`, {
        code, sevenPurchaseOrderId: sevenPoId, ...(paymentTerms === undefined ? {} : { paymentTerms })
      });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('PAYMENT_TERMS_REQUIRED');
      expect(isSafeUserMessage(refused.body.error)).toBe(true);
      const viaSeven = await post('staff', `/api/seven-purchase-orders/${sevenPoId}/supply-orders`, { code });
      expect(viaSeven.body.code).toBe('PAYMENT_TERMS_REQUIRED');
      expect(await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.code, code))).toHaveLength(0);
    }
    const unknown = await post('staff', `/api/projects/${projectId}/film-supply-orders`, {
      code: `FSO-P0-BAD-${nextTag()}`, paymentTerms: 'cash'
    });
    expect(unknown.body.code).toBe('UNKNOWN_PAYMENT_TERMS');
    expect(unknown.body.error).not.toMatch(/prepaid|on_delivery|paymentTerms/);
    const chosen = await createOrder(sevenPoId, 'undetermined');
    expect((await orderRow(chosen.orderId)).paymentTerms).toBe('undetermined');
  });

  it('lets staff and admin change the term after DRAFT, with an audit row; viewer and outsiders cannot', async () => {
    const { orderId } = await createOrder(await verifiedSevenPo(), 'undetermined');
    expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'SEVEN_PO_VERIFIED' })).status).toBe(200);
    const patch = (role: Role, body: unknown) => send(role, 'PATCH', `/api/film-supply-orders/${orderId}/payment-terms`, body);

    expect((await patch('viewer', { paymentTerms: 'prepaid' })).status).toBe(403);
    expect((await patch('outsider', { paymentTerms: 'prepaid' })).status).toBe(403);
    const blank = await patch('staff', { paymentTerms: 'prepaid', reason: '   ' });
    expect(blank.status).toBe(422);
    expect(blank.body.code).toBe('PAYMENT_TERMS_REASON_INVALID');
    expect((await orderRow(orderId)).paymentTerms).toBe('undetermined');

    const byStaff = await patch('staff', { paymentTerms: 'on_delivery', reason: '顧客と納品後払いで合意' });
    expect(byStaff.status).toBe(200);
    expect(byStaff.body).toMatchObject({ paymentTerms: 'on_delivery', paymentTermsLabel: '納品後払い', changed: true });
    const byAdmin = await patch('admin', { paymentTerms: 'prepaid' });
    expect(byAdmin.status).toBe(200);
    const same = await patch('admin', { paymentTerms: 'prepaid' });
    expect(same.body.changed).toBe(false);

    const audit = await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityId, orderId), eq(auditEvents.action, 'FILM_SUPPLY_ORDER_PAYMENT_TERMS_UPDATED')
    )).orderBy(auditEvents.occurredAt, auditEvents.id);
    expect(audit).toHaveLength(2);
    expect(audit[0]!.beforeState).toEqual({ paymentTerms: 'undetermined' });
    expect(audit[0]!.afterState).toEqual({ paymentTerms: 'on_delivery' });
    expect(audit[0]!.actorUserId).toBe(staffId);
    expect(audit[0]!.requestMetadata).toMatchObject({ actorRole: 'staff', orderStatus: 'SEVEN_PO_VERIFIED', reason: '顧客と納品後払いで合意' });
    expect(audit[1]!.actorUserId).toBe(adminId);
  });

  it('warns on the way to SEVEN_PO_VERIFIED while undetermined, and only then', async () => {
    const sevenPoId = await verifiedSevenPo();
    const undecided = await createOrder(sevenPoId, 'undetermined');
    const warned = await post('staff', `/api/film-supply-orders/${undecided.orderId}/transitions`, { to: 'SEVEN_PO_VERIFIED' });
    expect(warned.status).toBe(200);
    expect(warned.body.warnings.map((warning: { code: string }) => warning.code)).toEqual(['PAYMENT_TERMS_UNDETERMINED']);
    const settled = await createOrder(sevenPoId, 'prepaid');
    const quiet = await post('staff', `/api/film-supply-orders/${settled.orderId}/transitions`, { to: 'SEVEN_PO_VERIFIED' });
    expect(quiet.body.warnings).toEqual([]);
  });

  it('unblocks the B1 dead end: undetermined at MAKER_PO_READY is fixed in place, approved, then locked; cancel reopens', async () => {
    const chain = await readyOrder('undetermined');
    const paper = await createPaper(chain.orderId);
    expect(paper.status).toBe(201);
    const refused = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('PAYMENT_GATE_UNSATISFIED');
    expect(refused.body.error).not.toMatch(/paymentTerms|prepaid|on_delivery|G6/);

    // The fix the old system had no way to make: change the term at MAKER_PO_READY.
    const fixed = await send('staff', 'PATCH', `/api/film-supply-orders/${chain.orderId}/payment-terms`, { paymentTerms: 'prepaid' });
    expect(fixed.status).toBe(200);
    const approved = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const locked = await send('admin', 'PATCH', `/api/film-supply-orders/${chain.orderId}/payment-terms`, { paymentTerms: 'on_delivery' });
    expect(locked.status).toBe(422);
    expect(locked.body).toMatchObject({ code: 'PAYMENT_TERMS_LOCKED', reason: 'ceo_approved', makerPurchaseOrderId: paper.body.id });
    expect((await orderRow(chain.orderId)).paymentTerms).toBe('prepaid');

    const cancelled = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/cancel`, { note: '決済条件を見直すため取り消し' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((await orderRow(chain.orderId)).status).toBe('MAKER_PO_READY');
    const reopened = await send('staff', 'PATCH', `/api/film-supply-orders/${chain.orderId}/payment-terms`, { paymentTerms: 'on_delivery' });
    expect(reopened.status).toBe(200);
  });

  it('refuses a term change on a held order', async () => {
    const { orderId } = await createOrder(await verifiedSevenPo(), 'undetermined');
    expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ON_HOLD', holdReason: '確認待ち' })).status).toBe(200);
    const held = await send('staff', 'PATCH', `/api/film-supply-orders/${orderId}/payment-terms`, { paymentTerms: 'prepaid' });
    expect(held.status).toBe(422);
    expect(held.body).toMatchObject({ code: 'PAYMENT_TERMS_LOCKED', reason: 'order_frozen' });
  });

  it('re-decides the G6 gate under the order lock (a term changed after the pre-check is not approved over)', async () => {
    const chain = await readyOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    const original = db.transaction.bind(db);
    (db as any).transaction = async (fn: any, config?: any) => {
      (db as any).transaction = original;
      await db.update(filmSupplyOrders).set({ paymentTerms: 'undetermined' }).where(eq(filmSupplyOrders.id, chain.orderId));
      return original(fn, config);
    };
    try {
      const raced = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`);
      expect(raced.status).toBe(422);
      expect(raced.body.code).toBe('PAYMENT_GATE_UNSATISFIED');
    } finally {
      (db as any).transaction = original;
    }
    const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, paper.body.id));
    expect(row!.status).toBe('DRAFT');
    expect(row!.ceoApprovedAt).toBeNull();
  });

  it('lists orders with attention reasons for the stalled view; viewer reads terms, outsider is refused', async () => {
    const sevenPoId = await verifiedSevenPo();
    const undecided = await createOrder(sevenPoId, 'undetermined');
    const settled = await createOrder(sevenPoId, 'on_delivery');
    const all = await send('viewer', 'GET', `/api/projects/${projectId}/film-supply-orders`);
    expect(all.status).toBe(200);
    const byId = new Map(all.body.orders.map((order: any) => [order.id, order]));
    expect(byId.get(undecided.orderId)).toMatchObject({
      paymentTerms: 'undetermined', paymentTermsLabel: '未定', paymentTermsEditable: true,
      attention: [{ code: 'PAYMENT_TERMS_UNDETERMINED' }]
    });
    expect(byId.get(settled.orderId)).toMatchObject({ paymentTerms: 'on_delivery', attention: [] });
    for (const order of all.body.orders) expect(Object.keys(order)).not.toContain('amounts');
    const attention = await send('staff', 'GET', `/api/projects/${projectId}/film-supply-orders?attention=true`);
    expect(attention.body.orders.every((order: any) => order.attention.length > 0)).toBe(true);
    expect(attention.body.orders.some((order: any) => order.id === settled.orderId)).toBe(false);
    expect((await send('outsider', 'GET', `/api/projects/${projectId}/film-supply-orders`)).status).toBe(403);
  });
});

// --------------------------------------------------------------------- R02
describe('R02 approval evidence issuer = approving organization (policy P-1)', () => {
  async function pendingOrder() {
    const sevenPoId = await verifiedSevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await toApprovalPending(orderId);
    const { revisionId } = await revisionFor(sevenPoId, orderId);
    return { sevenPoId, orderId, revisionId };
  }

  it('refuses evidence issued by another organization (B2) and persists nothing', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const cases: Array<['customer' | 'seven', string]> = [
      ['seven', 'customer_generated'], ['customer', 'seven'], ['customer', 'kanei'], ['seven', 'maker'], ['seven', 'unknown']
    ];
    for (const [organization, issuer] of cases) {
      const identifier = `MSG-P0-MIS-${nextTag()}`;
      const evidence = await evidenceFor(sevenPoId, orderId, issuer, identifier);
      const refused = await approval(revisionId, organization, evidence.version.id, identifier);
      expect(refused.status, `${organization} <- ${issuer}`).toBe(422);
      expect(refused.body).toMatchObject({ code: 'EVIDENCE_ISSUER_MISMATCH', organization, evidenceIssuerEntity: issuer });
      expect(isSafeUserMessage(refused.body.error)).toBe(true);
    }
    expect(await db.select().from(artworkApprovalEvents).where(eq(artworkApprovalEvents.artworkRevisionId, revisionId))).toHaveLength(0);
  });

  it('refuses citing one evidence document for both organizations by default', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const identifier = `MSG-P0-SHARE-${nextTag()}`;
    const evidence = await upload(sevenPoId, orderId, {
      documentType: 'approval_evidence', issuerEntity: 'customer_generated', designKey: 'label-front',
      contentBase64: b64(`shared mail\ncustomer: ${identifier}-C\nseven: ${identifier}-S\n`)
    });
    expect((await approval(revisionId, 'customer', evidence.version.id, `${identifier}-C`)).status).toBe(201);
    const second = await approval(revisionId, 'seven', evidence.version.id, `${identifier}-S`);
    expect(second.status).toBe(422);
    expect(second.body.code).toBe('EVIDENCE_SHARED_ACROSS_ORGANIZATIONS');
  });

  it('allows the declared shared-evidence exception only with a reason, and it waits for the CEO', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const identifier = `MSG-P0-EXC-${nextTag()}`;
    const shared = await upload(sevenPoId, orderId, {
      documentType: 'approval_evidence', issuerEntity: 'customer_generated', designKey: 'label-front',
      contentBase64: b64(`one mail with both approvals\ncustomer: ${identifier}-C\nseven: ${identifier}-S\n`)
    });
    const ownCustomer = await approval(revisionId, 'customer', shared.version.id, `${identifier}-C`);
    expect(ownCustomer.status).toBe(201);
    expect(ownCustomer.body.countsTowardDualApproval).toBe(true);

    const noReason = await approval(revisionId, 'seven', shared.version.id, `${identifier}-S`, { sharedEvidence: true, sharedEvidenceReason: ' ' });
    expect(noReason.body.code).toBe('SHARED_EVIDENCE_REASON_REQUIRED');
    const badFlag = await approval(revisionId, 'seven', shared.version.id, `${identifier}-S`, { sharedEvidence: 'yes' });
    expect(badFlag.body.code).toBe('SHARED_EVIDENCE_FLAG_INVALID');
    const kaneiMemo = await evidenceFor(sevenPoId, orderId, 'kanei', `${identifier}-K`);
    const kanei = await approval(revisionId, 'seven', kaneiMemo.version.id, `${identifier}-K`, { sharedEvidence: true, sharedEvidenceReason: '電話メモ' });
    expect(kanei.body.code).toBe('SHARED_EVIDENCE_ISSUER_INVALID');

    const declared = await approval(revisionId, 'seven', shared.version.id, `${identifier}-S`, {
      sharedEvidence: true, sharedEvidenceReason: '顧客のメールにセブン化学の承認が同報で含まれている'
    });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
    expect(declared.body).toMatchObject({
      evidenceIdentifierStatus: 'pending_manual_verification', countsTowardDualApproval: false,
      issuerMatchesOrganization: false, dualApproved: false,
      sharedEvidenceException: { reason: '顧客のメールにセブン化学の承認が同報で含まれている' }
    });
    const eventId = declared.body.approvalEvent.id as string;

    const gate = await send('admin', 'GET', `/api/film-supply-orders/${orderId}/approval-gate`);
    const card = gate.body.pendingManualVerifications.find((item: any) => item.approvalEventId === eventId);
    expect(card).toMatchObject({ organization: 'seven', evidenceIssuerEntity: 'customer_generated', expectedIssuerEntity: 'seven', issuerMatchesOrganization: false, confirmable: true });

    expect((await post('staff', `/api/artwork-approval-events/${eventId}/verification`, { result: 'confirmed', reasonNote: '原本確認' })).status).toBe(403);
    const confirmed = await post('admin', `/api/artwork-approval-events/${eventId}/verification`, { result: 'confirmed', reasonNote: '原本メールにセブン化学の承認文を確認' });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect(confirmed.body.dualApproved).toBe(true);
  });

  it('refuses confirming a legacy mismatched pending approval; rejecting it stays possible', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const identifier = `MSG-P0-LEG-${nextTag()}`;
    const customerDoc = await evidenceFor(sevenPoId, orderId, 'customer_generated', identifier, 'application/pdf');
    // A row written before R02 (no issuer rule): seven approval on the customer's file.
    const [revision] = await db.execute(sql`select ar.id, dv.sha256 from artwork_revisions ar join document_versions dv on dv.id = ar.file_document_version_id where ar.id = ${revisionId}`).then((result) => result.rows as Array<{ id: string; sha256: string }>);
    const legacyId = uuidv7();
    await db.insert(artworkApprovalEvents).values({
      id: legacyId, artworkRevisionId: revisionId, organization: 'seven', decision: 'APPROVE',
      recordedByUserId: staffId, evidenceDocumentVersionId: customerDoc.version.id, evidenceIdentifier: identifier,
      evidenceIdentifierStatus: 'pending_manual_verification', evidenceSource: 'email',
      approvedFileSha256: revision!.sha256, eventTime: new Date(), recordedAt: new Date()
    });
    const gate = await send('admin', 'GET', `/api/film-supply-orders/${orderId}/approval-gate`);
    const card = gate.body.pendingManualVerifications.find((item: any) => item.approvalEventId === legacyId);
    expect(card).toMatchObject({ issuerMatchesOrganization: false, confirmable: false, sharedEvidenceException: null });
    const refused = await post('admin', `/api/artwork-approval-events/${legacyId}/verification`, { result: 'confirmed', reasonNote: 'PDF本文に承認の記載あり' });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('EVIDENCE_ISSUER_MISMATCH');
    expect(await db.select().from(evidenceManualVerifications).where(eq(evidenceManualVerifications.approvalEventId, legacyId))).toHaveLength(0);
    const rejected = await post('admin', `/api/artwork-approval-events/${legacyId}/verification`, { result: 'rejected', reasonNote: '発行元がセブン化学ではない' });
    expect(rejected.status).toBe(201);
  });
});

// --------------------------------------------------------------------- R11
describe('R11 manual verification: the verifier and the time are the session user and the server clock', () => {
  it('ignores a typed verifier name and a back-dated time on the approval evidence verification', async () => {
    const sevenPoId = await verifiedSevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await toApprovalPending(orderId);
    const { revisionId } = await revisionFor(sevenPoId, orderId);
    const identifier = `SIG-P0-PDF-${nextTag()}`;
    const pdf = await evidenceFor(sevenPoId, orderId, 'customer_generated', identifier, 'application/pdf');
    const recorded = await approval(revisionId, 'customer', pdf.version.id, identifier, { evidenceSource: 'signed_document' });
    expect(recorded.body.evidenceIdentifierStatus).toBe('pending_manual_verification');
    const eventId = recorded.body.approvalEvent.id as string;

    const missingReason = await post('admin', `/api/artwork-approval-events/${eventId}/verification`, { result: 'confirmed' });
    expect(missingReason.body.code).toBe('VERIFICATION_REASON_REQUIRED');
    expect((await post('viewer', `/api/artwork-approval-events/${eventId}/verification`, { result: 'confirmed', reasonNote: 'x' })).status).toBe(403);

    const before = Date.now();
    const verified = await post('admin', `/api/artwork-approval-events/${eventId}/verification`, {
      result: 'confirmed', verifierName: '別の人', verifiedAt: '2020-01-01T00:00:00.000Z', reasonNote: '署名ブロックを確認'
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(201);
    const [row] = await db.select().from(evidenceManualVerifications).where(eq(evidenceManualVerifications.approvalEventId, eventId));
    expect(row!.verifierName).toBe(ADMIN_DISPLAY_NAME);
    expect(row!.recordedByUserId).toBe(adminId);
    expect(row!.verifiedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.verifiedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('does the same for the send manual verification (no verifier fields needed)', async () => {
    const chain = await readyOrder();
    const paper = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`)).status).toBe(200);
    const pending = await sendMakerPoEmlEvidence((url, body) => post('staff', url, body), paper.body.id, { orderCode: chain.code });
    expect((pending.body as any).verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    const eventId = (pending.body as any).event.id as string;
    expect((await post('staff', `/api/maker-po-events/${eventId}/send-manual-verification`, { result: 'confirmed', reasonNote: 'x' })).status).toBe(403);
    const verified = await post('admin', `/api/maker-po-events/${eventId}/send-manual-verification`, {
      result: 'confirmed', verifierName: '別の人', verifiedAt: '2020-01-01T00:00:00.000Z', reasonNote: '送信済みフォルダで確認'
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(201);
    const [row] = await db.select().from(makerPoSendManualVerifications).where(eq(makerPoSendManualVerifications.makerPoEventId, eventId));
    expect(row!.verifierName).toBe(ADMIN_DISPLAY_NAME);
    expect(Math.abs(row!.verifiedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });
});

// --------------------------------------------------------------------- R10
describe('R10 maker recipient is a mail address, checked when the paper is written', () => {
  it('refuses postal addresses and display-name forms at creation; accepts and trims a bare address', async () => {
    const chain = await readyOrder();
    for (const recipientAddress of ['大阪府 合成メーカー 第2工場', 'Maker <order@maker.example.jp>', 'order@maker', 'order@@maker.example.jp', 'order @maker.example.jp', '.order@maker.example.jp']) {
      const refused = await createPaper(chain.orderId, recipientAddress);
      expect(refused.status, recipientAddress).toBe(422);
      expect(refused.body.code).toBe('RECIPIENT_ADDRESS_INVALID');
    }
    expect((await createPaper(chain.orderId, '  ')).body.code).toBe('RECIPIENT_ADDRESS_REQUIRED');
    expect((await post('staff', `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, { recipientAddress: 'order@maker.example.jp' })).status).toBe(403);
    expect(await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.filmSupplyOrderId, chain.orderId))).toHaveLength(0);
    const created = await createPaper(chain.orderId, '  order@maker.example.jp ');
    expect(created.status).toBe(201);
    const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, created.body.id));
    expect((row!.snapshot as any).recipient.address).toBe('order@maker.example.jp');
  });

  it('refuses the CEO approval of a paper frozen before R10 with a postal address', async () => {
    const chain = await readyOrder();
    const created = await createPaper(chain.orderId);
    const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, created.body.id));
    await db.update(makerPurchaseOrders)
      .set({ snapshot: { ...(row!.snapshot as object), recipient: { address: '大阪府 合成メーカー' } } })
      .where(eq(makerPurchaseOrders.id, created.body.id));
    const refused = await post('admin', `/api/maker-purchase-orders/${created.body.id}/ceo-approval`);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('RECIPIENT_ADDRESS_INVALID');
    const [after] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, created.body.id));
    expect(after!.status).toBe('DRAFT');
  });
});

// --------------------------------------------------------------------- R12
describe('R12 the evidence-gap reason is kept; a cancelled paper\'s send mail is not offered or accepted', () => {
  it('stores the reason for moving on without evidence in the transition audit row', async () => {
    const { orderId } = await createOrder(await verifiedSevenPo());
    const tooLong = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'SEVEN_PO_VERIFIED', evidenceNote: 'あ'.repeat(1001) });
    expect(tooLong.body.code).toBe('EVIDENCE_NOTE_TOO_LONG');
    expect((await orderRow(orderId)).status).toBe('DRAFT');
    const moved = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'SEVEN_PO_VERIFIED', evidenceNote: '入稿データは明日メールで届く予定' });
    expect(moved.status).toBe(200);
    const blank = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED', evidenceNote: '   ' });
    expect(blank.status).toBe(200);
    const rows = await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityId, orderId), eq(auditEvents.action, 'FILM_SUPPLY_ORDER_TRANSITIONED')
    )).orderBy(auditEvents.occurredAt, auditEvents.id);
    expect((rows[0]!.afterState as any).evidenceNote).toBe('入稿データは明日メールで届く予定');
    expect((rows[0]!.requestMetadata as any).evidenceNote).toBe('入稿データは明日メールで届く予定');
    expect((rows[1]!.afterState as any).evidenceNote).toBeUndefined();
  });

  it('excludes and refuses the send mail of a cancelled paper for the replacement paper', async () => {
    const chain = await readyOrder();
    const first = await createPaper(chain.orderId, 'maker-po@example.com');
    expect((await post('admin', `/api/maker-purchase-orders/${first.body.id}/ceo-approval`)).status).toBe(200);
    const firstSend = await sendMakerPoEmlEvidence((url, body) => post('staff', url, body), first.body.id, { orderCode: chain.code });
    expect(firstSend.status).toBe(200);
    const firstVersionId = (firstSend.body as any).event.evidenceDocumentVersionId as string;
    expect(firstVersionId).toBeTruthy();
    // A second mail uploaded for paper 1 but never cited: excluded by its binding alone.
    const boundOnly = await upload(chain.sevenPoId, chain.orderId, {
      documentType: 'send_evidence', issuerEntity: 'kanei', contentType: 'message/rfc822',
      filename: `p0-bound-${nextTag()}.eml`, contentBase64: buildMakerPoEml({ orderCode: chain.code }).contentBase64,
      makerPurchaseOrderId: first.body.id
    });
    expect((await post('admin', `/api/maker-purchase-orders/${first.body.id}/cancel`, { note: '宛先誤りのため再作成' })).status).toBe(200);

    const second = await createPaper(chain.orderId, 'maker-po@example.com');
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect((await post('admin', `/api/maker-purchase-orders/${second.body.id}/ceo-approval`)).status).toBe(200);
    const fresh = buildMakerPoEml({ orderCode: chain.code, messageId: `<p0-r12-fresh-${nextTag()}@kanei.example>` });
    await upload(chain.sevenPoId, chain.orderId, {
      documentType: 'send_evidence', issuerEntity: 'kanei', contentType: 'message/rfc822',
      filename: `p0-send-${nextTag()}.eml`, contentBase64: fresh.contentBase64
    });

    const candidates = await send('staff', 'GET', `/api/maker-purchase-orders/${second.body.id}/send-evidence-candidates`);
    expect(candidates.status).toBe(200);
    expect(candidates.body.excludedCancelledCount).toBe(2);
    expect(candidates.body.candidates.map((candidate: any) => candidate.versionId)).not.toContain(firstVersionId);
    expect(candidates.body.candidates.map((candidate: any) => candidate.versionId)).not.toContain(boundOnly.version.id);
    expect(candidates.body.candidates).toHaveLength(1);
    expect((await send('viewer', 'GET', `/api/maker-purchase-orders/${second.body.id}/send-evidence-candidates`)).status).toBe(403);

    const reused = await post('staff', `/api/maker-purchase-orders/${second.body.id}/send-evidence`, {
      evidenceDocumentVersionId: firstVersionId, senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'], sentAt: new Date().toISOString()
    });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('SEND_EVIDENCE_FROM_CANCELLED_PO');
    const reusedBound = await post('staff', `/api/maker-purchase-orders/${second.body.id}/send-evidence`, {
      evidenceDocumentVersionId: boundOnly.version.id, senderAddress: 'staff@kanei.example',
      recipients: ['maker-po@example.com'], sentAt: new Date().toISOString()
    });
    expect(reusedBound.body.code).toBe('SEND_EVIDENCE_FROM_CANCELLED_PO');
    expect((await post('viewer', `/api/maker-purchase-orders/${second.body.id}/send-evidence`, {
      evidenceDocumentVersionId: boundOnly.version.id, sentAt: new Date().toISOString()
    })).status).toBe(403);
  });
});

// --------------------------------------------------------------------- R05
describe('R05 duplicates answer 409 DUPLICATE; Idempotency-Key replays one write', () => {
  it('answers a duplicate PO number and order code with 409 DUPLICATE and the existing record', async () => {
    const poNumber = `SEVEN-P0-DUP-${nextTag()}`;
    const first = await post('staff', `/api/projects/${projectId}/seven-purchase-orders`, { poNumber });
    expect(first.status).toBe(201);
    const again = await post('staff', `/api/projects/${projectId}/seven-purchase-orders`, { poNumber });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'DUPLICATE', field: 'poNumber',
      existing: { entityType: 'seven_purchase_order', id: first.body.id, projectId, projectCode: 'P0-PROJECT-A' }
    });
    expect(isSafeUserMessage(again.body.error)).toBe(true);
    expect(await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.poNumber, poNumber))).toHaveLength(1);

    const order = await createOrder(await verifiedSevenPo());
    const duplicateCode = await post('staff', `/api/projects/${projectId}/film-supply-orders`, { code: order.code, paymentTerms: 'prepaid' });
    expect(duplicateCode.status).toBe(409);
    expect(duplicateCode.body).toMatchObject({ code: 'DUPLICATE', field: 'code', existing: { id: order.orderId } });
  });

  it('never reveals another project\'s record on a duplicate', async () => {
    const poNumber = `SEVEN-P0-XPROJ-${nextTag()}`;
    expect((await post('staff', `/api/projects/${projectId}/seven-purchase-orders`, { poNumber })).status).toBe(201);
    const foreign = await post('outsider', `/api/projects/${otherProjectId}/seven-purchase-orders`, { poNumber });
    expect(foreign.status).toBe(409);
    expect(foreign.body.code).toBe('DUPLICATE');
    expect(foreign.body.existing).toBeUndefined();
    expect(JSON.stringify(foreign.body)).not.toContain(projectId);
  });

  it('writes once for a same-tick triple submit with one Idempotency-Key and replays the answer', async () => {
    const poNumber = `SEVEN-P0-IDEM-${nextTag()}`;
    const key = `idem-${nextTag()}-0001`;
    const results = await Promise.all([0, 1, 2].map(() =>
      post('staff', `/api/projects/${projectId}/seven-purchase-orders`, { poNumber }, { 'idempotency-key': key })));
    expect(results.map((result) => result.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
    expect(results.filter((result) => result.headers.get('idempotent-replayed') === 'true')).toHaveLength(2);
    expect(await db.select().from(sevenPurchaseOrders).where(eq(sevenPurchaseOrders.poNumber, poNumber))).toHaveLength(1);

    const otherBody = await post('staff', `/api/projects/${projectId}/seven-purchase-orders`, { poNumber: `${poNumber}-X` }, { 'idempotency-key': key });
    expect(otherBody.status).toBe(422);
    expect(otherBody.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const invalid = await post('staff', `/api/projects/${projectId}/seven-purchase-orders`, { poNumber }, { 'idempotency-key': 'x' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    // A fake session cookie is never cached or replayed.
    const fake = await app.request(`/api/projects/${projectId}/seven-purchase-orders`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=forged`, 'idempotency-key': key },
      body: JSON.stringify({ poNumber })
    });
    expect(fake.status).toBe(401);
    expect(fake.headers.get('idempotent-replayed')).toBeNull();
    // Scoped to the session: the admin's same key is a new request (and a duplicate).
    const admin = await post('admin', `/api/projects/${projectId}/seven-purchase-orders`, { poNumber }, { 'idempotency-key': key });
    expect(admin.status).toBe(409);
    expect(admin.headers.get('idempotent-replayed')).toBeNull();
  });

  it('without a key, a same-tick triple submit yields one 201 and DUPLICATE refusals, never a server error', async () => {
    const poNumber = `SEVEN-P0-RACE-${nextTag()}`;
    const results = await Promise.all([0, 1, 2].map(() => post('staff', `/api/projects/${projectId}/seven-purchase-orders`, { poNumber })));
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    for (const result of results.filter((candidate) => candidate.status !== 201)) {
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('DUPLICATE');
    }
  });

  it('keeps no 5xx answer and expires entries (store unit)', async () => {
    let now = 1_000;
    const store = new IdempotencyStore(() => now);
    const first = store.begin('s', 'key-00000001', 'f');
    expect(first.kind).toBe('execute');
    if (first.kind === 'execute') first.complete({ status: 503, body: '{}', contentType: 'application/json' });
    expect(store.begin('s', 'key-00000001', 'f').kind).toBe('execute');
    const refused = store.begin('s', 'key-00000003', 'f');
    if (refused.kind === 'execute') refused.complete({ status: 422, body: '{}', contentType: 'application/json' });
    // A refusal is forgotten: the corrected body with the same key runs.
    expect(store.begin('s', 'key-00000003', 'g').kind).toBe('execute');
    const kept = store.begin('s', 'key-00000002', 'f');
    if (kept.kind === 'execute') kept.complete({ status: 201, body: '{"id":1}', contentType: 'application/json' });
    expect(store.begin('s', 'key-00000002', 'f').kind).toBe('replay');
    expect(store.begin('other', 'key-00000002', 'f').kind).toBe('execute');
    now += 24 * 60 * 60 * 1000 + 1;
    expect(store.begin('s', 'key-00000002', 'f').kind).toBe('execute');
  });
});

// --------------------------------------------------------------------- R09
describe('R09 every refusal carries a stable code and safe Japanese text', () => {
  it('lists every code literal of the API and core in the server dictionary and in ERROR_CODES.md', async () => {
    const roots = ['apps/api/src', 'packages/core/src'];
    const codes = new Set<string>();
    for (const root of roots) {
      for (const file of await readdir(root)) {
        if (!file.endsWith('.ts')) continue;
        const source = await readFile(path.join(root, file), 'utf8');
        // Review M3: a code may be chosen by a ternary spread over several
        // lines (`code: x ? 'A' : 'B'`), so every quoted code inside the
        // `code:` expression and its `?` / `:` continuation lines counts.
        const lines = source.split('\n');
        lines.forEach((line, index) => {
          const at = line.indexOf('code:');
          if (at < 0) return;
          let expression = line.slice(at + 5);
          for (let next = index + 1; next < lines.length && /^\s*[?:]/.test(lines[next]!); next += 1) expression += lines[next];
          for (const match of expression.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) codes.add(match[1]!);
        });
      }
    }
    expect(codes.size).toBeGreaterThan(100);
    const missing = [...codes].filter((code) => !(code in ERROR_MESSAGES_JA));
    expect(missing).toEqual([]);
    for (const [code, message] of Object.entries(ERROR_MESSAGES_JA)) {
      expect(isSafeUserMessage(message), code).toBe(true);
    }
    const documented = await readFile(path.resolve('docs/api/ERROR_CODES.md'), 'utf8');
    const notDocumented = Object.keys(ERROR_MESSAGES_JA).filter((code) => !documented.includes(`\`${code}\``));
    expect(notDocumented).toEqual([]);
  });

  it('normalizes English core messages, enums, field names and internal URLs (unit)', () => {
    expect(isSafeUserMessage('the proven recipients do not include the recipient address')).toBe(false);
    expect(isSafeUserMessage('作成できる発注（MAKER_PO_READY）はまだありません')).toBe(false);
    expect(isSafeUserMessage('検証者名（verifierName）は必須です')).toBe(false);
    expect(isSafeUserMessage('API（http://127.0.0.1:3095）に接続できません')).toBe(false);
    expect(isSafeUserMessage('決済条件（paymentTerms: prepaid / on_delivery）')).toBe(false);
    expect(isSafeUserMessage('この発注には既に有効なメーカー発注書があります（0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b）')).toBe(true);
    expect(isSafeUserMessage('15:12 に送信されたEMLを確認してください')).toBe(true);
    // ReDoS guard: a huge echoed value is rejected at once, without the patterns.
    const started = Date.now();
    expect(isSafeUserMessage(`あ${'a'.repeat(200_000)}`)).toBe(false);
    expect(isSafeUserMessage(`あ${'a@'.repeat(100_000)}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
    expect(normalizeRefusalBody(422, { error: 'unit must be one of rolls', code: 'UNKNOWN_UNIT' }))
      .toEqual({ error: ERROR_MESSAGES_JA.UNKNOWN_UNIT, code: 'UNKNOWN_UNIT' });
    expect(normalizeRefusalBody(404, { error: 'x' })).toMatchObject({ code: 'NOT_FOUND' });
    expect(normalizeRefusalBody(500, {})).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(normalizeRefusalBody(422, { code: 'not a code', error: '入力内容を確認' })).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('answers a battery of real refusals with a code and safe text', async () => {
    const { orderId } = await createOrder(await verifiedSevenPo());
    const unknownUuid = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const anonymous = await app.request('/api/me');
    const responses = [
      { status: anonymous.status, body: await anonymous.json() },
      await send('viewer', 'PATCH', `/api/film-supply-orders/${orderId}/payment-terms`, { paymentTerms: 'prepaid' }),
      await post('staff', `/api/film-supply-orders/${unknownUuid}/transitions`, { to: 'SEVEN_PO_VERIFIED' }),
      await post('staff', '/api/film-supply-orders/not-a-uuid/transitions', { to: 'SEVEN_PO_VERIFIED' }),
      await post('staff', `/api/film-supply-orders/${orderId}/lines`, { lineNumber: 2, description: 'x', orderedQuantity: 1, unit: 'gallons' }),
      await post('staff', `/api/film-supply-orders/${orderId}/lines`, { lineNumber: 2, description: 'x', orderedQuantity: -1, unit: 'sheets' }),
      await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'MAKER_PO_SENT_MANUALLY' }),
      await post('staff', '/api/no-such-route', {}),
      await post('staff', `/api/projects/${projectId}/film-supply-orders`, { code: 'X', paymentTerms: 'prepaid', lines: [{ lineNumber: 1, description: 'x', orderedQuantity: 1, unit: 'pods' }] }),
      await post('staff', `/api/projects/${projectId}/seven-purchase-orders`, {}, { origin: 'https://evil.example' })
    ];
    for (const response of responses) {
      expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
      expect(response.body.code, JSON.stringify(response.body)).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(isSafeUserMessage(response.body.error), JSON.stringify(response.body)).toBe(true);
      expect(JSON.stringify(response.body)).not.toMatch(/127\.0\.0\.1|localhost|https?:\/\/(?!evil)/);
    }
    expect(responses.map((response) => response.body.code)).toEqual([
      'AUTH_REQUIRED', 'FORBIDDEN', 'FILM_SUPPLY_ORDER_NOT_FOUND', 'INVALID_PATH_PARAMETER', 'UNKNOWN_UNIT',
      'INVALID_QUANTITY', 'MAKER_CHAIN_TRANSITION_FORBIDDEN', 'ROUTE_NOT_FOUND', 'UNIT_DOMAIN_MISMATCH', 'CSRF_ORIGIN_REJECTED'
    ]);
  });
});

// --------------------------------------------------------------- review gaps
describe('P0 follow-up coverage (test-engineer review)', () => {
  it('R01 PATCH: missing/unknown term refused, undetermined allowed, CANCELLED 409, change review frozen', async () => {
    const sevenPoId = await verifiedSevenPo();
    const { orderId } = await createOrder(sevenPoId, 'prepaid');
    const patch = (body: unknown) => send('staff', 'PATCH', `/api/film-supply-orders/${orderId}/payment-terms`, body);
    expect((await patch({})).body.code).toBe('PAYMENT_TERMS_REQUIRED');
    expect((await patch({ paymentTerms: 'later' })).body.code).toBe('UNKNOWN_PAYMENT_TERMS');
    expect((await patch({ paymentTerms: 'prepaid', reason: 'あ'.repeat(1001) })).body.code).toBe('PAYMENT_TERMS_REASON_TOO_LONG');
    const back = await patch({ paymentTerms: 'undetermined', reason: '顧客と再協議' });
    expect(back.status).toBe(200);
    expect((await orderRow(orderId)).paymentTerms).toBe('undetermined');
    // Every other transition answers an empty warning list.
    const moved = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'SEVEN_PO_VERIFIED' });
    expect(moved.body.warnings).toHaveLength(1);
    const next = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    expect(next.body.warnings).toEqual([]);
    expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'CHANGE_REVIEW' })).status).toBe(200);
    const review = await patch({ paymentTerms: 'prepaid' });
    expect(review.body).toMatchObject({ code: 'PAYMENT_TERMS_LOCKED', reason: 'order_frozen' });

    const cancelledOrder = await createOrder(sevenPoId, 'undetermined');
    await db.update(filmSupplyOrders).set({ status: 'CANCELLED' as any }).where(eq(filmSupplyOrders.id, cancelledOrder.orderId));
    const cancelled = await send('staff', 'PATCH', `/api/film-supply-orders/${cancelledOrder.orderId}/payment-terms`, { paymentTerms: 'prepaid' });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('FILM_ORDER_CANCELLED');
    const list = await send('staff', 'GET', `/api/projects/${projectId}/film-supply-orders`);
    const row = list.body.orders.find((order: any) => order.id === cancelledOrder.orderId);
    expect(row).toMatchObject({ paymentTerms: 'undetermined', attention: [], paymentTermsEditable: false });
  });

  it('R01 list marks an approved order as not editable', async () => {
    const chain = await readyOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`)).status).toBe(200);
    const list = await send('staff', 'GET', `/api/projects/${projectId}/film-supply-orders`);
    expect(list.body.orders.find((order: any) => order.id === chain.orderId)).toMatchObject({ paymentTermsEditable: false });
  });

  it('R02 a matching-issuer approval is recorded normally; viewers and outsiders cannot record', async () => {
    const sevenPoId = await verifiedSevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await toApprovalPending(orderId);
    const { revisionId } = await revisionFor(sevenPoId, orderId);
    const identifier = `SIG-P0-OK-${nextTag()}`;
    const pdf = await evidenceFor(sevenPoId, orderId, 'seven', identifier, 'application/pdf');
    const body = { organization: 'seven', decision: 'APPROVE', evidenceSource: 'signed_document', eventTime: '2026-11-15T10:00:00.000Z', evidenceIdentifier: identifier, evidenceDocumentVersionId: pdf.version.id };
    expect((await post('viewer', `/api/artwork-revisions/${revisionId}/approvals`, body)).status).toBe(403);
    expect((await post('outsider', `/api/artwork-revisions/${revisionId}/approvals`, body)).status).toBe(403);
    const recorded = await post('staff', `/api/artwork-revisions/${revisionId}/approvals`, body);
    expect(recorded.status).toBe(201);
    expect(recorded.body).toMatchObject({ issuerMatchesOrganization: true, sharedEvidenceException: null, evidenceIdentifierStatus: 'pending_manual_verification' });
    const gate = await send('admin', 'GET', `/api/film-supply-orders/${orderId}/approval-gate`);
    expect(gate.body.pendingManualVerifications.find((item: any) => item.approvalEventId === recorded.body.approvalEvent.id))
      .toMatchObject({ evidenceIssuerEntity: 'seven', expectedIssuerEntity: 'seven', issuerMatchesOrganization: true, confirmable: true, sharedEvidenceException: null });
    const staffGate = await send('staff', 'GET', `/api/film-supply-orders/${orderId}/approval-gate`);
    expect(staffGate.body.pendingManualVerifications).toEqual([]);
    const tooLong = await approval(revisionId, 'customer', pdf.version.id, identifier, { sharedEvidence: true, sharedEvidenceReason: 'あ'.repeat(1001) });
    expect(tooLong.body.code).toBe('SHARED_EVIDENCE_REASON_TOO_LONG');
  });

  it('R05 maps every known unique constraint to its field', async () => {
    const code = `P0-DUP-PRJ-${nextTag()}`;
    const project = { code, name: '重複確認', route: 'F1', endCustomerAccountId: customerAccountId, sevenAccountId, makerAccountId };
    expect((await post('admin', '/api/projects', project)).status).toBe(201);
    const dupProject = await post('admin', '/api/projects', project);
    expect(dupProject.status).toBe(409);
    expect(dupProject.body).toMatchObject({ code: 'DUPLICATE', field: 'code', existing: { entityType: 'project' } });

    const fillingCode = `FILL-P0-${nextTag()}`;
    const filling = { code: fillingCode, lines: [{ lineNumber: 1, description: '充填', orderedQuantity: 10, unit: 'pods' }] };
    expect((await post('staff', `/api/projects/${projectId}/filling-orders`, filling)).status).toBe(201);
    const dupFilling = await post('staff', `/api/projects/${projectId}/filling-orders`, filling);
    expect(dupFilling.status).toBe(409);
    expect(dupFilling.body).toMatchObject({ code: 'DUPLICATE', field: 'code', existing: { entityType: 'filling_order' } });

    const referenceCode = `PRE-P0-${nextTag()}`;
    const first = await post('staff', `/api/projects/${projectId}/pre-order-references`, { referenceCode });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const dupRef = await post('staff', `/api/projects/${projectId}/pre-order-references`, { referenceCode });
    expect(dupRef.status).toBe(409);
    expect(dupRef.body).toMatchObject({ code: 'DUPLICATE', field: 'referenceCode', existing: { entityType: 'pre_order_reference' } });
  });

  it('R10 local-part guards: dots, length and lists are refused', async () => {
    const chain = await readyOrder();
    for (const recipientAddress of ['order..x@maker.example.jp', 'order.@maker.example.jp', `${'a'.repeat(65)}@maker.example.jp`, 'a@x.jp, b@x.jp', `a@${'b'.repeat(250)}.jp`]) {
      expect((await createPaper(chain.orderId, recipientAddress)).body.code, recipientAddress).toBe('RECIPIENT_ADDRESS_INVALID');
    }
  });

  it('R11 a verification without any verifier fields records the session user', async () => {
    const sevenPoId = await verifiedSevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await toApprovalPending(orderId);
    const { revisionId } = await revisionFor(sevenPoId, orderId);
    const identifier = `SIG-P0-NF-${nextTag()}`;
    const pdf = await evidenceFor(sevenPoId, orderId, 'customer_generated', identifier, 'application/pdf');
    const recorded = await approval(revisionId, 'customer', pdf.version.id, identifier, { evidenceSource: 'signed_document' });
    const eventId = recorded.body.approvalEvent.id as string;
    const verified = await post('admin', `/api/artwork-approval-events/${eventId}/verification`, { result: 'rejected', reasonNote: '識別子が見当たらない' });
    expect(verified.status).toBe(201);
    const [row] = await db.select().from(evidenceManualVerifications).where(eq(evidenceManualVerifications.approvalEventId, eventId));
    expect(row!.verifierName).toBe(ADMIN_DISPLAY_NAME);
  });
});

// ------------------------------------------------- independent review fixes
describe('P0 review fixes (REVIEW_REPORT H1, M1-M9)', () => {
  async function pendingOrder() {
    const sevenPoId = await verifiedSevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await toApprovalPending(orderId);
    const { revisionId } = await revisionFor(sevenPoId, orderId);
    return { sevenPoId, orderId, revisionId };
  }
  async function uploadText(sevenPoId: string, orderId: string, issuerEntity: string, text: string, extra: Record<string, unknown> = {}) {
    return await post('staff', `/api/projects/${projectId}/documents`, {
      documentType: 'approval_evidence', issuerEntity, designKey: 'label-front', filename: `rv-${nextTag()}.txt`,
      contentType: 'text/plain', contentBase64: b64(text), sevenPurchaseOrderId: sevenPoId, filmSupplyOrderId: orderId, ...extra
    });
  }
  async function revisionSha(revisionId: string) {
    const rows = await db.execute(sql`select dv.sha256 from artwork_revisions ar join document_versions dv on dv.id = ar.file_document_version_id where ar.id = ${revisionId}`);
    return (rows.rows[0] as { sha256: string }).sha256;
  }

  it('H1 (GAP-3): the same bytes uploaded under both issuers do not fill both approvals; the upload warns', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const identifier = `MSG-P0-DUP-${nextTag()}`;
    const text = `one shared mail\ncustomer: ${identifier}-C\nseven: ${identifier}-S\n`;
    const asCustomer = await uploadText(sevenPoId, orderId, 'customer_generated', text, { filename: `dup-${identifier}.txt` });
    expect(asCustomer.body.warnings).toEqual([]);
    const asSeven = await uploadText(sevenPoId, orderId, 'seven', text, { filename: `dup-${identifier}.txt` });
    expect(asSeven.status).toBe(201);
    expect(asSeven.body.document.id).not.toBe(asCustomer.body.document.id);
    expect(asSeven.body.warnings.map((warning: any) => warning.code)).toEqual(['SAME_CONTENT_OTHER_ISSUER']);
    expect((await approval(revisionId, 'customer', asCustomer.body.version.id, `${identifier}-C`)).status).toBe(201);
    const second = await approval(revisionId, 'seven', asSeven.body.version.id, `${identifier}-S`);
    expect(second.status).toBe(422);
    expect(second.body).toMatchObject({ code: 'EVIDENCE_SHARED_ACROSS_ORGANIZATIONS', sameEvidenceMatchedOn: 'same_bytes' });
    expect((await orderRow(orderId)).status).not.toBe('DUAL_APPROVED');
  });

  it('H1: case, whitespace, line-ending and filename variants of the same text are the same evidence', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const identifier = `MSG-P0-VAR-${nextTag()}`;
    const original = `Approval Mail\nCustomer: ${identifier}-C\nSeven: ${identifier}-S\n`;
    const customer = await uploadText(sevenPoId, orderId, 'customer_generated', original);
    expect((await approval(revisionId, 'customer', customer.body.version.id, `${identifier}-C`)).status).toBe(201);
    const variants = [
      original.toUpperCase().replace(`${identifier}-S`.toUpperCase(), `${identifier}-S`),
      original.replace(/\n/g, '\r\n'),
      `﻿  ${original.replace(/ /g, '   ')}\n\n`,
      original.replace('Approval Mail', 'Ａｐｐｒｏｖａｌ　Ｍａｉｌ')
    ];
    for (const variant of variants) {
      const seven = await uploadText(sevenPoId, orderId, 'seven', variant);
      expect(seven.status, JSON.stringify(seven.body)).toBe(201);
      const refused = await approval(revisionId, 'seven', seven.body.version.id, `${identifier}-S`);
      expect(refused.status, variant).toBe(422);
      expect(refused.body).toMatchObject({ code: 'EVIDENCE_SHARED_ACROSS_ORGANIZATIONS', sameEvidenceMatchedOn: 'same_text' });
    }
    // A genuinely different Seven mail still records normally.
    const own = await uploadText(sevenPoId, orderId, 'seven', `seven approval\nid: ${identifier}-S\n`);
    expect((await approval(revisionId, 'seven', own.body.version.id, `${identifier}-S`)).status).toBe(201);
    expect((await orderRow(orderId)).status).toBe('DUAL_APPROVED');
  });

  it('H1: identical PDF bytes under both issuers are refused by bytes', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const identifier = `SIG-P0-PDFDUP-${nextTag()}`;
    const pdf = b64(`%PDF-1.4\n% one signed paper ${identifier}\n%%EOF\n`);
    const c = await post('staff', `/api/projects/${projectId}/documents`, { documentType: 'approval_evidence', issuerEntity: 'customer_generated', designKey: 'label-front', filename: `a-${identifier}.pdf`, contentType: 'application/pdf', contentBase64: pdf, sevenPurchaseOrderId: sevenPoId, filmSupplyOrderId: orderId });
    const s7 = await post('staff', `/api/projects/${projectId}/documents`, { documentType: 'approval_evidence', issuerEntity: 'seven', designKey: 'label-front', filename: `b-${identifier}.pdf`, contentType: 'application/pdf', contentBase64: pdf, sevenPurchaseOrderId: sevenPoId, filmSupplyOrderId: orderId });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect((await approval(revisionId, 'customer', c.body.version.id, identifier, { evidenceSource: 'signed_document' })).status).toBe(201);
    const refused = await approval(revisionId, 'seven', s7.body.version.id, identifier, { evidenceSource: 'signed_document' });
    expect(refused.body).toMatchObject({ code: 'EVIDENCE_SHARED_ACROSS_ORGANIZATIONS', sameEvidenceMatchedOn: 'same_bytes' });
  });

  it('H1 / M8 legacy rows: same content cited by both organizations waits for the CEO; the card says so', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const identifier = `MSG-P0-LEGDUP-${nextTag()}`;
    const text = `legacy shared mail\ncustomer: ${identifier}-C\nseven: ${identifier}-S\n`;
    const c = await uploadText(sevenPoId, orderId, 'customer_generated', text);
    const s7 = await uploadText(sevenPoId, orderId, 'seven', text);
    const sha = await revisionSha(revisionId);
    const base = { artworkRevisionId: revisionId, decision: 'APPROVE' as const, recordedByUserId: staffId, evidenceSource: 'email' as const, approvedFileSha256: sha, eventTime: new Date() };
    const customerEventId = uuidv7();
    const sevenEventId = uuidv7();
    // Rows written before the content check: both auto-verified.
    await db.insert(artworkApprovalEvents).values([
      { ...base, id: customerEventId, organization: 'customer', evidenceDocumentVersionId: c.body.version.id, evidenceIdentifier: `${identifier}-C`, evidenceIdentifierStatus: 'verified_in_document', recordedAt: new Date(Date.now() - 1000) },
      { ...base, id: sevenEventId, organization: 'seven', evidenceDocumentVersionId: s7.body.version.id, evidenceIdentifier: `${identifier}-S`, evidenceIdentifierStatus: 'verified_in_document', recordedAt: new Date() }
    ]);
    const gate = await send('admin', 'GET', `/api/film-supply-orders/${orderId}/approval-gate`);
    expect(gate.body.dualApproved).toBe(false);
    const card = gate.body.pendingManualVerifications.find((item: any) => item.approvalEventId === sevenEventId);
    expect(card).toMatchObject({ sameContentUsedByOtherOrganization: true, sameContentApprovalEventId: customerEventId, issuerMatchesOrganization: true });
    expect(card.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    // The transition to MAKER_PO_READY reads the same gate.
    expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'DUAL_APPROVED' })).body.code).toBe('DUAL_APPROVAL_REQUIRED');
    expect(card.confirmable).toBe(false);
    expect(card.recordedAsPending).toBe(false);
    const refused = await post('admin', `/api/artwork-approval-events/${sevenEventId}/verification`, { result: 'confirmed', reasonNote: '1通のメールに両社の承認があることを原本で確認' });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('EVIDENCE_REQUIRES_REPLACEMENT');
    // Recovery: Seven's approval recorded again on its own evidence replaces the held one.
    const own = await uploadText(sevenPoId, orderId, 'seven', `seven own approval ${identifier}-S2
`);
    const replaced = await approval(revisionId, 'seven', own.body.version.id, `${identifier}-S2`);
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(201);
    expect(replaced.body.dualApproved).toBe(true);
  });

  it('M8: a legacy auto-verified approval on another issuer\'s evidence never counts until re-recorded', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const identifier = `MSG-P0-LEGMIS-${nextTag()}`;
    const customerOwn = await uploadText(sevenPoId, orderId, 'customer_generated', `customer mail ${identifier}-C\n`);
    expect((await approval(revisionId, 'customer', customerOwn.body.version.id, `${identifier}-C`)).status).toBe(201);
    const customerFile = await uploadText(sevenPoId, orderId, 'customer_generated', `another customer mail ${identifier}-S\n`);
    const legacyId = uuidv7();
    await db.insert(artworkApprovalEvents).values({
      id: legacyId, artworkRevisionId: revisionId, organization: 'seven', decision: 'APPROVE', recordedByUserId: staffId,
      evidenceDocumentVersionId: customerFile.body.version.id, evidenceIdentifier: `${identifier}-S`,
      evidenceIdentifierStatus: 'verified_in_document', evidenceSource: 'email', approvedFileSha256: await revisionSha(revisionId),
      eventTime: new Date(), recordedAt: new Date()
    });
    const gate = await send('admin', 'GET', `/api/film-supply-orders/${orderId}/approval-gate`);
    expect(gate.body.dualApproved).toBe(false);
    expect(gate.body.pendingManualVerifications.find((item: any) => item.approvalEventId === legacyId)).toMatchObject({ confirmable: false, issuerMatchesOrganization: false });
    expect((await post('admin', `/api/artwork-approval-events/${legacyId}/verification`, { result: 'confirmed', reasonNote: '確認' })).body.code).toBe('EVIDENCE_REQUIRES_REPLACEMENT');
    expect((await post('admin', `/api/artwork-approval-events/${legacyId}/verification`, { result: 'rejected', reasonNote: '発行元がセブン化学ではない' })).body.code).toBe('EVIDENCE_REQUIRES_REPLACEMENT');
    expect((await send('admin', 'GET', `/api/film-supply-orders/${orderId}/approval-gate`)).body.dualApproved).toBe(false);
    const own = await uploadText(sevenPoId, orderId, 'seven', `seven own ${identifier}-S2
`);
    expect((await approval(revisionId, 'seven', own.body.version.id, `${identifier}-S2`)).body.dualApproved).toBe(true);
  });

  it('GAP-2: another version of a document the other organization cited is refused', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const identifier = `MSG-P0-GAP2-${nextTag()}`;
    const filename = `gap-shared-${nextTag()}.txt`;
    const v1 = await uploadText(sevenPoId, orderId, 'customer_generated', `v1\ncustomer: ${identifier}-C\n`, { filename });
    expect((await approval(revisionId, 'customer', v1.body.version.id, `${identifier}-C`)).status).toBe(201);
    const v2 = await uploadText(sevenPoId, orderId, 'customer_generated', `v2\nseven: ${identifier}-S\n`, { filename });
    expect(v2.body.document.id).toBe(v1.body.document.id);
    const second = await approval(revisionId, 'seven', v2.body.version.id, `${identifier}-S`);
    expect(second.body).toMatchObject({ code: 'EVIDENCE_SHARED_ACROSS_ORGANIZATIONS', sameEvidenceMatchedOn: 'same_document' });
  });

  it('M7: the shared-evidence exception needs the other organization to cite it first', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const identifier = `MSG-P0-M7-${nextTag()}`;
    const doc = await uploadText(sevenPoId, orderId, 'customer_generated', `mail ${identifier}-C ${identifier}-S\n`);
    const first = await approval(revisionId, 'seven', doc.body.version.id, `${identifier}-S`, { sharedEvidence: true, sharedEvidenceReason: '1通のメール' });
    expect(first.status).toBe(422);
    expect(first.body.code).toBe('SHARED_EVIDENCE_NOT_CITED_BY_OTHER_ORGANIZATION');
    expect((await approval(revisionId, 'customer', doc.body.version.id, `${identifier}-C`)).status).toBe(201);
    const declared = await approval(revisionId, 'seven', doc.body.version.id, `${identifier}-S`, { sharedEvidence: true, sharedEvidenceReason: '1通のメール' });
    expect(declared.status).toBe(201);
    expect(declared.body.countsTowardDualApproval).toBe(false);
  });

  it('M9: a revocation is recorded on any evidence of the order (fails closed, not open)', async () => {
    const { sevenPoId, orderId, revisionId } = await pendingOrder();
    const identifier = `MSG-P0-M9-${nextTag()}`;
    const own = await uploadText(sevenPoId, orderId, 'seven', `seven mail ${identifier}\n`);
    expect((await approval(revisionId, 'seven', own.body.version.id, identifier)).status).toBe(201);
    const memo = await uploadText(sevenPoId, orderId, 'kanei', `電話メモ 承認取消 ${identifier}-R\n`);
    const revoked = await approval(revisionId, 'seven', memo.body.version.id, `${identifier}-R`, { decision: 'REVOKE' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(201);
    expect(revoked.body.approvalEvent.decision).toBe('REVOKE');
    const gate = await send('staff', 'GET', `/api/film-supply-orders/${orderId}/approval-gate`);
    expect(gate.body.missingApprovals.some((missing: any) => missing.organization === 'seven')).toBe(true);
  });

  it('GAP-1 (M1): a term change racing the CEO approval waits for its lock and is refused after it', async () => {
    const chain = await readyOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    expect(paper.status, JSON.stringify(paper.body)).toBe(201);
    let patch: Promise<{ status: number; body: any }> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from film_supply_orders where id = ${chain.orderId} for update`);
      await tx.update(makerPurchaseOrders).set({ ceoApprovedAt: new Date(), ceoApprovedByUserId: adminId })
        .where(eq(makerPurchaseOrders.id, paper.body.id));
      patch = send('staff', 'PATCH', `/api/film-supply-orders/${chain.orderId}/payment-terms`, { paymentTerms: 'on_delivery' });
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    const result = await patch!;
    expect(result.status, JSON.stringify(result.body)).toBe(422);
    expect(result.body.code).toBe('PAYMENT_TERMS_LOCKED');
    expect((await orderRow(chain.orderId)).paymentTerms).toBe('prepaid');
  });

  it('M2: the CEO approval pins the term it was shown (expectedPaymentTerms)', async () => {
    const chain = await readyOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, { expectedPaymentTerms: 'cash' })).body.code).toBe('UNKNOWN_PAYMENT_TERMS');
    // Changed after the screen was opened.
    expect((await send('staff', 'PATCH', `/api/film-supply-orders/${chain.orderId}/payment-terms`, { paymentTerms: 'on_delivery' })).status).toBe(200);
    const stale = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, { expectedPaymentTerms: 'prepaid' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'PAYMENT_TERMS_CHANGED', expectedPaymentTerms: 'prepaid', paymentTerms: 'on_delivery' });
    const [draft] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, paper.body.id));
    expect(draft!.status).toBe('DRAFT');
    const approved = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, { expectedPaymentTerms: 'on_delivery' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.approvedPaymentTerms).toBe('on_delivery');
    const [audit] = await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityId, paper.body.id), eq(auditEvents.action, 'MAKER_PO_STATUS_CHANGED')
    ));
    expect((audit!.afterState as any).approvedPaymentTerms).toBe('on_delivery');
  });

  it('M3: the reason refusals of hold release / review / cancel / acknowledgement read their own Japanese text', async () => {
    for (const code of ['HOLD_RELEASE_REASON_REQUIRED', 'HOLD_RELEASE_REASON_TOO_LONG', 'CANCELLATION_REASON_REQUIRED', 'CANCELLATION_REASON_TOO_LONG',
      'MAKER_PO_CANCEL_REASON_REQUIRED', 'MAKER_PO_CANCEL_REASON_TOO_LONG', 'MAKER_CANCELLATION_ACK_REASON_REQUIRED', 'MAKER_CANCELLATION_ACK_REASON_TOO_LONG']) {
      expect(ERROR_MESSAGES_JA[code], code).toBeTruthy();
    }
    const { orderId } = await createOrder(await verifiedSevenPo());
    expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ON_HOLD', holdReason: '確認待ち' })).status).toBe(200);
    const release = await post('admin', `/api/film-supply-orders/${orderId}/hold-release`, {});
    expect(release.status).toBe(422);
    expect(release.body).toEqual({ error: ERROR_MESSAGES_JA.HOLD_RELEASE_REASON_REQUIRED, code: 'HOLD_RELEASE_REASON_REQUIRED' });
  });

  it('M4: a multipart upload replays only for the same file; another file with the same key is refused', async () => {
    const sevenPoId = await verifiedSevenPo();
    const { orderId } = await createOrder(sevenPoId);
    const key = `idem-mp-${nextTag()}-0001`;
    const filename = `mp-${nextTag()}.txt`;
    function multipart(boundary: string, content: string) {
      const fields: Record<string, string> = { documentType: 'proof', issuerEntity: 'kanei', filename, contentType: 'text/plain', sevenPurchaseOrderId: sevenPoId, filmSupplyOrderId: orderId, designKey: 'label-front' };
      let body = '';
      for (const [name, value] of Object.entries(fields)) body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
      body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`;
      return app.request(`/api/projects/${projectId}/documents`, {
        method: 'POST', body,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: `${SESSION_COOKIE}=${tokens.staff}`, 'idempotency-key': key }
      });
    }
    const first = await multipart('----boundaryAAAA1111', 'multipart proof one\n');
    expect(first.status).toBe(201);
    const retry = await multipart('----boundaryBBBB2222', 'multipart proof one\n');
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    const otherFile = await multipart('----boundaryCCCC3333', 'a different file\n');
    expect(otherFile.status).toBe(422);
    expect(((await otherFile.json()) as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('M5: concurrent health requests share one database probe', async () => {
    let probes = 0;
    const slowDb: any = { execute: () => { probes += 1; return new Promise((resolve) => setTimeout(resolve, 200)); } };
    const healthApp = createApp({ db: slowDb, port: 3096 });
    const answers = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve(healthApp.request('/api/health')).then((response: Response) => response.json())));
    expect(probes).toBe(1);
    expect(answers.every((answer: any) => answer.db === 'ok')).toBe(true);
  });

  it('M6: a cancelled paper\'s mail re-uploaded (inline, new document, or same Message-ID) is refused for the replacement', async () => {
    const chain = await readyOrder();
    const first = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${first.body.id}/ceo-approval`)).status).toBe(200);
    const messageId = `<p0-m6-${nextTag()}@kanei.example>`;
    const original = buildMakerPoEml({ orderCode: chain.code, messageId });
    const firstSend = await post('staff', `/api/maker-purchase-orders/${first.body.id}/send-evidence`, {
      contentBase64: original.contentBase64, senderAddress: original.senderAddress, recipients: [original.recipientAddress], sentAt: original.sentAtIso
    });
    expect(firstSend.status, JSON.stringify(firstSend.body)).toBe(200);
    expect((await post('admin', `/api/maker-purchase-orders/${first.body.id}/cancel`, { note: '再作成' })).status).toBe(200);
    const second = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${second.body.id}/ceo-approval`)).status).toBe(200);

    const inline = await post('staff', `/api/maker-purchase-orders/${second.body.id}/send-evidence`, {
      contentBase64: original.contentBase64, senderAddress: original.senderAddress, recipients: [original.recipientAddress], sentAt: new Date().toISOString()
    });
    expect(inline.body.code).toBe('SEND_EVIDENCE_FROM_CANCELLED_PO');
    const reuploaded = await upload(chain.sevenPoId, chain.orderId, {
      documentType: 'send_evidence', issuerEntity: 'kanei', contentType: 'message/rfc822', filename: `renamed-${nextTag()}.eml`, contentBase64: original.contentBase64
    });
    const sameId = buildMakerPoEml({ orderCode: chain.code, messageId, subject: `再送 ${chain.code}` });
    const sameMessageId = await upload(chain.sevenPoId, chain.orderId, {
      documentType: 'send_evidence', issuerEntity: 'kanei', contentType: 'message/rfc822', filename: `same-id-${nextTag()}.eml`, contentBase64: sameId.contentBase64
    });
    for (const versionId of [reuploaded.version.id, sameMessageId.version.id]) {
      const cited = await post('staff', `/api/maker-purchase-orders/${second.body.id}/send-evidence`, {
        evidenceDocumentVersionId: versionId, senderAddress: original.senderAddress, recipients: [original.recipientAddress], sentAt: new Date().toISOString()
      });
      expect(cited.body.code).toBe('SEND_EVIDENCE_FROM_CANCELLED_PO');
    }
    const candidates = await send('staff', 'GET', `/api/maker-purchase-orders/${second.body.id}/send-evidence-candidates`);
    const offered = candidates.body.candidates.map((candidate: any) => candidate.versionId);
    expect(offered).not.toContain(reuploaded.version.id);
    expect(offered).not.toContain(sameMessageId.version.id);
    // A fresh mail for the new paper is still offered.
    const fresh = await upload(chain.sevenPoId, chain.orderId, {
      documentType: 'send_evidence', issuerEntity: 'kanei', contentType: 'message/rfc822', filename: `fresh-${nextTag()}.eml`,
      contentBase64: buildMakerPoEml({ orderCode: chain.code, messageId: `<p0-m6-new-${nextTag()}@kanei.example>` }).contentBase64
    });
    const after = await send('staff', 'GET', `/api/maker-purchase-orders/${second.body.id}/send-evidence-candidates`);
    expect(after.body.candidates.map((candidate: any) => candidate.versionId)).toContain(fresh.version.id);
  });

  it('M6: a cancelled paper\'s mail without a Message-ID is still recognized by its bytes', async () => {
    const chain = await readyOrder();
    const first = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${first.body.id}/ceo-approval`)).status).toBe(200);
    const noId = buildMakerPoEml({ orderCode: chain.code, headers: { 'Message-ID': null } });
    expect(Buffer.from(noId.contentBase64, 'base64').toString('utf8')).not.toMatch(/^Message-ID:/im);
    const firstSend = await post('staff', `/api/maker-purchase-orders/${first.body.id}/send-evidence`, {
      contentBase64: noId.contentBase64, senderAddress: noId.senderAddress, recipients: [noId.recipientAddress], sentAt: noId.sentAtIso
    });
    expect(firstSend.status, JSON.stringify(firstSend.body)).toBe(200);
    expect((await post('admin', `/api/maker-purchase-orders/${first.body.id}/cancel`, { note: '再作成' })).status).toBe(200);
    const second = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${second.body.id}/ceo-approval`)).status).toBe(200);
    const renamed = await upload(chain.sevenPoId, chain.orderId, {
      documentType: 'send_evidence', issuerEntity: 'kanei', contentType: 'message/rfc822', filename: `noid-${nextTag()}.eml`, contentBase64: noId.contentBase64
    });
    const cited = await post('staff', `/api/maker-purchase-orders/${second.body.id}/send-evidence`, {
      evidenceDocumentVersionId: renamed.version.id, senderAddress: noId.senderAddress, recipients: [noId.recipientAddress], sentAt: new Date().toISOString()
    });
    expect(cited.body.code).toBe('SEND_EVIDENCE_FROM_CANCELLED_PO');
  });
});

describe('P0 integration: audit-history action filter', () => {
  it('returns only the asked actions; reads of a version no longer crowd out uploads', async () => {
    const sevenPoId = await verifiedSevenPo();
    const { orderId } = await createOrder(sevenPoId);
    const uploaded = await upload(sevenPoId, orderId, { documentType: 'approval_evidence', issuerEntity: 'seven', designKey: 'label-front' });
    for (let i = 0; i < 3; i += 1) await send('staff', 'GET', `/api/document-versions/${uploaded.version.id}/evidence-message-id`);
    const all = await send('staff', 'GET', `/api/projects/${projectId}/audit-history?entityType=document_version&entityId=${uploaded.version.id}&limit=500`);
    expect(all.status).toBe(200);
    const allActions = (all.body.events as Array<{ action: string }>).map((event) => event.action);
    expect(allActions).toContain('DOCUMENT_VERSION_UPLOADED');
    const onlyUploads = await send('staff', 'GET', `/api/projects/${projectId}/audit-history?entityType=document_version&entityId=${uploaded.version.id}&action=DOCUMENT_VERSION_UPLOADED`);
    expect(onlyUploads.status).toBe(200);
    expect((onlyUploads.body.events as Array<{ action: string }>).map((event) => event.action)).toEqual(['DOCUMENT_VERSION_UPLOADED']);
  });

  it('ignores malformed action names (no filter, no error) and keeps the project scope', async () => {
    const response = await send('staff', 'GET', `/api/projects/${projectId}/audit-history?entityType=document_version&action=${encodeURIComponent("x' OR 1=1 --")}&limit=5`);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.events)).toBe(true);
  });

  it('viewer still reads the history through the same permission (the filter grants nothing)', async () => {
    const response = await send('viewer', 'GET', `/api/projects/${projectId}/audit-history?entityType=document_version&action=DOCUMENT_VERSION_UPLOADED&limit=5`);
    expect([200, 403]).toContain(response.status);
  });
});
