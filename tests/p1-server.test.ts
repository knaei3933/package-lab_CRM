/**
 * P1 server (persona R2 redesign, approved policies P-1..P-10 with the
 * representative's answers on P-3 and P-4): R23 automatic steps, R24 approval
 * card and 差し戻し, R25 representative queue, P-4 self-verification, P-3/R36
 * film-only commission readiness and one delivery flow, R31 number/unit
 * display, R32 maker PO display number. Every rule has a normal, a refusal and
 * a permission case. Runs only against kanei_crm_mvp_test (tests/setup.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
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
import {
  evaluateCommissionReadiness,
  evaluateSelfVerification,
  formatAmountDisplay,
  formatQuantityDisplay,
  isAutoOnlyManualTarget,
  jstYear,
  makerPoDisplayNumber,
  planAutoAdvance
} from '@kanei/core';
import { createApp } from '../apps/api/src/app.js';
import { issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';
import { ERROR_MESSAGES_JA, isSafeUserMessage } from '../apps/api/src/error-codes.js';
import { sendMakerPoEmlEvidence } from './helpers/maker-po-evidence.js';
import { withApprovalSnapshot } from './helpers/approval-snapshot.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('p1-server tests require kanei_crm_mvp_test');
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
const filmOnlyProjectId = uuidv7();
const fillingProjectId = uuidv7();
const PROJECT_CODE = 'P1-PROJECT-A';
const ADMIN_DISPLAY_NAME = '合成代表者P1';
const STAFF_DISPLAY_NAME = '合成担当者P1';

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
const get = (role: Role, url: string) => send(role, 'GET', url);
const patchTerms = (role: Role, orderId: string, paymentTerms: string) =>
  send(role, 'PATCH', `/api/film-supply-orders/${orderId}/payment-terms`, { paymentTerms });

function fullChecklist() {
  return {
    issuerNameRecorded: true, issuerName: '合成セブン化学P1',
    documentNumberRecorded: true, documentNumber: 'PO-P1-0001',
    issueDateRecorded: true, issueDate: '2026-11-11',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル',
    pastTransactionCompared: true, pastTransactionNote: '過去の発注書と一致',
    quoteCompared: true, quoteMatchesPo: true, quoteComparisonNote: '見積と一致',
    tamperHints: '', uncertain: false, confirmationReplyRecorded: false, confirmationReplyNote: '',
    verificationNote: '合成チェックリストP1'
  };
}

async function sevenPo(project = projectId, checked = true) {
  const created = await post('staff', `/api/projects/${project}/seven-purchase-orders`, {
    poNumber: `SEVEN-P1-${nextTag()}`, officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  if (checked) {
    expect((await post('staff', `/api/seven-purchase-orders/${created.body.id}/verification-checklist`, fullChecklist())).status).toBe(200);
  }
  return created.body.id as string;
}

async function createOrder(sevenPoId: string, paymentTerms = 'prepaid', project = projectId) {
  const code = `FSO-P1-${nextTag()}`;
  const created = await post('staff', `/api/projects/${project}/film-supply-orders`, {
    code, sevenPurchaseOrderId: sevenPoId, paymentTerms,
    lines: [{ lineNumber: 1, description: '合成フィルムP1', orderedQuantity: 1000, unit: 'sheets' }]
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { orderId: created.body.id as string, code, body: created.body, lineId: created.body.lines[0].id as string };
}

async function upload(sevenPoId: string, orderId: string, overrides: Record<string, unknown>, role: Role = 'staff', project = projectId) {
  const tag = nextTag();
  const response = await post(role, `/api/projects/${project}/documents`, {
    documentType: 'proof', issuerEntity: 'kanei', filename: `p1-${tag}.txt`, contentType: 'text/plain',
    contentBase64: b64(`p1 document ${tag}\n`), sevenPurchaseOrderId: sevenPoId, filmSupplyOrderId: orderId,
    ...overrides
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as { document: { id: string }; version: { id: string } };
}

async function registerRevision(sevenPoId: string, orderId: string, designKey = 'label-front') {
  const proof = await upload(sevenPoId, orderId, { designKey, contentBase64: b64(`p1 artwork ${nextTag()}\n`) });
  return await post('staff', `/api/film-supply-orders/${orderId}/artwork-revisions`, { designKey, fileDocumentVersionId: proof.version.id });
}

async function evidence(sevenPoId: string, orderId: string, issuerEntity: string, identifier: string, contentType = 'text/plain', role: Role = 'staff') {
  return await upload(sevenPoId, orderId, {
    documentType: 'approval_evidence', issuerEntity, designKey: 'label-front', contentType,
    contentBase64: b64(`p1 approval\nidentifier: ${identifier}\n`)
  }, role);
}

function approve(revisionId: string, organization: 'customer' | 'seven', versionId: string, identifier: string, role: Role = 'staff') {
  return post(role, `/api/artwork-revisions/${revisionId}/approvals`, {
    organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
    evidenceIdentifier: identifier, evidenceDocumentVersionId: versionId
  });
}

async function approveBoth(sevenPoId: string, orderId: string, revisionId: string) {
  let last: Awaited<ReturnType<typeof approve>> | null = null;
  for (const [organization, issuer] of [['customer', 'customer_generated'], ['seven', 'seven']] as const) {
    const identifier = `MSG-P1-${organization.toUpperCase()}-${nextTag()}`;
    const doc = await evidence(sevenPoId, orderId, issuer, identifier);
    last = await approve(revisionId, organization, doc.version.id, identifier);
    expect(last.status, JSON.stringify(last.body)).toBe(201);
  }
  return last!;
}

/** Through the real endpoints: created, デザインデータ受領, proof, both approvals. */
async function approvedOrder(paymentTerms = 'prepaid') {
  const sevenPoId = await sevenPo();
  const order = await createOrder(sevenPoId, paymentTerms);
  expect((await post('staff', `/api/film-supply-orders/${order.orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).status).toBe(200);
  const revision = await registerRevision(sevenPoId, order.orderId);
  expect(revision.status, JSON.stringify(revision.body)).toBe(201);
  const lastApproval = await approveBoth(sevenPoId, order.orderId, revision.body.id);
  return { sevenPoId, ...order, revisionId: revision.body.id as string, lastApproval };
}

async function createPaper(orderId: string, withAmount = true) {
  return await post('admin', `/api/film-supply-orders/${orderId}/maker-purchase-orders`, {
    recipientAddress: 'maker-po@example.com',
    ...(withAmount ? { amounts: { currency: 'JPY', totalAmount: '480000' } } : {})
  });
}

async function orderStatus(orderId: string) {
  const [row] = await db.select({ status: filmSupplyOrders.status }).from(filmSupplyOrders).where(eq(filmSupplyOrders.id, orderId)).limit(1);
  return String(row!.status);
}

async function transitionRows(orderId: string) {
  return await db.select().from(auditEvents).where(and(
    eq(auditEvents.entityId, orderId), eq(auditEvents.action, 'FILM_SUPPLY_ORDER_TRANSITIONED')
  )).orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-p1-server-'));
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
    { id: adminId, username: 'admin_p1', passwordHash: 'not-a-login-hash', displayName: ADMIN_DISPLAY_NAME, role: 'admin' },
    { id: staffId, username: 'staff_p1', passwordHash: 'not-a-login-hash', displayName: STAFF_DISPLAY_NAME, role: 'staff' },
    { id: viewerId, username: 'viewer_p1', passwordHash: 'not-a-login-hash', displayName: '合成閲覧者P1', role: 'viewer' },
    { id: outsiderId, username: 'outsider_p1', passwordHash: 'not-a-login-hash', displayName: '合成別案件担当P1', role: 'staff' }
  ]);
  await db.insert(accounts).values([
    { id: customerAccountId, name: '合成P1顧客', role: 'end_customer', externalCode: 'P1-CUST' },
    { id: sevenAccountId, name: '合成P1セブン', role: 'seven', externalCode: 'P1-SEVEN' },
    { id: makerAccountId, name: '合成P1メーカー', role: 'maker', externalCode: 'P1-MAKER' }
  ]);
  const now = new Date();
  for (const [id, code] of [[projectId, PROJECT_CODE], [otherProjectId, 'P1-PROJECT-B'], [filmOnlyProjectId, 'P1-FILM-ONLY'], [fillingProjectId, 'P1-WITH-FILLING']] as const) {
    await db.insert(projects).values({
      id, code, name: `合成${code}`, businessUnit: 'F1', route: 'F1', leadSource: 'KANEI', status: 'DRAFT',
      endCustomerAccountId: customerAccountId, sevenAccountId, makerAccountId, createdByUserId: adminId,
      createdAt: now, updatedAt: now
    });
  }
  await db.insert(projectAssignments).values([
    { id: uuidv7(), userId: staffId, projectId },
    { id: uuidv7(), userId: viewerId, projectId },
    { id: uuidv7(), userId: staffId, projectId: filmOnlyProjectId },
    { id: uuidv7(), userId: viewerId, projectId: filmOnlyProjectId },
    { id: uuidv7(), userId: staffId, projectId: fillingProjectId },
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

// ------------------------------------------------------------------ pure core
describe('P1 core rules (pure)', () => {
  it('plans the automatic steps one normal step at a time, and nothing from exception states', () => {
    const all = { sevenPoGateOpen: true, hasArtworkRevision: true, dualApproved: true, paymentTerms: 'prepaid' };
    expect(planAutoAdvance('ARTWORK_RECEIVED', all).steps.map((step) => step.to))
      .toEqual(['PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY']);
    // デザインデータ受領 is an outside fact: the chain never skips it.
    expect(planAutoAdvance('DRAFT', all).steps.map((step) => step.to)).toEqual(['SEVEN_PO_VERIFIED']);
    expect(planAutoAdvance('SEVEN_PO_VERIFIED', all).steps).toEqual([]);
    for (const status of ['ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW', 'CANCELLED', 'FILM_RECEIPT_ASSUMED_NO_ISSUE'] as const) {
      expect(planAutoAdvance(status, all)).toMatchObject({ steps: [], nextAutomatic: null });
    }
    const undecided = planAutoAdvance('DUAL_APPROVED', { ...all, paymentTerms: 'undetermined' });
    expect(undecided.steps).toEqual([]);
    expect(undecided.nextAutomatic?.blockers.map((blocker) => blocker.code)).toEqual(['PAYMENT_TERMS_UNDETERMINED']);
    const noTerms = planAutoAdvance('DUAL_APPROVED', { ...all, paymentTerms: null });
    expect(noTerms.steps).toEqual([]);
    const closedGate = planAutoAdvance('DUAL_APPROVED', { ...all, dualApproved: false });
    expect(closedGate.nextAutomatic?.blockers.map((blocker) => blocker.code)).toEqual(['DUAL_APPROVAL_REQUIRED']);
    expect(planAutoAdvance('ARTWORK_RECEIVED', { ...all, hasArtworkRevision: false }).nextAutomatic?.blockers[0]?.code)
      .toBe('ARTWORK_REVISION_REQUIRED');
    expect(isAutoOnlyManualTarget('ARTWORK_RECEIVED', 'PROOF_READY')).toBe(true);
    expect(isAutoOnlyManualTarget('DUAL_APPROVED', 'MAKER_PO_READY')).toBe(true);
    expect(isAutoOnlyManualTarget('CHANGE_REVIEW', 'PROOF_READY')).toBe(false);
    expect(isAutoOnlyManualTarget('SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED')).toBe(false);
  });

  it('formats quantities, amounts and maker PO numbers as a person reads them (R31, R32)', () => {
    expect(formatQuantityDisplay('300.000', 'meters')).toBe('300 m');
    expect(formatQuantityDisplay('100000.000', 'sheets')).toBe('100,000 枚');
    expect(formatQuantityDisplay('2.500', 'rolls')).toBe('2.5 ロール');
    expect(formatQuantityDisplay('0.000', 'pods')).toBe('0 ポッド');
    expect(formatQuantityDisplay('99999999999.999', 'pieces')).toBe('99,999,999,999.999 個');
    expect(formatQuantityDisplay('12', 'unknown')).toBe('12');
    expect(formatQuantityDisplay('abc', 'meters')).toBeNull();
    expect(formatQuantityDisplay('1e5', 'meters')).toBeNull();
    expect(formatAmountDisplay('JPY', '312000.00')).toBe('¥312,000');
    expect(formatAmountDisplay('USD', '1200.50')).toBe('1,200.5 USD');
    expect(formatAmountDisplay('JPY', null)).toBeNull();
    expect(makerPoDisplayNumber(2026, 7)).toBe('MPO-2026-0007');
    expect(makerPoDisplayNumber(2026, 12345)).toBe('MPO-2026-12345');
    expect(jstYear(new Date('2026-12-31T14:59:59.999Z'))).toBe(2026);
    expect(jstYear(new Date('2026-12-31T15:00:00.000Z'))).toBe(2027);
  });

  it('labels a self-verification and never widens staff (P-4)', () => {
    expect(evaluateSelfVerification({ role: 'admin', verifierUserId: 'a', originatorUserIds: ['a'] }))
      .toEqual({ allowed: true, selfVerification: true, basis: 'admin_self_verification_p4' });
    // Decision 2 (2026-11-21): staff never confirm their own evidence.
    expect(evaluateSelfVerification({ role: 'staff', verifierUserId: 's', originatorUserIds: [null, 's'] }))
      .toMatchObject({ allowed: false, selfVerification: true, code: 'SELF_VERIFICATION_FORBIDDEN' });
    expect(evaluateSelfVerification({ role: 'staff', verifierUserId: 's', originatorUserIds: ['other'] }))
      .toEqual({ allowed: true, selfVerification: false, basis: 'independent_verifier' });
    expect(evaluateSelfVerification({ role: 'admin', verifierUserId: 'a', originatorUserIds: ['s', undefined] }))
      .toEqual({ allowed: true, selfVerification: false, basis: 'independent_verifier' });
  });

  it('judges a film-only project on confirmed film deliveries alone (P-3)', () => {
    const base = { filmDeliveryRecorded: true, fillingDeliveryRecorded: false, sevenPoOfficiallyRegistered: true, filmDeliveryConfirmed: true, fillingDeliveryConfirmed: false };
    expect(evaluateCommissionReadiness({ ...base, fillingApplicable: false })).toEqual({ state: 'READY', isReady: true, blocking: [] });
    expect(evaluateCommissionReadiness(base).state).toBe('PENDING_VERIFICATION');
    expect(evaluateCommissionReadiness({ ...base, fillingApplicable: false, filmDeliveryConfirmed: false }))
      .toEqual({ state: 'PENDING_VERIFICATION', isReady: false, blocking: ['FILM_DELIVERY_PENDING_CONFIRMATION'] });
    expect(evaluateCommissionReadiness({ ...base, fillingApplicable: false, filmDeliveryRecorded: false, filmDeliveryConfirmed: false }))
      .toEqual({ state: 'MISSING_DATA', isReady: false, blocking: ['FILM_DELIVERY_NOT_RECORDED'] });
  });

  it('has a safe Japanese text for every new P1 code', () => {
    for (const code of ['AUTO_TRANSITION_ONLY', 'ARTWORK_REVISION_REQUIRED', 'PROJECT_CONTEXT_MISMATCH', 'MAKER_PO_RETURN_REASON_REQUIRED',
      'MAKER_PO_RETURN_REASON_TOO_LONG', 'MAKER_PO_RETURN_ONLY_DRAFT', 'MAKER_PO_SNAPSHOT_CHANGED', 'EXPECTED_SNAPSHOT_SHA256_INVALID',
      'MAKER_PO_AMOUNT_MISSING', 'MAKER_PO_SNAPSHOT_DRIFTED']) {
      expect(isSafeUserMessage(ERROR_MESSAGES_JA[code]), code).toBe(true);
    }
  });
});

// ----------------------------------------------------------------------- R23
describe('R23 automatic steps (policy P-9)', () => {
  it('creates an order against a checked PO as セブン化学発注書確認済 in one audited automatic step; an unchecked PO stays DRAFT', async () => {
    const checked = await createOrder(await sevenPo());
    expect(checked.body.status).toBe('SEVEN_PO_VERIFIED');
    expect(checked.body.autoAdvanced).toMatchObject([{ from: 'DRAFT', to: 'SEVEN_PO_VERIFIED', rule: 'seven_po_gate_open' }]);
    const rows = await transitionRows(checked.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(staffId);
    expect(rows[0]!.requestMetadata).toMatchObject({ operation: 'film_order:auto_advance', automatic: true, rule: 'seven_po_gate_open', trigger: 'film_order:create' });
    expect(rows[0]!.id).toBe(checked.body.autoAdvanced[0].auditEventId);

    const viaSeven = await post('staff', `/api/seven-purchase-orders/${await sevenPo()}/supply-orders`, { code: `FSO-P1-S-${nextTag()}`, paymentTerms: 'prepaid' });
    expect(viaSeven.body.status).toBe('SEVEN_PO_VERIFIED');

    const unchecked = await createOrder(await sevenPo(projectId, false));
    expect(unchecked.body.status).toBe('DRAFT');
    expect(unchecked.body.autoAdvanced).toEqual([]);
    expect(await transitionRows(unchecked.orderId)).toHaveLength(0);
    const preview = await get('staff', `/api/film-supply-orders/${unchecked.orderId}/auto-advance`);
    expect(preview.body.nextAutomatic).toMatchObject({ target: 'SEVEN_PO_VERIFIED', blockers: [{ code: 'SEVEN_PO_NOT_VERIFIED' }] });
  });

  it('refuses pressing 校正ゲラ準備完了 / 校了確認待ち / 製造先発注準備完了 by hand; skipping and the change-review exit keep their rules', async () => {
    const { orderId } = await createOrder(await sevenPo());
    const skipped = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'PROOF_READY' });
    expect(skipped.body.code).toBe('INVALID_TRANSITION');
    expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).status).toBe(200);
    const before = (await transitionRows(orderId)).length;
    for (const to of ['PROOF_READY']) {
      const refused = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ code: 'AUTO_TRANSITION_ONLY', from: 'ARTWORK_RECEIVED', to });
      expect(isSafeUserMessage(refused.body.error)).toBe(true);
    }
    const asAdmin = await post('admin', `/api/film-supply-orders/${orderId}/transitions`, { to: 'PROOF_READY' });
    expect(asAdmin.body.code).toBe('AUTO_TRANSITION_ONLY');
    expect(await orderStatus(orderId)).toBe('ARTWORK_RECEIVED');
    expect(await transitionRows(orderId)).toHaveLength(before);

    // The change-review exit into the approval states stays a manual decision.
    expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'CHANGE_REVIEW' })).status).toBe(200);
    const resumed = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'PROOF_READY' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'PROOF_READY', autoAdvanced: [] });

    const approved = await approvedOrder('undetermined');
    const ready = await post('staff', `/api/film-supply-orders/${approved.orderId}/transitions`, { to: 'MAKER_PO_READY' });
    expect(ready.body.code).toBe('AUTO_TRANSITION_ONLY');
    expect(await orderStatus(approved.orderId)).toBe('DUAL_APPROVED');
  });

  it('registering the proof takes 校正ゲラ準備完了 and 校了確認待ち as two audited steps in order', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).status).toBe(200);
    const revision = await registerRevision(sevenPoId, orderId);
    expect(revision.status).toBe(201);
    expect(revision.body.status).toBe('APPROVAL_PENDING');
    expect(revision.body.autoAdvanced.map((step: { to: string }) => step.to)).toEqual(['PROOF_READY', 'APPROVAL_PENDING']);
    const rows = await transitionRows(orderId);
    const statuses = rows.map((row) => (row.afterState as { status: string }).status);
    expect(statuses).toEqual(['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']);
    for (const row of rows.slice(2)) {
      expect(row.requestMetadata).toMatchObject({ automatic: true, rule: 'proof_registered', trigger: 'artwork_revision:create' });
    }
    expect(rows[2]!.occurredAt.getTime()).toBeLessThan(rows[3]!.occurredAt.getTime());
    // A second design's proof moves nothing further.
    const second = await registerRevision(sevenPoId, orderId, 'label-back');
    expect(second.body).toMatchObject({ status: 'APPROVAL_PENDING', autoAdvanced: [] });
  });

  it('a proof registered before デザインデータ受領 waits; recording デザインデータ受領 then takes both steps', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    const early = await registerRevision(sevenPoId, orderId);
    expect(early.body).toMatchObject({ status: 'SEVEN_PO_VERIFIED', autoAdvanced: [] });
    const manual = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    expect(manual.status).toBe(200);
    expect(manual.body.status).toBe('APPROVAL_PENDING');
    expect(manual.body.autoAdvanced.map((step: { to: string }) => step.to)).toEqual(['PROOF_READY', 'APPROVAL_PENDING']);
    expect(manual.body.autoAdvanced[0].rule).toBe('proof_registered');
  });

  it('校了 with a decided term is 製造先発注準備完了; 未定 stops at 校了 with the reason, and choosing the term continues', async () => {
    const decided = await approvedOrder('prepaid');
    expect(decided.lastApproval.body.orderStatus).toBe('MAKER_PO_READY');
    // Review M1: the approval writes no state itself; each step is automatic and audited.
    expect(decided.lastApproval.body.autoAdvanced).toMatchObject([
      { from: 'APPROVAL_PENDING', to: 'DUAL_APPROVED', rule: 'dual_approval_reached' },
      { from: 'DUAL_APPROVED', to: 'MAKER_PO_READY', rule: 'dual_approved_and_payment_terms_decided' }
    ]);

    const undecided = await approvedOrder('undetermined');
    expect(undecided.lastApproval.body).toMatchObject({ orderStatus: 'DUAL_APPROVED', autoAdvanced: [{ from: 'APPROVAL_PENDING', to: 'DUAL_APPROVED' }] });
    const preview = await get('staff', `/api/film-supply-orders/${undecided.orderId}/auto-advance`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      status: 'DUAL_APPROVED', plannedSteps: [],
      nextAutomatic: { target: 'MAKER_PO_READY', blockers: [{ code: 'PAYMENT_TERMS_UNDETERMINED' }] }
    });
    expect((await createPaper(undecided.orderId)).body.code).toBe('MAKER_PO_NOT_READY');
    const chosen = await patchTerms('staff', undecided.orderId, 'on_delivery');
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ status: 'MAKER_PO_READY', autoAdvanced: [{ from: 'DUAL_APPROVED', to: 'MAKER_PO_READY' }] });
    const rows = await transitionRows(undecided.orderId);
    expect(rows.at(-1)!.requestMetadata).toMatchObject({ trigger: 'film_order:update_payment_terms', automatic: true });
    // Changing the term on a non-校了 order never moves it.
    const { orderId } = await createOrder(await sevenPo(), 'undetermined');
    expect((await patchTerms('staff', orderId, 'prepaid')).body).toMatchObject({ status: 'SEVEN_PO_VERIFIED', autoAdvanced: [] });
  });

  it('a PDF approval confirmed by the representative completes 校了 and takes the next automatic step', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    const revision = await registerRevision(sevenPoId, orderId);
    const textId = `MSG-P1-C-${nextTag()}`;
    expect((await approve(revision.body.id, 'customer', (await evidence(sevenPoId, orderId, 'customer_generated', textId)).version.id, textId)).status).toBe(201);
    const pdfId = `SIG-P1-S-${nextTag()}`;
    const pdf = await evidence(sevenPoId, orderId, 'seven', pdfId, 'application/pdf');
    const pending = await approve(revision.body.id, 'seven', pdf.version.id, pdfId);
    expect(pending.body).toMatchObject({ orderStatus: 'APPROVAL_PENDING', countsTowardDualApproval: false });
    const confirmed = await post('admin', `/api/artwork-approval-events/${pending.body.approvalEvent.id}/verification`, {
      result: 'confirmed', reasonNote: '原本PDFの署名欄で確認'
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect(confirmed.body.orderStatus).toBe('MAKER_PO_READY');
    expect(confirmed.body.autoAdvanced).toMatchObject([{ from: 'APPROVAL_PENDING', to: 'DUAL_APPROVED' }, { from: 'DUAL_APPROVED', to: 'MAKER_PO_READY' }]);
  });

  it('a frozen order never moves by itself; hold release lands exactly on its origin; auto-advance then catches up', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ON_HOLD', holdReason: '色見本待ち' })).status).toBe(200);
    const heldRevision = await registerRevision(sevenPoId, orderId);
    expect(heldRevision.body).toMatchObject({ status: 'ON_HOLD', autoAdvanced: [] });
    const heldApply = await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`);
    expect(heldApply.body).toMatchObject({ status: 'ON_HOLD', steps: [] });
    expect((await post('staff', `/api/film-supply-orders/${orderId}/hold-release`, { reason: '確認済み' })).status).toBe(403);
    const released = await post('admin', `/api/film-supply-orders/${orderId}/hold-release`, { reason: '色見本が届いた' });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(await orderStatus(orderId)).toBe('ARTWORK_RECEIVED');
    const preview = await get('staff', `/api/film-supply-orders/${orderId}/auto-advance`);
    expect(preview.body.plannedSteps.map((step: { to: string }) => step.to)).toEqual(['PROOF_READY', 'APPROVAL_PENDING']);
    expect(await orderStatus(orderId)).toBe('ARTWORK_RECEIVED');
    const applied = await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`, { expectedProjectId: projectId });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ from: 'ARTWORK_RECEIVED', status: 'APPROVAL_PENDING' });
    expect(applied.body.steps).toHaveLength(2);
    const again = await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`);
    expect(again.body).toMatchObject({ status: 'APPROVAL_PENDING', steps: [] });
  });

  it('applies the automatic steps exactly once when two re-evaluations race (order row lock)', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ON_HOLD', holdReason: '確認待ち' });
    expect((await registerRevision(sevenPoId, orderId)).body.status).toBe('ON_HOLD');
    expect((await post('admin', `/api/film-supply-orders/${orderId}/hold-release`, { reason: '再開' })).status).toBe(200);
    const results = await Promise.all([1, 2, 3].map(() => post('staff', `/api/film-supply-orders/${orderId}/auto-advance`)));
    for (const result of results) expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(results.flatMap((result) => result.body.steps).map((step: { to: string }) => step.to).sort())
      .toEqual(['APPROVAL_PENDING', 'PROOF_READY']);
    const statuses = (await transitionRows(orderId)).map((row) => (row.afterState as { status: string }).status);
    expect(statuses.filter((status) => status === 'PROOF_READY')).toHaveLength(1);
    expect(await orderStatus(orderId)).toBe('APPROVAL_PENDING');
  });

  it('guards the auto-advance endpoints: roles, assignment, project context, cancelled orders, ids, idempotency', async () => {
    const { orderId } = await createOrder(await sevenPo(projectId, false));
    expect((await get('viewer', `/api/film-supply-orders/${orderId}/auto-advance`)).status).toBe(403);
    expect((await post('viewer', `/api/film-supply-orders/${orderId}/auto-advance`)).status).toBe(403);
    expect((await post('outsider', `/api/film-supply-orders/${orderId}/auto-advance`)).status).toBe(403);
    const anonymous = await app.request(`/api/film-supply-orders/${orderId}/auto-advance`, { method: 'POST' });
    expect(anonymous.status).toBe(401);
    expect((await post('staff', `/api/film-supply-orders/not-a-uuid/auto-advance`)).body.code).toBe('INVALID_PATH_PARAMETER');
    expect((await post('staff', `/api/film-supply-orders/${uuidv7()}/auto-advance`)).status).toBe(404);
    const mismatch = await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`, { expectedProjectId: otherProjectId });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('PROJECT_CONTEXT_MISMATCH');
    const key = { 'Idempotency-Key': `p1-auto-${nextTag()}` };
    const first = await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`, {}, key);
    const repeat = await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`, {}, key);
    expect(first.status).toBe(200);
    expect(repeat.headers.get('idempotent-replayed')).toBe('true');
    await db.update(filmSupplyOrders).set({ status: 'CANCELLED' as any }).where(eq(filmSupplyOrders.id, orderId));
    const cancelled = await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('FILM_ORDER_CANCELLED');
  });
});

// ----------------------------------------------------------------------- R24
describe('R24 representative approval card and 差し戻し', () => {
  it('answers every fact the approval certifies in one admin-only response', async () => {
    const chain = await approvedOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    expect(paper.status).toBe(201);
    expect(paper.body.displayNumber).toMatch(/^MPO-\d{4}-\d{4,}$/);
    const card = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    expect(card.body.makerPurchaseOrder).toMatchObject({
      id: paper.body.id, displayNumber: paper.body.displayNumber, status: 'DRAFT',
      createdBy: { id: adminId, displayName: ADMIN_DISPLAY_NAME }, snapshotDrifted: false
    });
    expect(card.body.makerPurchaseOrder.approvalSnapshotSha256).toBe(card.body.makerPurchaseOrder.storedSnapshotSha256);
    expect(card.body.project).toEqual({ id: projectId, code: PROJECT_CODE, name: `合成${PROJECT_CODE}` });
    expect(card.body.order).toMatchObject({ id: chain.orderId, code: chain.code, status: 'MAKER_PO_READY', paymentTerms: 'prepaid', paymentTermsLabel: '前払い' });
    expect(card.body.snapshot.items).toMatchObject([{ lineNumber: 1, orderedQuantity: '1000.000', unit: 'sheets', quantityDisplay: '1,000 枚' }]);
    expect(card.body.snapshot.amounts).toEqual({ currency: 'JPY', totalAmount: '480000', display: '¥480,000' });
    expect(card.body.snapshot.recipient).toEqual({ address: 'maker-po@example.com', isEmail: true });
    expect(card.body.snapshot.artworkFiles).toMatchObject([{ designKey: 'label-front', revisionNo: 1, matchesApprovedRevision: true }]);
    expect(card.body.snapshot.artworkFiles[0].fileDocumentVersionId).toBeTruthy();
    expect(card.body.sevenPurchaseOrder).toMatchObject({ id: chain.sevenPoId, verificationStatus: 'verified' });
    expect(card.body.snapshot.sevenPoNumber).toBe(card.body.sevenPurchaseOrder.poNumber);
    expect(card.body.approvals.dualApproved).toBe(true);
    const design = card.body.approvals.designs[0];
    expect(design.organizations.customer).toMatchObject({
      state: 'approved', recordedBy: { id: staffId, displayName: STAFF_DISPLAY_NAME },
      evidence: { issuerEntity: 'customer_generated', expectedIssuerEntity: 'customer_generated', issuerMatchesOrganization: true, evidenceSource: 'email', identifierStatus: 'verified_in_document', sameContentUsedByOtherOrganization: false }
    });
    expect(design.organizations.seven.evidence).toMatchObject({ issuerEntity: 'seven', issuerMatchesOrganization: true });
    expect(design.organizations.seven.evidence.filename).toMatch(/^p1-/);
    expect(card.body).toMatchObject({ blockers: [], warnings: [], canApprove: true, canReturn: true });
    expect(card.body.approveRequest.body).toEqual({ expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: card.body.makerPurchaseOrder.approvalSnapshotSha256 });

    for (const role of ['staff', 'viewer', 'outsider'] as const) {
      const refused = await get(role, `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
      expect(refused.status, role).toBe(403);
      expect(refused.body.code).toBe('CEO_ONLY');
      expect(JSON.stringify(refused.body)).not.toContain('480000');
    }
    expect((await get('admin', `/api/maker-purchase-orders/${uuidv7()}/approval-card`)).status).toBe(404);
    expect((await get('admin', `/api/maker-purchase-orders/x/approval-card`)).body.code).toBe('INVALID_PATH_PARAMETER');

    const approved = await post('admin', card.body.approveRequest.path, card.body.approveRequest.body);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const after = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(after.body.canApprove).toBe(false);
    expect(after.body.blockers.map((blocker: { code: string }) => blocker.code)).toContain('MAKER_PO_TRANSITION_BLOCKED');
  });

  it('states the blockers the approval endpoint would refuse with, and warns about a missing amount', async () => {
    const chain = await approvedOrder('prepaid');
    const paper = await createPaper(chain.orderId, false);
    const first = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(first.body.warnings.map((warning: { code: string }) => warning.code)).toEqual(['MAKER_PO_AMOUNT_MISSING']);
    expect(first.body.snapshot.amounts).toBeNull();
    expect(first.body.canApprove).toBe(true);
    expect((await patchTerms('staff', chain.orderId, 'undetermined')).status).toBe(200);
    const blocked = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(blocked.body.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(['PAYMENT_GATE_UNSATISFIED']);
    expect(blocked.body.canApprove).toBe(false);
    const refused = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, paper.body.id));
    expect(refused.body.code).toBe('PAYMENT_GATE_UNSATISFIED');
    await post('staff', `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'ON_HOLD', holdReason: '確認待ち' });
    const held = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(held.body.blockers.map((blocker: { code: string }) => blocker.code)).toContain('ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED');
  });

  it('pins the approval to the snapshot the card showed (expectedSnapshotSha256)', async () => {
    const chain = await approvedOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    const card = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    const shown = card.body.makerPurchaseOrder.approvalSnapshotSha256 as string;
    // P1 integration: the hash is required — no hash, no approval (and nothing recorded).
    const missing = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, { expectedPaymentTerms: 'prepaid' });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('EXPECTED_SNAPSHOT_SHA256_REQUIRED');
    expect((await get('admin', `/api/maker-purchase-orders/${paper.body.id}`)).body.purchaseOrder.status).toBe('DRAFT');
    const invalid = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, { expectedSnapshotSha256: 'ABC' });
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe('EXPECTED_SNAPSHOT_SHA256_INVALID');
    // A line added after the card was read moves the snapshot.
    expect((await post('staff', `/api/film-supply-orders/${chain.orderId}/lines`, { lineNumber: 2, description: '追加明細', orderedQuantity: 300, unit: 'meters' })).status).toBe(201);
    const stale = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, { expectedSnapshotSha256: shown, expectedPaymentTerms: 'prepaid' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('MAKER_PO_SNAPSHOT_CHANGED');
    expect(stale.body.expectedSnapshotSha256).toBe(shown);
    const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, paper.body.id));
    expect(row!.status).toBe('DRAFT');
    expect(row!.ceoApprovedAt).toBeNull();
    expect(await db.select().from(makerPoEvents).where(eq(makerPoEvents.makerPurchaseOrderId, paper.body.id))).toHaveLength(0);
    const drifted = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(drifted.body.makerPurchaseOrder.snapshotDrifted).toBe(true);
    expect(drifted.body.warnings.map((warning: { code: string }) => warning.code)).toEqual(['MAKER_PO_SNAPSHOT_DRIFTED']);
    expect(drifted.body.snapshot.items[1]).toMatchObject({ unit: 'meters', quantityDisplay: '300 m' });
    const fresh = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, drifted.body.approveRequest.body);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.purchaseOrder.snapshotSha256).toBe(drifted.body.makerPurchaseOrder.approvalSnapshotSha256);
  });

  it('差し戻す: admin only, reason required, DRAFT only, recorded, and the staff can freeze new paper', async () => {
    const chain = await approvedOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    const url = `/api/maker-purchase-orders/${paper.body.id}/return`;
    expect((await post('staff', url, { reason: '金額違い' })).body.code).toBe('CEO_ONLY');
    expect((await post('viewer', url, { reason: '金額違い' })).status).toBe(403);
    expect((await post('admin', url, {})).body.code).toBe('MAKER_PO_RETURN_REASON_REQUIRED');
    expect((await post('admin', url, { reason: '​  ' })).body.code).toBe('MAKER_PO_RETURN_REASON_REQUIRED');
    expect((await post('admin', url, { reason: 'あ'.repeat(1001) })).body.code).toBe('MAKER_PO_RETURN_REASON_TOO_LONG');
    expect((await post('admin', url, { reason: '金額違い', expectedProjectId: otherProjectId })).body.code).toBe('PROJECT_CONTEXT_MISMATCH');
    const [stillDraft] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, paper.body.id));
    expect(stillDraft!.status).toBe('DRAFT');

    const returned = await post('admin', url, { reason: '金額が見積と違います', expectedProjectId: projectId });
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(returned.body).toMatchObject({ status: 'CANCELLED', returned: true, displayNumber: paper.body.displayNumber, reason: '金額が見積と違います' });
    const [audit] = await db.select().from(auditEvents).where(and(eq(auditEvents.action, 'MAKER_PO_RETURNED'), eq(auditEvents.entityId, paper.body.id)));
    expect(audit!.id).toBe(returned.body.auditEventId);
    expect(audit!.actorUserId).toBe(adminId);
    expect(audit!.afterState).toMatchObject({ reason: '金額が見積と違います', returnedToUserId: adminId, orderStatus: 'MAKER_PO_READY' });
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_READY');
    expect((await post('admin', url, { reason: 'もう一度' })).body.code).toBe('MAKER_PO_RETURN_ONLY_DRAFT');
    const replacement = await createPaper(chain.orderId);
    expect(replacement.status).toBe(201);
    expect((await post('admin', `/api/maker-purchase-orders/${replacement.body.id}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, replacement.body.id))).status).toBe(200);
    const approvedReturn = await post('admin', `/api/maker-purchase-orders/${replacement.body.id}/return`, { reason: '承認後' });
    expect(approvedReturn.status).toBe(422);
    expect(approvedReturn.body).toMatchObject({ code: 'MAKER_PO_RETURN_ONLY_DRAFT', from: 'APPROVED_FOR_MANUAL_SEND' });
  });
});

