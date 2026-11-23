import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  accounts,
  auditEvents,
  createDatabase,
  filmSupplyOrders,
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
import { menuPanel, orderScreen, projectScreen } from './helpers/project-screen.js';
import { withApprovalSnapshot } from './helpers/approval-snapshot.js';

/**
 * Recheck 7 (demo-eml/server-rules-recheck7/RECHECK_REPORT.md) web fixes,
 * against the REAL API on the isolated test database — the same harness as
 * tests/web-ui-batch-d-parity.test.tsx: the web's one API seam (callApi) is
 * routed into the real Hono app, so each assertion compares what the screen
 * offers with what the server then accepts or refuses.
 *
 * - Medium-1 (W1 moved here): a cancelled paper's pending send is never offered
 *   as ③′ (the API answers 409 to both decisions), and no per-event audit read
 *   is made for it.
 * - Medium-3: a cancelled or frozen order with live / unacknowledged paper is
 *   on /maker-po in cleanup-only mode; 「これ以上の作業はありません」 only when no
 *   cleanup is left; the cancellation-review form warns about live paper.
 * - Low-7: the hold wording, the Korean hold-reason refusal in Japanese, and
 *   the 取り消し承認 that blocks a new paper (headline and create form).
 */

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const projectId = uuidv7();
let adminToken = '';
let staffToken = '';
let app: ReturnType<typeof createApp>;
const signedIn = vi.hoisted(() => ({ token: '', role: 'admin' as 'admin' | 'staff', failPaths: new Set<string>(), paths: [] as string[] }));

vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://in-process',
  readSessionToken: async () => signedIn.token,
  readSelectedProjectId: async () => projectId,
  loadSessionUser: async () => ({ id: signedIn.role === 'admin' ? adminId : staffId, role: signedIn.role, displayName: '合成' }),
  loadSession: async () => ({ kind: 'user', user: ({ id: signedIn.role === 'admin' ? adminId : staffId, role: signedIn.role, displayName: '合成' }) }),
  // The real API, in process: the same request the web would send over HTTP.
  callApi: async (apiPath: string, options: { method?: string; body?: unknown } = {}) => {
    // A read the test makes fail (an outage of that one request).
    if (signedIn.failPaths.has(apiPath)) return { ok: false, status: 500, data: null, error: '一時的に取得できません' };
    signedIn.paths.push(apiPath);
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
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
// P4 web2a §0: the order screen (where the forms moved) draws client components that read the router.
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  usePathname: () => '/p/TEST-P/o/x',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const MakerPoPage = projectScreen((await import('../apps/web/src/screens/MakerPoScreen.js')).MakerPoScreen);
const OrdersPage = projectScreen((await import('../apps/web/src/screens/OrdersScreen.js')).OrdersScreen);
const {
  releaseFilmOrderHoldAction,
  resolveCancellationReviewAction,
  transitionFilmSupplyOrderAction
} = await import('../apps/web/src/app/actions.js');
const {
  acknowledgeMakerPoCancellationAction,
  cancelMakerPoAction,
  verifyMakerPoSendAction
} = await import('../apps/web/src/app/maker-po/actions.js');
const {
  CANCELLED_ORDER_CLEANUP_NOTICE,
  CANCELLED_ORDER_NOTICE
} = await import('../apps/web/src/lib/transitions.js');

function signIn(role: 'admin' | 'staff') {
  signedIn.role = role;
  signedIn.token = role === 'admin' ? adminToken : staffToken;
}

let counter = 0;
function nextTag() {
  counter += 1;
  return String(counter).padStart(4, '0');
}

async function call(token: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  const response = await app.request(url, {
    method,
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
const postAs = (token: string, url: string, body: unknown = {}) => call(token, 'POST', url, body);

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  data.set('_kaneiRenderedProjectId', projectId); // P0 R03: the form was drawn for the selected project
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

/** Prerendered so the per-order async sections (event trails) settle, as in batch B/C. */
async function render(page: () => Promise<unknown>): Promise<string> {
  const { prelude } = await prerenderToNodeStream((await page()) as Parameters<typeof prerenderToNodeStream>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replaceAll('<!-- -->', '');
}

async function uploadDocument(input: {
  documentType: string;
  issuerEntity: string;
  designKey?: string;
  orderId?: string;
  sevenPoId?: string;
  makerPoId?: string;
  content?: string;
}) {
  const tag = nextTag();
  const content = input.content ?? `composite recheck7 document bytes ${tag}\n`;
  const response = await postAs(staffToken, `/api/projects/${projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `r7w-doc-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    ...(input.sevenPoId ? { sevenPurchaseOrderId: input.sevenPoId } : {}),
    ...(input.orderId ? { filmSupplyOrderId: input.orderId } : {}),
    ...(input.makerPoId ? { makerPurchaseOrderId: input.makerPoId } : {}),
    ...(input.designKey ? { designKey: input.designKey } : {})
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as unknown as { document: { id: string }; version: { id: string } };
}

/** An order at MAKER_PO_READY through the real chain (checklist, artwork, dual approval). */
async function reachMakerPoReady() {
  const tag = nextTag();
  const sevenPo = await postAs(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, { poNumber: `SEVEN-R7W-${tag}` });
  expect(sevenPo.status).toBe(201);
  const sevenPoId = sevenPo.body.id as string;
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${sevenPoId}/verification-checklist`, {
    issuerNameRecorded: true, issuerName: '合成セブン化学事業', documentNumberRecorded: true,
    documentNumber: `PO-2026-R7W-${tag}`, issueDateRecorded: true, issueDate: '2026-11-15',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル', pastTransactionCompared: true,
    pastTransactionNote: '過去の発注書と様式が一致', quoteCompared: true, quoteMatchesPo: true,
    quoteComparisonNote: '見積と一致', tamperHints: '', uncertain: false,
    confirmationReplyRecorded: false, confirmationReplyNote: '', verificationNote: '合成チェックリスト'
  })).status).toBe(200);
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${sevenPoId}/register-official`, {
    officialRegisteredAt: '2026-11-14T09:00:00.000Z'
  })).status).toBe(200);
  const orderCode = `FSO-R7W-${tag}`;
  const order = await postAs(staffToken, `/api/seven-purchase-orders/${sevenPoId}/supply-orders`, {
    code: orderCode, paymentTerms: 'prepaid',
    lines: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 1000, unit: 'sheets' }]
  });
  expect(order.status).toBe(201);
  const orderId = order.body.id as string;
  // P1 R23: SEVEN_PO_VERIFIED on creation, PROOF_READY and APPROVAL_PENDING on the revision
  for (const to of ['ARTWORK_RECEIVED']) {
    expect((await postAs(staffToken, `/api/film-supply-orders/${orderId}/transitions`, { to })).status).toBe(200);
  }
  const artworkBytes = `composite recheck7 artwork bytes ${tag}\n`;
  const proof = await uploadDocument({
    documentType: 'proof', issuerEntity: 'kanei', designKey: 'label-front', orderId, sevenPoId, content: artworkBytes
  });
  const revision = await postAs(staffToken, `/api/film-supply-orders/${orderId}/artwork-revisions`, {
    designKey: 'label-front', fileDocumentVersionId: proof.version.id
  });
  expect(revision.status).toBe(201);
  for (const organization of ['customer', 'seven'] as const) {
    const identifier = `MSG-R7W-${organization.toUpperCase()}-${nextTag()}`;
    const evidence = await uploadDocument({
      documentType: 'approval_evidence',
      issuerEntity: organization === 'seven' ? 'seven' : 'customer_generated',
      designKey: 'label-front', orderId, sevenPoId,
      content: `composite recheck7 approval evidence\nidentifier: ${identifier}\n`
    });
    expect((await postAs(staffToken, `/api/artwork-revisions/${revision.body.id as string}/approvals`, {
      organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
      evidenceIdentifier: identifier, evidenceDocumentVersionId: evidence.version.id
    })).status).toBe(201);
  }
  expect((await postAs(staffToken, `/api/film-supply-orders/${orderId}/auto-advance`, {})).body.status).toBe('MAKER_PO_READY');
  return { orderId, orderCode, artworkBytes, sevenPoId };
}

/** A maker PO approved by the representative, ready for the send. */
async function approvedPaper(orderId: string) {
  const created = await postAs(adminToken, `/api/film-supply-orders/${orderId}/maker-purchase-orders`, {
    recipientAddress: 'maker-po@example.com'
  });
  expect(created.status).toBe(201);
  const poId = created.body.id as string;
  expect((await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, await withApprovalSnapshot(app, adminToken, poId))).status).toBe(200);
  return poId;
}

