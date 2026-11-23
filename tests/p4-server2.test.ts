/**
 * P4 server2 (p4-web2b REPORT §3): the server parts the web had to work around.
 * (1) GET /api/assignable-users — the representative's 担当者 picker: admin only,
 *     id·displayName·role only, inactive / deleted / admin users left out.
 * (2) /api/representative-queue `blocked` lists a 「未定」 order from its creation
 *     on, whatever its state — the same rule as the order list's `attention`
 *     (PAYMENT_TERMS_UNDETERMINED); admin only, no amounts.
 * (3) /api/me carries the caller's own displayName.
 * Each block has normal, refusal and permission cases and fails on 5faa6c6
 * (mutation log in /root/company-auto/demo-eml/p4-server2/REPORT.md).
 * Runs only against kanei_crm_mvp_test (tests/setup.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  accounts,
  auditEvents,
  createDatabase,
  filmSupplyOrders,
  makerPurchaseOrders,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import {
  approvalEvidenceDeclarationLine,
  evaluateFilmReceiptAssumption,
  evaluateFilmReceiptClosure,
  filmReceiptClosureBasis,
  buildMakerPoSnapshot,
  computeMakerPoSnapshotSha256,
  makerPoSnapshotWithoutApprovalEvidence,
  evidenceSenderVerdict,
  parseStoredEvidenceSenderDomainCheck,
  PAYMENT_TERMS_ATTENTION_CLOSED_STATES,
  paymentTermsAttention
} from '@kanei/core';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../apps/api/src/app.js';
import { issueToken, SESSION_COOKIE, sessionTokenHashForRole } from '../apps/api/src/auth.js';

const databaseUrl = process.env.DATABASE_URL!;
if (!/@127\.0\.0\.1:5434\/kanei_crm_mvp_test($|\?)/.test(databaseUrl)) {
  throw new Error('p4-server2 tests require kanei_crm_mvp_test');
}
const { db, pool } = createDatabase(databaseUrl);

const ids = {
  admin: uuidv7(), admin2: uuidv7(), staff: uuidv7(), staff2: uuidv7(), staffOff: uuidv7(), staffDeleted: uuidv7(),
  viewer: uuidv7(), auditor: uuidv7(), auditorOff: uuidv7(),
  customer: uuidv7(), customerNoMail: uuidv7(), seven: uuidv7(), maker: uuidv7(),
  projectA: uuidv7(), projectB: uuidv7(), projectGone: uuidv7(), projectC: uuidv7()
};
const DISPLAY = {
  admin: '合成代表者S2', admin2: '合成副代表S2', staff: '合成担当者S2', staff2: '合成担当二S2',
  staffOff: '合成無効担当S2', staffDeleted: '合成削除済担当S2', viewer: '合成閲覧者S2', auditor: '合成監査S2', auditorOff: '合成無効監査S2'
} as const;
const USERNAME = {
  admin: 'admin_s2', admin2: 'admin2_s2', staff: 'staff_s2', staff2: 'staff2_s2', staffOff: 'staff_off_s2',
  staffDeleted: 'staff_deleted_s2', viewer: 'viewer_s2', auditor: 'auditor_s2', auditorOff: 'auditor_off_s2'
} as const;
const DUMMY_HASH = 'not-a-login-hash';

const tokens = { admin: '', staff: '', staff2: '', viewer: '', auditor: '' };
type Role = keyof typeof tokens;
let app: ReturnType<typeof createApp>;

let counter = 0;
const tag = () => `${Date.now().toString(36)}${String(++counter).padStart(3, '0')}`;

async function send(role: Role | null, method: string, url: string, body?: unknown) {
  const response = await app.request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(role ? { cookie: `${SESSION_COOKIE}=${tokens[role]}` } : {}),
      ...(method === 'GET' ? {} : { 'Idempotency-Key': `s2-${tag()}-key` })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, text, headers: response.headers };
}
const get = (role: Role | null, url: string) => send(role, 'GET', url);
const post = (role: Role | null, url: string, body: unknown) => send(role, 'POST', url, body);
const patch = (role: Role | null, url: string, body: unknown) => send(role, 'PATCH', url, body);

function fullChecklist() {
  return {
    issuerNameRecorded: true, issuerName: '合成セブン化学S2',
    documentNumberRecorded: true, documentNumber: 'PO-S2-0001',
    issueDateRecorded: true, issueDate: '2026-11-11',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル',
    pastTransactionCompared: true, pastTransactionNote: '過去の発注書と一致',
    quoteCompared: true, quoteMatchesPo: true, quoteComparisonNote: '見積と一致',
    tamperHints: '', uncertain: false, confirmationReplyRecorded: false, confirmationReplyNote: '',
    verificationNote: '合成チェックリストS2'
  };
}

async function sevenPo(project = ids.projectA) {
  const created = await post('staff', `/api/projects/${project}/seven-purchase-orders`, {
    poNumber: `SEVEN-S2-${tag()}`, officialRegisteredAt: '2026-11-01T09:00:00.000Z'
  });
  expect(created.status, created.text).toBe(201);
  expect((await post('staff', `/api/seven-purchase-orders/${created.body.id}/verification-checklist`, fullChecklist())).status).toBe(200);
  return created.body.id as string;
}

/**
 * A new film order. With a verified seven PO it starts at SEVEN_PO_VERIFIED
 * (auto-advance); `{ sevenPo: false }` keeps it at DRAFT, the very first state.
 */
async function createOrder(paymentTerms: string, project = ids.projectA, options: { sevenPo?: boolean; extra?: Record<string, unknown> } = {}) {
  const sevenPoId = options.sevenPo === false ? null : await sevenPo(project);
  const code = `FSO-S2-${tag()}`;
  const created = await post('staff', `/api/projects/${project}/film-supply-orders`, {
    code, paymentTerms, ...(sevenPoId ? { sevenPurchaseOrderId: sevenPoId } : {}), ...(options.extra ?? {}),
    lines: [{ lineNumber: 1, description: '合成フィルムS2', orderedQuantity: 1000, unit: 'sheets' }]
  });
  expect(created.status, created.text).toBe(201);
  return { orderId: created.body.id as string, code, sevenPoId: sevenPoId as string, lineId: created.body.lines[0].id as string };
}

async function queue() {
  const answer = await get('admin', '/api/representative-queue');
  expect(answer.status, answer.text).toBe(200);
  return answer.body as { items: Array<Record<string, any>>; blocked: Array<Record<string, any>>; counts: { blocked: number } };
}
const blockedRowOf = async (orderId: string) => (await queue()).blocked.find((row) => row.order.id === orderId);

