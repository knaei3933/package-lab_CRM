import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
import { projectScreen } from './helpers/project-screen.js';

/**
 * UI nav-dashboard (demo-eml/ui-nav-dashboard/REPORT.md) against the REAL API
 * on the isolated test database (callApi routed into the Hono app, as in
 * web-ui-batch-e-parity). One project holds a maker PO drafted with an amount,
 * an order on hold and an order missing its design data. The dashboard of each
 * role is rendered from what the API answers that role:
 * - admin: the 代表承認 with ¥480,000 and the hold in 「いま自分がやること」;
 * - staff and viewer: no amount anywhere on the page (the API withholds it and
 *   the dashboard never prints one for them), the 支払条件 前払い shown;
 * - staff: its own work listed, the representative's steps as waiting;
 * - viewer: nothing to record.
 * No API, schema or migration file is changed.
 */

type Role = 'admin' | 'staff' | 'viewer';
const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);
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
  loadSession: async () => ({ kind: 'user', user: ({ id: signedIn.userId, role: signedIn.role, displayName: '合成' }) }),
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

const { default: DashboardPage } = await import('../apps/web/src/app/dashboard/page.js');
// P1 R20: the dashboard of an open project is its overview at /p/{code}.
const ProjectPage = projectScreen((await import('../apps/web/src/screens/ProjectOverviewScreen.js')).ProjectOverviewScreen);
const { default: GuidePage } = await import('../apps/web/src/app/guide/page.js');

function signIn(role: Role, withProject = true) {
  signedIn.role = role;
  signedIn.userId = userIds[role];
  signedIn.token = tokens[role];
  signedIn.projectId = withProject ? projectId : '';
}

let counter = 0;
const nextTag = () => String(++counter).padStart(4, '0');

async function call(role: Role, url: string, body: unknown = {}) {
  const response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${tokens[role]}` },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function get(role: Role, url: string) {
  const response = await app.request(url, { headers: { cookie: `${SESSION_COOKIE}=${tokens[role]}` } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function render(page: () => Promise<unknown>): Promise<string> {
  const { prelude } = await prerenderToNodeStream((await page()) as Parameters<typeof prerenderToNodeStream>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replaceAll('<!-- -->', '');
}

/** The markup of one dashboard panel, from its heading to the next panel heading. */
function panel(html: string, heading: string): string {
  // Headings start right after a tag; the same words inside a sentence do not.
  const at = html.indexOf(`>${heading}`);
  expect(at, heading).toBeGreaterThan(-1);
  const next = html.indexOf('<h2', at + heading.length);
  return html.slice(at, next === -1 ? undefined : next);
}

async function uploadDocument(input: { documentType: string; issuerEntity: string; designKey: string; orderId: string; sevenPoId: string; content: string }) {
  const response = await call('staff', `/api/projects/${projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `nd-doc-${nextTag()}.txt`,
    contentType: 'text/plain',
    contentBase64: Buffer.from(input.content, 'utf8').toString('base64'),
    sevenPurchaseOrderId: input.sevenPoId,
    filmSupplyOrderId: input.orderId,
    designKey: input.designKey
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as unknown as { document: { id: string }; version: { id: string } };
}

async function verifiedSevenPo() {
  const tag = nextTag();
  const sevenPo = await call('staff', `/api/projects/${projectId}/seven-purchase-orders`, { poNumber: `SEVEN-ND-${tag}` });
  expect(sevenPo.status).toBe(201);
  const sevenPoId = sevenPo.body.id as string;
  expect((await call('staff', `/api/seven-purchase-orders/${sevenPoId}/verification-checklist`, {
    issuerNameRecorded: true, issuerName: '合成セブン化学事業', documentNumberRecorded: true,
    documentNumber: `PO-2026-ND-${tag}`, issueDateRecorded: true, issueDate: '2026-11-15',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル', pastTransactionCompared: true,
    pastTransactionNote: '様式一致', quoteCompared: true, quoteMatchesPo: true,
    quoteComparisonNote: '見積と一致', tamperHints: '', uncertain: false,
    confirmationReplyRecorded: false, confirmationReplyNote: '', verificationNote: '合成チェックリスト'
  })).status).toBe(200);
  expect((await call('staff', `/api/seven-purchase-orders/${sevenPoId}/register-official`, { officialRegisteredAt: '2026-11-14' })).status).toBe(200);
  return sevenPoId;
}

async function linkedOrder(sevenPoId: string) {
  const orderCode = `FSO-ND-${nextTag()}`;
  const order = await call('staff', `/api/seven-purchase-orders/${sevenPoId}/supply-orders`, {
    code: orderCode, paymentTerms: 'prepaid',
    lines: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 1000, unit: 'sheets' }]
  });
  expect(order.status).toBe(201);
  return { orderId: order.body.id as string, orderCode };
}