/** A header-clean send with no attachment: PENDING_MANUAL_VERIFICATION (M8-HARDEN2 FIX 1). */
async function pendingSend(poId: string, orderCode: string) {
  const sent = await sendMakerPoEmlEvidence((url, body) => postAs(staffToken, url, body), poId, { orderCode });
  const body = sent.body as { verificationStatus: string; event: { id: string } };
  expect(body.verificationStatus).toBe('PENDING_MANUAL_VERIFICATION');
  return body.event.id;
}

async function confirmSend(eventId: string) {
  const confirmed = await postAs(adminToken, `/api/maker-po-events/${eventId}/send-manual-verification`, {
    result: 'confirmed', verifierName: '合成代表者', verifiedAt: new Date().toISOString(),
    reasonNote: 'メーカー宛の送信を原本で確認した'
  });
  expect(confirmed.status).toBe(201);
}

async function orderStatus(orderId: string) {
  const [row] = await db.select({ status: filmSupplyOrders.status }).from(filmSupplyOrders)
    .where(eq(filmSupplyOrders.id, orderId)).limit(1);
  return row?.status as string | undefined;
}

/** The HTML of one order's card on /maker-po (from its heading to the next card). */
function orderCard(html: string, orderCode: string): string {
  const start = html.indexOf(`フィルム発注 ${orderCode}`);
  expect(start, `card of ${orderCode}`).toBeGreaterThan(-1);
  const next = html.indexOf('<h2 class="card-head">', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-ui-recheck7-'));
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
    { id: adminId, username: 'admin_r7w_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者R7', role: 'admin' },
    { id: staffId, username: 'staff_r7w_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者R7', role: 'staff' }
  ]);
  const [customer, seven, maker] = [uuidv7(), uuidv7(), uuidv7()];
  await db.insert(accounts).values([
    { id: customer, name: '合成R7エンドカスタマー', role: 'end_customer', externalCode: 'TEST-R7W-CUST' },
    { id: seven, name: '合成R7セブン', role: 'seven', externalCode: 'TEST-R7W-SEVEN' },
    { id: maker, name: '合成R7メーカー', role: 'maker', externalCode: 'TEST-R7W-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId, code: 'TEST-R7W-PROJECT', name: '合成R7案件', businessUnit: 'F1' as const, route: 'F1' as const,
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

/** A VERIFIED send (the attachment matches the frozen artwork): order MAKER_PO_SENT_MANUALLY. */
async function verifiedSend(poId: string, chain: { orderCode: string; artworkBytes: string }) {
  const sent = await sendMakerPoEmlEvidence((url, body) => postAs(staffToken, url, body), poId, {
    orderCode: chain.orderCode, attachmentBytes: chain.artworkBytes
  });
  expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');
}

async function paperStatus(poId: string) {
  const detail = await call(adminToken, 'GET', `/api/maker-purchase-orders/${poId}`);
  return (detail.body.purchaseOrder as { status: string }).status;
}

/** The order's row in the /orders list (its 操作 cell included). */
function orderRow(html: string, orderCode: string): string {
  const start = html.indexOf(`>${orderCode}<`, html.indexOf('<table'));
  expect(start, `row of ${orderCode}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</tr>', start));
}

/** The 「次にやること」 card. */
function nextCard(html: string): string {
  const start = html.indexOf('<div class="next-card">');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

describe('Medium-1 (W1): a cancelled paper\'s pending send is history, never ③′', () => {
  it('after an internal cancel the ③′ form is gone (the API refuses it), and no per-event audit read is made', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    const eventId = await pendingSend(poId, chain.orderCode);
    signIn('admin');
    // Before the cancel the paper is live: ③′ is the work — at step 9 of the order screen (P4 §0).
    const live = await render(orderScreen(chain.orderCode));
    expect(live).toMatch(/<button type="submit"[^>]*>送信の確認を記録する/);
    expect(live).toContain(`name="eventId" value="${eventId}"`);
    expect(orderCard(await render(MakerPoPage), chain.orderCode)).not.toContain(`name="eventId" value="${eventId}"`);

    const cancelled = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '未確認の送信を訂正' });
    expect(cancelled.body).toMatchObject({ cancellationKind: 'INTERNAL_CANCEL' });
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_READY');

    signedIn.paths.length = 0;
    const card = orderCard(await render(MakerPoPage), chain.orderCode);
    expect(card).not.toContain('手順3の確認: 送信の手動確認（代表者のみ）');
    expect(card).not.toContain(`name="eventId" value="${eventId}"`);
    expect(await render(orderScreen(chain.orderCode))).not.toContain(`name="eventId" value="${eventId}"`);
    expect(card).toContain('は手動確認待ちのまま残っています。取り消し済みの発注書の送信は、確認も却下も記録できません（APIが拒否します）');
    expect(card).toContain('この取り消しは内部の訂正として扱われたため、取り消し承認も不要です。');
    // Info-4: the project audit read was complete, so the event is not asked about by id.
    expect(signedIn.paths.filter((apiPath) => apiPath.includes('entityId='))).toEqual([]);

    // What the screen holds back is what the server refuses — both decisions.
    for (const result of ['confirmed', 'rejected']) {
      const refused = await verifyMakerPoSendAction(null, form({
        eventId, result, verifierName: '合成代表者', verifiedAt: '2026-11-18T21:00:00+09:00', reasonNote: 'メーカー到達を後から確認'
      }));
      expect(refused).toMatchObject({ ok: false, message: '取り消し済みのメーカー発注書の送信は確認できません', messageKo: null, code: null });
    }

    // A replacement paper does not bring A's ③′ back.
    const replacement = await postAs(adminToken, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, { recipientAddress: 'maker-po@example.com' });
    expect(replacement.status).toBe(201);
    const withReplacement = orderCard(await render(MakerPoPage), chain.orderCode);
    expect(withReplacement).not.toContain(`name="eventId" value="${eventId}"`);
    expect(withReplacement).not.toContain('手順3の確認: 送信の手動確認（代表者のみ）');
  });
});

describe('Medium-3: a cancelled order with live maker paper', () => {
  it('review warns before 取消で終了; the board offers the cleanup; 「これ以上の作業はありません」 only after it', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    expect(await orderStatus(chain.orderId)).toBe('APPROVED_FOR_MANUAL_SEND');
    signIn('admin');
    expect((await transitionFilmSupplyOrderAction(null, form({ orderId: chain.orderId, to: 'CANCELLATION_REVIEW' }))).ok).toBe(true);

    // The review form warns that ending the order leaves the paper live — on the order screen (P4 §0).
    const review = await render(orderScreen(chain.orderCode));
    expect(review).toContain('取り消されていないメーカー発注書が1件あります（メーカーが生産する可能性があります）');
    // The board lists the frozen order in cleanup mode — no send form (the API refuses it there).
    const frozenCard = orderCard(await render(MakerPoPage), chain.orderCode);
    expect(frozenCard).toContain('整理だけができます');
    expect(frozenCard).not.toContain('手順3: 送信の記録');
    const sendWhileFrozen = await postAs(staffToken, `/api/maker-purchase-orders/${poId}/send-evidence`, {});
    expect(sendWhileFrozen.status).toBe(409);

    expect(await resolveCancellationReviewAction(null, form({ orderId: chain.orderId, outcome: 'cancel', reason: '顧客都合で取消' })))
      .toMatchObject({ ok: true });
    expect(await orderStatus(chain.orderId)).toBe('CANCELLED');
    // The server left the paper live (P7).
    expect(await paperStatus(poId)).toBe('APPROVED_FOR_MANUAL_SEND');

    const orders = await render(OrdersPage);
    expect(orders).not.toContain(CANCELLED_ORDER_NOTICE);
    expect(nextCard(orders)).toContain('この発注は取消で終了していますが、メーカー発注書の整理が残っています（取り消されていない発注書 1件）');
    // P4 §0: the cleanup is recorded on the order screen's 「その他の操作」.
    expect(nextCard(orders)).toContain(`href="/p/TEST-P/o/${chain.orderCode}"`);
    expect(CANCELLED_ORDER_CLEANUP_NOTICE).toContain('発注の画面の「その他の操作」');
    expect(orders).not.toContain('これ以上の作業はありません');

    const list = orderCard(await render(MakerPoPage), chain.orderCode);
    expect(list).toContain('整理だけができます');
    expect(list).toContain('整理（取り消し・取り消し承認）が残っています。');
    expect(list).not.toContain(`name="poId" value="${poId}"`);
    // The cancellation form itself is in the order screen's 「その他の操作」 (P4 §0).
    const card = menuPanel(await render(orderScreen(chain.orderCode)), 'maker-paper');
    expect(card).toContain(`name="poId" value="${poId}"`);
    expect(card).toContain('この発注は取消で終了しているため、取り消しても発注の状態は変わらず、新しい発注書も作成されません。');
    expect(card).not.toContain('再度開きます');
    expect(list).not.toContain('手順2: 代表承認（代表者のみ）');

    signIn('staff');
    const staffCard = orderCard(await render(MakerPoPage), chain.orderCode);
    expect(staffCard).toContain('整理（発注書の取り消し・取り消し承認）は代表者が行います。');
    expect(staffCard).not.toContain(`name="poId" value="${poId}"`);
    expect(menuPanel(await render(orderScreen(chain.orderCode)), 'maker-paper')).toBe('');

    signIn('admin');
    expect(await cancelMakerPoAction(null, form({ poId, note: '取消終了した発注の整理' }))).toMatchObject({ ok: true });
    expect(await paperStatus(poId)).toBe('CANCELLED');
    expect(await orderStatus(chain.orderId)).toBe('CANCELLED');

    // Nothing is left: the card leaves the board and the plain wording returns.
    expect(await render(MakerPoPage)).not.toContain(`フィルム発注 ${chain.orderCode}`);
    const settled = await render(OrdersPage);
    expect(nextCard(settled)).toContain('この発注は取消で終了しています。これ以上の作業はありません。');
  });

  it('a sent paper on a cancelled order: cancel, then the 取り消し承認 the screen asks for, then nothing is left', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    await verifiedSend(poId, chain);
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_SENT_MANUALLY');
    signIn('admin');
    expect((await transitionFilmSupplyOrderAction(null, form({ orderId: chain.orderId, to: 'CANCELLATION_REVIEW' }))).ok).toBe(true);
    expect(await resolveCancellationReviewAction(null, form({ orderId: chain.orderId, outcome: 'cancel', reason: '顧客都合で取消' })))
      .toMatchObject({ ok: true });

    const sent = menuPanel(await render(orderScreen(chain.orderCode)), 'maker-paper');
    expect(sent).toContain('取り消したあと、メーカーが取り消しを受け入れたことを「取り消し承認（メーカー取消確認）」として記録してください。');
    expect(await cancelMakerPoAction(null, form({ poId, note: '送信ずみの発注書の整理' }))).toMatchObject({ ok: true });

    const owed = menuPanel(await render(orderScreen(chain.orderCode)), 'maker-paper');
    expect(owed).toContain('取り消し承認を記録する（メーカー取消確認・代表者のみ）');
    expect(owed).toContain('この発注は取消で終了しているため新しい発注書は作成しませんが');
    expect(owed).not.toContain('訂正後の発注書を新しく作成する');
    expect(nextCard(await render(OrdersPage))).toContain('取り消し承認が未記録の発注書 1件');

    expect(await acknowledgeMakerPoCancellationAction(null, form({ poId, note: 'メーカーが取り消しを承諾' }))).toMatchObject({ ok: true });
    expect(await render(MakerPoPage)).not.toContain(`フィルム発注 ${chain.orderCode}`);
    expect(nextCard(await render(OrdersPage))).toContain('この発注は取消で終了しています。これ以上の作業はありません。');
  });
});

describe('Low-7: hold wording, hold reason refusals, and the 取り消し承認 that blocks a new paper', () => {
  it('(c) an over-long hold reason: the API\'s Korean refusal is shown in Japanese', async () => {
    const chain = await reachMakerPoReady();
    signIn('admin');
    const tooLong = await transitionFilmSupplyOrderAction(null, form({ orderId: chain.orderId, to: 'ON_HOLD', holdReason: 'あ'.repeat(1001) }));
    expect(tooLong).toMatchObject({ ok: false, message: '保留にする理由は1000字以内で入力してください。' });
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_READY');
  });

  it('(a)(b)(f) a sent paper cancelled on hold: release without the 取り消し承認, then ① asks for it before a new paper', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    await verifiedSend(poId, chain);
    signIn('admin');
    expect((await transitionFilmSupplyOrderAction(null, form({ orderId: chain.orderId, to: 'ON_HOLD', holdReason: '顧客確認待ち' }))).ok).toBe(true);

    // A held order with live paper: cleanup on the board, a link from 次にやること.
    const heldOrders = await render(OrdersPage);
    expect(nextCard(heldOrders)).toContain('解除の前でも、発注の画面の「その他の操作」で取り消し・取り消し承認を記録できます');
    expect(nextCard(heldOrders)).toContain(`href="/p/TEST-P/o/${chain.orderCode}"`);
    // The release form (on the order screen) says where the order resumes.
    const heldPage = await render(orderScreen(chain.orderCode));
    expect(heldPage).toContain('残っている発注書がない場合は「メーカー発注準備完了」（発注書の作成）から再開します');
    expect(orderCard(await render(MakerPoPage), chain.orderCode)).toContain('整理だけができます');

    expect(await cancelMakerPoAction(null, form({ poId, note: '保留中に送信ずみの発注書を取り消す' }))).toMatchObject({ ok: true });
    const heldOwed = menuPanel(await render(orderScreen(chain.orderCode)), 'maker-paper');
    expect(heldOwed).toContain('保留・見直し中でも記録できます');

    // (a) the server does not ask for the 取り消し承認 before the release.
    expect(await releaseFilmOrderHoldAction(null, form({ orderId: chain.orderId, reason: '顧客の確認が取れた' }))).toMatchObject({ ok: true });
    // (b) no live paper left: back to MAKER_PO_READY, not the maker step the hold left.
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_READY');

    // (f) the screen does not offer the create form for this order; the server refuses it.
    const page = await render(MakerPoPage);
    expect(page).not.toContain(`<option value="${chain.orderId}"`);
    expect(page).toContain(`${chain.orderCode}: 送信ずみのまま取り消した発注書の「取り消し承認（メーカー取消確認）」がまだ記録されていないため`);
    expect(orderCard(page, chain.orderCode)).toContain('取り消し済み（取り消し承認の記録待ち。新しい発注書はその後に作成）');
    const refused = await postAs(adminToken, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, { recipientAddress: 'maker-po@example.com' });
    expect(refused.body).toMatchObject({ code: 'MAKER_PO_CANCELLATION_ACK_REQUIRED' });

    expect(await acknowledgeMakerPoCancellationAction(null, form({ poId, note: 'メーカーが取り消しを承諾' }))).toMatchObject({ ok: true });
    const reopened = await render(MakerPoPage);
    // P4 §0: the paper is drawn up at step 7 of the order screen; the list links it.
    expect(reopened).toContain(`href="/p/TEST-P/o/${chain.orderCode}?step=7"`);
    expect(orderCard(reopened, chain.orderCode)).toContain('取り消し済み（新しい発注書の作成待ち）');
    const created = await postAs(adminToken, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, { recipientAddress: 'maker-po@example.com' });
    expect(created.status).toBe(201);
  });
});