/** Every key anywhere in a JSON value (deep), for the 金額 non-disclosure check. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((entry) => allKeys(entry, out));
  else if (value && typeof value === 'object') {
    for (const [name, entry] of Object.entries(value)) { out.push(name); allKeys(entry, out); }
  }
  return out;
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-p4-server2-'));
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
  const row = (name: keyof typeof DISPLAY, role: 'admin' | 'staff' | 'viewer' | 'auditor', extra: Record<string, unknown> = {}) => ({
    id: ids[name], username: USERNAME[name], passwordHash: DUMMY_HASH, displayName: DISPLAY[name], role, ...extra
  });
  await db.insert(users).values([
    row('admin', 'admin', { displayLanguage: 'ja' }),
    row('admin2', 'admin'),
    row('staff', 'staff'),
    row('staff2', 'staff'),
    row('staffOff', 'staff', { isActive: false }),
    // Logically deleted while is_active stays true (P4 review L-2 shape).
    row('staffDeleted', 'staff', { deletedAt: new Date('2026-11-01T00:00:00.000Z') }),
    row('viewer', 'viewer'),
    row('auditor', 'auditor'),
    row('auditorOff', 'auditor', { isActive: false })
  ] as any);
  await db.insert(accounts).values([
    { id: ids.customer, name: '合成S2顧客', role: 'end_customer', externalCode: 'S2-CUST', contactEmail: 'approvals@customer-s2.example' },
    { id: ids.customerNoMail, name: '合成S2顧客（連絡先なし）', role: 'end_customer', externalCode: 'S2-CUST-NOMAIL' },
    { id: ids.seven, name: '合成S2セブン', role: 'seven', externalCode: 'S2-SEVEN', contactEmail: 'po@seven-s2.example' },
    { id: ids.maker, name: '合成S2メーカー', role: 'maker', externalCode: 'S2-MAKER' }
  ]);
  const now = new Date();
  for (const [id, code, customer] of [
    [ids.projectA, 'S2-A', ids.customer], [ids.projectB, 'S2-B', ids.customer],
    [ids.projectGone, 'S2-GONE', ids.customer], [ids.projectC, 'S2-C', ids.customerNoMail]
  ] as const) {
    await db.insert(projects).values({
      id, code, name: `合成${code}`, businessUnit: 'F1', route: 'F1', leadSource: 'KANEI', status: 'DRAFT',
      endCustomerAccountId: customer, sevenAccountId: ids.seven, makerAccountId: ids.maker, createdByUserId: ids.admin,
      createdAt: now, updatedAt: now
    });
  }
  await db.insert(projectAssignments).values([
    { id: uuidv7(), userId: ids.staff, projectId: ids.projectA },
    { id: uuidv7(), userId: ids.staff, projectId: ids.projectB },
    { id: uuidv7(), userId: ids.staff, projectId: ids.projectGone },
    { id: uuidv7(), userId: ids.staff, projectId: ids.projectC },
    { id: uuidv7(), userId: ids.viewer, projectId: ids.projectA },
    { id: uuidv7(), userId: ids.auditor, projectId: ids.projectA }
  ]);
  for (const role of Object.keys(tokens) as Role[]) {
    const { token, tokenHash } = issueToken();
    const storedHash = sessionTokenHashForRole(tokenHash, role === 'auditor' ? 'auditor' : 'staff');
    await db.insert(sessions).values({ id: uuidv7(), userId: ids[role], tokenHash: storedHash, expiresAt: new Date(Date.now() + 3600_000) });
    tokens[role] = token;
  }
});

afterAll(async () => {
  await pool.end();
});

// ================================================================ (1)
describe('(1) GET /api/assignable-users: the 担当者 picker (admin only, minimum fields)', () => {
  const url = '/api/assignable-users';

  it('lists exactly the active, not deleted staff / viewer / auditor users, ordered by displayName then id', async () => {
    const answer = await get('admin', url);
    expect(answer.status, answer.text).toBe(200);
    const expected = (['staff', 'staff2', 'viewer', 'auditor'] as const)
      .map((name) => ({ id: ids[name], displayName: DISPLAY[name], role: name === 'staff2' ? 'staff' : name }))
      .sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : a.id < b.id ? -1 : 1));
    expect(answer.body.users).toEqual(expected);
    expect(answer.body).toMatchObject({ assignableRoles: ['staff', 'viewer', 'auditor'], limit: 200, truncated: false });
  });

  it('leaves out inactive, logically deleted and admin users', async () => {
    const listed = (await get('admin', url)).body.users.map((row: { id: string }) => row.id);
    for (const name of ['staffOff', 'staffDeleted', 'auditorOff', 'admin', 'admin2'] as const) {
      expect(listed, name).not.toContain(ids[name]);
    }
  });

  it('every row carries id, displayName and role only — never the login name, hash or any other column', async () => {
    const answer = await get('admin', url);
    for (const row of answer.body.users) expect(Object.keys(row).sort()).toEqual(['displayName', 'id', 'role']);
    expect(Object.keys(answer.body).sort()).toEqual(['assignableRoles', 'limit', 'truncated', 'users']);
    for (const name of Object.values(USERNAME)) expect(answer.text).not.toContain(name);
    expect(answer.text).not.toContain(DUMMY_HASH);
    expect(answer.text).not.toMatch(/password|username|email|session|token|deletedAt|isActive|displayLanguage/i);
  });

  it('every listed user is one POST …/assignments accepts (the picker never offers a refused choice)', async () => {
    const listed = (await get('admin', url)).body.users as Array<{ id: string }>;
    for (const row of listed) {
      const created = await post('admin', `/api/projects/${ids.projectB}/assignments`, { userId: row.id });
      expect([201, 409], `${row.id}: ${created.text}`).toContain(created.status);
    }
    for (const name of ['staffOff', 'staffDeleted', 'admin2'] as const) {
      const refused = await post('admin', `/api/projects/${ids.projectB}/assignments`, { userId: ids[name] });
      expect(refused.status, name).toBe(422);
    }
  });

  it('a user deactivated or deleted later leaves the list at once', async () => {
    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.staff2));
    try {
      expect((await get('admin', url)).body.users.map((row: { id: string }) => row.id)).not.toContain(ids.staff2);
    } finally {
      await db.update(users).set({ isActive: true }).where(eq(users.id, ids.staff2));
    }
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, ids.staff2));
    try {
      expect((await get('admin', url)).body.users.map((row: { id: string }) => row.id)).not.toContain(ids.staff2);
    } finally {
      await db.update(users).set({ deletedAt: null }).where(eq(users.id, ids.staff2));
    }
    expect((await get('admin', url)).body.users.map((row: { id: string }) => row.id)).toContain(ids.staff2);
  });

  it('?limit bounds the answer and says truncated; a malformed limit falls back to the default', async () => {
    const two = await get('admin', `${url}?limit=2`);
    expect(two.body.users).toHaveLength(2);
    expect(two.body).toMatchObject({ limit: 2, truncated: true });
    const all = await get('admin', `${url}?limit=4`);
    expect(all.body).toMatchObject({ limit: 4, truncated: false });
    expect(all.body.users).toHaveLength(4);
    for (const bad of ['0', '-1', 'abc', '1.5', "1'%20OR%201=1--"]) {
      const answer = await get('admin', `${url}?limit=${bad}`);
      expect(answer.status, bad).toBe(200);
      expect(answer.body.limit, bad).toBe(200);
      expect(answer.body.users, bad).toHaveLength(4);
    }
    expect((await get('admin', `${url}?limit=100000`)).body.limit).toBe(500);
  });

  it('answers 401 without a session and 403 CEO_ONLY to staff, viewer and auditor (even assigned ones)', async () => {
    const anonymous = await get(null, url);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe('AUTH_REQUIRED');
    for (const role of ['staff', 'staff2', 'viewer', 'auditor'] as const) {
      const refused = await get(role, url);
      expect(refused.status, role).toBe(403);
      expect(refused.body, role).toEqual({ error: 'この操作は代表者だけが行えます', code: 'CEO_ONLY' });
    }
  });
});

// ================================================================ (2)
describe('(2) representative queue `blocked`: a 未定 order from its creation on, whatever its state', () => {
  it('a 未定 order is blocked right after creation (DRAFT), with the attention reason and the PATCH fix', async () => {
    const order = await createOrder('undetermined', ids.projectA, { sevenPo: false });
    const row = await blockedRowOf(order.orderId);
    expect(row, 'DRAFT 未定 order missing from blocked').toBeDefined();
    expect(row).toMatchObject({
      key: `payment_terms_undetermined:${order.orderId}`,
      kind: 'payment_terms_undetermined',
      order: { id: order.orderId, code: order.code, status: 'DRAFT', paymentTerms: 'undetermined' },
      project: { id: ids.projectA, code: 'S2-A' },
      reason: { code: 'PAYMENT_TERMS_UNDETERMINED' },
      fixableBy: ['admin', 'staff'],
      paymentTermsEditable: true,
      paymentTermsLock: null,
      deepLink: {
        step: 'payment_terms', subjectId: order.orderId,
        action: { method: 'PATCH', path: `/api/film-supply-orders/${order.orderId}/payment-terms` }
      }
    });
  });

  it('an order that auto-advanced at creation (SEVEN_PO_VERIFIED) is blocked too', async () => {
    const order = await createOrder('undetermined');
    expect((await blockedRowOf(order.orderId))?.order).toMatchObject({ status: 'SEVEN_PO_VERIFIED', paymentTerms: 'undetermined' });
  });

  it('a decided term is never blocked, and deciding the term takes the order off the list', async () => {
    const prepaid = await createOrder('prepaid');
    const onDelivery = await createOrder('on_delivery');
    expect(await blockedRowOf(prepaid.orderId)).toBeUndefined();
    expect(await blockedRowOf(onDelivery.orderId)).toBeUndefined();
    const order = await createOrder('undetermined');
    expect(await blockedRowOf(order.orderId)).toBeDefined();
    const fixed = await patch('staff', `/api/film-supply-orders/${order.orderId}/payment-terms`, { paymentTerms: 'prepaid' });
    expect(fixed.status, fixed.text).toBe(200);
    expect(await blockedRowOf(order.orderId)).toBeUndefined();
  });

  it('stays blocked through the work states (ARTWORK_RECEIVED) — the state is not the condition', async () => {
    const order = await createOrder('undetermined');
    const moved = await post('staff', `/api/film-supply-orders/${order.orderId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    expect(moved.status, moved.text).toBe(200);
    expect((await blockedRowOf(order.orderId))?.order.status).toBe('ARTWORK_RECEIVED');
  });

  it('a frozen (ON_HOLD) 未定 order is listed with paymentTermsEditable false and the lock reason', async () => {
    const order = await createOrder('undetermined');
    const held = await post('staff', `/api/film-supply-orders/${order.orderId}/transitions`, { to: 'ON_HOLD', holdReason: '合成保留S2' });
    expect(held.status, held.text).toBe(200);
    const row = await blockedRowOf(order.orderId);
    expect(row).toMatchObject({
      order: { status: 'ON_HOLD' },
      paymentTermsEditable: false,
      paymentTermsLock: { code: 'PAYMENT_TERMS_LOCKED', reason: 'order_frozen' }
    });
    // The flag tells the truth: the PATCH the row links to is refused while frozen.
    const refused = await patch('staff', `/api/film-supply-orders/${order.orderId}/payment-terms`, { paymentTerms: 'prepaid' });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('PAYMENT_TERMS_LOCKED');
  });

  it('a 未定 order whose paper already carries a CEO approval (pre-gate data) is listed as locked (ceo_approved)', async () => {
    const order = await createOrder('undetermined');
    await db.update(filmSupplyOrders).set({ status: 'MAKER_PO_READY' }).where(eq(filmSupplyOrders.id, order.orderId));
    expect(await blockedRowOf(order.orderId)).toMatchObject({ paymentTermsEditable: true, paymentTermsLock: null });
    // Data shape from before the G6 gate (direct insert): the paper's approval stamp, not its status, locks the term.
    await db.insert(makerPurchaseOrders).values({
      id: uuidv7(), filmSupplyOrderId: order.orderId, snapshot: {}, snapshotSha256: '0'.repeat(64), status: 'DRAFT',
      ceoApprovedAt: new Date(), ceoApprovedByUserId: ids.admin, createdByUserId: ids.admin
    });
    expect(await blockedRowOf(order.orderId)).toMatchObject({
      order: { status: 'MAKER_PO_READY' },
      paymentTermsEditable: false,
      paymentTermsLock: { code: 'PAYMENT_TERMS_LOCKED', reason: 'ceo_approved' }
    });
    const list = await get('staff', `/api/projects/${ids.projectA}/film-supply-orders`);
    expect(list.body.orders.find((row: { id: string }) => row.id === order.orderId).paymentTermsEditable).toBe(false);
  });

  it('every state except the closed ones is listed; cancelled, closed, deleted orders and deleted projects are not', async () => {
    const statuses = (await db.execute(sql`select unnest(enum_range(null::film_supply_order_status))::text as status`)).rows
      .map((entry) => String((entry as { status: string }).status));
    expect(statuses).toContain('DRAFT');
    const byStatus = new Map<string, string>();
    for (const status of statuses) {
      const order = await createOrder('undetermined', ids.projectB);
      // Read-model check: the row is put in each state directly (the queue reads state, not history).
      await db.update(filmSupplyOrders).set({ status: status as any }).where(eq(filmSupplyOrders.id, order.orderId));
      byStatus.set(status, order.orderId);
    }
    const blocked = new Set((await queue()).blocked.map((row) => row.order.id));
    for (const [status, orderId] of byStatus) {
      const closed = (PAYMENT_TERMS_ATTENTION_CLOSED_STATES as readonly string[]).includes(status);
      expect(blocked.has(orderId), status).toBe(!closed);
    }
    expect(PAYMENT_TERMS_ATTENTION_CLOSED_STATES).toEqual(['CANCELLED', 'FILM_RECEIPT_ASSUMED_NO_ISSUE']);

    const deleted = await createOrder('undetermined', ids.projectB);
    await db.update(filmSupplyOrders).set({ deletedAt: new Date() }).where(eq(filmSupplyOrders.id, deleted.orderId));
    const gone = await createOrder('undetermined', ids.projectGone);
    await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, ids.projectGone));
    const after = new Set((await queue()).blocked.map((row) => row.order.id));
    expect(after.has(deleted.orderId)).toBe(false);
    expect(after.has(gone.orderId)).toBe(false);
  });

  it('agrees with the project order list: attention PAYMENT_TERMS_UNDETERMINED ⇔ in blocked (same reason text)', async () => {
    for (const project of [ids.projectA, ids.projectB]) {
      const list = await get('staff', `/api/projects/${project}/film-supply-orders`);
      expect(list.status, list.text).toBe(200);
      const answer = await queue();
      const blocked = new Map(answer.blocked.map((row) => [row.order.id, row]));
      expect(list.body.orders.length).toBeGreaterThan(0);
      for (const order of list.body.orders) {
        const attention = order.attention.find((entry: { code: string }) => entry.code === 'PAYMENT_TERMS_UNDETERMINED');
        expect(blocked.has(order.id), `${order.code} ${order.status}`).toBe(Boolean(attention));
        if (attention) expect(blocked.get(order.id)!.reason).toEqual(attention);
      }
      expect(answer.counts.blocked).toBe(answer.blocked.length);
    }
  });

  it('the pure rule: 未定 (or no stored term) in an open state needs attention; a decided term or a closed state does not', () => {
    expect(paymentTermsAttention({ orderStatus: 'DRAFT', paymentTerms: 'undetermined' })).toEqual([
      { code: 'PAYMENT_TERMS_UNDETERMINED', message: '支払条件が「未定」です。代表承認の前に「前払い」または「納品後払い」を選んでください' }
    ]);
    expect(paymentTermsAttention({ orderStatus: 'MAKER_PO_READY', paymentTerms: null })).toHaveLength(1);
    expect(paymentTermsAttention({ orderStatus: 'DRAFT', paymentTerms: 'prepaid' })).toEqual([]);
    expect(paymentTermsAttention({ orderStatus: 'DRAFT', paymentTerms: 'on_delivery' })).toEqual([]);
    expect(paymentTermsAttention({ orderStatus: 'CANCELLED', paymentTerms: 'undetermined' })).toEqual([]);
    expect(paymentTermsAttention({ orderStatus: 'FILM_RECEIPT_ASSUMED_NO_ISSUE', paymentTerms: 'undetermined' })).toEqual([]);
  });

  it('blocked rows carry no amount or price, and the queue stays admin only', async () => {
    await createOrder('undetermined');
    const answer = await get('admin', '/api/representative-queue');
    expect(answer.body.blocked.length).toBeGreaterThan(0);
    for (const row of answer.body.blocked) {
      const keys = allKeys(row);
      expect(keys.filter((name) => /amount|price|total|currency|display/i.test(name)), row.key).toEqual([]);
    }
    expect(JSON.stringify(answer.body.blocked)).not.toMatch(/480000|JPY|円/);
    expect((await get(null, '/api/representative-queue')).status).toBe(401);
    for (const role of ['staff', 'viewer', 'auditor'] as const) {
      const refused = await get(role, '/api/representative-queue');
      expect(refused.status, role).toBe(403);
      expect(refused.body.code, role).toBe('CEO_ONLY');
    }
  });
});

// ================================================================ (3)
describe('(3) /api/me carries the caller\'s own displayName', () => {
  it.each(['admin', 'staff', 'staff2', 'viewer', 'auditor'] as const)('%s sees its own displayName and nothing more', async (role) => {
    const me = await get(role, '/api/me');
    expect(me.status, me.text).toBe(200);
    expect(me.body.id).toBe(ids[role]);
    expect(me.body.displayName).toBe(DISPLAY[role]);
    expect(Object.keys(me.body).sort()).toEqual(['assignedProjectIds', 'displayLanguage', 'displayName', 'id', 'role']);
    expect(me.text).not.toContain(USERNAME[role]);
    expect(me.text).not.toContain(DUMMY_HASH);
    // Never another user's name.
    for (const [other, name] of Object.entries(DISPLAY)) if (other !== role) expect(me.text, other).not.toContain(name);
  });

  it('follows a rename at once (read per request, not cached in the session)', async () => {
    await db.update(users).set({ displayName: '合成改名担当S2' }).where(eq(users.id, ids.staff2));
    try {
      expect((await get('staff2', '/api/me')).body.displayName).toBe('合成改名担当S2');
    } finally {
      await db.update(users).set({ displayName: DISPLAY.staff2 }).where(eq(users.id, ids.staff2));
    }
  });

  it('keeps the other fields as they were (role, assignments, language)', async () => {
    const me = await get('admin', '/api/me');
    expect(me.body).toEqual({ id: ids.admin, role: 'admin', displayName: DISPLAY.admin, assignedProjectIds: [], displayLanguage: 'ja' });
    const staff = await get('staff', '/api/me');
    expect([...staff.body.assignedProjectIds].sort()).toEqual([ids.projectA, ids.projectB, ids.projectGone, ids.projectC].sort());
  });

  it('answers 401 AUTH_REQUIRED without a session or with a revoked one', async () => {
    const anonymous = await get(null, '/api/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ error: '認証が必要です', code: 'AUTH_REQUIRED' });
    const response = await app.request('/api/me', { headers: { cookie: `${SESSION_COOKIE}=not-a-session` } });
    expect(response.status).toBe(401);
  });
});

// ================================================================ server2 review L-1 / I-3
describe('server2 review L-1: a cancelled or deleted approved paper does not lock the term (queue = list = PATCH)', () => {
  async function undeterminedReadyOrderWithApprovedPaper() {
    const order = await createOrder('undetermined');
    await db.update(filmSupplyOrders).set({ status: 'MAKER_PO_READY' }).where(eq(filmSupplyOrders.id, order.orderId));
    const paperId = uuidv7();
    // Pre-gate data shape (direct insert): a paper carrying the representative's approval stamp.
    await db.insert(makerPurchaseOrders).values({
      id: paperId, filmSupplyOrderId: order.orderId, snapshot: {}, snapshotSha256: '0'.repeat(64), status: 'DRAFT',
      ceoApprovedAt: new Date(), ceoApprovedByUserId: ids.admin, createdByUserId: ids.admin
    });
    expect(await blockedRowOf(order.orderId)).toMatchObject({ paymentTermsEditable: false, paymentTermsLock: { reason: 'ceo_approved' } });
    return { ...order, paperId };
  }

  async function expectUnlocked(orderId: string) {
    expect(await blockedRowOf(orderId)).toMatchObject({ paymentTermsEditable: true, paymentTermsLock: null });
    const list = await get('staff', `/api/projects/${ids.projectA}/film-supply-orders`);
    expect(list.body.orders.find((row: { id: string }) => row.id === orderId).paymentTermsEditable).toBe(true);
    // The flag tells the truth: the PATCH the row links to goes through.
    const fixed = await patch('staff', `/api/film-supply-orders/${orderId}/payment-terms`, { paymentTerms: 'prepaid' });
    expect(fixed.status, fixed.text).toBe(200);
    expect(await blockedRowOf(orderId)).toBeUndefined();
  }

  it('after the approved paper is cancelled: editable in the queue and the list, and the PATCH answers 200', async () => {
    const order = await undeterminedReadyOrderWithApprovedPaper();
    await db.update(makerPurchaseOrders).set({ status: 'CANCELLED' }).where(eq(makerPurchaseOrders.id, order.paperId));
    await expectUnlocked(order.orderId);
  });

  it('after the approved paper is logically deleted: editable in the queue and the list, and the PATCH answers 200', async () => {
    const order = await undeterminedReadyOrderWithApprovedPaper();
    await db.update(makerPurchaseOrders).set({ deletedAt: new Date() }).where(eq(makerPurchaseOrders.id, order.paperId));
    await expectUnlocked(order.orderId);
  });

  it('a live paper without the approval stamp does not lock either', async () => {
    const order = await createOrder('undetermined');
    await db.update(filmSupplyOrders).set({ status: 'MAKER_PO_READY' }).where(eq(filmSupplyOrders.id, order.orderId));
    await db.insert(makerPurchaseOrders).values({
      id: uuidv7(), filmSupplyOrderId: order.orderId, snapshot: {}, snapshotSha256: '0'.repeat(64), status: 'DRAFT', createdByUserId: ids.admin
    });
    await expectUnlocked(order.orderId);
  });
});

describe('server2 review I-3: GET /api/assignable-users is never cached', () => {
  it('answers 200, 401 and 403 with Cache-Control: private, no-store', async () => {
    for (const role of ['admin', null, 'staff'] as const) {
      const answer = await get(role, '/api/assignable-users');
      expect(answer.status, String(role)).toBe(role === 'admin' ? 200 : role === null ? 401 : 403);
      expect(answer.headers.get('cache-control'), String(role)).toBe('private, no-store');
    }
  });
});

// ================================================================ (4) web2b review M-1
describe('(4) approval card: each evidence carries the server\'s sender verdict (display and warning only)', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const CARD_SENDER_KEYS = ['declarationLine', 'fromAddress', 'senderDomainCheck', 'senderVerdict', 'uploadedAt', 'uploadedBy', 'warnings'];

  function approvalEml(fromLines: string[], stamp = tag()): string {
    return [
      ...fromLines.map((address) => `From: 承認者 <${address}>`),
      'To: KANEI 担当 <staff@kanei.example>', `Subject: 校正承認 ${stamp}`, 'Date: Mon, 16 Nov 2026 01:00:00 +0000',
      `Message-ID: <approval-${stamp}@mail.example>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '',
      `承認します（${stamp}）`, ''
    ].join('\r\n');
  }

  async function uploadEvidence(chain: { sevenPoId: string; orderId: string }, project: string, organization: 'customer' | 'seven', content: string) {
    const uploaded = await post('staff', `/api/projects/${project}/documents`, {
      documentType: 'approval_evidence', issuerEntity: organization === 'customer' ? 'customer_generated' : 'seven',
      filename: `s2-${organization}-${tag()}.eml`, contentType: 'text/plain', contentBase64: b64(content),
      sevenPurchaseOrderId: chain.sevenPoId, filmSupplyOrderId: chain.orderId, designKey: 'label-front'
    });
    expect(uploaded.status, uploaded.text).toBe(201);
    return uploaded.body as { document: { id: string }; version: { id: string } };
  }

  /** An order (prepaid, with 希望納期) at MAKER_PO_READY through two recorded approvals, and its paper with an amount. */
  async function cardFor(project: string, evidence: { customer: string; seven: string }) {
    const order = await createOrder('prepaid', project, { extra: { requestedDeliveryDate: '2027-04-30' } });
    expect((await post('staff', `/api/film-supply-orders/${order.orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).status).toBe(200);
    const artwork = `s2 artwork ${tag()}\n`;
    const proof = await post('staff', `/api/projects/${project}/documents`, {
      documentType: 'proof', issuerEntity: 'kanei', filename: `s2-proof-${tag()}.txt`, contentType: 'text/plain',
      contentBase64: b64(artwork), sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId, designKey: 'label-front'
    });
    expect(proof.status, proof.text).toBe(201);
    const revision = await post('staff', `/api/film-supply-orders/${order.orderId}/artwork-revisions`, { designKey: 'label-front', fileDocumentVersionId: proof.body.version.id });
    expect(revision.status, revision.text).toBe(201);
    const recorded: Record<string, any> = {};
    for (const organization of ['customer', 'seven'] as const) {
      const doc = await uploadEvidence(order, project, organization, evidence[organization]);
      const approval = await post('staff', `/api/artwork-revisions/${revision.body.id}/approvals`, {
        organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
        evidenceIdentifier: `S2-ID-${tag()}`, evidenceDocumentVersionId: doc.version.id
      });
      expect(approval.status, approval.text).toBe(201);
      recorded[organization] = approval.body;
    }
    const paper = await post('admin', `/api/film-supply-orders/${order.orderId}/maker-purchase-orders`, {
      recipientAddress: 'maker-po-s2@example.com', amounts: { currency: 'JPY', totalAmount: '480000' }
    });
    expect(paper.status, paper.text).toBe(201);
    const card = await get('admin', `/api/maker-purchase-orders/${paper.body.id}/approval-card`);
    expect(card.status, card.text).toBe(200);
    const organizations = card.body.approvals.designs[0].organizations;
    return {
      order, paperId: paper.body.id as string, card: card.body, customer: organizations.customer.evidence, seven: organizations.seven.evidence,
      recorded, revisionId: revision.body.id as string, artwork, project
    };
  }

  it('a foreign-domain EML that counted automatically is a warning on the card, never 「申告どおり」; the matching one is', async () => {
    const { card, customer, seven, recorded } = await cardFor(ids.projectA, {
      customer: approvalEml(['boss@evil-s2.example']),
      seven: approvalEml(['po@seven-s2.example'])
    });
    // The web2b review M-1 shape: the mismatch counted (verified in the document) and the order moved on.
    expect(recorded.customer).toMatchObject({ countsTowardDualApproval: true, senderDomainCheck: { status: 'mismatch' } });
    expect(customer).toMatchObject({
      issuerMatchesOrganization: true,
      filename: expect.stringMatching(/^s2-customer-/),
      uploadedBy: { id: ids.staff, displayName: DISPLAY.staff },
      uploadedAt: expect.any(String),
      fromAddress: 'boss@evil-s2.example',
      senderDomainCheck: { status: 'mismatch', fromAddress: 'boss@evil-s2.example', fromDomain: 'evil-s2.example', registeredDomain: 'customer-s2.example' },
      senderVerdict: { code: 'mismatch', tone: 'warning' },
      declarationLine: { code: 'sender_domain_mismatch', tone: 'warning' },
      warnings: [{ code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', fromDomain: 'evil-s2.example', registeredDomain: 'customer-s2.example' }]
    });
    expect(customer.declarationLine.label).not.toContain('申告どおり');
    expect(seven).toMatchObject({
      fromAddress: 'po@seven-s2.example',
      senderDomainCheck: { status: 'match', registeredDomain: 'seven-s2.example' },
      senderVerdict: { code: 'match', tone: 'ok' },
      declarationLine: { code: 'declared_and_sender_match', tone: 'ok', label: '申告どおり（差出人のドメインも一致）' },
      warnings: []
    });
    expect(Object.keys(customer.uploadedBy).sort()).toEqual(['displayName', 'id']);
    for (const name of CARD_SENDER_KEYS) expect(seven, name).toHaveProperty(name);
    // Display only: no new blocker, and the card still approves.
    expect(card.blockers.map((entry: { code: string }) => entry.code).filter((code: string) => code.startsWith('EVIDENCE_'))).toEqual([]);
    expect(card.canApprove).toBe(true);
  });

  it('the warning never refuses: the approval goes through, and the frozen snapshot / its hash carry no sender data', async () => {
    const { paperId, card } = await cardFor(ids.projectA, {
      customer: approvalEml(['boss@evil-s2.example']),
      seven: approvalEml(['po@other-s2.example'])
    });
    const hash = card.makerPurchaseOrder.approvalSnapshotSha256;
    const approved = await post('admin', `/api/maker-purchase-orders/${paperId}/ceo-approval`, { expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: hash });
    expect(approved.status, approved.text).toBe(200);
    const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, paperId));
    expect(row!.snapshotSha256).toBe(hash);
    expect(JSON.stringify(row!.snapshot)).not.toMatch(/senderDomainCheck|fromAddress|senderVerdict|declarationLine|evil-s2/);
  });

  it('two From headers → unverifiable (warning); a customer without a registered address → not compared (neutral)', async () => {
    const two = await cardFor(ids.projectA, {
      customer: approvalEml(['boss@customer-s2.example', 'x@evil-s2.example']),
      seven: approvalEml(['po@seven-s2.example'])
    });
    expect(two.customer).toMatchObject({
      senderDomainCheck: { status: 'multiple_from' },
      senderVerdict: { code: 'unverifiable', tone: 'warning' },
      declarationLine: { code: 'sender_unverifiable', tone: 'warning' },
      warnings: [{ code: 'EVIDENCE_SENDER_UNVERIFIABLE' }]
    });
    expect(two.customer.declarationLine.label).not.toContain('申告どおり');
    const none = await cardFor(ids.projectC, {
      customer: approvalEml(['boss@customer-s2.example']),
      seven: approvalEml(['po@seven-s2.example'])
    });
    expect(none.customer).toMatchObject({
      senderDomainCheck: { status: 'no_registered_domain', registeredDomain: null },
      senderVerdict: { code: 'no_registered_domain', tone: 'neutral' },
      declarationLine: { code: 'declared_only', tone: 'neutral' },
      warnings: []
    });
    expect(none.customer.declarationLine.label).not.toContain('申告どおり');
  });

  it('the sender data is the representative\'s: staff, viewer and auditor get 403 CEO_ONLY for the card', async () => {
    const { paperId } = await cardFor(ids.projectA, { customer: approvalEml(['boss@evil-s2.example']), seven: approvalEml(['po@seven-s2.example']) });
    for (const role of ['staff', 'viewer', 'auditor'] as const) {
      const refused = await get(role, `/api/maker-purchase-orders/${paperId}/approval-card`);
      expect(refused.status, role).toBe(403);
      expect(refused.body.code, role).toBe('CEO_ONLY');
      expect(refused.text, role).not.toMatch(/evil-s2|senderDomainCheck|480000/);
    }
  });

  it('pure rules: every check status has one verdict, and 「申告どおり」 only for a declared issuer with a matching From', () => {
    const check = (status: string) => ({ status, fromAddress: 'a@b.example', fromDomain: 'b.example', registeredDomain: 'c.example' }) as any;
    expect(evidenceSenderVerdict(check('match')).code).toBe('match');
    expect(evidenceSenderVerdict(check('mismatch'))).toMatchObject({ code: 'mismatch', tone: 'warning' });
    expect(evidenceSenderVerdict(check('from_missing'))).toMatchObject({ code: 'unverifiable', tone: 'warning' });
    expect(evidenceSenderVerdict(check('multiple_from'))).toMatchObject({ code: 'unverifiable', tone: 'warning' });
    expect(evidenceSenderVerdict(check('no_registered_domain'))).toMatchObject({ code: 'no_registered_domain', tone: 'neutral' });
    expect(evidenceSenderVerdict(check('not_email'))).toMatchObject({ code: 'not_email', tone: 'neutral' });
    expect(evidenceSenderVerdict(null)).toMatchObject({ code: 'not_recorded', tone: 'neutral' });
    const line = (issuerMatchesOrganization: boolean, status: string | null, sharedEvidence = false) =>
      approvalEvidenceDeclarationLine({ issuerMatchesOrganization, sharedEvidence, senderDomainCheck: status ? check(status) : null });
    expect(line(true, 'match').code).toBe('declared_and_sender_match');
    for (const status of ['mismatch', 'from_missing', 'multiple_from', 'no_registered_domain', 'not_email', null]) {
      expect(line(true, status).label, String(status)).not.toContain('申告どおり');
    }
    expect(line(false, 'match')).toMatchObject({ code: 'issuer_differs', tone: 'warning' });
    expect(line(false, 'match', true)).toMatchObject({ code: 'shared_evidence', tone: 'warning' });
    expect(line(true, 'not_email').code).toBe('declared_only');
    // Stored values are read back defensively: anything malformed is "not recorded".
    expect(parseStoredEvidenceSenderDomainCheck({ status: 'match', fromAddress: 'a@b.example', fromDomain: 'b.example', registeredDomain: 'b.example' }))
      .toEqual({ status: 'match', fromAddress: 'a@b.example', fromDomain: 'b.example', registeredDomain: 'b.example' });
    for (const bad of [null, 'match', { status: 'trusted' }, { status: 7 }, []]) expect(parseStoredEvidenceSenderDomainCheck(bad)).toBeNull();
    expect(parseStoredEvidenceSenderDomainCheck({ status: 'mismatch', fromAddress: 5 })).toEqual({ status: 'mismatch', fromAddress: null, fromDomain: null, registeredDomain: null });
  });

  // ============================================================ (5) review2 M-1 / L-1
  describe('(5) review2 M-1: the CEO approval is pinned to the approval evidence set the card showed', () => {
    type Chain = Awaited<ReturnType<typeof cardFor>>;
    const cardOf = async (paperId: string) => {
      const card = await get('admin', `/api/maker-purchase-orders/${paperId}/approval-card`);
      expect(card.status, card.text).toBe(200);
      return card.body;
    };
    const approve = (paperId: string, hash: string) =>
      post('admin', `/api/maker-purchase-orders/${paperId}/ceo-approval`, { expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: hash });
    /** staff records one more 顧客 decision with a new evidence file (the review2 E2 step). */
    async function recordCustomer(chain: Chain, decision: 'APPROVE' | 'REVOKE', content: string) {
      const doc = await uploadEvidence(chain.order, chain.project, 'customer', content);
      return await post('staff', `/api/artwork-revisions/${chain.revisionId}/approvals`, {
        organization: 'customer', decision, evidenceSource: 'email', eventTime: '2026-11-16T10:00:00.000Z',
        evidenceIdentifier: `S2-ID-${tag()}`, evidenceDocumentVersionId: doc.version.id
      });
    }
    const foreign = () => approvalEml(['boss@evil-s2.example']);
    const fresh = () => cardFor(ids.projectA, { customer: approvalEml(['boss@customer-s2.example']), seven: approvalEml(['po@seven-s2.example']) });
    async function expectNotApproved(paperId: string) {
      const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, paperId));
      expect(row!.status).toBe('DRAFT');
      expect(row!.ceoApprovedAt).toBeNull();
    }

    it('review2 E2: revoke + re-approval with a foreign-domain mail after the card → the card\'s hash is refused 409 MAKER_PO_SNAPSHOT_CHANGED', async () => {
      const chain = await fresh();
      expect(chain.customer.declarationLine.code).toBe('declared_and_sender_match');
      const shownHash = chain.card.makerPurchaseOrder.approvalSnapshotSha256;
      expect((await recordCustomer(chain, 'REVOKE', approvalEml(['boss@customer-s2.example']))).status).toBe(201);
      const again = await recordCustomer(chain, 'APPROVE', foreign());
      expect(again.status, again.text).toBe(201);
      expect(again.body).toMatchObject({ countsTowardDualApproval: true, senderDomainCheck: { status: 'mismatch' } });
      const reread = await cardOf(chain.paperId);
      expect(reread.makerPurchaseOrder.approvalSnapshotSha256).not.toBe(shownHash);
      expect(reread.approvals.designs[0].organizations.customer.evidence.declarationLine.code).toBe('sender_domain_mismatch');
      const refused = await approve(chain.paperId, shownHash);
      expect(refused.status, refused.text).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'MAKER_PO_SNAPSHOT_CHANGED', expectedSnapshotSha256: shownHash, snapshotSha256: reread.makerPurchaseOrder.approvalSnapshotSha256
      });
      await expectNotApproved(chain.paperId);
      // After re-reading the card (which now shows the warning) the approval goes through, frozen on that set.
      const approved = await approve(chain.paperId, reread.makerPurchaseOrder.approvalSnapshotSha256);
      expect(approved.status, approved.text).toBe(200);
      const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, chain.paperId));
      expect(row!.snapshotSha256).toBe(reread.makerPurchaseOrder.approvalSnapshotSha256);
      const frozen = (row!.snapshot as any).approvalEvidence as Array<Record<string, string>>;
      const shown = reread.approvals.designs[0].organizations;
      expect(frozen).toEqual([
        { designKey: 'label-front', organization: 'customer', approvalEventId: shown.customer.approvalEventId,
          evidenceDocumentVersionId: shown.customer.evidence.documentVersionId, evidenceSha256: shown.customer.evidence.sha256 },
        { designKey: 'label-front', organization: 'seven', approvalEventId: shown.seven.approvalEventId,
          evidenceDocumentVersionId: shown.seven.evidence.documentVersionId, evidenceSha256: shown.seven.evidence.sha256 }
      ]);
      expect(shown.customer.approvalEventId).toBe(again.body.approvalEvent.id);
      // Only ids and content hashes are frozen: no verdict wording, no From address.
      expect(JSON.stringify(row!.snapshot)).not.toMatch(/senderVerdict|declarationLine|senderDomainCheck|fromAddress|evil-s2/);
    });

    it('a second APPROVE (no revoke) with another file also moves the hash; an unchanged set keeps it (re-reading is stable)', async () => {
      const chain = await fresh();
      const shownHash = chain.card.makerPurchaseOrder.approvalSnapshotSha256;
      expect((await cardOf(chain.paperId)).makerPurchaseOrder.approvalSnapshotSha256).toBe(shownHash);
      expect((await recordCustomer(chain, 'APPROVE', foreign())).status).toBe(201);
      expect((await approve(chain.paperId, shownHash)).body.code).toBe('MAKER_PO_SNAPSHOT_CHANGED');
      await expectNotApproved(chain.paperId);
    });

    it('a revoke alone right before the approval is never approved over', async () => {
      const chain = await fresh();
      const shownHash = chain.card.makerPurchaseOrder.approvalSnapshotSha256;
      expect((await recordCustomer(chain, 'REVOKE', approvalEml(['boss@customer-s2.example']))).status).toBe(201);
      const refused = await approve(chain.paperId, shownHash);
      expect([409, 422]).toContain(refused.status);
      await expectNotApproved(chain.paperId);
    });

    it('the representative\'s amount entry is pinned the same way (409 MAKER_PO_SNAPSHOT_CHANGED, nothing written)', async () => {
      const chain = await fresh();
      const shownHash = chain.card.makerPurchaseOrder.approvalSnapshotSha256;
      expect((await recordCustomer(chain, 'APPROVE', foreign())).status).toBe(201);
      const refused = await patch('admin', `/api/maker-purchase-orders/${chain.paperId}/amounts`, {
        amounts: { currency: 'JPY', totalAmount: '510000' }, expectedSnapshotSha256: shownHash
      });
      expect(refused.status, refused.text).toBe(409);
      expect(refused.body.code).toBe('MAKER_PO_SNAPSHOT_CHANGED');
      const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, chain.paperId));
      expect((row!.snapshot as any).amounts.totalAmount).toBe('480000');
    });

    /** Holds the film order row lock in a separate session until release() (the lock approval record / revoke and the CEO approval both take). */
    async function holdOrderLock(orderId: string) {
      const client = await pool.connect();
      await client.query('begin');
      await client.query('select id from film_supply_orders where id = $1 for update', [orderId]);
      const holderPid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      return {
        /** Waits until `count` other sessions wait on a lock; fails with the answer of any request that finished instead of waiting. */
        async waiters(count: number, requests: Array<Promise<any>> = []) {
          const done: any[] = [];
          requests.forEach((request, index) => { void request.then((answer) => { done[index] = answer; }); });
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const finished = done.find((answer) => answer !== undefined);
            if (finished) throw new Error(`a request finished instead of waiting: ${finished.status} ${finished.text}`);
            // Polled outside the holder's transaction: pg_stat_activity is snapshotted once per transaction.
            const { rows } = await pool.query(
              "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> $1",
              [holderPid]
            );
            if (rows[0].n >= count) return;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error(`expected ${count} lock waiters`);
        },
        async release() {
          await client.query('rollback');
          client.release();
        }
      };
    }

    it('race: a re-approval that wins the order lock just before the approval → the approval answers 409 (never a mix)', async () => {
      const chain = await fresh();
      const shownHash = chain.card.makerPurchaseOrder.approvalSnapshotSha256;
      const doc = await uploadEvidence(chain.order, chain.project, 'customer', foreign());
      const lock = await holdOrderLock(chain.order.orderId);
      let staff: Promise<any>; let ceo: Promise<any>;
      try {
        staff = post('staff', `/api/artwork-revisions/${chain.revisionId}/approvals`, {
          organization: 'customer', decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-16T10:00:00.000Z',
          evidenceIdentifier: `S2-ID-${tag()}`, evidenceDocumentVersionId: doc.version.id
        });
        await lock.waiters(1, [staff]);
        ceo = approve(chain.paperId, shownHash);
        await lock.waiters(2, [staff, ceo]);
      } finally {
        await lock.release();
      }
      const [recorded, approval] = await Promise.all([staff!, ceo!]);
      expect(recorded.status, recorded.text).toBe(201);
      expect(approval.status, approval.text).toBe(409);
      expect(approval.body.code).toBe('MAKER_PO_SNAPSHOT_CHANGED');
      await expectNotApproved(chain.paperId);
    });

    it('race: an approval that wins the order lock first freezes exactly the set the card showed; the later re-approval is recorded after it', async () => {
      const chain = await fresh();
      const shownHash = chain.card.makerPurchaseOrder.approvalSnapshotSha256;
      const doc = await uploadEvidence(chain.order, chain.project, 'customer', foreign());
      const lock = await holdOrderLock(chain.order.orderId);
      let staff: Promise<any>; let ceo: Promise<any>;
      try {
        ceo = approve(chain.paperId, shownHash);
        await lock.waiters(1, [ceo]);
        staff = post('staff', `/api/artwork-revisions/${chain.revisionId}/approvals`, {
          organization: 'customer', decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-16T10:00:00.000Z',
          evidenceIdentifier: `S2-ID-${tag()}`, evidenceDocumentVersionId: doc.version.id
        });
        await lock.waiters(2, [ceo, staff]);
      } finally {
        await lock.release();
      }
      const [approval, recorded] = await Promise.all([ceo!, staff!]);
      expect(approval.status, approval.text).toBe(200);
      const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, chain.paperId));
      expect(row!.snapshotSha256).toBe(shownHash);
      const frozenCustomer = ((row!.snapshot as any).approvalEvidence as Array<Record<string, string>>).find((entry) => entry.organization === 'customer')!;
      expect(frozenCustomer.approvalEventId).toBe(chain.card.approvals.designs[0].organizations.customer.approvalEventId);
      // Whatever the later recording answers, it is not part of what was approved.
      if (recorded.status === 201) expect(frozenCustomer.approvalEventId).not.toBe(recorded.body.approvalEvent.id);
    });

    it('G10 unchanged: evidence recorded after the approval never voids the approved paper (the frozen set is carried, not recomputed)', async () => {
      const chain = await fresh();
      expect((await approve(chain.paperId, chain.card.makerPurchaseOrder.approvalSnapshotSha256)).status).toBe(200);
      const later = await recordCustomer(chain, 'APPROVE', foreign());
      const boundary = '----s2-send-boundary';
      const eml = [
        'From: KANEI <staff@kanei.example>', 'To: Maker <maker-po-s2@example.com>', `Subject: 製造先発注書 ${chain.order.code}`,
        `Date: ${new Date().toUTCString()}`, `Message-ID: <s2-send-${tag()}@mail.kanei.example>`,
        'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
        `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', `発注コード ${chain.order.code}`, '',
        `--${boundary}`, 'Content-Type: text/plain; name="po.txt"', 'Content-Disposition: attachment; filename="po.txt"',
        'Content-Transfer-Encoding: base64', '', b64(chain.artwork), '', `--${boundary}--`, ''
      ].join('\r\n');
      const sent = await post('staff', `/api/maker-purchase-orders/${chain.paperId}/send-evidence`, {
        contentBase64: b64(eml), senderAddress: 'staff@kanei.example', recipients: ['maker-po-s2@example.com'], sentAt: new Date().toISOString()
      });
      expect(sent.status, `${later.status} ${sent.text}`).toBe(200);
      const [row] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, chain.paperId));
      expect(row!.status).not.toBe('SNAPSHOT_VOIDED');
    });

    it('a fresh paper\'s card shows no drift warning (the evidence set is not 明細・版); nothing moved → creation = card = approval digest', async () => {
      const chain = await fresh();
      expect(chain.card.warnings.map((entry: { code: string }) => entry.code)).not.toContain('MAKER_PO_SNAPSHOT_DRIFTED');
      const [created] = await db.select().from(makerPurchaseOrders).where(eq(makerPurchaseOrders.id, chain.paperId));
      expect(created!.snapshotSha256).toBe(chain.card.makerPurchaseOrder.approvalSnapshotSha256);
      expect((created!.snapshot as any).approvalEvidence).toHaveLength(2);
      expect((await recordCustomer(chain, 'APPROVE', foreign())).status).toBe(201);
      expect((await cardOf(chain.paperId)).warnings.map((entry: { code: string }) => entry.code)).not.toContain('MAKER_PO_SNAPSHOT_DRIFTED');
    });

    it('pure: absent set keeps the old digest; the set is order-independent; any id or content hash moves it', () => {
      const base = {
        order: { id: 'o', code: 'C', sevenPoNumber: null }, items: [{ lineNumber: 1, description: 'd', orderedQuantity: '1', unit: 'sheets' }],
        artworkFiles: [], amounts: null, recipientAddress: 'm@example.com'
      };
      const legacy = buildMakerPoSnapshot(base);
      expect(legacy).not.toHaveProperty('approvalEvidence');
      expect(computeMakerPoSnapshotSha256(buildMakerPoSnapshot({ ...base, approvalEvidence: undefined } as any))).toBe(computeMakerPoSnapshotSha256(legacy));
      const a = { designKey: 'back', organization: 'seven', approvalEventId: 'e2', evidenceDocumentVersionId: 'v2', evidenceSha256: 'b'.repeat(64) };
      const b = { designKey: 'back', organization: 'customer', approvalEventId: 'e1', evidenceDocumentVersionId: 'v1', evidenceSha256: 'a'.repeat(64) };
      const c = { designKey: 'front', organization: 'customer', approvalEventId: 'e3', evidenceDocumentVersionId: null, evidenceSha256: null };
      const hash = (set: any[]) => computeMakerPoSnapshotSha256(buildMakerPoSnapshot({ ...base, approvalEvidence: set }));
      expect(hash([a, b, c])).toBe(hash([c, b, a]));
      expect(buildMakerPoSnapshot({ ...base, approvalEvidence: [a, c, b] }).approvalEvidence!.map((entry) => entry.approvalEventId)).toEqual(['e1', 'e2', 'e3']);
      for (const changed of [{ ...a, evidenceSha256: 'c'.repeat(64) }, { ...a, approvalEventId: 'e9' }, { ...a, evidenceDocumentVersionId: 'v9' }]) {
        expect(hash([changed, b, c])).not.toBe(hash([a, b, c]));
      }
      expect(hash([])).not.toBe(computeMakerPoSnapshotSha256(legacy));
      expect(makerPoSnapshotWithoutApprovalEvidence(buildMakerPoSnapshot({ ...base, approvalEvidence: [a] }))).toEqual(legacy);
    });

    it('review2 L-1: the approval card and /api/me answer Cache-Control: private, no-store (200, 401, 403)', async () => {
      const chain = await fresh();
      const url = `/api/maker-purchase-orders/${chain.paperId}/approval-card`;
      for (const [role, status] of [['admin', 200], [null, 401], ['staff', 403]] as const) {
        const answer = await get(role, url);
        expect(answer.status, String(role)).toBe(status);
        expect(answer.headers.get('cache-control'), `card ${role}`).toBe('private, no-store');
      }
      for (const [role, status] of [['staff', 200], [null, 401]] as const) {
        const answer = await get(role, '/api/me');
        expect(answer.status, String(role)).toBe(status);
        expect(answer.headers.get('cache-control'), `me ${role}`).toBe('private, no-store');
      }
    });
  });
});