// ----------------------------------------------------------------------- R32
describe('R32 maker PO display numbers (computed, no migration)', () => {
  it('numbers papers in creation order within the JST year, stable and distinct under concurrent creation', async () => {
    const orders = [await approvedOrder('prepaid'), await approvedOrder('prepaid'), await approvedOrder('prepaid')];
    const created = await Promise.all(orders.map((order) => createPaper(order.orderId)));
    for (const paper of created) expect(paper.status).toBe(201);
    const numbers = created.map((paper) => paper.body.displayNumber as string);
    expect(new Set(numbers).size).toBe(3);
    const year = jstYear(new Date());
    const sequences = numbers.map((number) => {
      const match = /^MPO-(\d{4})-(\d{4,})$/.exec(number);
      expect(Number(match![1])).toBe(year);
      return Number(match![2]);
    }).sort((a, b) => a - b);
    expect(sequences[1]! - sequences[0]!).toBe(1);
    expect(sequences[2]! - sequences[1]!).toBe(1);
    const rows = await db.select().from(makerPurchaseOrders).orderBy(asc(makerPurchaseOrders.createdAt), asc(makerPurchaseOrders.id));
    const times = rows.map((row) => row.createdAt.getTime());
    expect(new Set(times).size).toBe(times.length);
    const single = await get('staff', `/api/maker-purchase-orders/${created[0]!.body.id}`);
    expect(single.body.displayNumber).toBe(numbers[0]);
    const viewer = await get('viewer', `/api/film-supply-orders/${orders[1]!.orderId}/maker-purchase-orders`);
    expect(viewer.body.displayNumbers[created[1]!.body.id]).toBe(numbers[1]);
    expect(JSON.stringify(viewer.body)).not.toContain('480000');
  });
});

