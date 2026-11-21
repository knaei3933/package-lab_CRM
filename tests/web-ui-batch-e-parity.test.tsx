import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderToString } from 'react-dom/server';
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
import { sendMakerPoEmlEvidence } from './helpers/maker-po-evidence.js';

/**
 * UI batch E (demo-eml/ui-batch-e/REPORT.md) against the REAL API on the
 * isolated test database — the harness of tests/web-ui-recheck9-parity.test.tsx
 * (callApi routed into the real Hono app). What the screens now say is checked
 * against what the API actually records and refuses: the unlinked order the
 * API will not advance (F-05), the hold reason the admin answer carries and the
 * staff answer withholds (F-11), the evidence warning (F-06), the maker paper's
 * amount and the approval facts (F-08, F-15, F-21), the provisional acceptance
 * and its prerequisite (F-10, F-22), a refused project (F-12) and the
 * representative queue (F-23). No API or package file is changed by batch E.
 */

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const projectId = uuidv7();
let adminToken = '';
let staffToken = '';
let app: ReturnType<typeof createApp>;
const signedIn = vi.hoisted(() => ({ token: '', role: 'admin' as 'admin' | 'staff', projectId: '' }));

vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://in-process',
  readSessionToken: async () => signedIn.token,
  readSelectedProjectId: async () => signedIn.projectId,
  loadSessionUser: async () => ({ id: signedIn.role === 'admin' ? adminId : staffId, role: signedIn.role, displayName: '合成' }),
  loadSession: async () => ({ kind: 'user', user: ({ id: signedIn.role === 'admin' ? adminId : staffId, role: signedIn.role, displayName: '合成' }) }),
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
const { default: MakerPoPage } = await import('../apps/web/src/app/maker-po/page.js');
const { default: DocumentsPage } = await import('../apps/web/src/app/documents/page.js');
const { default: DeliveriesPage } = await import('../apps/web/src/app/deliveries/page.js');
const { loadWorkspace, PROJECT_UNAVAILABLE_MESSAGE } = await import('../apps/web/src/lib/project-data.js');
const { ProjectUnavailable } = await import('../apps/web/src/components/ProjectUnavailable.js');
const { ceoApprovalFacts } = await import('../apps/web/src/lib/decision-facts.js');
const { loadRepresentativeQueue } = await import('../apps/web/src/lib/representative-queue.js');
const { callApi } = await import('../apps/web/src/lib/api.js');
const { recordDeliveryAction } = await import('../apps/web/src/app/actions.js');

function signIn(role: 'admin' | 'staff') {
  signedIn.role = role;
  signedIn.token = role === 'admin' ? adminToken : staffToken;
  signedIn.projectId = projectId;
}

let counter = 0;
function nextTag() {
  counter += 1;
  return String(counter).padStart(4, '0');
}

