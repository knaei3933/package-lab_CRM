import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { accounts, auditEvents, createDatabase, filmSupplyOrders, projectAssignments, projects, sessions, users, uuidv7 } from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { hashPassword } from '../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';

/**
 * P0 against the REAL API on the isolated test database. The web's own
 * callApi runs unmodified (dictionary text, timeout signal, idempotency header);
 * only the network is replaced by an in-process call into the Hono app and the
 * cookies by a jar.
 *
 * - R06: a record created through the server action is in loadWorkspace at once.
 * - R05: a duplicate number is answered as a duplicate (admin sees the link; the
 *   staff role never learns a withheld seven-PO number).
 * - R01: a film order cannot be created without a 支払条件; the order list offers
 *   the change form for DRAFT..MAKER_PO_READY, never to the viewer.
 * - R09: a 401 reads as SESSION_EXPIRED; the API's own text is never shown.
 * - R10: the maker-PO create form asks for an e-mail address.
 */
const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

type Role = 'admin' | 'staff' | 'viewer';
const userIds: Record<Role, string> = { admin: uuidv7(), staff: uuidv7(), viewer: uuidv7() };
const tokens: Record<Role, string> = { admin: '', staff: '', viewer: '' };
const projectId = uuidv7();
let app: ReturnType<typeof createApp>;

const jar = vi.hoisted(() => ({ session: '' as string | null, project: '' as string | null }));
const seen = vi.hoisted(() => ({ requests: [] as Array<{ path: string; method: string; headers: Record<string, string> }> }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = name === 'kanei_mvp_session' ? jar.session : name === 'kanei_web_project' ? jar.project : null;
      return value ? { name, value } : undefined;
    },
    set: () => undefined
  })
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: () => undefined }));

const api = await import('../apps/web/src/lib/api.js');
const actions = await import('../apps/web/src/app/actions.js');
const makerActions = await import('../apps/web/src/app/maker-po/actions.js');
const { loadWorkspace } = await import('../apps/web/src/lib/project-data.js');
const { default: OrdersPage } = await import('../apps/web/src/app/orders/page.js');
const { default: MakerPoPage } = await import('../apps/web/src/app/maker-po/page.js');
const { PAYMENT_TERMS_REQUIRED_MESSAGE } = await import('../apps/web/src/lib/form-messages.js');
const { UPLOAD_MAX_BYTES } = await import('../apps/web/src/lib/form-validation.js');

function signIn(role: Role, selected: string | null = projectId) {
  jar.session = tokens[role];
  jar.project = selected;
}