// ================================================================ (6) web2a review M-2 / L-1
describe('(6) web2a review M-2: a closure on confirmed deliveries is never recorded as evidence-free', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const closeUrl = (orderId: string) => `/api/film-supply-orders/${orderId}/receipt-assumption`;

  async function uploadReceipt(order: { orderId: string; sevenPoId: string }, role: Role = 'staff', extra: Record<string, unknown> = {}) {
    const uploaded = await post(role, `/api/projects/${ids.projectA}/documents`, {
      documentType: 'acceptance_evidence', issuerEntity: 'kanei', filename: `s2-receipt-${tag()}.txt`, contentType: 'text/plain',
      contentBase64: b64(`s2 receipt ${tag()}\n`), sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId, ...extra
    });
    expect(uploaded.status, uploaded.text).toBe(201);
    return uploaded.body as { document: { id: string }; version: { id: string } };
  }

  /** A film order with `deliveries` delivery rows; the first `confirmed` of them confirmed by the representative on staff's verified receipt evidence. */
  async function deliveredOrder(deliveries: number, confirmed: number, status = 'FILM_DELIVERED') {
    const order = await createOrder('prepaid');
    const rows: string[] = [];
    for (let index = 0; index < deliveries; index += 1) {
      const delivery = await post('staff', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 500, unit: 'sheets' });
      expect(delivery.status, delivery.text).toBe(201);
      rows.push(delivery.body.id);
    }
    const confirmations: string[] = [];
    if (confirmed > 0) {
      const receipt = await uploadReceipt(order);
      expect((await post('admin', `/api/documents/${receipt.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
      for (const deliveryId of rows.slice(0, confirmed)) {
        const confirmation = await post('admin', `/api/film-deliveries/${deliveryId}/confirmation`, { evidenceDocumentVersionId: receipt.version.id });
        expect(confirmation.status, confirmation.text).toBe(201);
        confirmations.push(confirmation.body.id ?? confirmation.body.confirmation?.id);
      }
    }
    // The closure is recorded only from FILM_DELIVERED; the state is set directly (the closure reads state, not history).
    await db.update(filmSupplyOrders).set({ status: status as any }).where(eq(filmSupplyOrders.id, order.orderId));
    return { ...order, deliveryIds: rows, confirmations };
  }

  const closureAudit = async (orderId: string) => {
    const rows = await db.select().from(auditEvents)
      .where(sql`${auditEvents.entityId} = ${orderId} and ${auditEvents.action} = 'FILM_RECEIPT_ASSUMPTION_RECORDED'`);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  it('every delivery confirmed → closes without acknowledgeNoEvidence; answer and audit say delivery_confirmations, never evidence-free', async () => {
    const order = await deliveredOrder(2, 2);
    const closed = await post('staff', closeUrl(order.orderId), { note: '受領証跡で納品確認済み' });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body).toMatchObject({
      status: 'FILM_RECEIPT_ASSUMED_NO_ISSUE', closureBasis: 'delivery_confirmations', evidenceFreeAcknowledgment: false,
      deliveries: { total: 2, confirmed: 2 }
    });
    const audit = await closureAudit(order.orderId);
    expect(audit.afterState).toMatchObject({
      status: 'FILM_RECEIPT_ASSUMED_NO_ISSUE', closureBasis: 'delivery_confirmations', evidenceFreeAcknowledgment: false,
      deliveries: { total: 2, confirmed: 2 }, requestAcknowledgedNoEvidence: false
    });
    expect((audit.afterState as any).deliveryConfirmations.map((entry: { deliveryId: string }) => entry.deliveryId).sort()).toEqual([...order.deliveryIds].sort());
    for (const entry of (audit.afterState as any).deliveryConfirmations) expect(entry.confirmationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(audit.requestMetadata).toEqual({
      operation: 'film_order:close_receipt_on_confirmed_deliveries', closureBasis: 'delivery_confirmations', evidenceFreeAcknowledgment: false
    });
    const status = await get('staff', `/api/film-supply-orders/${order.orderId}/delivery-status`);
    expect(status.body.receiptAssumption).toMatchObject({ closureBasis: 'delivery_confirmations', note: '受領証跡で納品確認済み' });
    expect(status.body.receiptClosure).toBeNull();
  });

  it('an old client that still sends acknowledgeNoEvidence: true on confirmed deliveries is recorded truthfully (basis kept apart from the request)', async () => {
    const order = await deliveredOrder(1, 1);
    const closed = await post('staff', closeUrl(order.orderId), { note: '問題なし', acknowledgeNoEvidence: true });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body).toMatchObject({ closureBasis: 'delivery_confirmations', evidenceFreeAcknowledgment: false });
    expect((await closureAudit(order.orderId)).afterState).toMatchObject({
      closureBasis: 'delivery_confirmations', evidenceFreeAcknowledgment: false, requestAcknowledgedNoEvidence: true
    });
  });

  it('a delivery not yet confirmed → evidence-free: refused without the acknowledgment (422), recorded as evidence-free with it', async () => {
    const order = await deliveredOrder(2, 1);
    const refused = await post('staff', closeUrl(order.orderId), { note: '一部未確認' });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED');
    const [still] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.orderId));
    expect(still!.status).toBe('FILM_DELIVERED');
    const closed = await post('staff', closeUrl(order.orderId), { note: '一部未確認', acknowledgeNoEvidence: true });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body).toMatchObject({ closureBasis: 'evidence_free_acknowledgment', evidenceFreeAcknowledgment: true, deliveries: { total: 2, confirmed: 1 } });
    const audit = await closureAudit(order.orderId);
    expect(audit.afterState).toMatchObject({ closureBasis: 'evidence_free_acknowledgment', evidenceFreeAcknowledgment: true, deliveryConfirmations: [] });
    expect(audit.requestMetadata).toMatchObject({ operation: 'film_order:assume_receipt', evidenceFreeAcknowledgment: true });
    expect((await get('staff', `/api/film-supply-orders/${order.orderId}/delivery-status`)).body.receiptAssumption.closureBasis).toBe('evidence_free_acknowledgment');
  });

  it('no delivery at all stays the evidence-free acknowledgment (the earlier contract)', async () => {
    const order = await deliveredOrder(0, 0);
    expect((await post('staff', closeUrl(order.orderId), { note: '納品記録なし' })).body.code).toBe('RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED');
    const closed = await post('staff', closeUrl(order.orderId), { note: '納品記録なし', acknowledgeNoEvidence: true });
    expect(closed.body).toMatchObject({ closureBasis: 'evidence_free_acknowledgment', evidenceFreeAcknowledgment: true, deliveries: { total: 0, confirmed: 0 } });
  });

  it('the rest is unchanged on the confirmed basis: the note is required and only FILM_DELIVERED closes', async () => {
    const order = await deliveredOrder(1, 1);
    expect((await post('staff', closeUrl(order.orderId), { note: '   ' })).body.code).toBe('RECEIPT_ASSUMPTION_NOTE_REQUIRED');
    const shipped = await deliveredOrder(1, 1, 'FILM_SHIPPED');
    expect((await post('staff', closeUrl(shipped.orderId), { note: '早すぎる' })).body.code).toBe('RECEIPT_ASSUMPTION_ONLY_FROM_FILM_DELIVERED');
    expect((await post('viewer', closeUrl(order.orderId), { note: 'x' })).status).toBe(403);
  });

  it('delivery-status tells the web which basis a closure would have now (receiptClosure)', async () => {
    const partial = await deliveredOrder(2, 1);
    expect((await get('staff', `/api/film-supply-orders/${partial.orderId}/delivery-status`)).body.receiptClosure)
      .toEqual({ basis: 'evidence_free_acknowledgment', acknowledgeNoEvidenceRequired: true });
    const full = await deliveredOrder(1, 1);
    const status = await get('staff', `/api/film-supply-orders/${full.orderId}/delivery-status`);
    expect(status.body.receiptClosure).toEqual({ basis: 'delivery_confirmations', acknowledgeNoEvidenceRequired: false });
    expect(status.body.nextAction).toMatchObject({ action: 'CLOSE_ORDER' });
    const shipped = await deliveredOrder(1, 1, 'FILM_SHIPPED');
    expect((await get('staff', `/api/film-supply-orders/${shipped.orderId}/delivery-status`)).body.receiptClosure).toBeNull();
  });

  it('race: a delivery committed while the closure waits for the order lock makes it evidence-free again → refused without the acknowledgment', async () => {
    const order = await deliveredOrder(1, 1);
    const client = await pool.connect();
    let closing: Promise<any> | undefined;
    try {
      await client.query('begin');
      await client.query('select id from film_supply_orders where id = $1 for update', [order.orderId]);
      const holderPid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      closing = post('staff', closeUrl(order.orderId), { note: '確認済みのはず' });
      for (let attempt = 0; ; attempt += 1) {
        const { rows } = await pool.query(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> $1", [holderPid]
        );
        if (rows[0].n >= 1) break;
        if (attempt > 200) throw new Error('the closure never waited for the order lock');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await client.query(
        `insert into film_deliveries (id, film_supply_order_id, film_supply_order_line_id, unit, delivered_quantity, delivery_sequence, delivered_at)
         values ($1, $2, $3, 'sheets', 100, 99, now())`, [uuidv7(), order.orderId, order.lineId]
      );
      await client.query('commit');
    } finally {
      client.release();
    }
    const answer = await closing!;
    expect(answer.status, answer.text).toBe(422);
    expect(answer.body.code).toBe('RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED');
    const [still] = await db.select().from(filmSupplyOrders).where(eq(filmSupplyOrders.id, order.orderId));
    expect(still!.status).toBe('FILM_DELIVERED');
  });

  it('P-4 unchanged: staff still cannot confirm a delivery on evidence they uploaded', async () => {
    const order = await deliveredOrder(1, 0);
    const receipt = await uploadReceipt(order);
    expect((await post('admin', `/api/documents/${receipt.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
    const self = await post('staff', `/api/film-deliveries/${order.deliveryIds[0]}/confirmation`, { evidenceDocumentVersionId: receipt.version.id });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_VERIFICATION_FORBIDDEN');
  });

  it('pure: the basis needs every delivery confirmed; the evidence-free evaluation keeps requiring the acknowledgment', () => {
    expect(filmReceiptClosureBasis({ total: 0, confirmed: 0 })).toBe('evidence_free_acknowledgment');
    expect(filmReceiptClosureBasis({ total: 2, confirmed: 1 })).toBe('evidence_free_acknowledgment');
    expect(filmReceiptClosureBasis({ total: 2, confirmed: 2 })).toBe('delivery_confirmations');
    const input = { currentStatus: 'FILM_DELIVERED', note: 'n', acknowledgeNoEvidence: undefined };
    expect(evaluateFilmReceiptClosure({ ...input, deliveries: { total: 1, confirmed: 1 } })).toMatchObject({ ok: true, basis: 'delivery_confirmations' });
    expect(evaluateFilmReceiptClosure({ ...input, deliveries: { total: 1, confirmed: 0 } })).toMatchObject({ ok: false, code: 'RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED' });
    expect(evaluateFilmReceiptAssumption(input)).toMatchObject({ ok: false, code: 'RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED' });
    expect(evaluateFilmReceiptClosure({ ...input, note: '', deliveries: { total: 1, confirmed: 1 } })).toMatchObject({ ok: false, code: 'RECEIPT_ASSUMPTION_NOTE_REQUIRED' });
  });
});

describe('(6) web2a review L-1: the delivery_confirmation queue item counts receipt evidence only', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const upload = async (order: { orderId: string; sevenPoId: string }, extra: Record<string, unknown> = {}) => {
    const uploaded = await post('staff', `/api/projects/${ids.projectA}/documents`, {
      documentType: 'acceptance_evidence', issuerEntity: 'kanei', filename: `s2-acc-${tag()}.txt`, contentType: 'text/plain',
      contentBase64: b64(`s2 acceptance ${tag()}\n`), sevenPurchaseOrderId: order.sevenPoId, filmSupplyOrderId: order.orderId, ...extra
    });
    expect(uploaded.status, uploaded.text).toBe(201);
    return uploaded.body as { document: { id: string }; version: { id: string } };
  };

  it('a maker-PO acceptance evidence alone raises no 「納品の確認」; a receipt evidence does, and the item lists only receipt evidence', async () => {
    const order = await createOrder('prepaid');
    const delivery = await post('staff', `/api/film-supply-orders/${order.orderId}/deliveries`, { filmSupplyOrderLineId: order.lineId, deliveredQuantity: 500, unit: 'sheets' });
    expect(delivery.status, delivery.text).toBe(201);
    const paperId = uuidv7();
    await db.insert(makerPurchaseOrders).values({
      id: paperId, filmSupplyOrderId: order.orderId, snapshot: {}, snapshotSha256: '0'.repeat(64), status: 'DRAFT', createdByUserId: ids.admin
    });
    const makerAcceptance = await upload(order, { makerPurchaseOrderId: paperId });
    const itemKey = `delivery_confirmation:${delivery.body.id}`;
    expect((await queue()).items.find((item) => item.key === itemKey)).toBeUndefined();
    const receipt = await upload(order);
    const item = (await queue()).items.find((entry) => entry.key === itemKey)!;
    expect(item).toBeDefined();
    expect(item.detail.evidence.map((entry: { documentId: string }) => entry.documentId)).toEqual([receipt.document.id]);
    expect(JSON.stringify(item)).not.toContain(makerAcceptance.document.id);
  });
});