async function call(token: string, url: string, body: unknown = {}) {
  const response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function render(page: () => Promise<unknown>): Promise<string> {
  const { prelude } = await prerenderToNodeStream((await page()) as Parameters<typeof prerenderToNodeStream>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replaceAll('<!-- -->', '');
}

/** The <tr> of one film order in the /orders list (its code cell opens the row). */
function orderRow(html: string, orderCode: string): string {
  const table = html.slice(html.indexOf('フィルム発注の一覧'));
  const at = table.indexOf(`>${orderCode}<`);
  expect(at, `row of ${orderCode}`).toBeGreaterThan(-1);
  return table.slice(table.lastIndexOf('<tr', at), table.indexOf('</tr>', at));
}

async function uploadDocument(input: { documentType: string; issuerEntity: string; designKey?: string; orderId?: string; sevenPoId?: string; makerPoId?: string; content?: string }) {
  const tag = nextTag();
  const response = await call(staffToken, `/api/projects/${projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `be-doc-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: Buffer.from(input.content ?? `composite batch-e document ${tag}\n`, 'utf8').toString('base64'),
    ...(input.sevenPoId ? { sevenPurchaseOrderId: input.sevenPoId } : {}),
    ...(input.orderId ? { filmSupplyOrderId: input.orderId } : {}),
    ...(input.makerPoId ? { makerPurchaseOrderId: input.makerPoId } : {}),
    ...(input.designKey ? { designKey: input.designKey } : {})
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as unknown as { document: { id: string }; version: { id: string } };
}

/** A registered + checklist-verified seven PO (staff records both). */
async function verifiedSevenPo() {
  const tag = nextTag();
  const sevenPo = await call(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, { poNumber: `SEVEN-BE-${tag}` });
  expect(sevenPo.status).toBe(201);
  const sevenPoId = sevenPo.body.id as string;
  expect((await call(staffToken, `/api/seven-purchase-orders/${sevenPoId}/verification-checklist`, {
    issuerNameRecorded: true, issuerName: '合成セブン化学事業', documentNumberRecorded: true,
    documentNumber: `PO-2026-BE-${tag}`, issueDateRecorded: true, issueDate: '2026-11-15',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル', pastTransactionCompared: true,
    pastTransactionNote: '様式一致', quoteCompared: true, quoteMatchesPo: true,
    quoteComparisonNote: '見積と一致', tamperHints: '', uncertain: false,
    confirmationReplyRecorded: false, confirmationReplyNote: '', verificationNote: '合成チェックリスト'
  })).status).toBe(200);
  expect((await call(staffToken, `/api/seven-purchase-orders/${sevenPoId}/register-official`, {
    officialRegisteredAt: '2026-11-14'
  })).status).toBe(200);
  return sevenPoId;
}

async function linkedOrder(sevenPoId: string) {
  const orderCode = `FSO-BE-${nextTag()}`;
  const order = await call(staffToken, `/api/seven-purchase-orders/${sevenPoId}/supply-orders`, {
    code: orderCode, paymentTerms: 'prepaid',
    lines: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 1000, unit: 'sheets' }]
  });
  expect(order.status).toBe(201);
  return { orderId: order.body.id as string, orderCode };
}

/** An order at MAKER_PO_READY through the real chain (checklist, artwork, dual approval). */
async function reachMakerPoReady() {
  const sevenPoId = await verifiedSevenPo();
  const { orderId, orderCode } = await linkedOrder(sevenPoId);
  // P1 R23: SEVEN_PO_VERIFIED on creation, PROOF_READY and APPROVAL_PENDING on the revision
  for (const to of ['ARTWORK_RECEIVED']) {
    expect((await call(staffToken, `/api/film-supply-orders/${orderId}/transitions`, { to })).status).toBe(200);
  }
  const artworkBytes = `composite batch-e artwork ${nextTag()}\n`;
  const proof = await uploadDocument({ documentType: 'proof', issuerEntity: 'kanei', designKey: 'label-front', orderId, sevenPoId, content: artworkBytes });
  const revision = await call(staffToken, `/api/film-supply-orders/${orderId}/artwork-revisions`, {
    designKey: 'label-front', fileDocumentVersionId: proof.version.id
  });
  expect(revision.status).toBe(201);
  for (const organization of ['customer', 'seven'] as const) {
    const identifier = `MSG-BE-${organization.toUpperCase()}-${nextTag()}`;
    const evidence = await uploadDocument({
      documentType: 'approval_evidence', issuerEntity: organization === 'seven' ? 'seven' : 'customer_generated',
      designKey: 'label-front', orderId, sevenPoId, content: `composite batch-e approval\nidentifier: ${identifier}\n`
    });
    expect((await call(staffToken, `/api/artwork-revisions/${revision.body.id as string}/approvals`, {
      organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
      evidenceIdentifier: identifier, evidenceDocumentVersionId: evidence.version.id
    })).status).toBe(201);
  }
  expect((await call(staffToken, `/api/film-supply-orders/${orderId}/auto-advance`, {})).status).toBe(200);
  return { orderId, orderCode, artworkBytes, sevenPoId };
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-ui-batch-e-'));
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
    { id: adminId, username: 'admin_be_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者BE', role: 'admin' },
    { id: staffId, username: 'staff_be_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者BE', role: 'staff' }
  ]);
  const [customer, seven, maker] = [uuidv7(), uuidv7(), uuidv7()];
  await db.insert(accounts).values([
    { id: customer, name: '合成BEエンドカスタマー', role: 'end_customer', externalCode: 'TEST-BE-CUST' },
    { id: seven, name: '合成BEセブン', role: 'seven', externalCode: 'TEST-BE-SEVEN' },
    { id: maker, name: '合成BEメーカー', role: 'maker', externalCode: 'TEST-BE-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId, code: 'TEST-BE-PROJECT', name: '合成BE案件', businessUnit: 'F1' as const, route: 'F1' as const,
    leadSource: 'KANEI', status: 'DRAFT' as const, endCustomerAccountId: customer, sevenAccountId: seven,
    makerAccountId: maker, createdByUserId: adminId, createdAt: now, updatedAt: now
  });
  await db.insert(projectAssignments).values([{ id: uuidv7(), userId: staffId, projectId }]);
  for (const userId of [adminId, staffId]) {
    const { token, tokenHash } = issueToken();
    await db.insert(sessions).values({ id: uuidv7(), userId, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    if (userId === adminId) adminToken = token; else staffToken = token;
  }
});

afterAll(async () => {
  await pool.end();
});

describe('F-05: an order without its セブン化学発注書', () => {
  it('the API refuses to advance it; the admin row says why and what to do; staff is not sent back to done work', async () => {
    await verifiedSevenPo();
    const code = `FSO-BE-UNLINKED-${nextTag()}`;
    const created = await call(adminToken, `/api/projects/${projectId}/film-supply-orders`, {
      paymentTerms: 'undetermined', code, lines: [{ lineNumber: 1, description: '合成', orderedQuantity: 10, unit: 'rolls' }]
    });
    expect(created.status).toBe(201);
    const refused = await call(staffToken, `/api/film-supply-orders/${created.body.id as string}/transitions`, { to: 'SEVEN_PO_VERIFIED' });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('SEVEN_PO_REQUIRED');

    signIn('admin');
    const row = orderRow(await render(OrdersPage), code);
    expect(row).toContain('紐付けなし');
    expect(row).toContain('この発注は「セブン化学発注書確認済」へ進められません。紐付けは作成のときだけ選べます。');

    // Server batch E: staff reads the PO link too, so staff gets the same cause and remedy (F-05: role-independent).
    signIn('staff');
    const staffHtml = await render(OrdersPage);
    expect(staffHtml).not.toContain('セブン化学発注書の公式登録と真性行チェックリストを済ませ');
    expect(orderRow(staffHtml, code)).toContain('この発注は「セブン化学発注書確認済」へ進められません。紐付けは作成のときだけ選べます。');
    expect(staffHtml).toContain('この発注はセブン化学発注書に紐付いていないため');
    // The create form (staff may create) requires the PO.
    expect(staffHtml).toMatch(/<select name="sevenPurchaseOrderId" required=""/);
  });
});

describe('F-11, F-16: the hold reason, by role', () => {
  it('admin reads the reason, who held it and when; staff is told it is withheld; the badge reads ‖', async () => {
    const sevenPoId = await verifiedSevenPo();
    const { orderId, orderCode } = await linkedOrder(sevenPoId);
    const held = await call(staffToken, `/api/film-supply-orders/${orderId}/transitions`, { to: 'ON_HOLD', holdReason: '色見本の再確認待ち（合成）' });
    expect(held.status).toBe(200);

    signIn('admin');
    const adminHtml = await render(OrdersPage);
    const adminRow = orderRow(adminHtml, orderCode);
    expect(adminRow).toMatch(/保留の理由: 色見本の再確認待ち（合成）（合成担当者BE が \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} JST に保留）/);
    expect(adminRow).toContain('aria-hidden="true">‖</span>保留中');
    expect(adminHtml).toContain('保留の理由は「色見本の再確認待ち（合成）」です。');

    signIn('staff');
    const staffRow = orderRow(await render(OrdersPage), orderCode);
    expect(staffRow).toContain('保留の理由: （閲覧権限なし）（合成担当者BE が');
    expect(staffRow).not.toContain('色見本の再確認待ち');
  });
});