function form(entries: Record<string, string>, rendered: string | null = jar.project ?? ''): FormData {
  const data = new FormData();
  if (rendered !== null) data.set('_kaneiRenderedProjectId', rendered);
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

async function render(page: () => Promise<unknown>): Promise<string> {
  const { prelude } = await prerenderToNodeStream((await page()) as Parameters<typeof prerenderToNodeStream>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replaceAll('<!-- -->', '');
}

let counter = 0;
const nextTag = () => `${Date.now().toString(36)}${String(++counter).padStart(3, '0')}`;

async function postAs(role: Role, url: string, body: unknown = {}) {
  const response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${tokens[role]}` },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A registered, verified seven PO and a DRAFT film order on it, made straight through the API. */
async function draftOrder(role: Role = 'staff') {
  const tag = nextTag();
  const sevenPo = await postAs(role, `/api/projects/${projectId}/seven-purchase-orders`, { poNumber: `SEVEN-P0-${tag}` });
  expect(sevenPo.status).toBe(201);
  const sevenPoId = sevenPo.body.id as string;
  expect((await postAs(role, `/api/seven-purchase-orders/${sevenPoId}/verification-checklist`, {
    issuerNameRecorded: true, issuerName: '合成セブン化学事業', documentNumberRecorded: true,
    documentNumber: `PO-2026-${tag}`, issueDateRecorded: true, issueDate: '2026-11-15',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル', pastTransactionCompared: true,
    pastTransactionNote: '過去の発注書と様式が一致', quoteCompared: true, quoteMatchesPo: true,
    quoteComparisonNote: '見積と一致', tamperHints: '', uncertain: false,
    confirmationReplyRecorded: false, confirmationReplyNote: '', verificationNote: '合成チェックリスト'
  })).status).toBe(200);
  expect((await postAs(role, `/api/seven-purchase-orders/${sevenPoId}/register-official`, {
    officialRegisteredAt: '2026-11-14T09:00:00.000Z'
  })).status).toBe(200);
  const order = await postAs(role, `/api/seven-purchase-orders/${sevenPoId}/supply-orders`, {
    code: `FSO-P0-${tag}`,
    paymentTerms: 'undetermined',
    lines: [{ lineNumber: 1, description: '合成フィルム', orderedQuantity: 10, unit: 'sheets' }]
  });
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  return { sevenPoId, orderId: order.body.id as string, orderCode: `FSO-P0-${tag}`, poNumber: `SEVEN-P0-${tag}` };
}

/**
 * The web reads an order's state from its audit trail (the latest transition
 * wins), so a state the test cannot reach by staff work (the dual approval,
 * the maker paper) is set by appending the same event the API writes.
 */
let clockOffset = 0;
async function moveOrderTo(orderId: string, status: string, actor: Role = 'admin') {
  // P0 integration: the API decides the 支払条件 editability from the order row
  // (paymentTermsEditable), the screen reads the state from the history — both move.
  await db.update(filmSupplyOrders).set({ status: status as never }).where(eq(filmSupplyOrders.id, orderId));
  await db.insert(auditEvents).values({
    id: uuidv7(),
    projectId,
    actorUserId: userIds[actor],
    action: 'FILM_SUPPLY_ORDER_TRANSITIONED',
    entityType: 'film_supply_order',
    entityId: orderId,
    beforeState: { status: 'DRAFT' },
    afterState: { status },
    occurredAt: new Date(Date.now() + 60_000 + ++clockOffset * 1000),
    requestMetadata: { operation: 'test' }
  });
}

const LINES = JSON.stringify([{ description: '合成フィルム', orderedQuantity: '10', unit: 'sheets' }]);

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-p0-web-'));
  app = createApp({ db });
  await db.execute(sql`
    truncate table audit_events, maker_po_events, maker_po_send_manual_verifications,
      maker_purchase_orders, artwork_revisions, artwork_approval_events,
      evidence_manual_verifications, documents, document_versions, pre_order_references,
      seven_purchase_orders, film_supply_orders, film_supply_order_lines, film_deliveries,
      filling_orders, filling_order_lines, filling_deliveries, commission_readiness,
      delivery_confirmations, project_assignments, projects, sessions, accounts, users cascade
  `);
  const now = new Date();
  const passwordHash = await hashPassword('composite-pass');
  await db.insert(users).values((['admin', 'staff', 'viewer'] as const).map((role) => ({
    id: userIds[role], username: `${role}_p0web_test`, passwordHash, displayName: `合成${role}P0`, role
  })));
  const [customer, seven, maker] = [uuidv7(), uuidv7(), uuidv7()];
  await db.insert(accounts).values([
    { id: customer, name: '合成P0エンドカスタマー', role: 'end_customer', externalCode: 'TEST-P0-CUST' },
    { id: seven, name: '合成P0セブン', role: 'seven', externalCode: 'TEST-P0-SEVEN' },
    { id: maker, name: '合成P0メーカー', role: 'maker', externalCode: 'TEST-P0-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId, code: 'TEST-P0-PROJECT', name: '合成P0案件', businessUnit: 'F1' as const, route: 'F1' as const,
    leadSource: 'KANEI', status: 'DRAFT' as const, endCustomerAccountId: customer, sevenAccountId: seven,
    makerAccountId: maker, createdByUserId: userIds.admin, createdAt: now, updatedAt: now
  });
  await db.insert(projectAssignments).values([
    { id: uuidv7(), userId: userIds.staff, projectId },
    { id: uuidv7(), userId: userIds.viewer, projectId }
  ]);
  for (const role of ['admin', 'staff', 'viewer'] as const) {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({ id: uuidv7(), userId: userIds[role], tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    tokens[role] = token;
  }
  // The web's callApi fetches API_BASE + path: answer it from the in-process app.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(api.apiBaseUrl)) {
      const requestPath = url.slice(api.apiBaseUrl.length);
      seen.requests.push({ path: requestPath, method: init?.method ?? 'GET', headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
      return app.request(requestPath, init);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

beforeEach(() => {
  revalidatePath.mockReset();
  seen.requests = [];
});

afterAll(async () => {
  await pool.end();
});

describe('R06: a saved record is on the list at once (real API)', () => {
  it('a seven PO created through the action is in loadWorkspace right after, and the screen is refreshed', async () => {
    signIn('admin');
    const poNumber = `SEVEN-R06-${nextTag()}`;
    const result = await actions.createSevenPurchaseOrderAction(null, form({ poNumber }));
    expect(result).toMatchObject({ ok: true, message: '記録しました。' });
    expect(typeof result.changedId).toBe('string');
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
    const workspace = await loadWorkspace(projectId);
    const created = workspace.sevenPurchaseOrders.find((po) => po.id === result.changedId);
    expect(created).toBeDefined();
    expect(created?.poNumber).toBe(poNumber);
  });

  it('a film order created through the action (with its 支払条件) is in loadWorkspace right after', async () => {
    signIn('staff');
    const { sevenPoId } = await draftOrder('staff');
    const code = `FSO-R06-${nextTag()}`;
    const result = await actions.createFilmSupplyOrderAction(null, form({ code, lines: LINES, sevenPurchaseOrderId: sevenPoId, paymentTerms: 'on_delivery' }));
    expect(result.ok, result.message).toBe(true);
    expect(typeof result.changedId).toBe('string');
    const workspace = await loadWorkspace(projectId);
    const created = workspace.filmOrders.find((order) => order.id === result.changedId);
    expect(created?.code).toBe(code);
    expect(created?.paymentTerms).toBe('on_delivery');
  });

  it('a filling order created through the action is in loadWorkspace right after', async () => {
    signIn('staff');
    const code = `FIL-R06-${nextTag()}`;
    const result = await actions.createFillingOrderAction(null, form({ code, lines: JSON.stringify([{ description: '合成充填', orderedQuantity: '5', unit: 'pods' }]) }));
    expect(result.ok, result.message).toBe(true);
    expect((await loadWorkspace(projectId)).fillingOrders.some((order) => order.id === result.changedId)).toBe(true);
  });

  it('a refused create writes nothing and does not refresh', async () => {
    signIn('viewer');
    const before = (await loadWorkspace(projectId)).sevenPurchaseOrders.length;
    const result = await actions.createSevenPurchaseOrderAction(null, form({ poNumber: `SEVEN-VIEWER-${nextTag()}` }));
    expect(result.ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
    signIn('admin');
    expect((await loadWorkspace(projectId)).sevenPurchaseOrders.length).toBe(before);
  });
});

describe('R01: 支払条件 is chosen at creation (real API)', () => {
  it('a film order without paymentTerms is refused and nothing is written', async () => {
    signIn('staff');
    const { sevenPoId } = await draftOrder('staff');
    const before = (await loadWorkspace(projectId)).filmOrders.length;
    const result = await actions.createFilmSupplyOrderAction(null, form({ code: `FSO-NOTERMS-${nextTag()}`, lines: LINES, sevenPurchaseOrderId: sevenPoId }));
    expect(result).toEqual({ ok: false, message: PAYMENT_TERMS_REQUIRED_MESSAGE });
    expect((await loadWorkspace(projectId)).filmOrders.length).toBe(before);
    expect(seen.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('「未定」 is accepted and stored as undetermined', async () => {
    signIn('staff');
    const { sevenPoId } = await draftOrder('staff');
    const result = await actions.createFilmSupplyOrderAction(null, form({ code: `FSO-UNDET-${nextTag()}`, lines: LINES, sevenPurchaseOrderId: sevenPoId, paymentTerms: 'undetermined' }));
    expect(result.ok, result.message).toBe(true);
    const order = (await loadWorkspace(projectId)).filmOrders.find((row) => row.id === result.changedId);
    expect(order?.paymentTerms).toBe('undetermined');
  });

  it('the order list offers 「支払条件を変更する」 to staff and admin for a DRAFT order, never to the viewer', async () => {
    const { orderCode } = await draftOrder('staff');
    for (const role of ['staff', 'admin'] as const) {
      signIn(role);
      const html = await render(OrdersPage);
      expect(html, role).toContain('>支払条件を変更する</button>');
      expect(html, role).toContain(orderCode);
    }
    signIn('viewer');
    const viewer = await render(OrdersPage);
    expect(viewer).not.toContain('>支払条件を変更する</button>');
  });

  it('the change form is offered for DRAFT..MAKER_PO_READY and not after the maker paper is sent', async () => {
    const { orderId, orderCode } = await draftOrder('staff');
    signIn('admin');
    const present = async () => {
      const html = await render(OrdersPage);
      const start = html.indexOf(`id="order-${orderId}"`);
      expect(start, orderCode).toBeGreaterThan(-1);
      const end = html.indexOf('</tr>', start);
      return html.slice(start, end).includes('>支払条件を変更する</button>');
    };
    for (const status of ['DRAFT', 'SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY']) {
      await moveOrderTo(orderId, status);
      expect(await present(), status).toBe(true);
    }
    for (const status of ['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED', 'FILM_IN_PRODUCTION', 'FILM_DELIVERED', 'ON_HOLD', 'CANCELLED']) {
      await moveOrderTo(orderId, status);
      expect(await present(), status).toBe(false);
    }
  });

  it('updating the terms through the action changes the stored value and shows the glossary label', async () => {
    signIn('staff');
    const { orderId } = await draftOrder('staff');
    const result = await actions.updateFilmPaymentTermsAction(null, form({ orderId, paymentTerms: 'prepaid', reason: '取引条件が決まった' }));
    expect(result.ok, result.message).toBe(true);
    expect(result.message).toContain('前払い');
    const order = (await loadWorkspace(projectId)).filmOrders.find((row) => row.id === orderId);
    expect(order?.paymentTerms).toBe('prepaid');
  });

  it('P0 integration: a change through the action is listed in the row\'s 支払条件の変更履歴 with its reason (P-5)', async () => {
    signIn('staff');
    const { orderId } = await draftOrder('staff');
    const changed = await actions.updateFilmPaymentTermsAction(null, form({ orderId, paymentTerms: 'on_delivery', reason: '納品後に支払うと合意' }));
    expect(changed.ok, changed.message).toBe(true);
    signIn('admin');
    const html = await render(OrdersPage);
    const start = html.indexOf(`id="order-${orderId}"`);
    const row = html.slice(start, html.indexOf('</tr>', start));
    expect(row).toContain('支払条件の変更履歴');
    expect(row).toContain('未定 → 納品後払い');
    expect(row).toContain('理由: 納品後に支払うと合意');
  });

  it('an undetermined order shows 「未定」 in the summary and the warning that it blocks the 代表承認', async () => {
    const { orderId } = await draftOrder('staff');
    signIn('admin');
    const html = await render(OrdersPage);
    const start = html.indexOf(`id="order-${orderId}"`);
    const row = html.slice(start, html.indexOf('</tr>', start));
    expect(row).toContain('支払条件: 未定');
    expect(row).toContain('支払条件が「未定」です');
  });
});

describe('R05: a duplicate number is a duplicate (real API)', () => {
  it('admin registering the same seven PO number again reads the duplicate message with a link to the record', async () => {
    signIn('admin');
    const poNumber = `SEVEN-DUP-${nextTag()}`;
    const first = await actions.createSevenPurchaseOrderAction(null, form({ poNumber }));
    expect(first.ok).toBe(true);
    const second = await actions.createSevenPurchaseOrderAction(null, form({ poNumber }));
    expect(second).toMatchObject({ ok: false, code: 'DUPLICATE' });
    expect(second.message).toContain('この番号はすでに登録されています');
    expect(second.link?.href).toBe(`/orders#seven-po-${first.changedId}`);
    expect(second.message).not.toMatch(/サーバー/);
  });

  it('a film order code registered twice reads the duplicate message and links the existing order', async () => {
    signIn('staff');
    const { sevenPoId } = await draftOrder('staff');
    const code = `FSO-DUP-${nextTag()}`;
    const first = await actions.createFilmSupplyOrderAction(null, form({ code, lines: LINES, sevenPurchaseOrderId: sevenPoId, paymentTerms: 'prepaid' }));
    expect(first.ok, first.message).toBe(true);
    const second = await actions.createFilmSupplyOrderAction(null, form({ code, lines: LINES, sevenPurchaseOrderId: sevenPoId, paymentTerms: 'prepaid' }));
    expect(second).toMatchObject({ ok: false, code: 'DUPLICATE' });
    expect(second.link?.href).toBe(`/orders#order-${first.changedId}`);
  });

  it('a filling order code registered twice reads the duplicate message', async () => {
    signIn('staff');
    const code = `FIL-DUP-${nextTag()}`;
    const lines = JSON.stringify([{ description: '合成充填', orderedQuantity: '5', unit: 'pods' }]);
    const first = await actions.createFillingOrderAction(null, form({ code, lines }));
    expect(first.ok, first.message).toBe(true);
    const second = await actions.createFillingOrderAction(null, form({ code, lines }));
    expect(second).toMatchObject({ ok: false, code: 'DUPLICATE' });
    expect(second.link?.href).toBe(`/orders#filling-order-${first.changedId}`);
  });

  it('the idempotency key reaches the API as the idempotency-key header only when it is valid', async () => {
    signIn('admin');
    await actions.createSevenPurchaseOrderAction(null, form({ poNumber: `SEVEN-KEY-${nextTag()}`, _kaneiIdempotencyKey: 'p0-key-0000001' }));
    const withKey = seen.requests.find((request) => request.method === 'POST');
    expect(withKey?.headers['idempotency-key']).toBe('p0-key-0000001');
    seen.requests = [];
    await actions.createSevenPurchaseOrderAction(null, form({ poNumber: `SEVEN-KEY-${nextTag()}`, _kaneiIdempotencyKey: 'bad key' }));
    const withoutKey = seen.requests.find((request) => request.method === 'POST');
    expect(withoutKey).toBeDefined();
    expect(withoutKey!.headers['idempotency-key']).toBeUndefined();
  });
});