// ----------------------------------------------------------------------- R25
describe('R25 representative queue (one admin-only source with deep links)', () => {
  const itemFor = (queue: any, key: string) => queue.items.find((item: { key: string }) => item.key === key);

  it('refuses everyone but the representative', async () => {
    for (const role of ['staff', 'viewer', 'outsider'] as const) {
      const refused = await get(role, '/api/representative-queue');
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('CEO_ONLY');
    }
    expect((await app.request('/api/representative-queue')).status).toBe(401);
  });

  it('lists creation, approval, hold, review, evidence and blocked work with the facts and the deep link', async () => {
    const ready = await approvedOrder('prepaid');
    const drafted = await approvedOrder('prepaid');
    const paper = await createPaper(drafted.orderId);
    const undecided = await approvedOrder('undetermined');
    const heldOrder = await createOrder(await sevenPo());
    await post('staff', `/api/film-supply-orders/${heldOrder.orderId}/transitions`, { to: 'ON_HOLD', holdReason: '版下の差し替え待ち' });
    const reviewOrder = await createOrder(await sevenPo());
    await post('staff', `/api/film-supply-orders/${reviewOrder.orderId}/transitions`, { to: 'CANCELLATION_REVIEW' });
    const sevenPoId = await sevenPo();
    const pdfOrder = await createOrder(sevenPoId);
    await post('staff', `/api/film-supply-orders/${pdfOrder.orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    const revision = await registerRevision(sevenPoId, pdfOrder.orderId);
    const pdfId = `SIG-P1-Q-${nextTag()}`;
    const wrongIssuer = await evidence(sevenPoId, pdfOrder.orderId, 'customer_generated', pdfId, 'application/pdf');
    const pending = await approve(revision.body.id, 'customer', wrongIssuer.version.id, pdfId);
    expect(pending.status).toBe(201);

    const queue = await get('admin', '/api/representative-queue');
    expect(queue.status).toBe(200);
    const creation = itemFor(queue.body, `maker_po_creation:${ready.orderId}`);
    expect(creation).toMatchObject({
      kind: 'maker_po_creation', label: '発注書の作成', subjectId: ready.orderId,
      project: { id: projectId, code: PROJECT_CODE }, order: { id: ready.orderId, code: ready.code, status: 'MAKER_PO_READY', paymentTerms: 'prepaid' },
      deepLink: { step: 'maker_po', projectCode: PROJECT_CODE, orderCode: ready.code, action: { method: 'POST' } }
    });
    const approval = itemFor(queue.body, `maker_po_ceo_approval:${paper.body.id}`);
    expect(approval).toMatchObject({
      kind: 'maker_po_ceo_approval', label: '代表承認',
      makerPurchaseOrder: { id: paper.body.id, displayNumber: paper.body.displayNumber, status: 'DRAFT', amounts: { display: '¥480,000' } },
      requestedBy: { id: adminId }, detail: { blockers: [] },
      deepLink: { step: 'approval_card', card: { path: `/api/maker-purchase-orders/${paper.body.id}/approval-card` } }
    });
    // Creation is not offered for an order that already holds live paper.
    expect(itemFor(queue.body, `maker_po_creation:${drafted.orderId}`)).toBeUndefined();
    expect(itemFor(queue.body, `hold_release:${heldOrder.orderId}`)).toMatchObject({
      detail: { origin: 'SEVEN_PO_VERIFIED', originLabel: 'セブン化学発注書確認済', holdReason: '版下の差し替え待ち' },
      deepLink: { step: 'hold', action: { path: `/api/film-supply-orders/${heldOrder.orderId}/hold-release` } }
    });
    expect(itemFor(queue.body, `cancellation_review:${reviewOrder.orderId}`)).toMatchObject({ label: '取消レビュー', detail: { origin: 'SEVEN_PO_VERIFIED' } });
    expect(itemFor(queue.body, `approval_evidence_verification:${pending.body.approvalEvent.id}`)).toMatchObject({
      label: '承認証跡の確認',
      requestedBy: { id: staffId, displayName: STAFF_DISPLAY_NAME },
      detail: { organization: 'customer', designKey: 'label-front', evidenceIssuerEntity: 'customer_generated', issuerMatchesOrganization: true, confirmable: true }
    });
    expect(queue.body.blocked.find((item: { key: string }) => item.key === `payment_terms_undetermined:${undecided.orderId}`)).toMatchObject({
      reason: { code: 'PAYMENT_TERMS_UNDETERMINED' }, fixableBy: ['admin', 'staff'],
      deepLink: { step: 'payment_terms', action: { method: 'PATCH' } }
    });
    expect(queue.body.counts.items).toBe(queue.body.items.length);
    const waits = queue.body.items.map((item: { waitingSince: string }) => new Date(item.waitingSince).getTime());
    expect([...waits].sort((a, b) => a - b)).toEqual(waits);

    // Done work leaves the queue.
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, paper.body.id))).status).toBe(200);
    const after = await get('admin', '/api/representative-queue');
    expect(itemFor(after.body, `maker_po_ceo_approval:${paper.body.id}`)).toBeUndefined();
    await db.update(filmSupplyOrders).set({ status: 'CANCELLED' as any }).where(eq(filmSupplyOrders.id, heldOrder.orderId));
    const cancelled = await get('admin', '/api/representative-queue');
    expect(itemFor(cancelled.body, `hold_release:${heldOrder.orderId}`)).toBeUndefined();
  });

  it('follows a paper through send verification, final acceptance and the cancellation acknowledgement', async () => {
    const chain = await approvedOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, paper.body.id))).status).toBe(200);
    const sent = await sendMakerPoEmlEvidence((url, body) => post('staff', url, body), paper.body.id, { orderCode: chain.code });
    expect((sent.body as any).verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
    const eventId = (sent.body as any).event.id as string;
    const first = await get('admin', '/api/representative-queue');
    expect(itemFor(first.body, `send_verification:${eventId}`)).toMatchObject({
      label: '送信の確認', makerPurchaseOrder: { id: paper.body.id, displayNumber: paper.body.displayNumber },
      deepLink: { step: 'send', action: { path: `/api/maker-po-events/${eventId}/send-manual-verification` } }
    });
    expect((await post('admin', `/api/maker-po-events/${eventId}/send-manual-verification`, { result: 'confirmed', reasonNote: '送信済みフォルダで確認' })).status).toBe(201);
    const second = await get('admin', '/api/representative-queue');
    expect(itemFor(second.body, `send_verification:${eventId}`)).toBeUndefined();
    expect(itemFor(second.body, `maker_po_final_acceptance:${paper.body.id}`)).toMatchObject({ label: '最終受入', detail: { provisionalAcceptanceRecorded: false } });
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/cancel`, { note: '送信後の取消（合成）' })).status).toBe(200);
    const third = await get('admin', '/api/representative-queue');
    expect(itemFor(third.body, `maker_po_final_acceptance:${paper.body.id}`)).toBeUndefined();
    expect(itemFor(third.body, `cancellation_acknowledgement:${paper.body.id}`)).toMatchObject({ label: '取消確認' });
    // The order cannot freeze new paper until the acknowledgement: no creation item either.
    expect(itemFor(third.body, `maker_po_creation:${chain.orderId}`)).toBeUndefined();
  });
});

