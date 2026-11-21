/**
 * P2 server (representative approval 2026-11-21, API_CONTRACT v1):
 * R30 希望納期・納品予定日, R30/P-8 セブン化学発注書 quantity and amount, R33 maker
 * master and recipientAddressId, R32 stored maker PO numbers, R29 display
 * language, R22 デザイン入稿データ, P-2 auditor role, and the viewer answers kept
 * exactly as in P1 (fail-closed defaults changed shape internally).
 * Every rule has normal, refusal and permission cases across admin, assigned
 * staff, unassigned staff, viewer, assigned auditor and unassigned auditor.
 * Runs only against kanei_crm_mvp_test (tests/setup.ts). The idempotency store
 * is covered by tests/p2-idempotency-store.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  accounts,
  auditEvents,
  createDatabase,
  documents,
  filmSupplyOrders,
  makerPoDisplayNumbers,
  makerPoEvents,
  makerPurchaseOrders,
  makerRecipientAddresses,
  projectAssignments,
  projects,
  sessions,
  sevenPoOrderFacts,
  users,
  uuidv7
} from '@kanei/db';
import { buildMakerPoSnapshot, canonicalJson, computeMakerPoSnapshotSha256, jstYear } from '@kanei/core';
import { createApp } from '../apps/api/src/app.js';
import { issueToken, SESSION_COOKIE, sessionTokenHashForRole } from '../apps/api/src/auth.js';
import { withApprovalSnapshot } from './helpers/approval-snapshot.js';
import { hashPassword } from '../apps/api/src/password.js';
import { checkSchemaPreflight, REQUIRED_MIGRATION } from '../apps/api/src/schema-preflight.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('p2-server tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);

const ids = {
  admin: uuidv7(), staff: uuidv7(), staffOut: uuidv7(), viewer: uuidv7(), auditor: uuidv7(), auditorOut: uuidv7(),
  customer: uuidv7(), seven: uuidv7(), makerA: uuidv7(), makerB: uuidv7(),
  projectA: uuidv7(), projectB: uuidv7()
};
const PROJECT_CODE = 'P2-PROJECT-A';

const tokens = { admin: '', staff: '', staffOut: '', viewer: '', auditor: '', auditorOut: '' };
type Role = keyof typeof tokens;
const ALL_ROLES: Role[] = ['admin', 'staff', 'staffOut', 'viewer', 'auditor', 'auditorOut'];
let app: ReturnType<typeof createApp>;

let counter = 0;
function nextTag(): string {
  counter += 1;
  return `${Date.now().toString(36)}${String(counter).padStart(3, '0')}`;
}
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const keysOf = (value: unknown) => Object.keys(value as object).sort();

async function send(role: Role | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(role ? { cookie: `${SESSION_COOKIE}=${tokens[role]}` } : {}),
      ...headers
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, text, headers: response.headers };
}
const post = (role: Role, url: string, body?: unknown, headers?: Record<string, string>) => send(role, 'POST', url, body ?? {}, headers);
const get = (role: Role | null, url: string) => send(role, 'GET', url);
const patch = (role: Role | null, url: string, body?: unknown, headers?: Record<string, string>) => send(role, 'PATCH', url, body ?? {}, headers);
const put = (role: Role | null, url: string, body?: unknown, headers?: Record<string, string>) => send(role, 'PUT', url, body ?? {}, headers);

function fullChecklist() {
  return {
    issuerNameRecorded: true, issuerName: '合成セブン化学P2',
    documentNumberRecorded: true, documentNumber: 'PO-P2-0001',
    issueDateRecorded: true, issueDate: '2026-11-11',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル',
    pastTransactionCompared: true, pastTransactionNote: '過去の発注書と一致',
    quoteCompared: true, quoteMatchesPo: true, quoteComparisonNote: '見積と一致',
    tamperHints: '', uncertain: false, confirmationReplyRecorded: false, confirmationReplyNote: '',
    verificationNote: '合成チェックリストP2'
  };
}

async function sevenPo(project = ids.projectA, checked = true, official = true, role: Role = 'staff') {
  const created = await post(role, `/api/projects/${project}/seven-purchase-orders`, {
    poNumber: `SEVEN-P2-${nextTag()}`, ...(official ? { officialRegisteredAt: '2026-11-01T09:00:00.000Z' } : {})
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  if (checked) {
    expect((await post(role, `/api/seven-purchase-orders/${created.body.id}/verification-checklist`, fullChecklist())).status).toBe(200);
  }
  return created.body.id as string;
}

async function createOrder(sevenPoId: string | null, extra: Record<string, unknown> = {}, project = ids.projectA, role: Role = 'staff') {
  const code = `FSO-P2-${nextTag()}`;
  const created = await post(role, `/api/projects/${project}/film-supply-orders`, {
    code, paymentTerms: 'prepaid', ...(sevenPoId ? { sevenPurchaseOrderId: sevenPoId } : {}),
    lines: [{ lineNumber: 1, description: '合成フィルムP2', orderedQuantity: 1000, unit: 'sheets' }],
    ...extra
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { orderId: created.body.id as string, code, body: created.body };
}

async function upload(sevenPoId: string | null, orderId: string | null, overrides: Record<string, unknown>, role: Role = 'staff', project = ids.projectA) {
  const tag = nextTag();
  return await post(role, `/api/projects/${project}/documents`, {
    documentType: 'proof', issuerEntity: 'kanei', filename: `p2-${tag}.txt`, contentType: 'text/plain',
    contentBase64: b64(`p2 document ${tag}\n`),
    ...(sevenPoId ? { sevenPurchaseOrderId: sevenPoId } : {}),
    ...(orderId ? { filmSupplyOrderId: orderId } : {}),
    ...overrides
  });
}

async function uploadOk(sevenPoId: string | null, orderId: string | null, overrides: Record<string, unknown>, role: Role = 'staff') {
  const response = await upload(sevenPoId, orderId, overrides, role);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as { document: { id: string }; version: { id: string } };
}

async function registerRevision(sevenPoId: string, orderId: string, designKey = 'label-front') {
  const proof = await uploadOk(sevenPoId, orderId, { designKey, contentBase64: b64(`p2 artwork ${nextTag()}\n`) });
  return await post('staff', `/api/film-supply-orders/${orderId}/artwork-revisions`, { designKey, fileDocumentVersionId: proof.version.id });
}

async function evidence(sevenPoId: string, orderId: string, issuerEntity: string, identifier: string, contentType = 'text/plain') {
  return await uploadOk(sevenPoId, orderId, {
    documentType: 'approval_evidence', issuerEntity, designKey: 'label-front', contentType,
    contentBase64: b64(`p2 approval\nidentifier: ${identifier}\n`)
  });
}

function approve(revisionId: string, organization: 'customer' | 'seven', versionId: string, identifier: string) {
  return post('staff', `/api/artwork-revisions/${revisionId}/approvals`, {
    organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
    evidenceIdentifier: identifier, evidenceDocumentVersionId: versionId
  });
}

const identifiersUsed: string[] = [];

async function approveBoth(sevenPoId: string, orderId: string, revisionId: string) {
  let last: Awaited<ReturnType<typeof approve>> | null = null;
  for (const [organization, issuer] of [['customer', 'customer_generated'], ['seven', 'seven']] as const) {
    const identifier = `MSG-P2-${organization.toUpperCase()}-${nextTag()}`;
    identifiersUsed.push(identifier);
    const doc = await evidence(sevenPoId, orderId, issuer, identifier);
    last = await approve(revisionId, organization, doc.version.id, identifier);
    expect(last.status, JSON.stringify(last.body)).toBe(201);
  }
  return last!;
}

/** Through the real endpoints: created, デザインデータ受領, proof, both approvals → MAKER_PO_READY. */
async function approvedOrder() {
  const sevenPoId = await sevenPo();
  const order = await createOrder(sevenPoId);
  expect((await post('staff', `/api/film-supply-orders/${order.orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).status).toBe(200);
  const revision = await registerRevision(sevenPoId, order.orderId);
  expect(revision.status, JSON.stringify(revision.body)).toBe(201);
  const lastApproval = await approveBoth(sevenPoId, order.orderId, revision.body.id);
  return { sevenPoId, ...order, revisionId: revision.body.id as string, lastApproval };
}

const PAPER_AMOUNT = '480000';
const PAPER_RECIPIENT = 'maker-po-p2@example.com';

async function createPaper(orderId: string, body: Record<string, unknown> = { recipientAddress: PAPER_RECIPIENT, amounts: { currency: 'JPY', totalAmount: PAPER_AMOUNT } }) {
  return await post('admin', `/api/film-supply-orders/${orderId}/maker-purchase-orders`, body);
}

async function papersOf(orderId: string) {
  return await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.filmSupplyOrderId, orderId));
}

async function auditRows(action: string, entityId: string) {
  return await db.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.entityId, entityId)));
}

/** Every key at any depth of a JSON value. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) allKeys(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      allKeys(inner, out);
    }
  }
  return out;
}

async function makeMaker(name: string) {
  const created = await post('admin', '/api/maker-accounts', { name, externalCode: `MK-${nextTag()}` });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id as string;
}

async function addAddress(accountId: string, email: string, extra: Record<string, unknown> = {}) {
  const created = await post('admin', `/api/maker-accounts/${accountId}/recipient-addresses`, { email, ...extra });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body as { id: string; email: string; isDefault: boolean; isActive: boolean };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-p2-server-'));
  app = createApp({ db });
  await db.execute(sql`
    truncate table audit_events, delivery_confirmations, film_deliveries, filling_deliveries,
      film_supply_order_lines, filling_order_lines, film_supply_orders, filling_orders,
      seven_purchase_orders, pre_order_references, document_versions, documents,
      artwork_revisions, artwork_approval_events, evidence_manual_verifications,
      maker_po_events, maker_po_send_manual_verifications, maker_purchase_orders, commission_readiness,
      seven_po_order_facts, maker_recipient_addresses, idempotency_keys, maker_po_display_numbers,
      project_assignments, projects, sessions, accounts, users cascade
  `);
  await db.insert(users).values([
    { id: ids.admin, username: 'admin_p2', passwordHash: 'not-a-login-hash', displayName: '合成代表者P2', role: 'admin' },
    { id: ids.staff, username: 'staff_p2', passwordHash: 'not-a-login-hash', displayName: '合成担当者P2', role: 'staff' },
    { id: ids.staffOut, username: 'staff_out_p2', passwordHash: 'not-a-login-hash', displayName: '合成別案件担当P2', role: 'staff' },
    { id: ids.viewer, username: 'viewer_p2', passwordHash: 'not-a-login-hash', displayName: '合成閲覧者P2', role: 'viewer' },
    { id: ids.auditor, username: 'auditor_p2', passwordHash: 'not-a-login-hash', displayName: '合成監査P2', role: 'auditor' },
    { id: ids.auditorOut, username: 'auditor_out_p2', passwordHash: 'not-a-login-hash', displayName: '合成別案件監査P2', role: 'auditor' }
  ]);
  await db.insert(accounts).values([
    { id: ids.customer, name: '合成P2顧客', role: 'end_customer', externalCode: 'P2-CUST' },
    { id: ids.seven, name: '合成P2セブン', role: 'seven', externalCode: 'P2-SEVEN' },
    { id: ids.makerA, name: '合成P2メーカーA', role: 'maker', externalCode: 'P2-MAKER-A' },
    { id: ids.makerB, name: '合成P2メーカーB', role: 'maker', externalCode: 'P2-MAKER-B' }
  ]);
  const now = new Date();
  for (const [id, code, maker] of [[ids.projectA, PROJECT_CODE, ids.makerA], [ids.projectB, 'P2-PROJECT-B', ids.makerB]] as const) {
    await db.insert(projects).values({
      id, code, name: `合成${code}`, businessUnit: 'F1', route: 'F1', leadSource: 'KANEI', status: 'DRAFT',
      endCustomerAccountId: ids.customer, sevenAccountId: ids.seven, makerAccountId: maker, createdByUserId: ids.admin,
      createdAt: now, updatedAt: now
    });
  }
  await db.insert(projectAssignments).values([
    { id: uuidv7(), userId: ids.staff, projectId: ids.projectA },
    { id: uuidv7(), userId: ids.viewer, projectId: ids.projectA },
    { id: uuidv7(), userId: ids.auditor, projectId: ids.projectA },
    { id: uuidv7(), userId: ids.staffOut, projectId: ids.projectB },
    { id: uuidv7(), userId: ids.auditorOut, projectId: ids.projectB }
  ]);
  for (const role of ALL_ROLES) {
    const { token, tokenHash } = issueToken();
    // Migration 0032: an auditor session is stored in the role-aware form.
    const storedHash = sessionTokenHashForRole(tokenHash, role.startsWith('auditor') ? 'auditor' : 'staff');
    await db.insert(sessions).values({ id: uuidv7(), userId: ids[role], tokenHash: storedHash, expiresAt: new Date(Date.now() + 3600_000) });
    tokens[role] = token;
  }
});

afterAll(async () => {
  await pool.end();
});

// ============================================================ R30 納期
describe('R30 希望納期・納品予定日', () => {
  const url = (orderId: string) => `/api/film-supply-orders/${orderId}/delivery-dates`;

  it('stores both dates given at creation and shows them in the order list to every reader', async () => {
    const order = await createOrder(await sevenPo(), { requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: '2026-12-10' });
    const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.orderId));
    expect(row).toMatchObject({ requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: '2026-12-10' });
    for (const role of ['admin', 'staff', 'viewer', 'auditor'] as const) {
      const list = await get(role, `/api/projects/${ids.projectA}/film-supply-orders`);
      expect(list.status, role).toBe(200);
      const listed = list.body.orders.find((candidate: { id: string }) => candidate.id === order.orderId);
      expect(listed, role).toMatchObject({ requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: '2026-12-10' });
    }
  });

  it('defaults both dates to null when creation omits them', async () => {
    const order = await createOrder(await sevenPo());
    const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.orderId));
    expect(row).toMatchObject({ requestedDeliveryDate: null, plannedDeliveryDate: null });
  });

  it('refuses an impossible date at creation with DELIVERY_DATE_INVALID and creates no order', async () => {
    const code = `FSO-P2-BAD-${nextTag()}`;
    const refused = await post('staff', `/api/projects/${ids.projectA}/film-supply-orders`, {
      code, paymentTerms: 'prepaid', requestedDeliveryDate: '2026-02-30'
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('DELIVERY_DATE_INVALID');
    expect(await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.code, code))).toHaveLength(0);
  });

  it('changes only the date that was sent and answers the contract shape', async () => {
    const order = await createOrder(await sevenPo(), { requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: '2026-12-10' });
    const changed = await patch('staff', url(order.orderId), { requestedDeliveryDate: '2027-01-15' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(keysOf(changed.body)).toEqual(['code', 'id', 'plannedDeliveryDate', 'requestedDeliveryDate', 'status', 'updatedAt']);
    expect(changed.body).toMatchObject({ id: order.orderId, code: order.code, requestedDeliveryDate: '2027-01-15', plannedDeliveryDate: '2026-12-10' });
    const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.orderId));
    expect(row).toMatchObject({ requestedDeliveryDate: '2027-01-15', plannedDeliveryDate: '2026-12-10' });
  });

  it('clears a date sent as null', async () => {
    const order = await createOrder(await sevenPo(), { requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: '2026-12-10' });
    const cleared = await patch('admin', url(order.orderId), { plannedDeliveryDate: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: null });
  });

  it('writes exactly one audit row with the before and after dates', async () => {
    const order = await createOrder(await sevenPo(), { requestedDeliveryDate: '2026-12-01' });
    expect((await patch('staff', url(order.orderId), { plannedDeliveryDate: '2026-12-20' })).status).toBe(200);
    const rows = await auditRows('FILM_SUPPLY_ORDER_DELIVERY_DATES_UPDATED', order.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: ids.projectA, actorUserId: ids.staff,
      beforeState: { requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: null },
      afterState: { requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: '2026-12-20' }
    });
  });

  it.each([
    ['an impossible day', { requestedDeliveryDate: '2026-02-30' }],
    ['slashes', { requestedDeliveryDate: '2026/12/01' }],
    ['a number', { plannedDeliveryDate: 20261201 }],
    ['month 13', { plannedDeliveryDate: '2026-13-01' }],
    ['a timestamp', { plannedDeliveryDate: '2026-12-01T00:00:00Z' }],
    ['an empty body', {}],
    ['only unknown keys', { deliveryDate: '2026-12-01' }]
  ])('refuses %s with 422 DELIVERY_DATE_INVALID and writes nothing', async (_name, body) => {
    const order = await createOrder(await sevenPo(), { requestedDeliveryDate: '2026-12-01' });
    const refused = await patch('staff', url(order.orderId), body);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('DELIVERY_DATE_INVALID');
    const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.orderId));
    expect(row).toMatchObject({ requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: null });
    expect(await auditRows('FILM_SUPPLY_ORDER_DELIVERY_DATES_UPDATED', order.orderId)).toHaveLength(0);
  });

  it.each(['viewer', 'auditor', 'staffOut', 'auditorOut'] as const)('refuses %s with 403 FORBIDDEN', async (role) => {
    const order = await createOrder(await sevenPo(), { requestedDeliveryDate: '2026-12-01' });
    const refused = await patch(role, url(order.orderId), { requestedDeliveryDate: '2027-02-01' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    const [row] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.orderId));
    expect(row!.requestedDeliveryDate).toBe('2026-12-01');
  });

  it('refuses a cancelled order with 409 FILM_ORDER_CANCELLED', async () => {
    const order = await createOrder(await sevenPo());
    await db.update(filmSupplyOrders).set({ status: 'CANCELLED' as any }).where(eq(filmSupplyOrders.id, order.orderId));
    const refused = await patch('admin', url(order.orderId), { requestedDeliveryDate: '2027-02-01' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('FILM_ORDER_CANCELLED');
  });

  it('still accepts a change while the order is on hold', async () => {
    const order = await createOrder(await sevenPo());
    expect((await post('staff', `/api/film-supply-orders/${order.orderId}/transitions`, { to: 'ON_HOLD', holdReason: '版下待ち' })).status).toBe(200);
    expect((await patch('staff', url(order.orderId), { requestedDeliveryDate: '2027-03-01' })).status).toBe(200);
  });

  it('answers 401, 400 and 404 for anonymous, malformed and unknown targets', async () => {
    const order = await createOrder(await sevenPo());
    expect((await patch(null, url(order.orderId), { requestedDeliveryDate: '2027-03-01' })).status).toBe(401);
    expect((await patch('admin', url('not-a-uuid'), { requestedDeliveryDate: '2027-03-01' })).body.code).toBe('INVALID_PATH_PARAMETER');
    const missing = await patch('admin', url(uuidv7()), { requestedDeliveryDate: '2027-03-01' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('FILM_SUPPLY_ORDER_NOT_FOUND');
  });

  it('refuses a write drawn for another project with 409 PROJECT_CONTEXT_MISMATCH', async () => {
    const order = await createOrder(await sevenPo());
    const refused = await patch('staff', url(order.orderId), { requestedDeliveryDate: '2027-03-01' }, { 'X-Kanei-Expected-Project': ids.projectB });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PROJECT_CONTEXT_MISMATCH');
  });

  it('shows the dates on the admin approval card, read from the order', async () => {
    const chain = await approvedOrder();
    expect((await patch('staff', url(chain.orderId), { requestedDeliveryDate: '2027-04-01', plannedDeliveryDate: '2027-04-10' })).status).toBe(200);
    const paper = await createPaper(chain.orderId);
    expect(paper.status, JSON.stringify(paper.body)).toBe(201);
    const card = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(card.status).toBe(200);
    expect(card.body.order).toMatchObject({ requestedDeliveryDate: '2027-04-01', plannedDeliveryDate: '2027-04-10' });
    expect(card.body.makerPurchaseOrder.snapshotDrifted).toBe(false);
    // P2 decision (review round): the dates are frozen at approval, so a change
    // on a draft is visible on the card and moves the hash the approval needs.
    expect((await patch('staff', url(chain.orderId), { plannedDeliveryDate: '2027-04-20' })).status).toBe(200);
    const again = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(again.body.order.plannedDeliveryDate).toBe('2027-04-20');
    expect(again.body.makerPurchaseOrder.snapshotDrifted).toBe(true);
    expect(again.body.makerPurchaseOrder.approvalSnapshotSha256).not.toBe(card.body.makerPurchaseOrder.approvalSnapshotSha256);
  });

  it('puts order.updatedAt on the approval card and moves it when a date changes (v1.1)', async () => {
    const chain = await approvedOrder();
    const paper = await createPaper(chain.orderId);
    expect(paper.status).toBe(201);
    const cardUrl = `/api/maker-purchase-orders/${paper.body.id}/approval-card`;
    const first = await get('admin', cardUrl);
    expect(typeof first.body.order.updatedAt).toBe('string');
    const [row] = await db.select({ updatedAt: filmSupplyOrders.updatedAt }).from(filmSupplyOrders).where(eq(filmSupplyOrders.id, chain.orderId));
    expect(new Date(first.body.order.updatedAt).getTime()).toBe(row!.updatedAt.getTime());
    const changed = await patch('staff', url(chain.orderId), { requestedDeliveryDate: '2027-04-02' });
    expect(changed.status).toBe(200);
    const second = await get('admin', cardUrl);
    expect(new Date(second.body.order.updatedAt).getTime()).toBe(new Date(changed.body.updatedAt).getTime());
    expect(new Date(second.body.order.updatedAt).getTime()).toBeGreaterThan(new Date(first.body.order.updatedAt).getTime());
  });
});

// ============================================== R30 / P-8 seven PO facts
describe('R30 セブン化学発注書 quantity and amount', () => {
  const url = (poId: string) => `/api/seven-purchase-orders/${poId}/order-facts`;
  const QUANTITY_KEYS = ['orderedQuantity', 'orderedQuantityDisplay', 'orderedUnit', 'poNumber', 'sevenPurchaseOrderId', 'updatedAt'];
  const ADMIN_KEYS = [...QUANTITY_KEYS, 'currency', 'totalAmount'].sort();
  const AMOUNT = '987654.32';

  async function factsRow(poId: string) {
    const [row] = await db.select().from(sevenPoOrderFacts).where(eq(sevenPoOrderFacts.sevenPurchaseOrderId, poId));
    return row;
  }

  it('lets assigned staff record the quantity and answers without amount keys', async () => {
    const poId = await sevenPo();
    const saved = await put('staff', url(poId), { orderedQuantity: '1000', orderedUnit: 'meters' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(keysOf(saved.body)).toEqual(QUANTITY_KEYS);
    expect(saved.body).toMatchObject({ sevenPurchaseOrderId: poId, orderedQuantity: '1000.000', orderedUnit: 'meters' });
    expect(saved.body.orderedQuantityDisplay).toContain('1,000');
    expect(await factsRow(poId)).toMatchObject({ orderedQuantity: '1000.000', orderedUnit: 'meters', totalAmount: null, currency: null });
  });

  it.each([
    ['both amount keys', { orderedQuantity: '5', orderedUnit: 'rolls', totalAmount: '1', currency: 'JPY' }],
    ['the currency only', { currency: 'JPY' }],
    ['the amount only', { totalAmount: '1' }],
    ['an amount clear', { totalAmount: null, currency: null }]
  ])('refuses staff sending %s with 403 SEVEN_PO_AMOUNT_ADMIN_ONLY and writes nothing', async (_name, body) => {
    const poId = await sevenPo();
    expect((await put('staff', url(poId), { orderedQuantity: '1000', orderedUnit: 'meters' })).status).toBe(200);
    const before = await factsRow(poId);
    const auditBefore = (await auditRows('SEVEN_PO_ORDER_FACTS_UPDATED', poId)).length;
    const refused = await put('staff', url(poId), body);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('SEVEN_PO_AMOUNT_ADMIN_ONLY');
    expect(await factsRow(poId)).toEqual(before);
    expect(await auditRows('SEVEN_PO_ORDER_FACTS_UPDATED', poId)).toHaveLength(auditBefore);
  });

  it('lets admin record the amount and keeps the quantity already stored', async () => {
    const poId = await sevenPo();
    expect((await put('staff', url(poId), { orderedQuantity: '12.5', orderedUnit: 'rolls' })).status).toBe(200);
    const saved = await put('admin', url(poId), { totalAmount: AMOUNT, currency: 'JPY' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(keysOf(saved.body)).toEqual(ADMIN_KEYS);
    expect(saved.body).toMatchObject({ orderedQuantity: '12.500', orderedUnit: 'rolls', totalAmount: AMOUNT, currency: 'JPY' });
  });

  it('clears a pair sent as null', async () => {
    const poId = await sevenPo();
    expect((await put('admin', url(poId), { orderedQuantity: '3', orderedUnit: 'pods', totalAmount: '10', currency: 'JPY' })).status).toBe(200);
    const cleared = await put('admin', url(poId), { orderedQuantity: null, orderedUnit: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ orderedQuantity: null, orderedUnit: null, orderedQuantityDisplay: null, totalAmount: '10.00', currency: 'JPY' });
  });

  it.each([
    ['a quantity without its unit', { orderedQuantity: '10' }],
    ['a unit without its quantity', { orderedUnit: 'rolls' }],
    ['a zero quantity', { orderedQuantity: '0', orderedUnit: 'rolls' }],
    ['four decimals', { orderedQuantity: '1.2345', orderedUnit: 'rolls' }],
    ['an unknown unit', { orderedQuantity: '1', orderedUnit: 'kg' }],
    ['a numeric quantity', { orderedQuantity: 10, orderedUnit: 'rolls' }],
    ['an amount without its currency', { totalAmount: '5' }],
    ['a lower-case currency', { totalAmount: '5', currency: 'jpy' }],
    ['a negative amount', { totalAmount: '-1', currency: 'JPY' }],
    ['three amount decimals', { totalAmount: '1.005', currency: 'JPY' }],
    ['a half-cleared pair', { totalAmount: null, currency: 'JPY' }],
    ['an empty body', {}]
  ])('refuses %s with 422 SEVEN_PO_ORDER_FACTS_INVALID', async (_name, body) => {
    const poId = await sevenPo();
    const refused = await put('admin', url(poId), body);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('SEVEN_PO_ORDER_FACTS_INVALID');
    expect(await factsRow(poId)).toBeUndefined();
  });

  it.each(['viewer', 'auditor', 'staffOut', 'auditorOut'] as const)('refuses a write by %s with 403 FORBIDDEN', async (role) => {
    const poId = await sevenPo();
    const refused = await put(role, url(poId), { orderedQuantity: '1', orderedUnit: 'rolls' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(await factsRow(poId)).toBeUndefined();
  });

  it('refuses a write drawn for another project with 409 PROJECT_CONTEXT_MISMATCH', async () => {
    const poId = await sevenPo();
    const refused = await put('staff', url(poId), { orderedQuantity: '1', orderedUnit: 'rolls' }, { 'X-Kanei-Expected-Project': ids.projectB });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PROJECT_CONTEXT_MISMATCH');
    expect(await factsRow(poId)).toBeUndefined();
  });

  describe('reading the facts by role', () => {
    let poId = '';
    beforeAll(async () => {
      poId = await sevenPo();
      expect((await put('admin', url(poId), { orderedQuantity: '1000', orderedUnit: 'sheets', totalAmount: AMOUNT, currency: 'JPY' })).status).toBe(200);
    });

    it('answers admin with the amount', async () => {
      const read = await get('admin', url(poId));
      expect(read.status).toBe(200);
      expect(keysOf(read.body)).toEqual(ADMIN_KEYS);
      expect(read.body).toMatchObject({ totalAmount: AMOUNT, currency: 'JPY' });
    });

    it.each(['staff', 'auditor'] as const)('answers %s with the quantity and no amount keys at all', async (role) => {
      const read = await get(role, url(poId));
      expect(read.status).toBe(200);
      expect(keysOf(read.body)).toEqual(QUANTITY_KEYS);
      expect(read.text).not.toContain('987654');
      expect(read.body.orderedQuantity).toBe('1000.000');
    });

    it.each(['viewer', 'staffOut', 'auditorOut'] as const)('refuses %s with 403', async (role) => {
      const read = await get(role, url(poId));
      expect(read.status).toBe(403);
      expect(read.text).not.toContain('987654');
    });

    it('answers the null shape before anything is recorded', async () => {
      const empty = await sevenPo();
      const read = await get('staff', url(empty));
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ sevenPurchaseOrderId: empty, orderedQuantity: null, orderedUnit: null, orderedQuantityDisplay: null, updatedAt: null });
    });

    it('answers 401, 400 and 404', async () => {
      expect((await get(null, url(poId))).status).toBe(401);
      expect((await get('admin', url('nope'))).body.code).toBe('INVALID_PATH_PARAMETER');
      const missing = await get('admin', url(uuidv7()));
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('SEVEN_PO_NOT_FOUND');
    });

    it.each(['staff', 'auditor', 'viewer'] as const)('never shows the amount in the audit history of %s', async (role) => {
      const history = await get(role, `/api/projects/${ids.projectA}/audit-history?limit=500&order=desc`);
      expect(history.status).toBe(200);
      const row = history.body.events.find((event: { action: string; entityId: string }) => event.action === 'SEVEN_PO_ORDER_FACTS_UPDATED' && event.entityId === poId);
      expect(row).toBeTruthy();
      expect(history.text).not.toContain('987654');
      expect(allKeys(history.body).has('totalAmount')).toBe(false);
    });

    it('keeps the amount in the admin audit history', async () => {
      const history = await get('admin', `/api/projects/${ids.projectA}/audit-history?limit=500&order=desc`);
      const row = history.body.events.find((event: { action: string; entityId: string }) => event.action === 'SEVEN_PO_ORDER_FACTS_UPDATED' && event.entityId === poId);
      expect(row.afterState).toMatchObject({ totalAmount: AMOUNT, currency: 'JPY' });
    });
  });

  it('puts the admin facts on the approval card as sevenPurchaseOrder.orderFacts', async () => {
    const chain = await approvedOrder();
    expect((await put('admin', url(chain.sevenPoId), { orderedQuantity: '1000', orderedUnit: 'sheets', totalAmount: '312000', currency: 'JPY' })).status).toBe(200);
    const paper = await createPaper(chain.orderId);
    expect(paper.status).toBe(201);
    const card = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(card.status).toBe(200);
    expect(card.body.sevenPurchaseOrder.orderFacts).toMatchObject({
      sevenPurchaseOrderId: chain.sevenPoId, orderedQuantity: '1000.000', orderedUnit: 'sheets', totalAmount: '312000.00', currency: 'JPY'
    });
    expect(keysOf(card.body.sevenPurchaseOrder.orderFacts)).toEqual(['currency', 'orderedQuantity', 'orderedQuantityDisplay', 'orderedUnit', 'sevenPurchaseOrderId', 'totalAmount', 'updatedAt']);
  });
});

// ======================================================== R33 maker master
describe('R33 maker master and recipient addresses', () => {
  it('lists every maker with inactive addresses to admin only', async () => {
    const maker = await makeMaker(`合成P2一覧メーカー${nextTag()}`);
    const address = await addAddress(maker, `list-${nextTag()}@maker.example.com`);
    expect((await patch('admin', `/api/maker-recipient-addresses/${address.id}`, { isActive: false })).status).toBe(200);
    const listed = await get('admin', '/api/maker-accounts');
    expect(listed.status).toBe(200);
    const entry = listed.body.makers.find((candidate: { id: string }) => candidate.id === maker);
    expect(entry.recipientAddresses).toMatchObject([{ id: address.id, isActive: false }]);
    for (const role of ['staff', 'staffOut', 'viewer', 'auditor', 'auditorOut'] as const) {
      const refused = await get(role, '/api/maker-accounts');
      expect(refused.status, role).toBe(403);
      expect(refused.body.code, role).toBe('CEO_ONLY');
    }
    expect((await get(null, '/api/maker-accounts')).status).toBe(401);
  });

  it('creates a maker with an empty address list', async () => {
    const name = `合成P2新メーカー${nextTag()}`;
    const created = await post('admin', '/api/maker-accounts', { name });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name, externalCode: null, isActive: true, recipientAddresses: [] });
    const [row] = await db.select().from(accounts).where(eq(accounts.id, created.body.id));
    expect(row).toMatchObject({ role: 'maker', name });
  });

  it('refuses a second maker with the same name with 409 DUPLICATE', async () => {
    const name = `合成P2重複メーカー${nextTag()}`;
    expect((await post('admin', '/api/maker-accounts', { name })).status).toBe(201);
    const again = await post('admin', '/api/maker-accounts', { name });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DUPLICATE');
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['a 201-character name', { name: 'あ'.repeat(201) }],
    ['a 65-character code', { name: 'ok', externalCode: 'x'.repeat(65) }],
    ['a numeric code', { name: 'ok', externalCode: 12 }]
  ])('refuses %s with 422 MAKER_ACCOUNT_INVALID', async (_name, body) => {
    const refused = await post('admin', '/api/maker-accounts', body);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('MAKER_ACCOUNT_INVALID');
  });

  it.each(['staff', 'viewer', 'auditor'] as const)('refuses every master write by %s with 403', async (role) => {
    const maker = await makeMaker(`合成P2権限メーカー${nextTag()}`);
    const address = await addAddress(maker, `perm-${nextTag()}@maker.example.com`);
    const writes = [
      await post(role, '/api/maker-accounts', { name: `合成P2拒否${nextTag()}` }),
      await post(role, `/api/maker-accounts/${maker}/recipient-addresses`, { email: `x-${nextTag()}@maker.example.com` }),
      await patch(role, `/api/maker-recipient-addresses/${address.id}`, { isDefault: true })
    ];
    for (const refused of writes) expect(refused.status).toBe(403);
    const stored = await db.select().from(makerRecipientAddresses).where(eq(makerRecipientAddresses.accountId, maker));
    expect(stored).toMatchObject([{ id: address.id, isDefault: false }]);
  });

  it('stores the address in lower case and refuses the same address in other case with 409 DUPLICATE', async () => {
    const maker = await makeMaker(`合成P2小文字メーカー${nextTag()}`);
    const tag = nextTag();
    const created = await post('admin', `/api/maker-accounts/${maker}/recipient-addresses`, { email: `Orders-${tag}@Maker.Example.COM`, label: '受注窓口' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ email: `orders-${tag}@maker.example.com`, label: '受注窓口', isDefault: false, isActive: true });
    const again = await post('admin', `/api/maker-accounts/${maker}/recipient-addresses`, { email: `ORDERS-${tag}@maker.example.com` });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'DUPLICATE', field: 'email' });
  });

  it.each([
    ['no address', {}, 'RECIPIENT_ADDRESS_REQUIRED'],
    ['a malformed address', { email: 'not an address' }, 'RECIPIENT_ADDRESS_INVALID'],
    ['a 101-character label', { email: 'ok@maker.example.com', label: 'x'.repeat(101) }, 'MAKER_RECIPIENT_ADDRESS_INVALID'],
    ['a string default flag', { email: 'ok@maker.example.com', isDefault: 'yes' }, 'MAKER_RECIPIENT_ADDRESS_INVALID']
  ])('refuses %s with 422 %s', async (_name, body, code) => {
    const maker = await makeMaker(`合成P2入力メーカー${nextTag()}`);
    const refused = await post('admin', `/api/maker-accounts/${maker}/recipient-addresses`, body);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe(code);
  });

  it('answers 404 MAKER_ACCOUNT_NOT_FOUND for an unknown account and a non-maker account', async () => {
    for (const accountId of [uuidv7(), ids.customer]) {
      const refused = await post('admin', `/api/maker-accounts/${accountId}/recipient-addresses`, { email: `x-${nextTag()}@maker.example.com` });
      expect(refused.status).toBe(404);
      expect(refused.body.code).toBe('MAKER_ACCOUNT_NOT_FOUND');
    }
  });

  it('moves the default to a new default address and releases the old one', async () => {
    const maker = await makeMaker(`合成P2既定メーカー${nextTag()}`);
    const first = await addAddress(maker, `first-${nextTag()}@maker.example.com`, { isDefault: true });
    const second = await addAddress(maker, `second-${nextTag()}@maker.example.com`, { isDefault: true });
    const rows = await db.select().from(makerRecipientAddresses).where(eq(makerRecipientAddresses.accountId, maker));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.isDefault]))).toEqual({ [first.id]: false, [second.id]: true });
    const back = await patch('admin', `/api/maker-recipient-addresses/${first.id}`, { isDefault: true });
    expect(back.status).toBe(200);
    const after = await db.select().from(makerRecipientAddresses).where(eq(makerRecipientAddresses.accountId, maker));
    expect(Object.fromEntries(after.map((row) => [row.id, row.isDefault]))).toEqual({ [first.id]: true, [second.id]: false });
  });

  it('ends the default role when the address is deactivated', async () => {
    const maker = await makeMaker(`合成P2停止メーカー${nextTag()}`);
    const address = await addAddress(maker, `stop-${nextTag()}@maker.example.com`, { isDefault: true });
    const stopped = await patch('admin', `/api/maker-recipient-addresses/${address.id}`, { isActive: false });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ isActive: false, isDefault: false });
  });

  it('refuses to make an inactive address the default with 422 MAKER_RECIPIENT_ADDRESS_INVALID', async () => {
    const maker = await makeMaker(`合成P2停止既定メーカー${nextTag()}`);
    const address = await addAddress(maker, `inactive-${nextTag()}@maker.example.com`);
    expect((await patch('admin', `/api/maker-recipient-addresses/${address.id}`, { isActive: false })).status).toBe(200);
    const refused = await patch('admin', `/api/maker-recipient-addresses/${address.id}`, { isDefault: true });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('MAKER_RECIPIENT_ADDRESS_INVALID');
    const [row] = await db.select().from(makerRecipientAddresses).where(eq(makerRecipientAddresses.id, address.id));
    expect(row).toMatchObject({ isActive: false, isDefault: false });
  });

  it('answers 404 for an unknown address and 422 for an empty change', async () => {
    const missing = await patch('admin', `/api/maker-recipient-addresses/${uuidv7()}`, { isDefault: true });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('MAKER_RECIPIENT_ADDRESS_NOT_FOUND');
    const maker = await makeMaker(`合成P2空変更メーカー${nextTag()}`);
    const address = await addAddress(maker, `empty-${nextTag()}@maker.example.com`);
    const empty = await patch('admin', `/api/maker-recipient-addresses/${address.id}`, {});
    expect(empty.status).toBe(422);
    expect(empty.body.code).toBe('MAKER_RECIPIENT_ADDRESS_INVALID');
  });

  describe('the project list of usable addresses', () => {
    let active: { id: string; email: string };
    let fallback: { id: string; email: string };
    let stopped: { id: string; email: string };
    beforeAll(async () => {
      fallback = await addAddress(ids.makerA, `aaa-fallback-${nextTag()}@maker-a.example.com`);
      active = await addAddress(ids.makerA, `zzz-default-${nextTag()}@maker-a.example.com`, { isDefault: true });
      stopped = await addAddress(ids.makerA, `stopped-${nextTag()}@maker-a.example.com`);
      expect((await patch('admin', `/api/maker-recipient-addresses/${stopped.id}`, { isActive: false })).status).toBe(200);
    });

    it.each(['admin', 'staff'] as const)('answers %s with the active addresses, default first', async (role) => {
      const listed = await get(role, `/api/projects/${ids.projectA}/maker-recipient-addresses`);
      expect(listed.status).toBe(200);
      expect(listed.body.maker).toMatchObject({ id: ids.makerA, name: '合成P2メーカーA' });
      const addresses = listed.body.maker.recipientAddresses as Array<{ id: string; isDefault: boolean; isActive: boolean }>;
      expect(addresses[0]!.id).toBe(active.id);
      expect(addresses.map((address) => address.id)).toContain(fallback.id);
      expect(addresses.map((address) => address.id)).not.toContain(stopped.id);
      expect(addresses.every((address) => address.isActive)).toBe(true);
      expect(keysOf(addresses[0])).toEqual(['email', 'id', 'isActive', 'isDefault', 'label', 'updatedAt']);
    });

    it.each(['viewer', 'auditor', 'staffOut', 'auditorOut'] as const)('refuses %s with 403', async (role) => {
      const refused = await get(role, `/api/projects/${ids.projectA}/maker-recipient-addresses`);
      expect(refused.status).toBe(403);
      expect(refused.text).not.toContain('maker-a.example.com');
    });
  });
});

// ================================================ R33 recipientAddressId
describe('R33 maker PO created from a master address', () => {
  let chain: Awaited<ReturnType<typeof approvedOrder>>;
  let usable: { id: string; email: string };
  let inactive: { id: string; email: string };
  let otherMakers: { id: string; email: string };

  beforeAll(async () => {
    chain = await approvedOrder();
    usable = await addAddress(ids.makerA, `po-usable-${nextTag()}@maker-a.example.com`);
    inactive = await addAddress(ids.makerA, `po-inactive-${nextTag()}@maker-a.example.com`);
    expect((await patch('admin', `/api/maker-recipient-addresses/${inactive.id}`, { isActive: false })).status).toBe(200);
    // Maker B is the maker of project B, so its address is "a real maker address", just not this project's.
    otherMakers = await addAddress(ids.makerB, `po-other-${nextTag()}@maker-b.example.com`);
  });

  it.each([
    ['another maker’s address', () => ({ recipientAddressId: otherMakers.id })],
    ['an inactive address', () => ({ recipientAddressId: inactive.id })],
    ['an unknown address', () => ({ recipientAddressId: uuidv7() })],
    ['a malformed id', () => ({ recipientAddressId: 'not-a-uuid' })],
    ['a typed address that differs', () => ({ recipientAddressId: usable.id, recipientAddress: 'someone-else@maker-a.example.com' })]
  ])('refuses %s with 422 MAKER_RECIPIENT_ADDRESS_UNAVAILABLE and writes no paper', async (_name, body) => {
    const refused = await createPaper(chain.orderId, { ...body(), amounts: { currency: 'JPY', totalAmount: PAPER_AMOUNT } });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.code).toBe('MAKER_RECIPIENT_ADDRESS_UNAVAILABLE');
    expect(await papersOf(chain.orderId)).toHaveLength(0);
  });

  it('writes the chosen address into the snapshot and the audit row', async () => {
    const created = await createPaper(chain.orderId, {
      recipientAddressId: usable.id, recipientAddress: usable.email.toUpperCase(), amounts: { currency: 'JPY', totalAmount: PAPER_AMOUNT }
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [paper] = await papersOf(chain.orderId);
    expect((paper!.snapshot as any).recipient.address).toBe(usable.email);
    const [audit] = await auditRows('MAKER_PO_CREATED', created.body.id);
    expect((audit!.afterState as any).recipientAddressId).toBe(usable.id);
    expect((audit!.afterState as any).recipientSource).toBe('master');
    const card = await get('admin', `/api/maker-purchase-orders/${created.body.id}/approval-card`);
    expect(card.body.snapshot.recipient).toMatchObject({ address: usable.email, isEmail: true, inMakerMaster: true });
  });

  it('keeps the free-typed recipient working without a master address', async () => {
    const other = await approvedOrder();
    const created = await createPaper(other.orderId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [paper] = await papersOf(other.orderId);
    expect((paper!.snapshot as any).recipient.address).toBe(PAPER_RECIPIENT);
    const [audit] = await auditRows('MAKER_PO_CREATED', created.body.id);
    expect((audit!.afterState as any).recipientAddressId).toBeNull();
    expect((audit!.afterState as any).recipientSource).toBe('typed');
    const card = await get('admin', `/api/maker-purchase-orders/${created.body.id}/approval-card`);
    expect(card.body.snapshot.recipient).toMatchObject({ address: PAPER_RECIPIENT, inMakerMaster: false });
  });

  it('marks a typed address that is an active master address of this maker as inMakerMaster, until it is deactivated', async () => {
    const other = await approvedOrder();
    const typedMaster = await addAddress(ids.makerA, `po-typed-master-${nextTag()}@maker-a.example.com`);
    const created = await createPaper(other.orderId, { recipientAddress: typedMaster.email, amounts: { currency: 'JPY', totalAmount: PAPER_AMOUNT } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [audit] = await auditRows('MAKER_PO_CREATED', created.body.id);
    expect((audit!.afterState as any).recipientSource).toBe('typed');
    const cardUrl = `/api/maker-purchase-orders/${created.body.id}/approval-card`;
    expect((await get('admin', cardUrl)).body.snapshot.recipient.inMakerMaster).toBe(true);
    expect((await patch('admin', `/api/maker-recipient-addresses/${typedMaster.id}`, { isActive: false })).status).toBe(200);
    expect((await get('admin', cardUrl)).body.snapshot.recipient.inMakerMaster).toBe(false);
  });

  it('does not count another maker’s active address as inMakerMaster', async () => {
    const other = await approvedOrder();
    const created = await createPaper(other.orderId, { recipientAddress: otherMakers.email, amounts: { currency: 'JPY', totalAmount: PAPER_AMOUNT } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const card = await get('admin', `/api/maker-purchase-orders/${created.body.id}/approval-card`);
    expect(card.body.snapshot.recipient.inMakerMaster).toBe(false);
  });
});

// ======================================================== R32 numbers
describe('R32 stored maker PO numbers', () => {
  async function storedNumber(poId: string) {
    const [row] = await db.select().from(makerPoDisplayNumbers).where(eq(makerPoDisplayNumbers.makerPurchaseOrderId, poId));
    return row?.displayNumber;
  }

  it('answers the stored number in the create answer, the single read and the order list', async () => {
    const chain = await approvedOrder();
    const created = await createPaper(chain.orderId);
    expect(created.status).toBe(201);
    const stored = await storedNumber(created.body.id);
    expect(stored).toMatch(new RegExp(`^MPO-${jstYear(new Date())}-\\d{4,}$`));
    expect(created.body.displayNumber).toBe(stored);
    expect((await get('staff', `/api/maker-purchase-orders/${created.body.id}`)).body.displayNumber).toBe(stored);
    expect((await get('viewer', `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`)).body.displayNumbers[created.body.id]).toBe(stored);
    expect((await get('auditor', `/api/maker-purchase-orders/${created.body.id}`)).body.displayNumber).toBe(stored);
  });

  it('gives concurrently created papers distinct consecutive numbers', async () => {
    const chains = [await approvedOrder(), await approvedOrder(), await approvedOrder(), await approvedOrder()];
    const created = await Promise.all(chains.map((chain) => createPaper(chain.orderId)));
    for (const paper of created) expect(paper.status, JSON.stringify(paper.body)).toBe(201);
    const numbers = created.map((paper) => paper.body.displayNumber as string);
    expect(new Set(numbers).size).toBe(4);
    for (const paper of created) expect(await storedNumber(paper.body.id)).toBe(paper.body.displayNumber);
    const sequences = numbers.map((number) => Number(/-(\d{4,})$/.exec(number)![1])).sort((a, b) => a - b);
    expect(sequences.map((value) => value - sequences[0]!)).toEqual([0, 1, 2, 3]);
  });
});

// ======================================================== R29 language
describe('R29 display language stored per user', () => {
  const url = '/api/me/preferences';

  it.each(['ja', 'ja-ko', 'ko', null])('stores %s and shows it on /api/me', async (value) => {
    const saved = await put('staff', url, { displayLanguage: value });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ id: ids.staff, displayLanguage: value });
    const me = await get('staff', '/api/me');
    expect(me.body).toMatchObject({ id: ids.staff, role: 'staff', displayLanguage: value });
  });

  it.each([
    ['an unknown language', { displayLanguage: 'en' }],
    ['upper case', { displayLanguage: 'JA' }],
    ['a number', { displayLanguage: 1 }],
    ['no key', {}],
    ['a non-object body', 'ko']
  ])('refuses %s with 422 DISPLAY_LANGUAGE_INVALID', async (_name, body) => {
    expect((await put('staff', url, { displayLanguage: 'ja' })).status).toBe(200);
    const refused = await put('staff', url, body);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('DISPLAY_LANGUAGE_INVALID');
    expect((await get('staff', '/api/me')).body.displayLanguage).toBe('ja');
  });

  it('changes only the caller', async () => {
    expect((await put('viewer', url, { displayLanguage: null })).status).toBe(200);
    expect((await put('staff', url, { displayLanguage: 'ko' })).status).toBe(200);
    expect((await get('viewer', '/api/me')).body.displayLanguage).toBeNull();
    const [viewerRow] = await db.select({ displayLanguage: users.displayLanguage }).from(users).where(eq(users.id, ids.viewer));
    expect(viewerRow!.displayLanguage).toBeNull();
  });

  it('lets an auditor change their own language', async () => {
    const saved = await put('auditor', url, { displayLanguage: 'ja-ko' });
    expect(saved.status).toBe(200);
    expect((await get('auditor', '/api/me')).body).toMatchObject({ role: 'auditor', displayLanguage: 'ja-ko' });
  });

  it('writes a project-less audit row with the before and after values', async () => {
    expect((await put('admin', url, { displayLanguage: 'ja' })).status).toBe(200);
    expect((await put('admin', url, { displayLanguage: 'ko' })).status).toBe(200);
    const rows = await auditRows('USER_DISPLAY_LANGUAGE_UPDATED', ids.admin);
    const last = rows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).at(-1)!;
    expect(last).toMatchObject({ projectId: null, actorUserId: ids.admin, beforeState: { displayLanguage: 'ja' }, afterState: { displayLanguage: 'ko' } });
  });

  it('answers 401 without a session', async () => {
    const refused = await put(null, url, { displayLanguage: 'ja' });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('AUTH_REQUIRED');
  });
});

// ============================================== R22 デザイン入稿データ
describe('R22 artwork_submission documents', () => {
  const submission = (overrides: Record<string, unknown> = {}) => ({
    documentType: 'artwork_submission', issuerEntity: 'customer_generated', designKey: 'label-front',
    contentBase64: b64(`p2 submission ${nextTag()}\n`), ...overrides
  });

  it('accepts the file bound to an order whose seven PO is neither official nor verified, and stores that PO', async () => {
    const poId = await sevenPo(ids.projectA, false, false);
    const order = await createOrder(poId);
    // The same PO cannot carry an official artifact yet: the precedence gate is closed.
    const proof = await upload(poId, order.orderId, { designKey: 'label-front' });
    expect(proof.status).toBe(422);
    const created = await upload(null, order.orderId, submission());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [row] = await db.select().from(documents).where(eq(documents.id, created.body.document.id));
    expect(row).toMatchObject({ documentType: 'artwork_submission', filmSupplyOrderId: order.orderId, sevenPurchaseOrderId: poId });
  });

  it('accepts the order’s own PO sent explicitly', async () => {
    const poId = await sevenPo();
    const order = await createOrder(poId);
    expect((await upload(poId, order.orderId, submission())).status).toBe(201);
  });

  it('refuses a file without an order with 422 ARTWORK_SUBMISSION_ORDER_REQUIRED', async () => {
    const poId = await sevenPo();
    const refused = await upload(poId, null, submission({ designKey: undefined }));
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('ARTWORK_SUBMISSION_ORDER_REQUIRED');
  });

  it('refuses an order without a seven PO with the same 422', async () => {
    const order = await createOrder(null);
    const refused = await upload(null, order.orderId, submission());
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('ARTWORK_SUBMISSION_ORDER_REQUIRED');
  });

  it('refuses another seven PO of the same project with the same 422 and stores nothing', async () => {
    const poId = await sevenPo();
    const order = await createOrder(poId);
    const otherPo = await sevenPo();
    const filename = `p2-mismatch-${nextTag()}.txt`;
    const refused = await upload(otherPo, order.orderId, submission({ filename }));
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.code).toBe('ARTWORK_SUBMISSION_ORDER_REQUIRED');
    expect(await db.select().from(documents).where(eq(documents.originalFilename, filename))).toHaveLength(0);
  });

  it.each(['viewer', 'auditor', 'staffOut'] as const)('refuses an upload by %s with 403', async (role) => {
    const poId = await sevenPo();
    const order = await createOrder(poId);
    expect((await upload(null, order.orderId, submission(), role)).status).toBe(403);
  });

  describe('it is never approval evidence or a 版 file', () => {
    let chain: { sevenPoId: string; orderId: string; revisionId: string };
    let submitted: { document: { id: string }; version: { id: string } };
    beforeAll(async () => {
      const sevenPoId = await sevenPo();
      const order = await createOrder(sevenPoId);
      expect((await post('staff', `/api/film-supply-orders/${order.orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).status).toBe(200);
      const revision = await registerRevision(sevenPoId, order.orderId);
      expect(revision.status).toBe(201);
      chain = { sevenPoId, orderId: order.orderId, revisionId: revision.body.id };
      submitted = await uploadOk(null, order.orderId, submission({ contentBase64: b64(`p2 approval\nidentifier: MSG-P2-SUB-${nextTag()}\n`) }));
    });

    it('refuses it as approval evidence', async () => {
      const refused = await approve(chain.revisionId, 'customer', submitted.version.id, `MSG-P2-SUB-${nextTag()}`);
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('EVIDENCE_DOCUMENT_TYPE_INVALID');
    });

    it('refuses it as the file of a 版', async () => {
      const refused = await post('staff', `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, { designKey: 'label-front', fileDocumentVersionId: submitted.version.id });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('FILE_DOCUMENT_TYPE_INVALID');
    });
  });
});

// ==================================================== P-2 auditor + viewer
describe('P-2 auditor role and the unchanged viewer answers', () => {
  const AMOUNT = '987654.32';
  const NOTE = '内部メモ金額P2';
  const world = {
    sevenPoId: '', orderId: '', revisionId: '', paperId: '', approvalEventId: '', makerPoEventId: '',
    evidenceVersionId: '', evidenceDocumentId: '', noteDocumentId: '', addressId: '', projectB: ids.projectB,
    quoteDocumentId: ''
  };
  const QUOTE_TOKEN = 'quote-1234567yen-p2';

  beforeAll(async () => {
    const chain = await approvedOrder();
    world.sevenPoId = chain.sevenPoId;
    world.orderId = chain.orderId;
    world.revisionId = chain.revisionId;
    world.approvalEventId = chain.lastApproval.body.approvalEvent.id;
    expect((await put('admin', `/api/seven-purchase-orders/${chain.sevenPoId}/order-facts`, { orderedQuantity: '1000', orderedUnit: 'sheets', totalAmount: AMOUNT, currency: 'JPY' })).status).toBe(200);
    expect((await patch('staff', `/api/film-supply-orders/${chain.orderId}/delivery-dates`, { requestedDeliveryDate: '2027-05-01' })).status).toBe(200);
    const paper = await createPaper(chain.orderId);
    expect(paper.status).toBe(201);
    world.paperId = paper.body.id;
    const approved = await post('admin', `/api/maker-purchase-orders/${paper.body.id}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, paper.body.id));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const [event] = await db.select().from(makerPoEvents).where(eq(makerPoEvents.makerPurchaseOrderId, paper.body.id));
    world.makerPoEventId = event!.id;
    const noted = await uploadOk(chain.sevenPoId, chain.orderId, { documentType: 'artwork_submission', issuerEntity: 'customer_generated', note: NOTE });
    world.noteDocumentId = noted.document.id;
    const [evidenceDocument] = await db.select().from(documents).where(and(eq(documents.filmSupplyOrderId, chain.orderId), eq(documents.documentType, 'approval_evidence')));
    world.evidenceDocumentId = evidenceDocument!.id;
    world.evidenceVersionId = evidenceDocument!.id; // a document's first version shares its id
    world.addressId = (await addAddress(ids.makerA, `auditor-world-${nextTag()}@maker-a.example.com`)).id;
    // A quote whose file name carries its price (v1.1, security review L3): two versions, then verified.
    const quoteFilename = `${QUOTE_TOKEN}.txt`;
    const quote = await uploadOk(null, null, { documentType: 'film_quote_kanei', issuerEntity: 'kanei', filename: quoteFilename, contentBase64: b64('quote v1\n') });
    // A new version of an existing logical document answers 200 (existing P0 rule).
    const second = await upload(null, null, { documentType: 'film_quote_kanei', issuerEntity: 'kanei', filename: quoteFilename, contentBase64: b64('quote v2\n') });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.version.versionNumber).toBe(2);
    world.quoteDocumentId = quote.document.id;
    expect((await post('admin', `/api/documents/${quote.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
  });

  const readPaths: Array<[string, () => string]> = [
    ['/api/projects/:projectId', () => `/api/projects/${ids.projectA}`],
    ['/api/projects/:projectId/film-supply-orders', () => `/api/projects/${ids.projectA}/film-supply-orders`],
    ['/api/film-supply-orders/:orderId/delivery-status', () => `/api/film-supply-orders/${world.orderId}/delivery-status`],
    ['/api/projects/:projectId/audit-history', () => `/api/projects/${ids.projectA}/audit-history`],
    ['/api/film-supply-orders/:orderId/approval-gate', () => `/api/film-supply-orders/${world.orderId}/approval-gate`],
    ['/api/maker-purchase-orders/:poId', () => `/api/maker-purchase-orders/${world.paperId}`],
    ['/api/film-supply-orders/:orderId/maker-purchase-orders', () => `/api/film-supply-orders/${world.orderId}/maker-purchase-orders`],
    ['/api/film-supply-orders/:orderId/payment-gate', () => `/api/film-supply-orders/${world.orderId}/payment-gate`],
    ['/api/seven-purchase-orders/:poId/order-facts', () => `/api/seven-purchase-orders/${world.sevenPoId}/order-facts`],
    ['/api/projects/:projectId/evidence-metadata', () => `/api/projects/${ids.projectA}/evidence-metadata`]
  ];

  describe('reads the contract allows', () => {
    it.each(readPaths)('answers the assigned auditor 200 on %s with no amount', async (_name, path) => {
      const read = await get('auditor', path());
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.text).not.toContain('987654');
      expect(read.text).not.toContain(PAPER_AMOUNT);
    });

    it.each(readPaths)('refuses the unassigned auditor 403 on %s', async (_name, path) => {
      const read = await get('auditorOut', path());
      expect(read.status).toBe(403);
    });

    it('answers /api/me, /api/projects (assigned only) and /api/status-labels', async () => {
      expect((await get('auditor', '/api/me')).body).toMatchObject({ id: ids.auditor, role: 'auditor', assignedProjectIds: [ids.projectA] });
      const projectsList = await get('auditor', '/api/projects');
      expect(projectsList.body.projects.map((project: { id: string }) => project.id)).toEqual([ids.projectA]);
      const outsiderList = await get('auditorOut', '/api/projects');
      expect(outsiderList.body.projects.map((project: { id: string }) => project.id)).toEqual([ids.projectB]);
      expect((await get('auditor', '/api/status-labels')).status).toBe(200);
    });

    it('shows the delivery dates in the order list', async () => {
      const list = await get('auditor', `/api/projects/${ids.projectA}/film-supply-orders`);
      expect(list.body.orders.find((order: { id: string }) => order.id === world.orderId)).toMatchObject({ requestedDeliveryDate: '2027-05-01' });
    });

    it('keeps pendingManualVerifications empty in the auditor approval gate', async () => {
      const identifier = `SIG-P2-PENDING-${nextTag()}`;
      const sevenPoId = await sevenPo();
      const order = await createOrder(sevenPoId);
      expect((await post('staff', `/api/film-supply-orders/${order.orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).status).toBe(200);
      const revision = await registerRevision(sevenPoId, order.orderId);
      const pdf = await evidence(sevenPoId, order.orderId, 'customer_generated', identifier, 'application/pdf');
      expect((await approve(revision.body.id, 'customer', pdf.version.id, identifier)).status).toBe(201);
      const adminGate = await get('admin', `/api/film-supply-orders/${order.orderId}/approval-gate`);
      expect(adminGate.body.pendingManualVerifications.length).toBeGreaterThan(0);
      const auditorGate = await get('auditor', `/api/film-supply-orders/${order.orderId}/approval-gate`);
      expect(auditorGate.status).toBe(200);
      expect(auditorGate.body.pendingManualVerifications).toEqual([]);
      expect(auditorGate.text).not.toContain(identifier);
    });
  });

  describe('reads the contract refuses', () => {
    it.each([
      ['evidence download', () => `/api/document-versions/${world.evidenceVersionId}/download`],
      ['evidence Message-ID', () => `/api/document-versions/${world.evidenceVersionId}/evidence-message-id`],
      ['approval card', () => `/api/maker-purchase-orders/${world.paperId}/approval-card`],
      ['representative queue', () => '/api/representative-queue'],
      ['maker recipient addresses', () => `/api/projects/${ids.projectA}/maker-recipient-addresses`],
      ['maker master', () => '/api/maker-accounts'],
      ['send evidence candidates', () => `/api/maker-purchase-orders/${world.paperId}/send-evidence-candidates`]
    ])('refuses the assigned auditor the %s with 403', async (_name, path) => {
      const read = await get('auditor', path());
      expect(read.status, JSON.stringify(read.body)).toBe(403);
      expect(['FORBIDDEN', 'CEO_ONLY']).toContain(read.body.code);
    });
  });

  describe('every write is refused', () => {
    const W = () => world;
    const writes: Array<[string, string, () => string, () => unknown]> = [
      ['create project', 'POST', () => '/api/projects', () => ({ route: 'F1', code: `P2-AUD-${nextTag()}`, name: '監査作成', endCustomerAccountId: ids.customer, sevenAccountId: ids.seven, makerAccountId: ids.makerA })],
      ['update project', 'PATCH', () => `/api/projects/${ids.projectA}`, () => ({ name: '監査変更' })],
      ['ceo approvals', 'POST', () => '/api/ceo-approvals', () => ({})],
      ['create seven PO', 'POST', () => `/api/projects/${ids.projectA}/seven-purchase-orders`, () => ({ poNumber: `SEVEN-AUD-${nextTag()}` })],
      ['register official', 'POST', () => `/api/seven-purchase-orders/${W().sevenPoId}/register-official`, () => ({ officialRegisteredAt: '2026-11-02T00:00:00.000Z' })],
      ['verification checklist', 'POST', () => `/api/seven-purchase-orders/${W().sevenPoId}/verification-checklist`, () => fullChecklist()],
      ['supply orders from PO', 'POST', () => `/api/seven-purchase-orders/${W().sevenPoId}/supply-orders`, () => ({ code: `FSO-AUD-${nextTag()}`, paymentTerms: 'prepaid' })],
      ['order facts', 'PUT', () => `/api/seven-purchase-orders/${W().sevenPoId}/order-facts`, () => ({ orderedQuantity: '1', orderedUnit: 'rolls' })],
      ['pre-order reference', 'POST', () => `/api/projects/${ids.projectA}/pre-order-references`, () => ({ note: '監査' })],
      ['create film order', 'POST', () => `/api/projects/${ids.projectA}/film-supply-orders`, () => ({ code: `FSO-AUD-${nextTag()}`, paymentTerms: 'prepaid' })],
      ['payment terms', 'PATCH', () => `/api/film-supply-orders/${W().orderId}/payment-terms`, () => ({ paymentTerms: 'on_delivery' })],
      ['delivery dates', 'PATCH', () => `/api/film-supply-orders/${W().orderId}/delivery-dates`, () => ({ requestedDeliveryDate: '2027-06-01' })],
      ['order lines', 'POST', () => `/api/film-supply-orders/${W().orderId}/lines`, () => ({ lineNumber: 2, description: 'x', orderedQuantity: 1, unit: 'sheets' })],
      ['deliveries', 'POST', () => `/api/film-supply-orders/${W().orderId}/deliveries`, () => ({ deliveredQuantity: 1 })],
      ['transitions', 'POST', () => `/api/film-supply-orders/${W().orderId}/transitions`, () => ({ to: 'ON_HOLD', holdReason: '監査' })],
      ['auto-advance', 'POST', () => `/api/film-supply-orders/${W().orderId}/auto-advance`, () => ({})],
      ['hold release', 'POST', () => `/api/film-supply-orders/${W().orderId}/hold-release`, () => ({})],
      ['cancellation review resolve', 'POST', () => `/api/film-supply-orders/${W().orderId}/cancellation-review-resolve`, () => ({})],
      ['receipt assumption', 'POST', () => `/api/film-supply-orders/${W().orderId}/receipt-assumption`, () => ({ note: '監査' })],
      ['filling order', 'POST', () => `/api/projects/${ids.projectA}/filling-orders`, () => ({ code: `FIL-AUD-${nextTag()}` })],
      ['commission readiness', 'POST', () => `/api/projects/${ids.projectA}/commission-readiness`, () => ({})],
      ['document upload', 'POST', () => `/api/projects/${ids.projectA}/documents`, () => ({ documentType: 'artwork_submission', issuerEntity: 'customer_generated', filename: `aud-${nextTag()}.txt`, contentType: 'text/plain', contentBase64: b64('aud'), filmSupplyOrderId: W().orderId })],
      ['document verify', 'POST', () => `/api/documents/${W().evidenceDocumentId}/verify`, () => ({ verificationStatus: 'verified' })],
      ['artwork revision', 'POST', () => `/api/film-supply-orders/${W().orderId}/artwork-revisions`, () => ({ designKey: 'label-front', fileDocumentVersionId: W().evidenceVersionId })],
      ['approval', 'POST', () => `/api/artwork-revisions/${W().revisionId}/approvals`, () => ({ organization: 'customer', decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z', evidenceIdentifier: 'x', evidenceDocumentVersionId: W().evidenceVersionId })],
      ['approval verification', 'POST', () => `/api/artwork-approval-events/${W().approvalEventId}/verification`, () => ({ result: 'confirmed' })],
      ['create maker PO', 'POST', () => `/api/film-supply-orders/${W().orderId}/maker-purchase-orders`, () => ({ recipientAddress: PAPER_RECIPIENT })],
      ['maker PO amounts', 'PATCH', () => `/api/maker-purchase-orders/${W().paperId}/amounts`, () => ({ amounts: { currency: 'JPY', totalAmount: '1' } })],
      ['maker PO ceo approval', 'POST', () => `/api/maker-purchase-orders/${W().paperId}/ceo-approval`, () => ({ expectedPaymentTerms: 'prepaid' })],
      ['maker PO return', 'POST', () => `/api/maker-purchase-orders/${W().paperId}/return`, () => ({ reason: '監査' })],
      ['send evidence', 'POST', () => `/api/maker-purchase-orders/${W().paperId}/send-evidence`, () => ({ evidenceDocumentVersionId: W().evidenceVersionId })],
      ['maker PO cancel', 'POST', () => `/api/maker-purchase-orders/${W().paperId}/cancel`, () => ({ reason: '監査' })],
      ['cancellation acknowledgement', 'POST', () => `/api/maker-purchase-orders/${W().paperId}/cancellation-acknowledgement`, () => ({})],
      ['accept evidence', 'POST', () => `/api/maker-purchase-orders/${W().paperId}/accept-evidence`, () => ({})],
      ['provisional acceptance', 'POST', () => `/api/maker-purchase-orders/${W().paperId}/provisional-acceptance`, () => ({ note: '監査' })],
      ['send manual verification', 'POST', () => `/api/maker-po-events/${W().makerPoEventId}/send-manual-verification`, () => ({ result: 'confirmed' })],
      ['maker account', 'POST', () => '/api/maker-accounts', () => ({ name: `監査メーカー${nextTag()}` })],
      ['maker address', 'POST', () => `/api/maker-accounts/${ids.makerA}/recipient-addresses`, () => ({ email: `aud-${nextTag()}@maker.example.com` })],
      ['maker address change', 'PATCH', () => `/api/maker-recipient-addresses/${W().addressId}`, () => ({ isDefault: true })]
    ];

    it.each(writes)('refuses the assigned auditor: %s', async (_name, method, path, body) => {
      const auditBefore = await db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.actorUserId, ids.auditor));
      const refused = await send('auditor', method, path(), body());
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(['FORBIDDEN', 'CEO_ONLY', 'READ_ONLY_ROLE']).toContain(refused.body.code);
      const auditAfter = await db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.actorUserId, ids.auditor));
      expect(auditAfter).toHaveLength(auditBefore.length);
    });

    it('still lets staff create a project', async () => {
      const created = await post('staff', '/api/projects', {
        route: 'F1', code: `P2-STAFF-${nextTag()}`, name: 'staff作成',
        endCustomerAccountId: ids.customer, sevenAccountId: ids.seven, makerAccountId: ids.makerA
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
    });

    // P2 conductor decision: the viewer writes nothing (P1 let it create projects).
    it.each(['viewer', 'auditor', 'auditorOut'] as const)('refuses %s creating a project with 403 READ_ONLY_ROLE and writes nothing', async (role) => {
      const code = `P2-RO-${role.toUpperCase()}-${nextTag()}`;
      const refused = await post(role, '/api/projects', {
        route: 'F1', code, name: `${role}作成`,
        endCustomerAccountId: ids.customer, sevenAccountId: ids.seven, makerAccountId: ids.makerA
      });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('READ_ONLY_ROLE');
      expect(await db.select({ id: projects.id }).from(projects).where(eq(projects.code, code))).toHaveLength(0);
    });
  });

  describe('audit history answers', () => {
    const FORBIDDEN_KEYS = ['snapshot', 'snapshotSha256', 'recipients', 'evidenceIdentifier', 'totalAmount', 'currency', 'amounts', 'storagePath', 'note', 'recipientAddress', 'senderAddress'];

    it('gives the auditor who, what and when on every row', async () => {
      const history = await get('auditor', `/api/projects/${ids.projectA}/audit-history?limit=500&order=desc`);
      expect(history.status).toBe(200);
      expect(history.body.events.length).toBeGreaterThan(10);
      for (const event of history.body.events) {
        expect(event.actor, event.action).toMatchObject({ id: expect.any(String), displayName: expect.any(String), role: expect.any(String) });
        expect(typeof event.action).toBe('string');
        expect(typeof event.occurredAt).toBe('string');
      }
      const created = history.body.events.find((event: any) => event.action === 'MAKER_PO_CREATED' && event.entityId === world.paperId);
      expect(created.afterState).toMatchObject({ id: world.paperId, status: 'DRAFT' });
    });

    it('leaves amounts, snapshots, digests, recipients and identifiers out of the auditor answer', async () => {
      const history = await get('auditor', `/api/projects/${ids.projectA}/audit-history?limit=500&order=desc`);
      const keys = allKeys(history.body.events.map((event: any) => ({ b: event.beforeState, a: event.afterState, r: event.requestMetadata })));
      for (const key of FORBIDDEN_KEYS) expect(keys.has(key), key).toBe(false);
      expect(history.text).not.toContain('987654');
      expect(history.text).not.toContain(PAPER_AMOUNT);
      expect(history.text).not.toContain(PAPER_RECIPIENT);
      expect(history.text).not.toContain(NOTE);
      for (const identifier of identifiersUsed) expect(history.text).not.toContain(identifier);
      for (const event of history.body.events) {
        if (event.requestMetadata) {
          for (const key of Object.keys(event.requestMetadata)) expect(['operation', 'automatic', 'rule', 'trigger']).toContain(key);
        }
      }
    });

    it('drops the quote file name from the auditor audit history but keeps other file names (v1.1)', async () => {
      const history = await get('auditor', `/api/projects/${ids.projectA}/audit-history?limit=500&order=desc`);
      expect(history.text).not.toContain(QUOTE_TOKEN);
      const quoteRows = history.body.events.filter((event: any) => [event.beforeState, event.afterState]
        .some((state) => state && ['film_quote_kanei', 'filling_quote_seven'].includes(state.documentType)));
      expect(quoteRows.length).toBeGreaterThanOrEqual(3); // created, 2 versions, verification
      for (const event of quoteRows) {
        for (const state of [event.beforeState, event.afterState]) if (state) expect(state, event.action).not.toHaveProperty('originalFilename');
      }
      const submission = history.body.events.find((event: any) => event.action === 'DOCUMENT_CREATED' && event.entityId === world.noteDocumentId);
      expect(submission.afterState.originalFilename).toMatch(/^p2-.*\.txt$/);
    });

    it('still shows staff the quote file name in the audit history', async () => {
      const history = await get('staff', `/api/projects/${ids.projectA}/audit-history?limit=500&order=desc`);
      expect(history.text).toContain(QUOTE_TOKEN);
    });

    it('keeps the viewer answer to statuses and payment terms only (P1 shape)', async () => {
      const history = await get('viewer', `/api/projects/${ids.projectA}/audit-history?limit=500&order=desc`);
      expect(history.status).toBe(200);
      for (const event of history.body.events) {
        for (const key of Object.keys(event)) {
          expect(['id', 'action', 'entityType', 'entityId', 'occurredAt', 'actor', 'beforeState', 'afterState']).toContain(key);
        }
        for (const state of [event.beforeState, event.afterState]) {
          if (state) for (const key of Object.keys(state)) expect(['status', 'readinessState', 'isReady', 'paymentTerms']).toContain(key);
        }
      }
      expect(history.text).not.toContain('987654');
      expect(history.text).not.toContain(PAPER_RECIPIENT);
    });

    it('keeps the staff answer free of amounts and snapshots', async () => {
      const history = await get('staff', `/api/projects/${ids.projectA}/audit-history?limit=500&order=desc`);
      const keys = allKeys(history.body.events.map((event: any) => ({ b: event.beforeState, a: event.afterState })));
      for (const key of ['snapshot', 'snapshotSha256', 'totalAmount', 'currency', 'amounts']) expect(keys.has(key), key).toBe(false);
      expect(history.text).not.toContain('987654');
      expect(history.text).not.toContain(PAPER_AMOUNT);
    });
  });

  describe('maker PO answers by role', () => {
    const AUDITOR_PO_KEYS = ['ceoApprovedAt', 'ceoApprovedByUserId', 'createdAt', 'createdByUserId', 'filmSupplyOrderId', 'id', 'orderCode', 'status', 'updatedAt'];
    const AUDITOR_EVENT_KEYS = ['eventType', 'evidenceDocumentVersionId', 'id', 'provisional', 'recordedAt', 'recordedByUserId', 'sentAt', 'verificationStatus'];
    const VIEWER_PO_KEYS = ['createdAt', 'id', 'status', 'updatedAt'];
    const VIEWER_EVENT_KEYS = ['eventType', 'id', 'recordedAt'];
    const STAFF_PO_KEYS = ['ceoApprovedAt', 'createdAt', 'createdByUserId', 'filmSupplyOrderId', 'id', 'orderCode', 'recipientAddress', 'status', 'updatedAt'];

    it('answers the auditor exactly the contract §7 keys', async () => {
      const read = await get('auditor', `/api/maker-purchase-orders/${world.paperId}`);
      expect(keysOf(read.body)).toEqual(['displayNumber', 'events', 'purchaseOrder']);
      expect(keysOf(read.body.purchaseOrder)).toEqual(AUDITOR_PO_KEYS);
      expect(read.body.purchaseOrder).toMatchObject({ id: world.paperId, filmSupplyOrderId: world.orderId, ceoApprovedByUserId: ids.admin, status: 'APPROVED_FOR_MANUAL_SEND' });
      expect(read.body.events.length).toBeGreaterThan(0);
      for (const event of read.body.events) expect(keysOf(event)).toEqual(AUDITOR_EVENT_KEYS);
      const list = await get('auditor', `/api/film-supply-orders/${world.orderId}/maker-purchase-orders`);
      for (const paper of list.body.makerPurchaseOrders) expect(keysOf(paper)).toEqual(AUDITOR_PO_KEYS);
      expect(list.text).not.toContain(PAPER_RECIPIENT);
    });

    it('answers the viewer the P1 status summary only', async () => {
      const read = await get('viewer', `/api/maker-purchase-orders/${world.paperId}`);
      expect(read.status).toBe(200);
      expect(keysOf(read.body.purchaseOrder)).toEqual(VIEWER_PO_KEYS);
      for (const event of read.body.events) expect(keysOf(event)).toEqual(VIEWER_EVENT_KEYS);
      const list = await get('viewer', `/api/film-supply-orders/${world.orderId}/maker-purchase-orders`);
      for (const paper of list.body.makerPurchaseOrders) expect(keysOf(paper)).toEqual(VIEWER_PO_KEYS);
    });

    it('answers staff the P1 work view', async () => {
      const read = await get('staff', `/api/maker-purchase-orders/${world.paperId}`);
      expect(keysOf(read.body.purchaseOrder)).toEqual(STAFF_PO_KEYS);
      expect(read.body.purchaseOrder.recipientAddress).toBe(PAPER_RECIPIENT);
      expect(read.text).not.toContain(PAPER_AMOUNT);
    });

    it('answers admin the stored row with snapshot and digest', async () => {
      const read = await get('admin', `/api/maker-purchase-orders/${world.paperId}`);
      expect(read.body.purchaseOrder).toHaveProperty('snapshotSha256');
      expect(read.body.purchaseOrder.snapshot.amounts.totalAmount).toBe(PAPER_AMOUNT);
    });
  });

  describe('evidence metadata', () => {
    const DOCUMENT_KEYS = ['createdAt', 'createdBy', 'designKey', 'documentId', 'documentType', 'filmSupplyOrderId', 'issuerEntity', 'makerPurchaseOrderId', 'orderCode', 'originalFilename', 'originalFilenameHidden', 'sevenPurchaseOrderId', 'verificationStatus', 'verifiedAt', 'verifiedBy', 'versions'];
    const VERSION_KEYS = ['byteSize', 'detectedMimeType', 'originalFilename', 'sha256', 'uploadedAt', 'uploadedBy', 'versionId', 'versionNumber'];

    it.each(['admin', 'staff', 'auditor'] as const)('answers %s the metadata without bytes, paths or notes', async (role) => {
      const read = await get(role, `/api/projects/${ids.projectA}/evidence-metadata`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ projectId: ids.projectA, limit: 200 });
      expect(read.body.documents.length).toBeGreaterThan(0);
      for (const document of read.body.documents) {
        expect(keysOf(document)).toEqual(DOCUMENT_KEYS);
        for (const version of document.versions) {
          expect(keysOf(version)).toEqual(VERSION_KEYS);
          expect(version.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
      }
      const noted = read.body.documents.find((document: { documentId: string }) => document.documentId === world.noteDocumentId);
      expect(noted).toMatchObject({ documentType: 'artwork_submission', filmSupplyOrderId: world.orderId, sevenPurchaseOrderId: world.sevenPoId });
      expect(read.text).not.toContain(NOTE);
      expect(allKeys(read.body).has('storagePath')).toBe(false);
    });

    it('hides the quote file name from the auditor on the document and every version (v1.1)', async () => {
      const read = await get('auditor', `/api/projects/${ids.projectA}/evidence-metadata`);
      const quote = read.body.documents.find((document: { documentId: string }) => document.documentId === world.quoteDocumentId);
      expect(quote).toMatchObject({ documentType: 'film_quote_kanei', originalFilename: null, originalFilenameHidden: true });
      expect(quote.versions).toHaveLength(2);
      for (const version of quote.versions) {
        expect(version.originalFilename).toBeNull();
        expect(version.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(read.text).not.toContain(QUOTE_TOKEN);
      const other = read.body.documents.find((document: { documentId: string }) => document.documentId === world.noteDocumentId);
      expect(other.originalFilenameHidden).toBe(false);
      expect(other.originalFilename).toMatch(/^p2-.*\.txt$/);
    });

    it.each(['admin', 'staff'] as const)('still shows %s the quote file name', async (role) => {
      const read = await get(role, `/api/projects/${ids.projectA}/evidence-metadata`);
      const quote = read.body.documents.find((document: { documentId: string }) => document.documentId === world.quoteDocumentId);
      expect(quote).toMatchObject({ originalFilename: `${QUOTE_TOKEN}.txt`, originalFilenameHidden: false });
      for (const version of quote.versions) expect(version.originalFilename).toBe(`${QUOTE_TOKEN}.txt`);
    });

    it('narrows to one order and honours limit with truncated', async () => {
      const narrowed = await get('auditor', `/api/projects/${ids.projectA}/evidence-metadata?filmSupplyOrderId=${world.orderId}`);
      expect(narrowed.body.documents.every((document: { filmSupplyOrderId: string }) => document.filmSupplyOrderId === world.orderId)).toBe(true);
      const limited = await get('auditor', `/api/projects/${ids.projectA}/evidence-metadata?limit=1`);
      expect(limited.body).toMatchObject({ limit: 1, truncated: true });
      expect(limited.body.documents).toHaveLength(1);
    });

    it.each(['viewer', 'staffOut', 'auditorOut'] as const)('refuses %s with 403', async (role) => {
      const read = await get(role, `/api/projects/${ids.projectA}/evidence-metadata`);
      expect(read.status).toBe(403);
    });

    it('answers 401 and 404', async () => {
      expect((await get(null, `/api/projects/${ids.projectA}/evidence-metadata`)).status).toBe(401);
      expect((await get('admin', `/api/projects/${uuidv7()}/evidence-metadata`)).status).toBe(404);
    });
  });

  describe('viewer regression (P1 answers unchanged)', () => {
    it.each([
      ['evidence metadata', () => `/api/projects/${ids.projectA}/evidence-metadata`],
      ['order facts', () => `/api/seven-purchase-orders/${world.sevenPoId}/order-facts`],
      ['maker recipient addresses', () => `/api/projects/${ids.projectA}/maker-recipient-addresses`],
      ['evidence Message-ID', () => `/api/document-versions/${world.evidenceVersionId}/evidence-message-id`],
      ['evidence download', () => `/api/document-versions/${world.evidenceVersionId}/download`]
    ])('refuses the viewer the %s', async (_name, path) => {
      expect((await get('viewer', path())).status).toBe(403);
    });

    it.each([
      ['project', () => `/api/projects/${ids.projectA}`],
      ['order list', () => `/api/projects/${ids.projectA}/film-supply-orders`],
      ['delivery status', () => `/api/film-supply-orders/${world.orderId}/delivery-status`],
      ['audit history', () => `/api/projects/${ids.projectA}/audit-history`],
      ['maker PO', () => `/api/maker-purchase-orders/${world.paperId}`]
    ])('still answers the viewer the %s', async (_name, path) => {
      const read = await get('viewer', path());
      expect(read.status).toBe(200);
      expect(read.text).not.toContain('987654');
    });
  });
});

// ---------------------------------------------------------------------------
// P2 independent review (2026-11-21) and the conductor's decisions.
// ---------------------------------------------------------------------------
describe('P2 decision: 納期・数量 are frozen into the maker PO at the representative approval', () => {
  async function paperWithTerms() {
    const chain = await approvedOrder();
    expect((await put('staff', `/api/seven-purchase-orders/${chain.sevenPoId}/order-facts`, { orderedQuantity: '1200', orderedUnit: 'meters' })).status).toBe(200);
    expect((await patch('staff', `/api/film-supply-orders/${chain.orderId}/delivery-dates`, { requestedDeliveryDate: '2027-01-20', plannedDeliveryDate: '2027-01-25' })).status).toBe(200);
    const paper = await createPaper(chain.orderId);
    expect(paper.status, JSON.stringify(paper.body)).toBe(201);
    return { ...chain, paperId: paper.body.id as string };
  }
  const storedSnapshot = async (paperId: string) =>
    (await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, paperId)))[0]!;

  it('a new paper carries the delivery terms in its snapshot', async () => {
    const world = await paperWithTerms();
    const row = await storedSnapshot(world.paperId);
    expect((row.snapshot as any).deliveryTerms).toEqual({
      requestedDeliveryDate: '2027-01-20', plannedDeliveryDate: '2027-01-25',
      sevenPoOrderedQuantity: '1200.000', sevenPoOrderedUnit: 'meters'
    });
    const card = await get('admin', `/api/maker-purchase-orders/${world.paperId}/approval-card`);
    expect(card.body.makerPurchaseOrder.snapshotDrifted).toBe(false);
  });

  it('a draft whose dates change is approved only against the card that shows the new dates', async () => {
    const world = await paperWithTerms();
    const before = await withApprovalSnapshot(app, tokens.admin, world.paperId);
    expect((await patch('staff', `/api/film-supply-orders/${world.orderId}/delivery-dates`, { plannedDeliveryDate: '2027-02-10' })).status).toBe(200);
    const stale = await post('admin', `/api/maker-purchase-orders/${world.paperId}/ceo-approval`, before);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('MAKER_PO_SNAPSHOT_CHANGED');
    const fresh = await post('admin', `/api/maker-purchase-orders/${world.paperId}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, world.paperId));
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect((await storedSnapshot(world.paperId)).snapshot).toMatchObject({ deliveryTerms: { plannedDeliveryDate: '2027-02-10' } });
  });

  it('after the approval the dates and the quantity are locked (409 DELIVERY_TERMS_LOCKED, nothing written); the amount is not', async () => {
    const world = await paperWithTerms();
    const approved = await post('admin', `/api/maker-purchase-orders/${world.paperId}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, world.paperId));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    for (const role of ['staff', 'admin'] as const) {
      const dates = await patch(role, `/api/film-supply-orders/${world.orderId}/delivery-dates`, { plannedDeliveryDate: '2027-03-01' });
      expect(dates.status).toBe(409);
      expect(dates.body).toMatchObject({ code: 'DELIVERY_TERMS_LOCKED', makerPurchaseOrderId: world.paperId });
      const quantity = await put(role, `/api/seven-purchase-orders/${world.sevenPoId}/order-facts`, { orderedQuantity: '1300', orderedUnit: 'meters' });
      expect(quantity.status).toBe(409);
      expect(quantity.body.code).toBe('DELIVERY_TERMS_LOCKED');
    }
    const [order] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, world.orderId));
    expect(order!.plannedDeliveryDate).toBe('2027-01-25');
    const [facts] = await db.select().from(sevenPoOrderFacts).where(eq(sevenPoOrderFacts.sevenPurchaseOrderId, world.sevenPoId));
    expect(facts!.orderedQuantity).toBe('1200.000');
    const amount = await put('admin', `/api/seven-purchase-orders/${world.sevenPoId}/order-facts`, { totalAmount: '555000', currency: 'JPY' });
    expect(amount.status).toBe(200);
    expect((await auditRows('FILM_SUPPLY_ORDER_DELIVERY_DATES_UPDATED', world.orderId))).toHaveLength(1);
  });

  /** Rewrites a stored paper to its pre-P2 shape (no deliveryTerms) with the matching digest. */
  async function toPreP2Shape(paperId: string) {
    const row = await storedSnapshot(paperId);
    const { deliveryTerms: _dropped, ...legacy } = row.snapshot as Record<string, unknown>;
    const legacyHash = computeMakerPoSnapshotSha256(legacy as any);
    await db.update(makerPurchaseOrders).set({ snapshot: legacy, snapshotSha256: legacyHash }).where(eq(makerPurchaseOrders.id, paperId));
    return legacyHash;
  }

  it('a draft made before P2 is re-frozen with the delivery terms by the approval (card and approval agree)', async () => {
    const world = await paperWithTerms();
    const legacyHash = await toPreP2Shape(world.paperId);
    const card = await get('admin', `/api/maker-purchase-orders/${world.paperId}/approval-card`);
    expect(card.body.makerPurchaseOrder.snapshotDrifted).toBe(true);
    expect(card.body.makerPurchaseOrder.approvalSnapshotSha256).not.toBe(legacyHash);
    const approved = await post('admin', `/api/maker-purchase-orders/${world.paperId}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, world.paperId));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const row = await storedSnapshot(world.paperId);
    expect((row.snapshot as any).deliveryTerms).toMatchObject({ requestedDeliveryDate: '2027-01-20', sevenPoOrderedQuantity: '1200.000' });
    expect(row.snapshotSha256).toBe(card.body.makerPurchaseOrder.approvalSnapshotSha256);
  });

  it('a paper approved before P2 is not voided at the send (its identity check keeps the stored shape)', async () => {
    const world = await paperWithTerms();
    const approved = await post('admin', `/api/maker-purchase-orders/${world.paperId}/ceo-approval`, await withApprovalSnapshot(app, tokens.admin, world.paperId));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await toPreP2Shape(world.paperId);
    const evidence = await uploadOk(world.sevenPoId, world.orderId, { documentType: 'send_evidence', issuerEntity: 'kanei' });
    const sent = await post('staff', `/api/maker-purchase-orders/${world.paperId}/send-evidence`, {
      evidenceDocumentVersionId: evidence.version.id,
      senderAddress: 'staff@kanei.example',
      recipients: [PAPER_RECIPIENT],
      sentAt: new Date(Date.now() - 60_000).toISOString()
    });
    expect(sent.body?.code, JSON.stringify(sent.body)).not.toBe('SNAPSHOT_VOIDED');
    expect((await storedSnapshot(world.paperId)).status).not.toBe('SNAPSHOT_VOIDED');
    expect(await db.select().from(makerPoEvents).where(and(eq(makerPoEvents.makerPurchaseOrderId, world.paperId), eq(makerPoEvents.eventType, 'SNAPSHOT_VOIDED')))).toHaveLength(0);
  });

  it('a paper frozen before P2 (no deliveryTerms) keeps its digest exactly', () => {
    const base = {
      order: { id: 'o-1', code: 'FILM-1', sevenPoNumber: 'SC-1' },
      items: [{ lineNumber: 1, description: 'フィルム', orderedQuantity: '10.000', unit: 'rolls' }],
      artworkFiles: [{ designKey: 'A', revisionNo: 1, fileSha256: 'a'.repeat(64) }],
      amounts: { currency: 'JPY', totalAmount: '1000' },
      recipientAddress: 'maker@example.com'
    };
    const legacy = buildMakerPoSnapshot(base);
    expect('deliveryTerms' in legacy).toBe(false);
    // The P1 canonical form had exactly these six keys.
    expect(Object.keys(JSON.parse(canonicalJson(legacy))).sort()).toEqual(['amounts', 'items', 'order', 'quantities', 'recipient', 'specs']);
    const withTerms = buildMakerPoSnapshot({ ...base, deliveryTerms: { requestedDeliveryDate: null, plannedDeliveryDate: null, sevenPoOrderedQuantity: null, sevenPoOrderedUnit: null } });
    expect(computeMakerPoSnapshotSha256(withTerms)).not.toBe(computeMakerPoSnapshotSha256(legacy));
  });
});

describe('P2 review M-3: an auditor session exists only through an API that knows the role (0032)', () => {
  const password = 'p2-review-auditor-pass';
  async function loginAs(username: string) {
    const response = await app.request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password })
    });
    return { status: response.status, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0]! };
  }
  async function newUser(role: 'auditor' | 'staff') {
    const id = uuidv7();
    const username = `p2rev_${role}_${nextTag()}`;
    await db.insert(users).values({ id, username, passwordHash: await hashPassword(password), displayName: `合成${role}`, role });
    return { id, username };
  }

  it('the P2 login stores an auditor session in the role-aware form; a bare-hash lookup (P1 build) finds nothing', async () => {
    const auditor = await newUser('auditor');
    const login = await loginAs(auditor.username);
    expect(login.status).toBe(201);
    const token = login.cookie.slice(`${SESSION_COOKIE}=`.length);
    const stored = await db.select({ tokenHash: sessions.tokenHash }).from(sessions).where(eq(sessions.userId, auditor.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash.startsWith('p2:')).toBe(true);
    const { createHash } = await import('node:crypto');
    const bare = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(await db.select().from(sessions).where(eq(sessions.tokenHash, bare))).toHaveLength(0);
    const me = await app.request('/api/me', { headers: { cookie: login.cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).role).toBe('auditor');
  });

  it('the database refuses an auditor session written the P1 way (bare hash); staff stay bare', async () => {
    const auditor = await newUser('auditor');
    const { tokenHash } = issueToken();
    const refused = await db.insert(sessions).values({ id: uuidv7(), userId: auditor.id, tokenHash, expiresAt: new Date(Date.now() + 60_000) })
      .then(() => null, (error: any) => error?.cause?.code ?? error?.code);
    expect(refused).toBe('42501');
    await db.insert(sessions).values({ id: uuidv7(), userId: auditor.id, tokenHash: `p2:${tokenHash}`, expiresAt: new Date(Date.now() + 60_000) });
    const staff = await newUser('staff');
    const login = await loginAs(staff.username);
    expect(login.status).toBe(201);
    const [row] = await db.select({ tokenHash: sessions.tokenHash }).from(sessions).where(eq(sessions.userId, staff.id));
    expect(row!.tokenHash.startsWith('p2:')).toBe(false);
  });

  it('making a user an auditor revokes the sessions they already hold', async () => {
    const user = await newUser('staff');
    const login = await loginAs(user.username);
    expect((await app.request('/api/me', { headers: { cookie: login.cookie } })).status).toBe(200);
    await db.update(users).set({ role: 'auditor' }).where(eq(users.id, user.id));
    expect((await app.request('/api/me', { headers: { cookie: login.cookie } })).status).toBe(401);
    const live = await db.select().from(sessions).where(and(eq(sessions.userId, user.id), sql`${sessions.revokedAt} is null`));
    expect(live).toHaveLength(0);
    // Logging in again as the auditor works through the P2 API.
    expect((await loginAs(user.username)).status).toBe(201);
  });
});

describe('P2 review M-4: the API refuses to start on a database older than its migrations', () => {
  it('names the last journal migration', async () => {
    const journal = JSON.parse(await readFile(path.resolve('packages/db/drizzle/meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> };
    expect(REQUIRED_MIGRATION).toEqual({ tag: journal.entries.at(-1)!.tag, createdAt: journal.entries.at(-1)!.when });
  });

  it('passes on the migrated test database', async () => {
    expect(await checkSchemaPreflight(db)).toEqual({ ok: true, latestApplied: REQUIRED_MIGRATION.createdAt });
  });

  it('refuses a database whose ledger stops earlier, or has no ledger', async () => {
    const answers = (rows: unknown[][]) => {
      let call = 0;
      return { execute: async () => ({ rows: rows[call++] ?? [] }) } as any;
    };
    const behind = await checkSchemaPreflight(answers([[{ present: true }], [{ latest: '1796077560000' }]]));
    expect(behind).toMatchObject({ ok: false, reason: 'migrations_behind', latestApplied: 1796077560000 });
    expect((behind as { message: string }).message).toContain('npm run db:migrate');
    expect(await checkSchemaPreflight(answers([[{ present: false }]]))).toMatchObject({ ok: false, reason: 'migrations_table_missing' });
    expect(await checkSchemaPreflight(answers([[{ present: true }], [{ latest: null }]]))).toMatchObject({ ok: false, reason: 'migrations_behind' });
  });
});