describe('F-06: the evidence warning before a transition', () => {
  it('an order at セブン化学発注書確認済 with no document offers the warning and the reason field for デザイン受領', async () => {
    const sevenPoId = await verifiedSevenPo();
    const { orderId, orderCode } = await linkedOrder(sevenPoId);
    // P1 R23: the linked verified PO makes the new order SEVEN_PO_VERIFIED at once.
    signIn('staff');
    const row = orderRow(await render(OrdersPage), orderCode);
    expect(row).toContain('証跡がないまま進める場合（「デザインデータ受領」）');
    expect(row).toContain('この発注に紐付いた書類（デザイン入稿データ）が、文書画面にまだ登録されていません。');
    expect(row).toContain('name="evidenceNote"');
    // Warn only: the API still accepts the transition (the gate is a policy decision).
    expect((await call(staffToken, `/api/film-supply-orders/${orderId}/transitions`, { to: 'ARTWORK_RECEIVED' })).status).toBe(200);
  });
});

describe('F-08, F-15, F-21: the maker paper and its approval', () => {
  it('the amount reads ¥480,000, the facts come from the admin answer, and the order is not offered for a second paper', async () => {
    const chain = await reachMakerPoReady();
    const created = await call(adminToken, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, {
      recipientAddress: 'order@osaka-maker.example.jp', amounts: { currency: 'JPY', totalAmount: '480000' }
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    signIn('admin');
    const html = await render(MakerPoPage);
    expect(html).toContain('¥480,000');
    expect(html).not.toContain('JPY 480000');
    expect(html).not.toContain('ダイジェスト');
    expect(html).toContain('作成したときの内容（宛先・明細・金額）に対して承認します。');
    expect(html).toContain(`${chain.orderCode}: メーカー発注書は作成済みです。`);
    expect(html).not.toMatch(new RegExp(`<option value="${chain.orderId}"`));
    // The second paper the hidden form would have tried: the API refuses it.
    expect((await call(adminToken, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, { recipientAddress: 'second@osaka-maker.example.jp' })).body.code)
      .toBe('MAKER_PO_ALREADY_EXISTS');

    const list = await callApi<{ makerPurchaseOrders?: unknown[]; purchaseOrders?: unknown[] }>(`/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`);
    const rows = (list.data?.makerPurchaseOrders ?? list.data?.purchaseOrders ?? list.data) as Array<Parameters<typeof ceoApprovalFacts>[0]>;
    expect(Array.isArray(rows), JSON.stringify(list.data)).toBe(true);
    expect(ceoApprovalFacts(rows[0]!, chain.orderCode, 'prepaid')).toEqual([
      { label: '発注コード', value: chain.orderCode },
      { label: 'メーカーの送信先', value: 'order@osaka-maker.example.jp' },
      { label: '金額', value: '¥480,000' },
      { label: '支払条件', value: '前払い' }
    ]);
  });
});

describe('F-10, F-22: the provisional acceptance and what the final one waits for', () => {
  it('staff reads 「未入力」 for the acceptance time apart from the record time, and the 受領証跡 step', async () => {
    const chain = await reachMakerPoReady();
    const created = await call(adminToken, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, { recipientAddress: 'maker-po@example.com' });
    const poId = created.body.id as string;
    expect((await call(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {})).status).toBe(200);
    const sent = await sendMakerPoEmlEvidence((url, body) => call(staffToken, url, body), poId, {
      orderCode: chain.orderCode, attachmentBytes: chain.artworkBytes
    });
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');
    expect((await call(staffToken, `/api/maker-purchase-orders/${poId}/provisional-acceptance`, {})).status).toBe(201);
    // Review M2: an uploaded but still unchecked 受領証跡 does not satisfy the prerequisite.
    await uploadDocument({ documentType: 'acceptance_evidence', issuerEntity: 'maker', orderId: chain.orderId, sevenPoId: chain.sevenPoId, makerPoId: poId });

    signIn('staff');
    const staffHtml = await render(MakerPoPage);
    expect(staffHtml).toMatch(/メーカー受入の日時: 未入力（記録した日時: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} JST）/);
    expect(staffHtml).toContain('仮の受入記録はあります。最終受入確認の前に、受領証跡（メーカーの受入・検収を示す書類）が必要です。');
    expect(staffHtml).toContain('書類種別「受領証跡」としてこの発注とこのメーカー発注書に紐付けてアップロード');
    expect(staffHtml).toContain('担当者が仮の記録と受領証跡の登録、代表者が受領証跡を確認して最終確認');

    signIn('admin');
    const adminHtml = await render(MakerPoPage);
    expect(adminHtml).toContain('仮の受入記録はあります。最終受入確認の前に、受領証跡');
    expect(adminHtml).not.toContain('最終受入確認のブロック理由');
    // The unchecked upload is not offered for the final acceptance.
    expect(adminHtml).not.toContain('受領証跡の書類バージョン（確認済み）');
  });
});

describe('F-07: the upload form names the PO state', () => {
  it('a PO without its checklist is labelled as not usable for an official artifact', async () => {
    const unverified = await call(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, { poNumber: `SEVEN-BE-UNV-${nextTag()}` });
    expect(unverified.status).toBe(201);
    signIn('admin');
    const html = await render(DocumentsPage);
    // Review L3: the label names the step that is missing.
    expect(html).toMatch(/SEVEN-BE-UNV-\d+（未登録） 真性行チェックリストがまだです/);
  });
});

describe('F-12: a project the API no longer opens', () => {
  it('workspace marks it refused; the screen shows only the way out', async () => {
    signIn('admin');
    signedIn.projectId = uuidv7();
    const workspace = await loadWorkspace(signedIn.projectId);
    expect(workspace.project).toBeNull();
    expect(workspace.projectRefused).toBe(true);
    // ui/fix-project-select: the screen no longer stops on it — a project the
    // operator's list does not offer is forgotten first (the /project-selection
    // route writes the cookie), and the message stays for a refusal of a
    // listed project (ProjectUnavailable, below and web-ui-batch-e).
    const target = await render(OrdersPage).then(() => null, (error: { digest?: string }) => error.digest ?? String(error));
    expect(target).toContain('/project-selection?next=%2Forders');
    expect(renderToString(<ProjectUnavailable title="案件（発注）一覧／作成" reason={workspace.error} returnTo="/orders" />)).toContain(PROJECT_UNAVAILABLE_MESSAGE);
    signedIn.projectId = projectId;
  });
});

describe('F-23: the representative queue', () => {
  it('lists the held order and the order waiting for its maker paper, from the API', async () => {
    signIn('admin');
    const queue = await loadRepresentativeQueue([{ id: projectId, code: 'TEST-BE-PROJECT', name: '合成BE案件', status: 'DRAFT' }]);
    expect(queue.unreadProjects).toEqual([]);
    const works = queue.tasks.map((task) => task.work);
    expect(works).toContain('保留の解除（理由の確認）');
    expect(works).toContain('メーカー発注書の作成と代表承認');
    expect(queue.tasks.every((task) => task.projectLabel === 'TEST-BE-PROJECT（合成BE案件）')).toBe(true);
  });
});

describe('F-00 (server batch E 9972e99) on the screen: the delivery line choice reaches commission READY', () => {
  it('staff picks the line the screen offers, the delivery and its confirmation land, and staff and viewer read READY', async () => {
    const sevenPoId = await verifiedSevenPo();
    // The web's own create path (POST /api/projects/:id/film-supply-orders) — the one that writes line audits.
    const code = `FSO-BE-LINE-${nextTag()}`;
    const created = await call(staffToken, `/api/projects/${projectId}/film-supply-orders`, {
      code, sevenPurchaseOrderId: sevenPoId, paymentTerms: 'prepaid',
      lines: [{ lineNumber: 1, description: '合成フィルム本体（納品検証）', orderedQuantity: 1000, unit: 'sheets' }]
    });
    expect(created.status).toBe(201);
    const orderId = created.body.id as string;

    signIn('staff');
    const workspace = await loadWorkspace(projectId);
    const order = workspace.filmOrders.find((candidate) => candidate.id === orderId)!;
    expect(order.lines).toHaveLength(1);
    const lineId = order.lines[0]!.id;
    // What deliveries/page.tsx turns into 「明細1：合成フィルム本体（納品検証）（1000.000枚）」 (the select
    // fills after an order is chosen in the client form; the browser check covers that step).
    expect(order.lines[0]).toMatchObject({ lineNumber: 1, description: '合成フィルム本体（納品検証）', orderedQuantity: '1000.000', unit: 'sheets' });
    expect(order.detailsHidden).toBe(false);

    const delivery = await call(staffToken, `/api/film-supply-orders/${orderId}/deliveries`, {
      filmSupplyOrderLineId: lineId, deliveredQuantity: 1000, unit: 'sheets'
    });
    expect(delivery.status, JSON.stringify(delivery.body)).toBe(201);
    const filmEvidence = await uploadDocument({ documentType: 'acceptance_evidence', issuerEntity: 'kanei', orderId, sevenPoId });
    expect((await call(staffToken, `/api/documents/${filmEvidence.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
    expect((await call(staffToken, `/api/film-deliveries/${delivery.body.id as string}/confirmation`, {
      evidenceDocumentVersionId: filmEvidence.version.id
    })).status).toBe(201);

    const filling = await call(staffToken, `/api/projects/${projectId}/filling-orders`, {
      code: `FLO-BE-${nextTag()}`, lines: [{ lineNumber: 1, description: '合成充填カプセル', orderedQuantity: 2000, unit: 'pods' }]
    });
    expect(filling.status).toBe(201);
    const fillingLines = filling.body.lines as Array<{ id: string }>;
    const fillingDelivery = await call(staffToken, `/api/filling-orders/${filling.body.id as string}/deliveries`, {
      fillingOrderLineId: fillingLines[0]!.id, deliveredQuantity: 1900, unit: 'pods'
    });
    expect(fillingDelivery.status).toBe(201);
    const fillingEvidence = await call(staffToken, `/api/projects/${projectId}/documents`, {
      documentType: 'acceptance_evidence', issuerEntity: 'kanei', filename: `be-filling-${nextTag()}.txt`, contentType: 'text/plain',
      contentBase64: Buffer.from('batch E filling acceptance\n', 'utf8').toString('base64'),
      sevenPurchaseOrderId: sevenPoId, fillingOrderId: filling.body.id
    });
    expect(fillingEvidence.status, JSON.stringify(fillingEvidence.body)).toBe(201);
    const fe = fillingEvidence.body as unknown as { document: { id: string }; version: { id: string } };
    expect((await call(staffToken, `/api/documents/${fe.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
    expect((await call(staffToken, `/api/filling-deliveries/${fillingDelivery.body.id as string}/confirmation`, {
      evidenceDocumentVersionId: fe.version.id
    })).status).toBe(201);

    const readiness = await call(staffToken, `/api/projects/${projectId}/commission-readiness`, {});
    expect(readiness.status).toBe(201);
    expect(readiness.body).toMatchObject({ readinessState: 'READY', isReady: true });

    // F-01/F-09 on the screen: staff and the viewer read the state (no 閲覧権限なし).
    signIn('staff');
    expect((await loadWorkspace(projectId)).readiness).toMatchObject({ readinessState: 'READY', hidden: false });
    expect(await render(DeliveriesPage)).toContain('手数料計算可能');
    signedIn.role = 'staff';
  });
});

describe('E2 (server follow-up db4bd88): document identity for staff, the unit mismatch in Japanese', () => {
  it('staff reads the file name and the issuer of an uploaded document on 書類 (not 閲覧権限なし)', async () => {
    const sevenPoId = await verifiedSevenPo();
    const { orderId } = await linkedOrder(sevenPoId);
    const uploaded = await uploadDocument({ documentType: 'acceptance_evidence', issuerEntity: 'maker', orderId, sevenPoId });

    signIn('staff');
    const workspace = await loadWorkspace(projectId);
    const document = workspace.documents.find((candidate) => candidate.id === uploaded.document.id)!;
    expect(document.filename).toMatch(/^be-doc-\d{4}\.txt$/);
    expect(document).toMatchObject({ issuerEntity: 'maker', detailsHidden: false, typeHidden: false });
    // The version names its file too; its content digest stays withheld.
    expect(document.versions[0]).toMatchObject({ originalFilename: document.filename, sha256: null, sha256Hidden: true });

    const html = await render(DocumentsPage);
    const at = html.indexOf(document.filename);
    expect(at, 'file name on the 書類 list').toBeGreaterThan(-1);
    const row = html.slice(html.lastIndexOf('<tr', at), html.indexOf('</tr>', at));
    // The 発行主体 cell reads the issuer; only the version hash stays 「閲覧権限なし」.
    expect(row).toMatch(/<td[^>]*>製造先<\/td>/);
    expect(row).toContain('ハッシュ 閲覧権限なし');
    signIn('admin');
  });

  it('a delivery in another unit than its line is refused in Japanese and records nothing (film and filling)', async () => {
    const sevenPoId = await verifiedSevenPo();
    const { orderId } = await linkedOrder(sevenPoId);
    signIn('staff');
    const before = await loadWorkspace(projectId);
    const line = before.filmOrders.find((order) => order.id === orderId)!.lines[0]!;
    expect(line.unit).toBe('sheets');

    const film = await recordDeliveryAction(null, formOf({
      kind: 'film', orderId, lineId: line.id, unit: 'rolls', deliveredQuantity: '10'
    }));
    expect(film).toMatchObject({
      ok: false,
      message: '納品単位（ロール）が明細の単位（枚）と異なります。単位を明細と同じ単位に直して、もう一度記録してください。'
    });

    const filling = await call(staffToken, `/api/projects/${projectId}/filling-orders`, {
      code: `FLO-BE2-${nextTag()}`, lines: [{ lineNumber: 1, description: '合成充填カプセル', orderedQuantity: 20, unit: 'pods' }]
    });
    expect(filling.status).toBe(201);
    const fillingLine = (filling.body.lines as Array<{ id: string }>)[0]!;
    const refusedFilling = await recordDeliveryAction(null, formOf({
      kind: 'filling', orderId: filling.body.id as string, lineId: fillingLine.id, unit: 'pieces', deliveredQuantity: '5'
    }));
    expect(refusedFilling.message).toBe('納品単位（個）が明細の単位（ポッド）と異なります。単位を明細と同じ単位に直して、もう一度記録してください。');

    const after = await loadWorkspace(projectId);
    expect(after.deliveries.filter((delivery) => delivery.orderId === orderId || delivery.orderId === filling.body.id)).toHaveLength(0);

    // The same form in the line's unit is accepted.
    expect(await recordDeliveryAction(null, formOf({
      kind: 'film', orderId, lineId: line.id, unit: 'sheets', deliveredQuantity: '10'
    }))).toEqual({ ok: true, message: '記録しました。', changedId: expect.any(String) });
    signIn('admin');
  });
});

function formOf(entries: Record<string, string>): FormData {
  const data = new FormData();
  data.set('_kaneiRenderedProjectId', signedIn.projectId); // P0 R03: the form was drawn for the selected project
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}