// ----------------------------------------------------------------------- P-4
describe('P-4 the representative may confirm their own evidence; who and when are recorded', () => {
  it('records an admin self-verification of approval evidence with the session user and the server clock', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    const revision = await registerRevision(sevenPoId, orderId);
    const pdfId = `SIG-P1-SELF-${nextTag()}`;
    const own = await evidence(sevenPoId, orderId, 'customer_generated', pdfId, 'application/pdf', 'admin');
    const recorded = await approve(revision.body.id, 'customer', own.version.id, pdfId, 'admin');
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    const eventId = recorded.body.approvalEvent.id as string;
    // Staff keep the existing rule: approval-evidence verification is the representative's.
    expect((await post('staff', `/api/artwork-approval-events/${eventId}/verification`, { result: 'confirmed', reasonNote: 'x' })).status).toBe(403);
    const verified = await post('admin', `/api/artwork-approval-events/${eventId}/verification`, {
      result: 'confirmed', reasonNote: '自分で受け取ったPDFの署名欄を確認', verifierName: '別人', verifiedAt: '2020-01-01T00:00:00.000Z'
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(201);
    expect(verified.body).toMatchObject({ selfVerification: true, selfVerificationBasis: 'admin_self_verification_p4', verifiedBy: { id: adminId, displayName: ADMIN_DISPLAY_NAME } });
    const [row] = await db.select().from(evidenceManualVerifications).where(eq(evidenceManualVerifications.approvalEventId, eventId));
    expect(row!.verifierName).toBe(ADMIN_DISPLAY_NAME);
    expect(row!.recordedByUserId).toBe(adminId);
    expect(Math.abs(row!.verifiedAt.getTime() - Date.now())).toBeLessThan(60_000);
    const [audit] = await db.select().from(auditEvents).where(and(eq(auditEvents.action, 'EVIDENCE_MANUAL_VERIFICATION_RECORDED'), eq(auditEvents.entityId, eventId)));
    expect(audit!.afterState).toMatchObject({ selfVerification: true, selfVerificationBasis: 'admin_self_verification_p4', verifiedByUserId: adminId });
  });

  it('labels document and send verifications; staff may not confirm their own document (decision 2)', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    const staffDoc = await upload(sevenPoId, orderId, { documentType: 'acceptance_evidence', designKey: undefined });
    const byStaff = await post('staff', `/api/documents/${staffDoc.document.id}/verify`, { verificationStatus: 'verified' });
    expect(byStaff.status).toBe(403);
    expect(byStaff.body.code).toBe('SELF_VERIFICATION_FORBIDDEN');
    expect(isSafeUserMessage(byStaff.body.error)).toBe(true);
    const [untouched] = await db.execute(sql`select verification_status from documents where id = ${staffDoc.document.id}`).then((r) => r.rows as Array<{ verification_status: string }>);
    expect(untouched!.verification_status).toBe('unverified');
    // Another staff member's upload is an independent confirmation.
    const adminDoc = await upload(sevenPoId, orderId, { documentType: 'acceptance_evidence', designKey: undefined }, 'admin');
    const independentStaff = await post('staff', `/api/documents/${adminDoc.document.id}/verify`, { verificationStatus: 'verified' });
    expect(independentStaff.body).toMatchObject({ selfVerification: false, selfVerificationBasis: 'independent_verifier', verifiedByUserId: staffId });
    const otherDoc = await upload(sevenPoId, orderId, { documentType: 'acceptance_evidence', designKey: undefined });
    const byAdmin = await post('admin', `/api/documents/${otherDoc.document.id}/verify`, { verificationStatus: 'verified' });
    expect(byAdmin.body).toMatchObject({ selfVerification: false, selfVerificationBasis: 'independent_verifier', verifiedBy: { id: adminId } });
    expect((await post('viewer', `/api/documents/${otherDoc.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(403);

    const chain = await approvedOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, paper.body.id))).status).toBe(200);
    const sent = await sendMakerPoEmlEvidence((url, body) => post('admin', url, body), paper.body.id, { orderCode: chain.code });
    const eventId = (sent.body as any).event.id as string;
    const confirmed = await post('admin', `/api/maker-po-events/${eventId}/send-manual-verification`, { result: 'confirmed', reasonNote: '自分で送ったメールを確認' });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect(confirmed.body).toMatchObject({ selfVerification: true, selfVerificationBasis: 'admin_self_verification_p4', verifiedBy: { id: adminId } });
  });
});

// ------------------------------------------------------------------ P-3 / R36
describe('P-3 / R36 film-only commission readiness and one delivery flow', () => {
  async function filmOnlyOrder(project: string) {
    const sevenPoId = await sevenPo(project);
    const order = await createOrder(sevenPoId, 'prepaid', project);
    return { sevenPoId, ...order };
  }
  async function confirmDelivery(project: string, sevenPoId: string, orderId: string, deliveryId: string) {
    const doc = await upload(sevenPoId, orderId, { documentType: 'acceptance_evidence', designKey: undefined }, 'staff', project);
    expect((await post('admin', `/api/documents/${doc.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
    // Decision 2: staff may not confirm a delivery on evidence they uploaded.
    const self = await post('staff', `/api/film-deliveries/${deliveryId}/confirmation`, { evidenceDocumentVersionId: doc.version.id });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_VERIFICATION_FORBIDDEN');
    return await post('admin', `/api/film-deliveries/${deliveryId}/confirmation`, { evidenceDocumentVersionId: doc.version.id });
  }

  it('a film-only project is READY once the delivered film quantity is confirmed; filling is 対象外', async () => {
    const order = await filmOnlyOrder(filmOnlyProjectId);
    const evaluate = () => post('staff', `/api/projects/${filmOnlyProjectId}/commission-readiness`);
    const empty = await evaluate();
    expect(empty.status).toBe(201);
    expect(empty.body).toMatchObject({ readinessState: 'MISSING_DATA', blocking: ['FILM_DELIVERY_NOT_RECORDED'], fillingRequirement: 'not_applicable', basis: 'film_delivered_quantity_confirmed' });

    const status0 = await get('viewer', `/api/film-supply-orders/${order.orderId}/delivery-status`);
    expect(status0.status).toBe(200);
    expect(status0.body).toMatchObject({ filmOnly: true, stage: 'not_delivered', nextAction: { action: 'RECORD_DELIVERY' } });
    expect(status0.body.lines[0]).toMatchObject({ unitLabel: '枚', orderedDisplay: '1,000 枚', deliveredDisplay: '0 枚' });

    const delivery = await post('staff', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 1000, unit: 'sheets' });
    expect(delivery.status).toBe(201);
    const pending = await evaluate();
    expect(pending.body).toMatchObject({ readinessState: 'PENDING_VERIFICATION', blocking: ['FILM_DELIVERY_PENDING_CONFIRMATION'], commissionCalculationAllowed: false });
    const status1 = await get('staff', `/api/film-supply-orders/${order.orderId}/delivery-status`);
    expect(status1.body).toMatchObject({ stage: 'quantity_pending_confirmation', nextAction: { action: 'CONFIRM_DELIVERY', deliveryIds: [delivery.body.id] } });
    expect(status1.body.lines[0]).toMatchObject({ deliveredQuantity: '1000.000', deliveredDisplay: '1,000 枚', confirmedDisplay: '0 枚' });

    const confirmed = await confirmDelivery(filmOnlyProjectId, order.sevenPoId, order.orderId, delivery.body.id);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    // The representative confirmed staff's evidence: an independent confirmation.
    expect(confirmed.body.selfVerification).toBe(false);
    const ready = await evaluate();
    expect(ready.body).toMatchObject({ readinessState: 'READY', isReady: true, blocking: [], commissionCalculationAllowed: true, fillingRequirement: 'not_applicable' });
    expect(ready.body.filmDeliveredQuantities).toMatchObject([{ orderCode: order.code, lineNumber: 1, deliveredQuantity: '1000.000', confirmedQuantity: '1000.000', display: { confirmed: '1,000 枚' } }]);
    const status2 = await get('staff', `/api/film-supply-orders/${order.orderId}/delivery-status`);
    expect(status2.body.stage).toBe('quantity_confirmed');
    expect(status2.body.lines[0].deliveries[0].confirmation).toMatchObject({ confirmedBy: { id: adminId }, selfVerification: false });
    expect(JSON.stringify(status2.body)).not.toMatch(/totalAmount|amount/i);
  });

  it('a project with a filling order keeps the filling requirement (existing rule)', async () => {
    const order = await filmOnlyOrder(fillingProjectId);
    const filling = await post('staff', `/api/projects/${fillingProjectId}/filling-orders`, {
      code: `FILLO-P1-${nextTag()}`, lines: [{ lineNumber: 1, description: '合成充填P1', orderedQuantity: 100, unit: 'pods' }]
    });
    expect(filling.status, JSON.stringify(filling.body)).toBe(201);
    const delivery = await post('staff', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 1000, unit: 'sheets' });
    expect((await confirmDelivery(fillingProjectId, order.sevenPoId, order.orderId, delivery.body.id)).status).toBe(201);
    const readiness = await post('staff', `/api/projects/${fillingProjectId}/commission-readiness`);
    expect(readiness.body).toMatchObject({ readinessState: 'PENDING_VERIFICATION', fillingRequirement: 'required', basis: 'film_and_filling_deliveries_confirmed' });
    expect(readiness.body.blocking).toContain('FILLING_DELIVERY_NOT_RECORDED');
    const status = await get('staff', `/api/film-supply-orders/${order.orderId}/delivery-status`);
    expect(status.body.filmOnly).toBe(false);
  });

  it('guards the delivery status read', async () => {
    const order = await filmOnlyOrder(filmOnlyProjectId);
    expect((await get('outsider', `/api/film-supply-orders/${order.orderId}/delivery-status`)).status).toBe(403);
    expect((await get('staff', `/api/film-supply-orders/${uuidv7()}/delivery-status`)).status).toBe(404);
    expect((await app.request(`/api/film-supply-orders/${order.orderId}/delivery-status`)).status).toBe(401);
  });
});

// ----------------------------------------------------------------------- R31
describe('R31 unit vocabulary on the status labels', () => {
  it('serves the unit symbols and names next to the status labels', async () => {
    const labels = await get('viewer', '/api/status-labels');
    expect(labels.status).toBe(200);
    expect(labels.body.units).toMatchObject({ meters: { symbol: 'm', label: 'メートル' }, sheets: { symbol: '枚' }, rolls: { symbol: 'ロール' } });
    expect(labels.body.filmSupplyOrderStates).toHaveLength(18);
  });
});

// ----------------------------------------------- review additions (test-engineer, security review M1)
describe('P1 review additions', () => {
  const revoke = async (sevenPoId: string, orderId: string, revisionId: string, organization: 'customer' | 'seven') => {
    const identifier = `MEMO-P1-R-${nextTag()}`;
    const memo = await evidence(sevenPoId, orderId, 'kanei', identifier);
    const revoked = await post('staff', `/api/artwork-revisions/${revisionId}/approvals`, {
      organization, decision: 'REVOKE', evidenceSource: 'email', eventTime: '2026-11-16T10:00:00.000Z',
      evidenceIdentifier: identifier, evidenceDocumentVersionId: memo.version.id
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(201);
  };

  it('M1: a change-review restart into デザインデータ受領 waits for a new proof; the old proof no longer counts', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    expect((await registerRevision(sevenPoId, orderId)).body.status).toBe('APPROVAL_PENDING');
    expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'CHANGE_REVIEW' })).status).toBe(200);
    const restarted = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    expect(restarted.body).toMatchObject({ status: 'ARTWORK_RECEIVED', autoAdvanced: [] });
    const preview = await get('staff', `/api/film-supply-orders/${orderId}/auto-advance`);
    expect(preview.body).toMatchObject({ plannedSteps: [], nextAutomatic: { target: 'PROOF_READY', blockers: [{ code: 'ARTWORK_REVISION_REQUIRED' }] } });
    expect((await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`)).body.steps).toEqual([]);
    const fresh = await registerRevision(sevenPoId, orderId, 'label-front');
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    expect(fresh.body).toMatchObject({ status: 'APPROVAL_PENDING' });
  });

  it('a change-review exit lands exactly where it was sent even when a proof exists (no chaining)', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    expect((await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'CHANGE_REVIEW' })).status).toBe(200);
    expect((await registerRevision(sevenPoId, orderId)).body.status).toBe('CHANGE_REVIEW');
    const resumed = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'PROOF_READY' });
    expect(resumed.body).toMatchObject({ status: 'PROOF_READY', autoAdvanced: [] });
    expect(await orderStatus(orderId)).toBe('PROOF_READY');
    const manual = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'APPROVAL_PENDING' });
    expect(manual.body).toMatchObject({ code: 'AUTO_TRANSITION_ONLY', from: 'PROOF_READY' });
    expect((await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`)).body.status).toBe('APPROVAL_PENDING');
  });

  it('a cancellation-review resume lands on its origin; auto-advance catches up afterwards', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'CANCELLATION_REVIEW' });
    expect((await registerRevision(sevenPoId, orderId)).body.status).toBe('CANCELLATION_REVIEW');
    const fromHold = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'PROOF_READY' });
    expect(fromHold.body.code).not.toBe('AUTO_TRANSITION_ONLY');
    const resumed = await post('admin', `/api/film-supply-orders/${orderId}/cancellation-review-resolve`, { outcome: 'resume', reason: '取消しない' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(await orderStatus(orderId)).toBe('ARTWORK_RECEIVED');
    expect((await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`)).body).toMatchObject({ status: 'APPROVAL_PENDING' });
  });

  it('the payment-term trigger still needs the live gate; a racing re-evaluation takes the step once', async () => {
    const closed = await approvedOrder('undetermined');
    await revoke(closed.sevenPoId, closed.orderId, closed.revisionId, 'customer');
    const chosen = await patchTerms('staff', closed.orderId, 'prepaid');
    expect(chosen.body).toMatchObject({ status: 'DUAL_APPROVED', autoAdvanced: [] });
    expect((await get('staff', `/api/film-supply-orders/${closed.orderId}/auto-advance`)).body.nextAutomatic.blockers
      .map((blocker: { code: string }) => blocker.code)).toEqual(['DUAL_APPROVAL_REQUIRED']);

    const open = await approvedOrder('undetermined');
    const [patched, ...applied] = await Promise.all([
      patchTerms('staff', open.orderId, 'on_delivery'),
      post('staff', `/api/film-supply-orders/${open.orderId}/auto-advance`),
      post('staff', `/api/film-supply-orders/${open.orderId}/auto-advance`)
    ]);
    expect(patched.status).toBe(200);
    for (const result of applied) expect(result.status).toBe(200);
    // Whichever request came second, the step is written exactly once.
    await post('staff', `/api/film-supply-orders/${open.orderId}/auto-advance`);
    const rows = (await transitionRows(open.orderId)).filter((row) => (row.afterState as { status: string }).status === 'MAKER_PO_READY');
    expect(rows).toHaveLength(1);
    expect(await orderStatus(open.orderId)).toBe('MAKER_PO_READY');
  });

  it('replays an applying auto-advance for the same Idempotency-Key without writing again; preview guards', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ON_HOLD', holdReason: '確認' });
    await registerRevision(sevenPoId, orderId);
    await post('admin', `/api/film-supply-orders/${orderId}/hold-release`, { reason: '再開' });
    const key = { 'Idempotency-Key': `p1-apply-${nextTag()}` };
    const first = await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`, {}, key);
    expect(first.body.steps).toHaveLength(2);
    const count = (await transitionRows(orderId)).length;
    const again = await post('staff', `/api/film-supply-orders/${orderId}/auto-advance`, {}, key);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.body.steps).toHaveLength(2);
    expect(await transitionRows(orderId)).toHaveLength(count);
    expect((await get('outsider', `/api/film-supply-orders/${orderId}/auto-advance`)).status).toBe(403);
    expect((await app.request(`/api/film-supply-orders/${orderId}/auto-advance`)).status).toBe(401);
    // An order without any seven PO names that blocker; checking a PO later lets auto-advance take the step.
    const bare = await post('staff', `/api/projects/${projectId}/film-supply-orders`, { code: `FSO-P1-BARE-${nextTag()}`, paymentTerms: 'prepaid' });
    expect(bare.body.status).toBe('DRAFT');
    expect((await get('staff', `/api/film-supply-orders/${bare.body.id}/auto-advance`)).body.nextAutomatic.blockers[0].code).toBe('SEVEN_PO_REQUIRED');
    const late = await sevenPo(projectId, false);
    const lateOrder = await createOrder(late);
    expect(lateOrder.body.status).toBe('DRAFT');
    expect((await post('staff', `/api/seven-purchase-orders/${late}/verification-checklist`, fullChecklist())).status).toBe(200);
    const caught = await post('staff', `/api/film-supply-orders/${lateOrder.orderId}/auto-advance`);
    expect(caught.body.steps).toMatchObject([{ to: 'SEVEN_PO_VERIFIED', rule: 'seven_po_gate_open' }]);
  });

  it('approval pin: refusal order and formats', async () => {
    const chain = await approvedOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    const url = `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`;
    const card = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect((await post('staff', url, { expectedSnapshotSha256: card.body.makerPurchaseOrder.approvalSnapshotSha256 })).body.code).toBe('CEO_ONLY');
    expect((await post('admin', url, { expectedSnapshotSha256: 'A'.repeat(64) })).body.code).toBe('EXPECTED_SNAPSHOT_SHA256_INVALID');
    expect((await post('admin', url, { expectedSnapshotSha256: 123 })).body.code).toBe('EXPECTED_SNAPSHOT_SHA256_INVALID');
    const wrong = await post('admin', url, { expectedSnapshotSha256: '0'.repeat(64) });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ code: 'MAKER_PO_SNAPSHOT_CHANGED', snapshotSha256: card.body.makerPurchaseOrder.approvalSnapshotSha256 });
    expect((await post('admin', url, card.body.approveRequest.body)).status).toBe(200);
    const stale = await post('admin', url, { expectedSnapshotSha256: '0'.repeat(64) });
    expect(stale.body.code).toBe('MAKER_PO_TRANSITION_BLOCKED');
  });

  it('card states revoked approvals, a non-mail recipient and a cancelled order as blockers', async () => {
    const chain = await approvedOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    await revoke(chain.sevenPoId, chain.orderId, chain.revisionId, 'seven');
    const revoked = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(revoked.body.approvals.designs[0].organizations.seven.state).toBe('revoked');
    expect(revoked.body.blockers.map((blocker: { code: string }) => blocker.code)).toContain('DUAL_APPROVAL_REQUIRED');
    const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, paper.body.id));
    await db.update(makerPurchaseOrders).set({ snapshot: { ...(row!.snapshot as object), recipient: { address: '大阪府 合成工場' } } })
      .where(eq(makerPurchaseOrders.id, paper.body.id));
    const postal = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(postal.body.blockers.map((blocker: { code: string }) => blocker.code)).toContain('RECIPIENT_ADDRESS_INVALID');
    expect(postal.body.snapshot.recipient.isEmail).toBe(false);
    await db.update(filmSupplyOrders).set({ status: 'CANCELLED' as any }).where(eq(filmSupplyOrders.id, chain.orderId));
    const cancelled = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(cancelled.body.blockers.map((blocker: { code: string }) => blocker.code)).toContain('FILM_ORDER_CANCELLED_MAKER_PO_ACTION_BLOCKED');
    expect(cancelled.body.canApprove).toBe(false);
  });

  it('return: boundaries, races with the approval, and its effect on the queue and the numbers', async () => {
    expect((await post('admin', `/api/maker-purchase-orders/${uuidv7()}/return`, { reason: 'x' })).status).toBe(404);
    expect((await post('admin', `/api/maker-purchase-orders/x/return`, { reason: 'x' })).body.code).toBe('INVALID_PATH_PARAMETER');
    const chain = await approvedOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    const queued = await get('admin', '/api/representative-queue');
    expect(queued.body.items.some((item: { key: string }) => item.key === `maker_po_ceo_approval:${paper.body.id}`)).toBe(true);
    const longest = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/return`, { reason: 'あ'.repeat(1000) });
    expect(longest.status).toBe(200);
    const after = await get('admin', '/api/representative-queue');
    expect(after.body.items.some((item: { key: string }) => item.key === `maker_po_ceo_approval:${paper.body.id}`)).toBe(false);
    expect(after.body.items.some((item: { key: string }) => item.key === `maker_po_creation:${chain.orderId}`)).toBe(true);
    const list = await get('admin', `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`);
    expect(list.body.displayNumbers[paper.body.id]).toBe(paper.body.displayNumber);

    const raced = await createPaper(chain.orderId);
    const outcomes = await Promise.all([
      post('admin', `/api/maker-purchase-orders/${raced.body.id}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, raced.body.id)),
      post('admin', `/api/maker-purchase-orders/${raced.body.id}/return`, { reason: '同時操作' })
    ]);
    expect(outcomes.filter((result) => result.status === 200)).toHaveLength(1);
    const loser = outcomes.find((result) => result.status !== 200)!;
    expect(['MAKER_PO_STATE_CHANGED', 'MAKER_PO_RETURN_ONLY_DRAFT', 'MAKER_PO_TRANSITION_BLOCKED']).toContain(loser.body.code);
  });

  it('queue: limit, unique keys, done evidence and chosen terms leave, refusal carries no amount', async () => {
    const undecided = await approvedOrder('undetermined');
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    const revision = await registerRevision(sevenPoId, orderId);
    const pdfId = `SIG-P1-QL-${nextTag()}`;
    const pending = await approve(revision.body.id, 'customer', (await evidence(sevenPoId, orderId, 'customer_generated', pdfId, 'application/pdf')).version.id, pdfId);
    const before = await get('admin', '/api/representative-queue');
    const keys = before.body.items.map((item: { key: string }) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(before.body.items.some((item: { key: string }) => item.key === `approval_evidence_verification:${pending.body.approvalEvent.id}`)).toBe(true);
    const limited = await get('admin', '/api/representative-queue?limit=1');
    expect(limited.body.truncated).toBe(true);
    for (const value of ['0', 'abc', '501']) expect((await get('admin', `/api/representative-queue?limit=${value}`)).status).toBe(200);
    expect((await post('admin', `/api/artwork-approval-events/${pending.body.approvalEvent.id}/verification`, { result: 'rejected', reasonNote: '署名なし' })).status).toBe(201);
    expect((await patchTerms('staff', undecided.orderId, 'prepaid')).body.status).toBe('MAKER_PO_READY');
    const after = await get('admin', '/api/representative-queue');
    expect(after.body.items.some((item: { key: string }) => item.key === `approval_evidence_verification:${pending.body.approvalEvent.id}`)).toBe(false);
    expect(after.body.blocked.some((item: { key: string }) => item.key === `payment_terms_undetermined:${undecided.orderId}`)).toBe(false);
    const refused = await get('staff', '/api/representative-queue');
    expect(JSON.stringify(refused.body)).not.toMatch(/480000|totalAmount/);
  });

  it('P-4: admin self document verification, independent admin verification, rejected self, viewer refused, staff audit row', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    const own = await upload(sevenPoId, orderId, { documentType: 'acceptance_evidence', designKey: undefined }, 'admin');
    expect((await post('admin', `/api/documents/${own.document.id}/verify`, { verificationStatus: 'verified' })).body)
      .toMatchObject({ selfVerification: true, selfVerificationBasis: 'admin_self_verification_p4' });
    const staffDoc = await upload(sevenPoId, orderId, { documentType: 'acceptance_evidence', designKey: undefined });
    // Decision 2: even a 'mismatch' verdict on one's own upload is refused, and nothing is recorded.
    expect((await post('staff', `/api/documents/${staffDoc.document.id}/verify`, { verificationStatus: 'mismatch' })).body.code).toBe('SELF_VERIFICATION_FORBIDDEN');
    expect(await db.select().from(auditEvents).where(and(eq(auditEvents.action, 'DOCUMENT_VERIFICATION_RECORDED'), eq(auditEvents.entityId, staffDoc.document.id)))).toHaveLength(0);

    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    const revision = await registerRevision(sevenPoId, orderId);
    const staffPdfId = `SIG-P1-IND-${nextTag()}`;
    const staffPending = await approve(revision.body.id, 'customer', (await evidence(sevenPoId, orderId, 'customer_generated', staffPdfId, 'application/pdf')).version.id, staffPdfId);
    expect((await post('viewer', `/api/artwork-approval-events/${staffPending.body.approvalEvent.id}/verification`, { result: 'confirmed', reasonNote: 'x' })).status).toBe(403);
    const independent = await post('admin', `/api/artwork-approval-events/${staffPending.body.approvalEvent.id}/verification`, { result: 'confirmed', reasonNote: '原本で確認' });
    expect(independent.body).toMatchObject({ selfVerification: false, selfVerificationBasis: 'independent_verifier' });
    const adminPdfId = `SIG-P1-REJ-${nextTag()}`;
    const adminPending = await approve(revision.body.id, 'seven', (await evidence(sevenPoId, orderId, 'seven', adminPdfId, 'application/pdf', 'admin')).version.id, adminPdfId, 'admin');
    const rejected = await post('admin', `/api/artwork-approval-events/${adminPending.body.approvalEvent.id}/verification`, { result: 'rejected', reasonNote: '署名欄が空' });
    expect(rejected.body).toMatchObject({ selfVerification: true, selfVerificationBasis: 'admin_self_verification_p4' });
  });

  it('P-3 / R36: permissions, partial confirmation, and the later delivery stages', async () => {
    const sevenPoId = await sevenPo(filmOnlyProjectId);
    const order = await createOrder(sevenPoId, 'prepaid', filmOnlyProjectId);
    expect((await post('viewer', `/api/projects/${filmOnlyProjectId}/commission-readiness`)).status).toBe(403);
    expect((await post('outsider', `/api/projects/${filmOnlyProjectId}/commission-readiness`)).status).toBe(403);
    const first = await post('staff', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 600, unit: 'sheets' });
    const second = await post('staff', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 400, unit: 'sheets' });
    const doc = await upload(sevenPoId, order.orderId, { documentType: 'acceptance_evidence', designKey: undefined }, 'staff', filmOnlyProjectId);
    await post('admin', `/api/documents/${doc.document.id}/verify`, { verificationStatus: 'verified' });
    expect((await post('admin', `/api/film-deliveries/${first.body.id}/confirmation`, { evidenceDocumentVersionId: doc.version.id })).body.selfVerification).toBe(false);
    const partial = await post('staff', `/api/projects/${filmOnlyProjectId}/commission-readiness`);
    expect(partial.body.readinessState).toBe('PENDING_VERIFICATION');
    expect(partial.body.blocking).toContain('FILM_DELIVERY_PENDING_CONFIRMATION');
    // The full 1,000 is delivered (600 + 400), so the quantity itself is complete.
    expect(partial.body.blocking).not.toContain('FILM_DELIVERY_QUANTITY_INCOMPLETE');
    const status = await get('staff', `/api/film-supply-orders/${order.orderId}/delivery-status`);
    expect(status.body.lines[0]).toMatchObject({ deliveredDisplay: '1,000 枚', confirmedDisplay: '600 枚' });
    expect(status.body.nextAction).toMatchObject({ action: 'CONFIRM_DELIVERY', deliveryIds: [second.body.id] });
    const doc2 = await upload(sevenPoId, order.orderId, { documentType: 'acceptance_evidence', designKey: undefined }, 'staff', filmOnlyProjectId);
    await post('admin', `/api/documents/${doc2.document.id}/verify`, { verificationStatus: 'verified' });
    expect((await post('staff', `/api/film-deliveries/${second.body.id}/confirmation`, { evidenceDocumentVersionId: doc2.version.id })).body.code).toBe('SELF_VERIFICATION_FORBIDDEN');
    expect((await post('admin', `/api/film-deliveries/${second.body.id}/confirmation`, { evidenceDocumentVersionId: doc2.version.id })).status).toBe(201);
    await db.update(filmSupplyOrders).set({ status: 'FILM_SHIPPED' as any }).where(eq(filmSupplyOrders.id, order.orderId));
    expect((await get('staff', `/api/film-supply-orders/${order.orderId}/delivery-status`)).body.nextAction.action).toBe('RECORD_FILM_DELIVERED');
    await db.update(filmSupplyOrders).set({ status: 'FILM_DELIVERED' as any }).where(eq(filmSupplyOrders.id, order.orderId));
    expect((await get('staff', `/api/film-supply-orders/${order.orderId}/delivery-status`)).body.nextAction.action).toBe('CLOSE_ORDER');
    const closed = await post('staff', `/api/film-supply-orders/${order.orderId}/receipt-assumption`, { note: '受領問題なし（合成）', acknowledgeNoEvidence: true });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const done = await get('viewer', `/api/film-supply-orders/${order.orderId}/delivery-status`);
    expect(done.body).toMatchObject({ stage: 'completed', nextAction: null, receiptAssumption: { assumedBy: { id: staffId }, note: '受領問題なし（合成）' } });
    const units = (await get('viewer', '/api/status-labels')).body.units;
    expect(Object.keys(units).sort()).toEqual(['meters', 'pieces', 'pods', 'rolls', 'sheets']);
    expect(units.pods.symbol).toBe('ポッド');
    expect(units.pieces.symbol).toBe('個');
  });
});

