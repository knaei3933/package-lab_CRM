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
    expect(evaluateSelfVerification({ role: 'staff', verifierUserId: 's', originatorUserIds: [null, 's'] }))
      .toEqual({ allowed: true, selfVerification: true, basis: 'existing_staff_rule' });
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
    expect(decided.lastApproval.body.autoAdvanced).toMatchObject([{ from: 'DUAL_APPROVED', to: 'MAKER_PO_READY', rule: 'dual_approved_and_payment_terms_decided' }]);

    const undecided = await approvedOrder('undetermined');
    expect(undecided.lastApproval.body).toMatchObject({ orderStatus: 'DUAL_APPROVED', autoAdvanced: [] });
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
    expect(confirmed.body.autoAdvanced).toMatchObject([{ from: 'DUAL_APPROVED', to: 'MAKER_PO_READY' }]);
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
    const refused = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`);
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
    expect((await post('admin', `/api/maker-purchase-orders/${replacement.body.id}/ceo-approval`)).status).toBe(200);
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
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`)).status).toBe(200);
    const after = await get('admin', '/api/representative-queue');
    expect(itemFor(after.body, `maker_po_ceo_approval:${paper.body.id}`)).toBeUndefined();
    await db.update(filmSupplyOrders).set({ status: 'CANCELLED' as any }).where(eq(filmSupplyOrders.id, heldOrder.orderId));
    const cancelled = await get('admin', '/api/representative-queue');
    expect(itemFor(cancelled.body, `hold_release:${heldOrder.orderId}`)).toBeUndefined();
  });

  it('follows a paper through send verification, final acceptance and the cancellation acknowledgement', async () => {
    const chain = await approvedOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`)).status).toBe(200);
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

  it('labels document and send verifications, and keeps staff document verification as before', async () => {
    const sevenPoId = await sevenPo();
    const { orderId } = await createOrder(sevenPoId);
    const staffDoc = await upload(sevenPoId, orderId, { documentType: 'acceptance_evidence', designKey: undefined });
    const byStaff = await post('staff', `/api/documents/${staffDoc.document.id}/verify`, { verificationStatus: 'verified' });
    expect(byStaff.status).toBe(200);
    expect(byStaff.body).toMatchObject({ selfVerification: true, selfVerificationBasis: 'existing_staff_rule', verifiedByUserId: staffId });
    const otherDoc = await upload(sevenPoId, orderId, { documentType: 'acceptance_evidence', designKey: undefined });
    const byAdmin = await post('admin', `/api/documents/${otherDoc.document.id}/verify`, { verificationStatus: 'verified' });
    expect(byAdmin.body).toMatchObject({ selfVerification: false, selfVerificationBasis: 'independent_verifier', verifiedBy: { id: adminId } });
    expect((await post('viewer', `/api/documents/${otherDoc.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(403);

    const chain = await approvedOrder('prepaid');
    const paper = await createPaper(chain.orderId);
    expect((await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`)).status).toBe(200);
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
    return await post('staff', `/api/film-deliveries/${deliveryId}/confirmation`, { evidenceDocumentVersionId: doc.version.id });
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
    expect(confirmed.body.selfVerification).toBe(true);
    const ready = await evaluate();
    expect(ready.body).toMatchObject({ readinessState: 'READY', isReady: true, blocking: [], commissionCalculationAllowed: true, fillingRequirement: 'not_applicable' });
    expect(ready.body.filmDeliveredQuantities).toMatchObject([{ orderCode: order.code, lineNumber: 1, deliveredQuantity: '1000.000', confirmedQuantity: '1000.000', display: { confirmed: '1,000 枚' } }]);
    const status2 = await get('staff', `/api/film-supply-orders/${order.orderId}/delivery-status`);
    expect(status2.body.stage).toBe('quantity_confirmed');
    expect(status2.body.lines[0].deliveries[0].confirmation).toMatchObject({ confirmedBy: { id: staffId }, selfVerification: true });
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