async function transition(orderId: string, to: string, extra: Record<string, unknown> = {}) {
  const result = await call('staff', `/api/film-supply-orders/${orderId}/transitions`, { to, ...extra });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

const chain = { readyId: '', readyCode: '', heldCode: '', artworkCode: '', reviewId: '', reviewCode: '' };

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-nav-dashboard-'));
  app = createApp({ db });
  await db.execute(sql`
    truncate table audit_events, maker_po_events, maker_po_send_manual_verifications,
      maker_purchase_orders, artwork_revisions, artwork_approval_events,
      evidence_manual_verifications, documents, document_versions, pre_order_references,
      seven_purchase_orders, film_supply_orders, film_supply_order_lines, film_deliveries,
      filling_orders, filling_order_lines, filling_deliveries, commission_readiness,
      delivery_confirmations, project_assignments, projects, sessions, accounts, users cascade
  `);
  await db.insert(users).values([
    { id: userIds.admin, username: 'admin_nd_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者ND', role: 'admin' },
    { id: userIds.staff, username: 'staff_nd_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者ND', role: 'staff' },
    { id: userIds.viewer, username: 'viewer_nd_test', passwordHash: await hashPassword('composite-viewer-pass'), displayName: '合成閲覧者ND', role: 'viewer' }
  ]);
  const [customer, seven, maker] = [uuidv7(), uuidv7(), uuidv7()];
  await db.insert(accounts).values([
    { id: customer, name: '合成NDエンドカスタマー', role: 'end_customer', externalCode: 'TEST-ND-CUST' },
    { id: seven, name: '合成NDセブン', role: 'seven', externalCode: 'TEST-ND-SEVEN' },
    { id: maker, name: '合成NDメーカー', role: 'maker', externalCode: 'TEST-ND-MAKER' }
  ]);
  const now = new Date();
  await db.insert(projects).values({
    id: projectId, code: 'TEST-ND-PROJECT', name: '合成ND案件', businessUnit: 'F1' as const, route: 'F1' as const,
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

  // ① An order through the real chain to MAKER_PO_READY, its maker PO drafted with an amount.
  const sevenPoId = await verifiedSevenPo();
  const ready = await linkedOrder(sevenPoId);
  // P1 R23: SEVEN_PO_VERIFIED on creation, PROOF_READY and APPROVAL_PENDING on the revision
  for (const to of ['ARTWORK_RECEIVED']) await transition(ready.orderId, to);
  const proof = await uploadDocument({ documentType: 'proof', issuerEntity: 'kanei', designKey: 'label-front', orderId: ready.orderId, sevenPoId, content: `nd artwork ${nextTag()}\n` });
  const revision = await call('staff', `/api/film-supply-orders/${ready.orderId}/artwork-revisions`, { designKey: 'label-front', fileDocumentVersionId: proof.version.id });
  expect(revision.status).toBe(201);
  for (const organization of ['customer', 'seven'] as const) {
    const identifier = `MSG-ND-${organization.toUpperCase()}-${nextTag()}`;
    const evidence = await uploadDocument({
      documentType: 'approval_evidence', issuerEntity: organization === 'seven' ? 'seven' : 'customer_generated',
      designKey: 'label-front', orderId: ready.orderId, sevenPoId, content: `nd approval\nidentifier: ${identifier}\n`
    });
    expect((await call('staff', `/api/artwork-revisions/${revision.body.id as string}/approvals`, {
      organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
      evidenceIdentifier: identifier, evidenceDocumentVersionId: evidence.version.id
    })).status).toBe(201);
  }
  // P1 R23: dual approval with a decided term is MAKER_PO_READY by itself.
  const paper = await call('admin', `/api/film-supply-orders/${ready.orderId}/maker-purchase-orders`, {
    recipientAddress: 'order@osaka-maker.example.jp', amounts: { currency: 'JPY', totalAmount: '480000' }
  });
  expect(paper.status, JSON.stringify(paper.body)).toBe(201);
  chain.readyId = ready.orderId;
  chain.readyCode = ready.orderCode;

  // ② An order put on hold by staff, with a reason.
  const held = await linkedOrder(await verifiedSevenPo());
  await transition(held.orderId, 'ON_HOLD', { holdReason: '色見本の再確認待ち（合成ND）' });
  chain.heldCode = held.orderCode;

  // ③ An order at セブン確認済み without its design data (evidence missing for デザイン受領).
  const artwork = await linkedOrder(await verifiedSevenPo()); // P1 R23: SEVEN_PO_VERIFIED on creation
  chain.artworkCode = artwork.orderCode;

  // ④ An order in 変更確認 (entered by staff through the general transition).
  const review = await linkedOrder(await verifiedSevenPo()); // P1 R23: SEVEN_PO_VERIFIED on creation
  await transition(review.orderId, 'CHANGE_REVIEW');
  chain.reviewId = review.orderId;
  chain.reviewCode = review.orderCode;
});

/** Korean text (Hangul) outside the guide's lang="ko" notes. */
const HANGUL = /[\uAC00-\uD7A3]/;

afterAll(async () => {
  await pool.end();
});

const AMOUNT = /480,?000|¥|金額/;

describe('the API itself: amounts reach the representative only', () => {
  it('the maker PO list answers admin with the amount and staff / viewer without it', async () => {
    const url = `/api/film-supply-orders/${chain.readyId}/maker-purchase-orders`;
    expect(JSON.stringify((await get('admin', url)).body)).toContain('480000');
    for (const role of ['staff', 'viewer'] as const) {
      const answer = await get(role, url);
      expect(answer.status, role).toBe(200);
      expect(JSON.stringify(answer.body), role).not.toContain('480000');
    }
  });
});

describe('dashboard by role on the real API', () => {
  it('admin: the 代表承認 with its amount and the hold release are the representative’s own work', async () => {
    signIn('admin');
    const html = await render(ProjectPage);
    expect(html).not.toMatch(HANGUL);
    const todo = panel(html, 'いま自分がやること');
    expect(todo).toContain(chain.readyCode);
    expect(todo).toContain('メーカー発注書の代表承認を記録する（発注書は作成済み）。');
    expect(todo).toContain('金額: ¥480,000');
    // P1 R21: an item about one order opens that order's own screen.
    expect(todo).toContain(`href="/p/TEST-P/o/${chain.readyCode}"`);
    expect(todo).toContain('この発注を開く');
    expect(todo).toContain(chain.heldCode);
    expect(todo).toContain('保留の理由: 色見本の再確認待ち（合成ND）');
    expect(todo).toContain('支払条件: 前払い');
    // The staff step of order ③ is the staff's, shown as reference with its missing evidence as a note.
    const staffWork = panel(html, '担当者が進めている作業');
    expect(staffWork).toContain(chain.artworkCode);
    // 変更確認 is resumed by 担当者・代表者 (server: film_order:transition) — not the representative's own list (review R-1).
    expect(todo).not.toContain(chain.reviewCode);
    expect(staffWork).toContain(chain.reviewCode);
    expect(todo).toContain('代表者だけが行う作業: 代表承認、送信の確認、最終受入、保留の解除、取消確認の処理');
    expect(staffWork).toContain('証跡が未登録: この発注に紐付いた書類（デザイン入稿データ）が、文書画面にまだ登録されていません。');
    const blocked = panel(html, '止まっている発注');
    expect(blocked).toContain('「保留中」で止まっています。');
    expect(blocked).toContain('「変更確認中」で止まっています。');
    // A moving order's next evidence is not a block; fresh orders are not listed as quiet.
    expect(blocked).not.toContain('証跡が未登録');
    const stalled = panel(html, '更新が止まっている発注（確認用）');
    expect(stalled).toContain('希望納期が記録された発注は、その日を過ぎると');
    expect(stalled).toContain('7日以上更新が止まっている発注はありません。');
    const activity = panel(html, '最近の記録');
    expect(activity).toContain(`${chain.reviewCode} 発注の状態を変更（→「変更確認中」）`);
    expect(activity).toContain('合成担当者ND');
    // A line is named by its order (the line's own state carries the order link).
    expect(activity).toContain(`${chain.reviewCode} 発注明細を登録`);
  });

  it('staff: its own record is listed, the representative’s steps wait; no amount anywhere on the page', async () => {
    signIn('staff');
    const html = await render(ProjectPage);
    expect(html).not.toMatch(AMOUNT);
    expect(html).not.toMatch(HANGUL);
    const todo = panel(html, 'いま自分がやること');
    expect(todo).toContain(chain.artworkCode);
    // The 変更確認 restart is the staff's own work, with the server's rule as its note.
    expect(todo).toContain(chain.reviewCode);
    expect(todo).toContain('変更確認からの再開は担当者・代表者が行えます');
    expect(todo).toContain('デザイン入稿データを発注の画面（手順4）で登録し');
    expect(todo).toContain('証跡が未登録: この発注に紐付いた書類（デザイン入稿データ）');
    expect(todo).not.toContain(chain.readyCode);
    const waiting = panel(html, '代表者の対応待ち（代表者が行う作業）');
    expect(waiting).toContain(chain.readyCode);
    expect(waiting).toContain(chain.heldCode);
    expect(html).toContain('支払条件: 前払い');
    // The hold reason is withheld from staff by the API: named as withheld, never shown.
    expect(html).not.toContain('色見本の再確認待ち');
    expect(html).toContain('保留の理由: （閲覧権限なし）');
  });

  it('viewer: nothing to record, the work in progress and what is stuck are readable; no amount', async () => {
    signIn('viewer');
    const html = await render(ProjectPage);
    expect(html).not.toMatch(AMOUNT);
    expect(html).not.toMatch(HANGUL);
    expect(panel(html, 'いま自分がやること')).toContain('閲覧者は記録・変更をしません。');
    expect(panel(html, '進行中の作業（誰が何をするか）')).toContain('支払条件: 前払い');
    expect(panel(html, '止まっている発注')).toContain('「保留中」で止まっています。');
    // The viewer does not read the linked records: no quiet-order judgement, said plainly.
    expect(panel(html, '更新が止まっている発注（確認用）')).toContain('判定していません');
    // No form of any kind on the viewer's dashboard (the project list form only shows without a project).
    expect(html).not.toContain('<form');
  });

  it('without a selected project: the only project the API lists for the role is opened for the operator', async () => {
    // ui/fix-project-select: one project — no choice to make, the route opens it
    // (the cards for several projects: web-fix-project-select-parity).
    signIn('staff', false);
    const target = await render(DashboardPage).then(() => null, (error: { digest?: string }) => error.digest ?? String(error));
    expect(target).toContain(';/p/TEST-ND-PROJECT;');
  });

  it('the guide page is Japanese; Korean only in the closed 「한국어 설명」 note under each section; the role’s day comes first', async () => {
    signIn('viewer');
    const html = await render(GuidePage);
    const first = html.indexOf('<h3');
    expect(html.slice(first, first + 200)).toContain('閲覧者（viewer）の一日');
    expect(html).toContain('（いまログインしている役割）');
    const notes = html.match(/<details class="guide-ko" lang="ko">[\s\S]*?<\/details>/g) ?? [];
    // One note under the intro and under each of the four sections, all closed.
    expect(notes).toHaveLength(5);
    expect(notes.every((note) => !note.includes(' open=""'))).toBe(true);
    let outside = html;
    for (const note of notes) outside = outside.replace(note, '');
    expect(outside).not.toMatch(HANGUL);
    // The wording follows the server: 変更確認 is resumed by 担当者 too; only the hold and the cancellation review are the representative's.
    expect(html).toContain('担当者・代表者が再開する状態');
    expect(html).toContain('保留の解除と取消確認の処理（再開するか、取消で終了するか）は代表者だけが行えます');
    expect(html).toContain('代表者に取消での終了を依頼します');
    expect(html).not.toMatch(/変更確認[^。]*代表者だけ/);
  });

  it('the server rules the copy states: staff resumes a 変更確認; the hold release and the cancellation review resolve refuse staff', async () => {
    expect((await call('staff', `/api/film-supply-orders/${chain.readyId}/hold-release`, { reason: '合成' })).status).toBe(403);
    expect((await call('staff', `/api/film-supply-orders/${chain.readyId}/cancellation-review-resolve`, { reason: '合成', resolution: 'cancel' })).status).toBe(403);
    const resumed = await call('staff', `/api/film-supply-orders/${chain.reviewId}/transitions`, { to: 'ARTWORK_RECEIVED' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  });
});