// ------------------------------------------------ independent review round 2 (REVIEW_REPORT H1, M1-M4)
describe('P1 review round 2', () => {
  async function approveOrg(sevenPoId: string, orderId: string, revisionId: string, organization: 'customer' | 'seven') {
    const identifier = `MSG-P1-R2-${organization}-${nextTag()}`;
    const doc = await evidence(sevenPoId, orderId, organization === 'seven' ? 'seven' : 'customer_generated', identifier);
    const recorded = await approve(revisionId, organization, doc.version.id, identifier);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    return recorded;
  }
  async function freshFilmOnlyProject() {
    const id = uuidv7();
    const now = new Date();
    await db.insert(projects).values({
      id, code: `P1-H1-${nextTag()}`, name: '合成H1案件', businessUnit: 'F1', route: 'F1', leadSource: 'KANEI', status: 'DRAFT',
      endCustomerAccountId: customerAccountId, sevenAccountId, makerAccountId, createdByUserId: adminId, createdAt: now, updatedAt: now
    });
    await db.insert(projectAssignments).values({ id: uuidv7(), userId: staffId, projectId: id });
    return id;
  }
  async function deliverAndConfirm(project: string, sevenPoId: string, order: { orderId: string; lineId: string }, quantity: number) {
    const delivery = await post('staff', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: quantity, unit: 'sheets' });
    expect(delivery.status).toBe(201);
    const doc = await upload(sevenPoId, order.orderId, { documentType: 'acceptance_evidence', designKey: undefined }, 'staff', project);
    expect((await post('admin', `/api/documents/${doc.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
    expect((await post('admin', `/api/film-deliveries/${delivery.body.id}/confirmation`, { evidenceDocumentVersionId: doc.version.id })).status).toBe(201);
    return delivery.body.id as string;
  }

  it('H1: a film-only project is not READY while an order is delivered short or not delivered at all', async () => {
    const project = await freshFilmOnlyProject();
    const sevenPoId = await sevenPo(project);
    const first = await createOrder(sevenPoId, 'prepaid', project);
    const second = await createOrder(sevenPoId, 'prepaid', project);
    await deliverAndConfirm(project, sevenPoId, first, 300);
    const evaluate = () => post('staff', `/api/projects/${project}/commission-readiness`);
    const partial = await evaluate();
    expect(partial.body).toMatchObject({ readinessState: 'PENDING_VERIFICATION', isReady: false, commissionCalculationAllowed: false });
    expect(partial.body.blocking).toEqual(['FILM_ORDER_NOT_DELIVERED', 'FILM_DELIVERY_QUANTITY_INCOMPLETE']);
    expect(partial.body.filmOrders).toEqual({ total: 2, withoutDelivery: 1, quantityIncomplete: 1 });
    const status = await get('staff', `/api/film-supply-orders/${first.orderId}/delivery-status`);
    expect(status.body).toMatchObject({ stage: 'partially_delivered', nextAction: { action: 'RECORD_DELIVERY', label: '残りの納品を記録する' } });
    expect(status.body.lines[0]).toMatchObject({ quantityComplete: false, confirmedDisplay: '300 枚' });

    await deliverAndConfirm(project, sevenPoId, first, 700);
    const oneLeft = await evaluate();
    expect(oneLeft.body.blocking).toEqual(['FILM_ORDER_NOT_DELIVERED']);
    // A short delivery that the order closes as delivered counts as fixed.
    await deliverAndConfirm(project, sevenPoId, second, 900);
    expect((await evaluate()).body.blocking).toEqual(['FILM_DELIVERY_QUANTITY_INCOMPLETE']);
    await db.update(filmSupplyOrders).set({ status: 'FILM_DELIVERED' as any }).where(eq(filmSupplyOrders.id, second.orderId));
    const ready = await evaluate();
    expect(ready.body).toMatchObject({ readinessState: 'READY', isReady: true, blocking: [], filmOrders: { total: 2, withoutDelivery: 0, quantityIncomplete: 0 } });
    // A cancelled order is not part of the project's film to deliver.
    const third = await createOrder(sevenPoId, 'prepaid', project);
    expect((await evaluate()).body.blocking).toEqual(['FILM_ORDER_NOT_DELIVERED']);
    await db.update(filmSupplyOrders).set({ status: 'CANCELLED' as any }).where(eq(filmSupplyOrders.id, third.orderId));
    expect((await evaluate()).body.readinessState).toBe('READY');
    // Any filling order row (even one never delivered) makes the project filling-linked: the old rule applies.
    expect((await post('staff', `/api/projects/${project}/filling-orders`, { code: `FILLO-H1-${nextTag()}`, lines: [{ lineNumber: 1, description: '充填', orderedQuantity: 10, unit: 'pods' }] })).status).toBe(201);
    const linked = await evaluate();
    expect(linked.body).toMatchObject({ readinessState: 'PENDING_VERIFICATION', fillingRequirement: 'required' });
    expect(linked.body.blocking).toContain('FILLING_DELIVERY_NOT_RECORDED');
  });

  it('M1: an approval recorded before デザインデータ受領 writes no state; the steps come one by one afterwards', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    const revision = await registerRevision(sevenPoId, orderId);
    await approveOrg(sevenPoId, orderId, revision.body.id, 'customer');
    const second = await approveOrg(sevenPoId, orderId, revision.body.id, 'seven');
    expect(second.body).toMatchObject({ dualApproved: true, orderStatus: 'SEVEN_PO_VERIFIED', autoAdvanced: [] });
    const manual = await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    expect(manual.body.status).toBe('MAKER_PO_READY');
    const statuses = (await transitionRows(orderId)).map((row) => `${(row.beforeState as { status: string }).status}>${(row.afterState as { status: string }).status}`);
    expect(statuses).toEqual([
      'DRAFT>SEVEN_PO_VERIFIED', 'SEVEN_PO_VERIFIED>ARTWORK_RECEIVED', 'ARTWORK_RECEIVED>PROOF_READY',
      'PROOF_READY>APPROVAL_PENDING', 'APPROVAL_PENDING>DUAL_APPROVED', 'DUAL_APPROVED>MAKER_PO_READY'
    ]);
  });

  it('M2: a re-approval after a revoke continues to 製造先発注準備完了 instead of stopping at 校了', async () => {
    const chain = await approvedOrder('undetermined');
    const memoId = `MEMO-P1-R2-${nextTag()}`;
    const memo = await evidence(chain.sevenPoId, chain.orderId, 'kanei', memoId);
    expect((await post('staff', `/api/artwork-revisions/${chain.revisionId}/approvals`, {
      organization: 'customer', decision: 'REVOKE', evidenceSource: 'email', eventTime: '2026-11-16T10:00:00.000Z', evidenceIdentifier: memoId, evidenceDocumentVersionId: memo.version.id
    })).status).toBe(201);
    expect((await patchTerms('staff', chain.orderId, 'prepaid')).body).toMatchObject({ status: 'DUAL_APPROVED', autoAdvanced: [] });
    const again = await approveOrg(chain.sevenPoId, chain.orderId, chain.revisionId, 'customer');
    expect(again.body).toMatchObject({ orderStatus: 'MAKER_PO_READY', autoAdvanced: [{ from: 'DUAL_APPROVED', to: 'MAKER_PO_READY' }] });
  });

  it('M3/M4: a review cycle asks for the change once, never loops, and needs re-approval before the order moves on', async () => {
    const chain = await approvedOrder('prepaid');
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_READY');
    // Manual review without a new proof, restarted into デザインデータ受領.
    expect((await post('staff', `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'CHANGE_REVIEW' })).status).toBe(200);
    expect((await post('staff', `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).body.status).toBe('ARTWORK_RECEIVED');
    const changeEvidence = await evidence(chain.sevenPoId, chain.orderId, 'customer_generated', `CHG-${nextTag()}`);
    const proof = await upload(chain.sevenPoId, chain.orderId, { designKey: 'label-front', contentBase64: b64(`p1 artwork v2 ${nextTag()}\n`) });
    const noFacts = await post('staff', `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, { designKey: 'label-front', fileDocumentVersionId: proof.version.id });
    expect(noFacts.body.code).toBe('CHANGE_REQUEST_ORGANIZATION_REQUIRED');
    const withFacts = await post('staff', `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, {
      designKey: 'label-front', fileDocumentVersionId: proof.version.id, lotMarking: 'LOT-B',
      changeRequest: { requestedOrganization: 'customer', reason: '色の変更', evidenceDocumentVersionId: changeEvidence.version.id, impactSchedule: 'なし', impactQuantity: 0, impactAmount: 0, actualCost: 0 }
    });
    expect(withFacts.status, JSON.stringify(withFacts.body)).toBe(201);
    // The review that already covers this change is not entered again.
    expect(withFacts.body).toMatchObject({ status: 'APPROVAL_PENDING', invalidatedApprovals: true });
    const proof3 = await upload(chain.sevenPoId, chain.orderId, { designKey: 'label-front', contentBase64: b64(`p1 artwork v3 ${nextTag()}\n`) });
    const sameCycle = await post('staff', `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, { designKey: 'label-front', fileDocumentVersionId: proof3.version.id });
    expect(sameCycle.status, JSON.stringify(sameCycle.body)).toBe(201);
    expect(sameCycle.body.status).toBe('APPROVAL_PENDING');
    await approveOrg(chain.sevenPoId, chain.orderId, sameCycle.body.id, 'customer');
    const done = await approveOrg(chain.sevenPoId, chain.orderId, sameCycle.body.id, 'seven');
    expect(done.body.orderStatus).toBe('MAKER_PO_READY');

    // Keep-the-proof restart: review → 校了確認待ち keeps the current proof, but the old approvals do not count.
    const kept = await approvedOrder('prepaid');
    expect((await post('staff', `/api/film-supply-orders/${kept.orderId}/transitions`, { to: 'CHANGE_REVIEW' })).status).toBe(200);
    expect((await post('staff', `/api/film-supply-orders/${kept.orderId}/transitions`, { to: 'APPROVAL_PENDING' })).body.status).toBe('APPROVAL_PENDING');
    const stalled = await post('staff', `/api/film-supply-orders/${kept.orderId}/auto-advance`);
    expect(stalled.body).toMatchObject({ status: 'APPROVAL_PENDING', steps: [] });
    expect((await get('staff', `/api/film-supply-orders/${kept.orderId}/auto-advance`)).body.nextAutomatic.blockers[0].code).toBe('DUAL_APPROVAL_REQUIRED');
    await approveOrg(kept.sevenPoId, kept.orderId, kept.revisionId, 'customer');
    const reapproved = await approveOrg(kept.sevenPoId, kept.orderId, kept.revisionId, 'seven');
    expect(reapproved.body.orderStatus).toBe('MAKER_PO_READY');
    // Keep-the-proof restart into 校正ゲラ準備完了 takes the proof step with the current revision.
    const proofKept = await approvedOrder('prepaid');
    await post('staff', `/api/film-supply-orders/${proofKept.orderId}/transitions`, { to: 'CHANGE_REVIEW' });
    await post('staff', `/api/film-supply-orders/${proofKept.orderId}/transitions`, { to: 'PROOF_READY' });
    expect((await post('staff', `/api/film-supply-orders/${proofKept.orderId}/auto-advance`)).body.status).toBe('APPROVAL_PENDING');
  });

  it('M8: the queue lists only the latest pending approval of an organization (a superseded one leaves)', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    await post('staff', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    const revision = await registerRevision(sevenPoId, orderId);
    const pdfId = `SIG-P1-SUP-${nextTag()}`;
    const pending = await approve(revision.body.id, 'customer', (await evidence(sevenPoId, orderId, 'customer_generated', pdfId, 'application/pdf')).version.id, pdfId);
    const key = `approval_evidence_verification:${pending.body.approvalEvent.id}`;
    expect((await get('admin', '/api/representative-queue')).body.items.some((item: { key: string }) => item.key === key)).toBe(true);
    await approveOrg(sevenPoId, orderId, revision.body.id, 'customer');
    expect((await get('admin', '/api/representative-queue')).body.items.some((item: { key: string }) => item.key === key)).toBe(false);
  });

  it('N1: after a change review the manual DUAL_APPROVED recovery also needs re-approval', async () => {
    const chain = await approvedOrder('prepaid');
    await post('staff', `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'CHANGE_REVIEW' });
    expect((await post('staff', `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'APPROVAL_PENDING' })).body.status).toBe('APPROVAL_PENDING');
    const manual = await post('staff', `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'DUAL_APPROVED' });
    expect(manual.status).toBe(422);
    expect(manual.body.code).toBe('DUAL_APPROVAL_REQUIRED');
    expect(manual.body.missingApprovals).toHaveLength(2);
    expect(manual.body.reapprovalRequiredSince).toBeTruthy();
    expect(await orderStatus(chain.orderId)).toBe('APPROVAL_PENDING');
    await approveOrg(chain.sevenPoId, chain.orderId, chain.revisionId, 'customer');
    expect((await approveOrg(chain.sevenPoId, chain.orderId, chain.revisionId, 'seven')).body.orderStatus).toBe('MAKER_PO_READY');
    // Without any review, the manual recovery keeps its plain live gate.
    const plain = await createOrder(await sevenPo());
    await post('staff', `/api/film-supply-orders/${plain.orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    expect((await post('staff', `/api/film-supply-orders/${plain.orderId}/transitions`, { to: 'DUAL_APPROVED' })).body.code).toBe('INVALID_TRANSITION');
  });

  it('N2: a printed order with a covered review cycle still enters CHANGE_REVIEW on a new proof (admin, with facts)', async () => {
    const chain = await approvedOrder('prepaid');
    await post('staff', `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'CHANGE_REVIEW' });
    await post('staff', `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'APPROVAL_PENDING' });
    // Legacy shape (before P1 the manual steps could reach production from here).
    await db.update(filmSupplyOrders).set({ status: 'FILM_IN_PRODUCTION' as any }).where(eq(filmSupplyOrders.id, chain.orderId));
    const changeEvidence = await evidence(chain.sevenPoId, chain.orderId, 'customer_generated', `CHG-N2-${nextTag()}`);
    const proof = await upload(chain.sevenPoId, chain.orderId, { designKey: 'label-front', contentBase64: b64(`p1 printed v2 ${nextTag()}\n`) });
    const body = {
      designKey: 'label-front', fileDocumentVersionId: proof.version.id, lotMarking: 'LOT-N2',
      changeRequest: { requestedOrganization: 'customer', reason: '印刷後の修正', evidenceDocumentVersionId: changeEvidence.version.id, impactSchedule: '3日遅れ', impactQuantity: 0, impactAmount: 0, actualCost: 12000 }
    };
    expect((await post('staff', `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, body)).body.code).toBe('PRINTED_CHANGE_ADMIN_APPROVAL_REQUIRED');
    const printed = await post('admin', `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, body);
    expect(printed.status, JSON.stringify(printed.body)).toBe(201);
    expect(printed.body).toMatchObject({ status: 'CHANGE_REVIEW', invalidatedApprovals: true });
    expect(await orderStatus(chain.orderId)).toBe('CHANGE_REVIEW');
  });

  it('Y7: the queue limit is 100 by default, follows a valid value and is capped at 500', async () => {
    expect((await get('admin', '/api/representative-queue')).body.limit).toBe(100);
    expect((await get('admin', '/api/representative-queue?limit=7')).body.limit).toBe(7);
    expect((await get('admin', '/api/representative-queue?limit=500')).body.limit).toBe(500);
    expect((await get('admin', '/api/representative-queue?limit=10000')).body.limit).toBe(500);
    for (const value of ['0', '-1', 'abc', '2.5']) expect((await get('admin', `/api/representative-queue?limit=${value}`)).body.limit).toBe(100);
  });

  it('decision 2: staff may not confirm a delivery on evidence they uploaded; admin may, recorded as self-verification', async () => {
    const project = await freshFilmOnlyProject();
    const sevenPoId = await sevenPo(project);
    const order = await createOrder(sevenPoId, 'prepaid', project);
    const delivery = await post('staff', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 1000, unit: 'sheets' });
    const adminDoc = await upload(sevenPoId, order.orderId, { documentType: 'acceptance_evidence', designKey: undefined }, 'admin', project);
    expect((await post('admin', `/api/documents/${adminDoc.document.id}/verify`, { verificationStatus: 'verified' })).body.selfVerification).toBe(true);
    const own = await post('admin', `/api/film-deliveries/${delivery.body.id}/confirmation`, { evidenceDocumentVersionId: adminDoc.version.id });
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ selfVerification: true, selfVerificationBasis: 'admin_self_verification_p4' });
    const [audit] = await db.select().from(auditEvents).where(and(eq(auditEvents.action, 'FILM_DELIVERY_CONFIRMED'), eq(auditEvents.id, own.body.auditEventId)));
    expect(audit!.afterState).toMatchObject({ selfVerification: true, confirmedByUserId: adminId });
  });
});