describe('R09 / R08: refusals in operator words (real API)', () => {
  it('a viewer who may not write reads the dictionary text, never the API text', async () => {
    signIn('viewer');
    const result = await actions.createSevenPurchaseOrderAction(null, form({ poNumber: `SEVEN-VW-${nextTag()}` }));
    expect(result.ok).toBe(false);
    expect(result.code).toBeTruthy();
    expect(result.message).not.toMatch(/[A-Za-z]{3,}/);
  });

  it('an expired session reads SESSION_EXPIRED on a write', async () => {
    signIn('admin');
    jar.session = 'a-token-the-api-never-issued';
    const result = await actions.createSevenPurchaseOrderAction(null, form({ poNumber: `SEVEN-EXP-${nextTag()}` }));
    expect(result).toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
    expect(result.message).toContain('ログインの有効期限');
    expect(await api.loadSession()).toEqual({ kind: 'expired' });
  });

  it('loadSession with a valid cookie is the user', async () => {
    signIn('staff');
    const session = await api.loadSession();
    expect(session.kind).toBe('user');
  });

  it('a stale tab (project switched) writes nothing', async () => {
    signIn('admin');
    const before = (await loadWorkspace(projectId)).sevenPurchaseOrders.length;
    const result = await actions.createSevenPurchaseOrderAction(null, form({ poNumber: `SEVEN-STALE-${nextTag()}` }, 'another-project'));
    expect(result).toMatchObject({ ok: false, code: 'PROJECT_CONTEXT_MISMATCH' });
    expect((await loadWorkspace(projectId)).sevenPurchaseOrders.length).toBe(before);
    expect(seen.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });
});

describe('R10: the maker PO create form asks for an e-mail address (real API)', () => {
  it('admin sees the e-mail field with its new label, type=email, and no 宛先住所 label', async () => {
    const { orderId } = await draftOrder('staff');
    await moveOrderTo(orderId, 'MAKER_PO_READY');
    signIn('admin');
    const html = await render(MakerPoPage);
    const input = /<input[^>]*name="recipientAddress"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('type="email"');
    expect(input).toContain('required');
    expect(html).toContain('メーカーの送信先メールアドレス');
    expect(html).not.toContain('宛先住所（メーカーの送り先）');
  });

  it('a postal address is refused before the paper is frozen (nothing is written)', async () => {
    const { orderId } = await draftOrder('staff');
    await moveOrderTo(orderId, 'MAKER_PO_READY');
    signIn('admin');
    const result = await makerActions.createMakerPoAction(null, form({ orderId, recipientAddress: '東京都港区1-2-3' }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('メールアドレス');
    expect(seen.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('staff cannot create a maker PO even with a valid e-mail address (role rule stays with the API)', async () => {
    const { orderId } = await draftOrder('staff');
    await moveOrderTo(orderId, 'MAKER_PO_READY');
    signIn('staff');
    const result = await makerActions.createMakerPoAction(null, form({ orderId, recipientAddress: 'order@maker.example' }));
    expect(result.ok).toBe(false);
    expect(result.code).toBeTruthy();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('R07: the upload limit is the API limit (real API)', () => {
  async function upload(bytes: number) {
    signIn('staff');
    const { orderId, sevenPoId } = await draftOrder('staff');
    return actions.uploadDocumentAction(null, form({
      documentType: 'proof',
      issuerEntity: 'kanei',
      filename: `r07-${nextTag()}.txt`,
      contentType: 'text/plain',
      contentBase64: Buffer.alloc(bytes, 0x61).toString('base64'),
      sevenPurchaseOrderId: sevenPoId,
      filmSupplyOrderId: orderId,
      designKey: 'label-front'
    }));
  }

  it('a file of exactly 5 MiB is stored', async () => {
    const result = await upload(UPLOAD_MAX_BYTES);
    expect(result.ok, result.message).toBe(true);
    expect(typeof result.changedId).toBe('string');
  });

  it('a file one byte over 5 MiB is refused by the API in operator words and nothing is written', async () => {
    const result = await upload(UPLOAD_MAX_BYTES + 1);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/大きすぎ|5MB/);
    expect(result.message).not.toMatch(/[A-Za-z]{4,}/);
  });
});
