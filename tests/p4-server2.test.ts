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
  createDatabase,
  filmSupplyOrders,
  makerPurchaseOrders,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { PAYMENT_TERMS_ATTENTION_CLOSED_STATES, paymentTermsAttention } from '@kanei/core';
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
  customer: uuidv7(), seven: uuidv7(), maker: uuidv7(),
  projectA: uuidv7(), projectB: uuidv7(), projectGone: uuidv7()
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
  return { status: response.status, body: parsed, text };
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
async function createOrder(paymentTerms: string, project = ids.projectA, options: { sevenPo?: boolean } = {}) {
  const sevenPoId = options.sevenPo === false ? null : await sevenPo(project);
  const code = `FSO-S2-${tag()}`;
  const created = await post('staff', `/api/projects/${project}/film-supply-orders`, {
    code, paymentTerms, ...(sevenPoId ? { sevenPurchaseOrderId: sevenPoId } : {}),
    lines: [{ lineNumber: 1, description: '合成フィルムS2', orderedQuantity: 1000, unit: 'sheets' }]
  });
  expect(created.status, created.text).toBe(201);
  return { orderId: created.body.id as string, code };
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
    { id: ids.seven, name: '合成S2セブン', role: 'seven', externalCode: 'S2-SEVEN', contactEmail: 'po@seven-s2.example' },
    { id: ids.maker, name: '合成S2メーカー', role: 'maker', externalCode: 'S2-MAKER' }
  ]);
  const now = new Date();
  for (const [id, code] of [[ids.projectA, 'S2-A'], [ids.projectB, 'S2-B'], [ids.projectGone, 'S2-GONE']] as const) {
    await db.insert(projects).values({
      id, code, name: `合成${code}`, businessUnit: 'F1', route: 'F1', leadSource: 'KANEI', status: 'DRAFT',
      endCustomerAccountId: ids.customer, sevenAccountId: ids.seven, makerAccountId: ids.maker, createdByUserId: ids.admin,
      createdAt: now, updatedAt: now
    });
  }
  await db.insert(projectAssignments).values([
    { id: uuidv7(), userId: ids.staff, projectId: ids.projectA },
    { id: uuidv7(), userId: ids.staff, projectId: ids.projectB },
    { id: uuidv7(), userId: ids.staff, projectId: ids.projectGone },
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
    expect([...staff.body.assignedProjectIds].sort()).toEqual([ids.projectA, ids.projectB, ids.projectGone].sort());
  });

  it('answers 401 AUTH_REQUIRED without a session or with a revoked one', async () => {
    const anonymous = await get(null, '/api/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ error: '認証が必要です', code: 'AUTH_REQUIRED' });
    const response = await app.request('/api/me', { headers: { cookie: `${SESSION_COOKIE}=not-a-session` } });
    expect(response.status).toBe(401);
  });
});