describe('P1 integration review (H1 / M1 / M2 / X1 / X2)', () => {
  const OTHER = '01a1e8eb-0000-7000-8000-000000000001';
  const card = async (poId: string) => (await get('admin', `/api/maker-purchase-orders/${poId}/approval-card`)).body.makerPurchaseOrder.approvalSnapshotSha256 as string;

  it('X1/X2: on the real app a write naming another project is refused 409 before the handler (maker PO join resolved)', async () => {
    const { orderId } = await approvedOrder();
    const paper = await createPaper(orderId);
    const body = { expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: await card(paper.body.id) };
    const refused = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, body, { 'x-kanei-expected-project': OTHER });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PROJECT_CONTEXT_MISMATCH');
    expect((await get('admin', `/api/maker-purchase-orders/${paper.body.id}`)).body.purchaseOrder.status).toBe('DRAFT');
    const approved = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, body, { 'x-kanei-expected-project': projectId });
    expect(approved.status).toBe(200);
  });

  it('M1: without a session the answer is 401 whatever the target; an unassigned id and a missing id answer the same', async () => {
    const { orderId } = await approvedOrder();
    const anonymous = await app.request(`/api/film-supply-orders/${orderId}/transitions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-kanei-expected-project': OTHER }, body: JSON.stringify({ to: 'ON_HOLD' })
    });
    expect(anonymous.status).toBe(401);
    const existing = await post('outsider', `/api/film-supply-orders/${orderId}/transitions`, { to: 'ON_HOLD', holdReason: 'x' }, { 'x-kanei-expected-project': OTHER });
    const missing = await post('outsider', `/api/film-supply-orders/${uuidv7()}/transitions`, { to: 'ON_HOLD', holdReason: 'x' }, { 'x-kanei-expected-project': OTHER });
    expect(existing.status).not.toBe(409);
    expect(existing.body.code).not.toBe('PROJECT_CONTEXT_MISMATCH');
    expect([existing.status, missing.status].every((status) => status === 403 || status === 404)).toBe(true);
  });

  it('M2: the representative sets the amount pinned to the card; the approval then needs the hash that includes it', async () => {
    const { orderId } = await approvedOrder();
    const paper = await createPaper(orderId, false);
    const shown = await card(paper.body.id);
    expect((await send('staff', 'PATCH', `/api/maker-purchase-orders/${paper.body.id}/amounts`, { amounts: { currency: 'JPY', totalAmount: '312000' }, expectedSnapshotSha256: shown })).status).toBe(403);
    const set = await send('admin', 'PATCH', `/api/maker-purchase-orders/${paper.body.id}/amounts`, { amounts: { currency: 'JPY', totalAmount: '312000' }, expectedSnapshotSha256: shown });
    expect(set.status).toBe(200);
    const withAmount = set.body.approvalSnapshotSha256 as string;
    expect(withAmount).not.toBe(shown);
    expect(await card(paper.body.id)).toBe(withAmount);
    // The hash the card showed before the amount no longer approves; the new one does.
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, { expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: shown })).body.code).toBe('MAKER_PO_SNAPSHOT_CHANGED');
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, { expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: withAmount })).status).toBe(200);
  });

  it('H1 / M2: a line added after the card was drawn refuses both the amount and the approval (nothing unseen is approved)', async () => {
    const { orderId } = await approvedOrder();
    const paper = await createPaper(orderId, false);
    const shown = await card(paper.body.id);
    expect((await post('staff', `/api/film-supply-orders/${orderId}/lines`, { lineNumber: 2, description: '追加明細（画面描画後）', orderedQuantity: 10, unit: 'rolls' })).status).toBe(201);
    const amount = await send('admin', 'PATCH', `/api/maker-purchase-orders/${paper.body.id}/amounts`, { amounts: { currency: 'JPY', totalAmount: '1' }, expectedSnapshotSha256: shown });
    expect(amount.status).toBe(409);
    expect(amount.body.code).toBe('MAKER_PO_SNAPSHOT_CHANGED');
    const approval = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, { expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: shown });
    expect(approval.status).toBe(409);
    expect(approval.body.code).toBe('MAKER_PO_SNAPSHOT_CHANGED');
  });
});
