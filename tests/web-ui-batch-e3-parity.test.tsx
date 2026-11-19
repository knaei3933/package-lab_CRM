import { prerenderToNodeStream } from 'react-dom/static';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  accounts,
  createDatabase,
  projectAssignments,
  projects,
  sessions,
  users,
  uuidv7
} from '@kanei/db';
import { createApp } from '../apps/api/src/app.js';
import { hashPassword } from '../apps/api/src/password.js';
import { issueToken, SESSION_COOKIE } from '../apps/api/src/auth.js';

/**
 * UI batch E3 (demo-eml/ui-batch-e3/REPORT.md) against the REAL API on the
 * isolated test database. The representative decided that the 決済条件
 * (paymentTerms) is public while amounts stay hidden; the API's audit-history
 * allowlists now carry paymentTerms for staff and viewer. Checked here: the
 * raw answer each role gets, the workspace the web replays from it (creation
 * value replaced by a later 決済条件の記録), and the 決済条件 column of
 * /orders for staff and viewer — never 閲覧権限なし, never an amount.
 */

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

type Role = 'admin' | 'staff' | 'viewer';
const userIds: Record<Role, string> = { admin: uuidv7(), staff: uuidv7(), viewer: uuidv7() };
const tokens: Record<Role, string> = { admin: '', staff: '', viewer: '' };
const projectId = uuidv7();
let app: ReturnType<typeof createApp>;
const signedIn = vi.hoisted(() => ({ token: '', role: 'admin' as 'admin' | 'staff' | 'viewer', userId: '', projectId: '' }));

vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://in-process',
  readSessionToken: async () => signedIn.token,
  readSelectedProjectId: async () => signedIn.projectId,
  loadSessionUser: async () => ({ id: signedIn.userId, role: signedIn.role, displayName: '合成' }),
  callApi: async (apiPath: string, options: { method?: string; body?: unknown } = {}) => {
    const response = await app.request(apiPath, {
      method: options.method ?? 'GET',
      headers: {
        cookie: `${SESSION_COOKIE}=${signedIn.token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    const raw = await response.text();
    let data: unknown = null;
    try { data = raw.length > 0 ? JSON.parse(raw) : null; } catch { data = null; }
    const error = response.ok
      ? null
      : (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `status ${response.status}`);
    return { ok: response.ok, status: response.status, data, error };
  }
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, refresh: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const { default: OrdersPage } = await import('../apps/web/src/app/orders/page.js');
const { loadWorkspace } = await import('../apps/web/src/lib/project-data.js');
const { HIDDEN_BY_ROLE_LABEL } = await import('../apps/web/src/lib/redaction.js');

function signIn(role: Role) {
  signedIn.role = role;
  signedIn.userId = userIds[role];
  signedIn.token = tokens[role];
  signedIn.projectId = projectId;
}

async function send(role: Role, method: 'POST' | 'PATCH', url: string, body: unknown = {}) {
  const response = await app.request(url, {
    method,
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${tokens[role]}` },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function auditAs(role: Role) {
  const response = await app.request(
    `/api/projects/${projectId}/audit-history?entityType=film_supply_order&limit=500`,
    { headers: { cookie: `${SESSION_COOKIE}=${tokens[role]}` } }
  );
  expect(response.status).toBe(200);
  return (await response.json() as { events: Array<{ action: string; entityId: string; afterState?: Record<string, unknown> | null }> }).events;
}

async function render(page: () => Promise<unknown>): Promise<string> {
  const { prelude } = await prerenderToNodeStream((await page()) as Parameters<typeof prerenderToNodeStream>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replaceAll('<!-- -->', '');
}

/** The <tr> of one film order in the /orders list, found by the order's id (the viewer cannot read the code). */
function orderRow(html: string, orderId: string): string {
  const table = html.slice(html.indexOf('フィルム発注の一覧'));
  const at = table.indexOf(orderId);
  expect(at, `row of ${orderId}`).toBeGreaterThan(-1);
  return table.slice(table.lastIndexOf('<tr', at), table.indexOf('</tr>', at));
}

/** The header cells of the film order table, in order. */
function headers(html: string): string[] {
  const table = html.slice(html.indexOf('フィルム発注の一覧'));
  const head = table.slice(table.indexOf('<thead'), table.indexOf('</thead>'));
  return [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => match[1]!);
}

let orderId = '';
let draftOnlyOrderId = '';

beforeAll(async () => {
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
  await db.insert(users).values([
    { id: userIds.admin, username: 'admin_be3_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者BE3', role: 'admin' },
    { id: userIds.staff, username: 'staff_be3_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者BE3', role: 'staff' },
    { id: userIds.viewer, username: 'viewer_be3_test', passwordHash: await hashPassword('composite-viewer-pass'), displayName: '合成閲覧者BE3', role: 'viewer' }
  ]);
  const [customer, seven, maker] = [uuidv7(), uuidv7(), uuidv7()];
  await db.insert(accounts).values([
    { id: customer, name: '合成BE3エンドカスタマー', role: 'end_customer', externalCode: 'TEST-BE3-CUST' },
    { id: seven, name: '合成BE3セブン', role: 'seven', externalCode: 'TEST-BE3-SEVEN' },
    { id: maker, name: '合成BE3メーカー', role: 'maker', externalCode: 'TEST-BE3-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId, code: 'TEST-BE3-PROJECT', name: '合成BE3案件', businessUnit: 'F1' as const, route: 'F1' as const,
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

  // One order created 未確定 and then recorded as 搬入時払い; one left at its creation value.
  const sevenPo = await send('staff', 'POST', `/api/projects/${projectId}/seven-purchase-orders`, { poNumber: 'SEVEN-BE3-0001' });
  expect(sevenPo.status).toBe(201);
  expect((await send('staff', 'POST', `/api/seven-purchase-orders/${sevenPo.body.id as string}/verification-checklist`, {
    issuerNameRecorded: true, issuerName: '合成セブン化学事業', documentNumberRecorded: true,
    documentNumber: 'PO-2026-BE3-0001', issueDateRecorded: true, issueDate: '2026-11-15',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル', pastTransactionCompared: true,
    pastTransactionNote: '様式一致', quoteCompared: true, quoteMatchesPo: true,
    quoteComparisonNote: '見積と一致', tamperHints: '', uncertain: false,
    confirmationReplyRecorded: false, confirmationReplyNote: '', verificationNote: '合成チェックリスト'
  })).status).toBe(200);
  expect((await send('staff', 'POST', `/api/seven-purchase-orders/${sevenPo.body.id as string}/register-official`, {
    officialRegisteredAt: '2026-11-14'
  })).status).toBe(200);
  const created = await send('staff', 'POST', `/api/seven-purchase-orders/${sevenPo.body.id as string}/supply-orders`, {
    code: 'FSO-BE3-0001', paymentTerms: 'undetermined',
    lines: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 1000, unit: 'sheets' }]
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  orderId = created.body.id as string;
  const recorded = await send('staff', 'PATCH', `/api/film-supply-orders/${orderId}/payment-terms`, { paymentTerms: 'on_delivery' });
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
  const second = await send('staff', 'POST', `/api/seven-purchase-orders/${sevenPo.body.id as string}/supply-orders`, {
    code: 'FSO-BE3-0002', paymentTerms: 'prepaid',
    lines: [{ lineNumber: 1, description: '合成フィルム別版', orderedQuantity: 500, unit: 'sheets' }]
  });
  expect(second.status, JSON.stringify(second.body)).toBe(201);
  draftOnlyOrderId = second.body.id as string;
});

afterAll(async () => {
  await pool.end();
});

describe('E3: the 決済条件 is public, amounts are not (representative decision)', () => {
  it('the API answers paymentTerms to staff and viewer on creation and on 決済条件の記録', async () => {
    for (const role of ['staff', 'viewer'] as const) {
      const events = await auditAs(role);
      const createdEvent = events.find((event) => event.action === 'FILM_SUPPLY_ORDER_CREATED' && event.entityId === orderId);
      const updatedEvent = events.find((event) => event.action === 'FILM_SUPPLY_ORDER_PAYMENT_TERMS_UPDATED' && event.entityId === orderId);
      expect(createdEvent?.afterState?.paymentTerms, role).toBe('undetermined');
      expect(updatedEvent?.afterState, role).toEqual({ paymentTerms: 'on_delivery' });
      for (const event of events) {
        for (const key of ['amount', 'totalAmount', 'unitPrice', 'price', 'commissionAmount']) {
          expect(event.afterState ?? {}, `${role} ${event.action}`).not.toHaveProperty(key);
        }
      }
    }
    // The viewer still reads no order code or id beside the status and the term.
    const viewerCreated = (await auditAs('viewer')).find((event) => event.action === 'FILM_SUPPLY_ORDER_CREATED' && event.entityId === orderId);
    expect(Object.keys(viewerCreated?.afterState ?? {}).sort()).toEqual(['paymentTerms', 'status']);
  });

  it('the workspace replays the latest term for every role (creation value replaced by the later record)', async () => {
    for (const role of ['admin', 'staff', 'viewer'] as const) {
      signIn(role);
      const workspace = await loadWorkspace(projectId);
      const order = workspace.filmOrders.find((candidate) => candidate.id === orderId);
      const untouched = workspace.filmOrders.find((candidate) => candidate.id === draftOnlyOrderId);
      expect(order, role).toMatchObject({ paymentTerms: 'on_delivery', paymentTermsHidden: false });
      expect(untouched, role).toMatchObject({ paymentTerms: 'prepaid', paymentTermsHidden: false });
    }
    signIn('viewer');
    // The viewer's other order details stay withheld.
    expect((await loadWorkspace(projectId)).filmOrders.find((candidate) => candidate.id === orderId))
      .toMatchObject({ code: HIDDEN_BY_ROLE_LABEL, detailsHidden: true });
  });

  it('/orders shows the 決済条件 column in Japanese to staff and viewer, never 閲覧権限なし there', async () => {
    for (const role of ['staff', 'viewer'] as const) {
      signIn(role);
      const html = await render(OrdersPage);
      expect(headers(html), role).toContain('決済条件');
      const header = headers(html);
      const termsColumn = header.indexOf('決済条件');
      const cells = (row: string) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1]!);
      expect(cells(orderRow(html, orderId))[termsColumn], role).toBe('搬入時払い');
      expect(cells(orderRow(html, draftOnlyOrderId))[termsColumn], role).toBe('前払い');
      // The stored code is never shown as text (it is only the value of staff's recording form option).
      expect(html, role).not.toMatch(/>\s*(on_delivery|prepaid|undetermined)\s*</);
    }
  });
});
