import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  accounts,
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
 * Recheck 8 (demo-eml/server-rules-recheck8/RECHECK_REPORT.md) web fixes,
 * against the REAL API on the isolated test database — the same harness as
 * tests/web-ui-recheck8-parity.test.tsx (callApi routed into the real Hono app).
 *
 * - Medium-B (W1, W2): a record-only post-delivery confirmation is never shown
 *   as 「送信ずみ…取り消し承認」; decision (a) has its own admin-only form, and
 *   the action reports the kind and the live-replacement warning the API answers.
 * - Low-5: the artwork revision form does not offer an order with live maker
 *   paper, and the 409 is explained in Japanese with the real way out.
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
const ApprovalsPage = projectScreen((await import('../apps/web/src/screens/ApprovalsScreen.js')).ApprovalsScreen);
const { registerArtworkRevisionAction } = await import('../apps/web/src/app/actions.js');
const {
  acknowledgeMakerPoCancellationAction,
  cancelMakerPoAction
} = await import('../apps/web/src/app/maker-po/actions.js');
const { ARTWORK_REVISION_LIVE_PAPER_REFUSAL } = await import('../apps/web/src/lib/maker-po-data.js');

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
  const content = input.content ?? `composite recheck8 document bytes ${tag}\n`;
  const response = await postAs(staffToken, `/api/projects/${projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `r8w-doc-${tag}.txt`,
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
  const sevenPo = await postAs(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, { poNumber: `SEVEN-R8W-${tag}` });
  expect(sevenPo.status).toBe(201);
  const sevenPoId = sevenPo.body.id as string;
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${sevenPoId}/verification-checklist`, {
    issuerNameRecorded: true, issuerName: '合成セブン化学事業', documentNumberRecorded: true,
    documentNumber: `PO-2026-R8W-${tag}`, issueDateRecorded: true, issueDate: '2026-11-15',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル', pastTransactionCompared: true,
    pastTransactionNote: '過去の発注書と様式が一致', quoteCompared: true, quoteMatchesPo: true,
    quoteComparisonNote: '見積と一致', tamperHints: '', uncertain: false,
    confirmationReplyRecorded: false, confirmationReplyNote: '', verificationNote: '合成チェックリスト'
  })).status).toBe(200);
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${sevenPoId}/register-official`, {
    officialRegisteredAt: '2026-11-14T09:00:00.000Z'
  })).status).toBe(200);
  const orderCode = `FSO-R8W-${tag}`;
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
  const artworkBytes = `composite recheck8 artwork bytes ${tag}\n`;
  const proof = await uploadDocument({
    documentType: 'proof', issuerEntity: 'kanei', designKey: 'label-front', orderId, sevenPoId, content: artworkBytes
  });
  const revision = await postAs(staffToken, `/api/film-supply-orders/${orderId}/artwork-revisions`, {
    designKey: 'label-front', fileDocumentVersionId: proof.version.id
  });
  expect(revision.status).toBe(201);
  for (const organization of ['customer', 'seven'] as const) {
    const identifier = `MSG-R8W-${organization.toUpperCase()}-${nextTag()}`;
    const evidence = await uploadDocument({
      documentType: 'approval_evidence',
      issuerEntity: organization === 'seven' ? 'seven' : 'customer_generated',
      designKey: 'label-front', orderId, sevenPoId,
      content: `composite recheck8 approval evidence\nidentifier: ${identifier}\n`
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
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-ui-recheck8-'));
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
    { id: adminId, username: 'admin_r8w_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者R8', role: 'admin' },
    { id: staffId, username: 'staff_r8w_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者R8', role: 'staff' }
  ]);
  const [customer, seven, maker] = [uuidv7(), uuidv7(), uuidv7()];
  await db.insert(accounts).values([
    { id: customer, name: '合成R8エンドカスタマー', role: 'end_customer', externalCode: 'TEST-R8W-CUST' },
    { id: seven, name: '合成R8セブン', role: 'seven', externalCode: 'TEST-R8W-SEVEN' },
    { id: maker, name: '合成R8メーカー', role: 'maker', externalCode: 'TEST-R8W-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId, code: 'TEST-R8W-PROJECT', name: '合成R8案件', businessUnit: 'F1' as const, route: 'F1' as const,
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

/** The admin-only cleanup zone of a card (the 取り消し details). */
/**
 * P4 web2a §0: what the representative reads and records about one order's maker paper — the
 * read-only list card plus the order screen's 「その他の操作」 panel where the forms are now.
 */
async function paperView(orderCode: string): Promise<string> {
  return `${orderCard(await render(MakerPoPage), orderCode)}\n${menuPanel(await render(orderScreen(orderCode)), 'maker-paper')}`;
}

function dangerZone(card: string): string {
  // The forms are in the order screen's panel (the second half of paperView).
  const start = card.indexOf('data-menu-panel="maker-paper"');
  return start === -1 ? '' : card.slice(start);
}

/** The 「校正ゲラの版を登録する」 card of /approvals. */
function revisionCard(html: string): string {
  const start = html.indexOf('校正ゲラの版を登録する');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('承認の記録履歴', start));
}

describe('Medium-B (W2): an internal cancel that reached the maker — decision (a)', () => {
  it('the screen offers the record-only form (admin only), the API records POST_DELIVERY_CONFIRMATION, the card never says 送信ずみ', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    await pendingSend(poId, chain.orderCode);
    const cancelled = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '未確認の送信を訂正' });
    expect(cancelled.body).toMatchObject({ cancellationKind: 'INTERNAL_CANCEL' });

    signIn('admin');
    const before = await paperView(chain.orderCode);
    expect(before).toContain('メーカー到達の事後確認を記録する（記録のみ・代表者のみ）');
    expect(before).toContain('下の「メーカー到達の事後確認を記録する（記録のみ）」で記録できます');
    expect(before).not.toContain('この画面に記録する手段はありません');
    // The 取り消し承認 form is not offered: nothing proves the send.
    expect(before).not.toContain('取り消し承認を記録する（メーカー取消確認・代表者のみ）');
    expect(dangerZone(before)).toContain(`name="poId" value="${poId}"`);

    signIn('staff');
    const staffCard = await paperView(chain.orderCode);
    expect(staffCard).not.toContain('メーカー到達の事後確認を記録する（記録のみ・代表者のみ）');
    expect(staffCard).toContain('代表者が「メーカー到達の事後確認（記録のみ）」を記録します');

    signIn('admin');
    const recorded = await acknowledgeMakerPoCancellationAction(null, form({ poId, note: 'メーカーから受信済みと連絡があった' }));
    expect(recorded).toEqual({
      ok: true,
      changedId: expect.any(String),
      message: 'メーカー到達の事後確認を記録しました（記録のみ。発注の状態と新しい発注書の作成可否は変わりません）。'
    });
    // Contract: record only — the order keeps its step.
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_READY');

    const after = await paperView(chain.orderCode);
    expect(after).toContain('メーカー到達の事後確認（記録のみ）: 記録済み');
    expect(after).toContain('この記録は事実を残すだけで、取り消し承認ではありません。');
    expect(after).not.toContain('送信ずみの発注書の取消に対する取り消し承認は記録済みです');
    expect(after).not.toContain('取り消し承認（メーカー取消確認）: 記録済み');
    expect(after).not.toContain('メーカー到達の事後確認を記録する（記録のみ・代表者のみ）');
    expect(after).toContain('「メーカー到達の事後確認（記録のみ）」は記録済みです。');
    // The create form still offers this order (the record lifted no gate, and none was needed).
    // P4 §0: the paper is drawn up at step 7 of the order screen; the list links it.
    expect(await render(MakerPoPage)).toContain(`href="/p/TEST-P/o/${chain.orderCode}?step=7"`);

    // The API takes it once; the screen no longer offers it.
    const again = await acknowledgeMakerPoCancellationAction(null, form({ poId, note: '二重の記録' }));
    expect(again.ok).toBe(false);
  });

  it('with a live replacement paper the action relays the API\'s warning', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    await pendingSend(poId, chain.orderCode);
    expect((await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '未確認の送信を訂正' })).status).toBe(200);
    const replacement = await postAs(adminToken, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, { recipientAddress: 'maker-po@example.com' });
    expect(replacement.status).toBe(201);

    signIn('admin');
    const card = await paperView(chain.orderCode);
    expect(card).toContain('訂正後の発注書がすでにある場合は、メーカーが二重に生産しないよう');
    const recorded = await acknowledgeMakerPoCancellationAction(null, form({ poId, note: 'メーカーに届いていた' }));
    expect(recorded.ok).toBe(true);
    expect(recorded.message).toContain('メーカー到達の事後確認を記録しました');
    expect(recorded.message).toContain('注意: この発注には取り消されていない別の発注書（訂正後の発注書）があります。');
  });
});

describe('Medium-B: decision (a) after the replacement is in production', () => {
  it('the internally cancelled paper keeps its record-only form past acceptance; the API warns about the live replacement', async () => {
    const chain = await reachMakerPoReady();
    const first = await approvedPaper(chain.orderId);
    await pendingSend(first, chain.orderCode);
    expect((await postAs(adminToken, `/api/maker-purchase-orders/${first}/cancel`, { note: '未確認の送信を訂正' })).body)
      .toMatchObject({ cancellationKind: 'INTERNAL_CANCEL' });
    const second = await approvedPaper(chain.orderId);
    await verifiedSend(second, chain);
    const acceptEvidence = await uploadDocument({
      documentType: 'acceptance_evidence', issuerEntity: 'kanei', orderId: chain.orderId, sevenPoId: chain.sevenPoId, makerPoId: second,
      content: 'composite recheck8 acceptance evidence\n'
    });
    expect((await postAs(adminToken, `/api/documents/${acceptEvidence.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
    expect((await postAs(adminToken, `/api/maker-purchase-orders/${second}/accept-evidence`, {
      evidenceDocumentVersionId: acceptEvidence.version.id, acceptedAt: '2026-11-18T12:00:00.000Z'
    })).status).toBe(200);
    expect((await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'FILM_IN_PRODUCTION' })).status).toBe(200);

    signIn('admin');
    const card = await paperView(chain.orderCode);
    expect(card).toContain('メーカー発注の紙は受入済みです');
    expect(card).toContain('メーカー到達の事後確認を記録する（記録のみ・代表者のみ）');
    expect(dangerZone(card)).toContain(`name="poId" value="${first}"`);
    // Past acceptance nothing else is offered there: no cancel of the accepted paper.
    expect(dangerZone(card)).not.toContain(`name="poId" value="${second}"`);

    const recorded = await acknowledgeMakerPoCancellationAction(null, form({ poId: first, note: '生産開始後にメーカーへ届いていたと判明' }));
    expect(recorded.ok).toBe(true);
    expect(recorded.message).toContain('注意: この発注には取り消されていない別の発注書（訂正後の発注書）があります。');
    expect(await orderStatus(chain.orderId)).toBe('FILM_IN_PRODUCTION');
    expect(await paperView(chain.orderCode)).toContain('メーカー到達の事後確認（記録のみ）: 記録済み');
  });
});

describe('Medium-B (W1): a never-sent paper is never shown as 送信ずみ', () => {
  it('no decision (a) form without a send record; any record the API keeps is not called a 取り消し承認', async () => {
    const chain = await reachMakerPoReady();
    const created = await postAs(adminToken, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, { recipientAddress: 'maker-po@example.com' });
    expect(created.status).toBe(201);
    const poId = created.body.id as string;
    expect((await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '下書きを訂正' })).body)
      .toMatchObject({ cancellationKind: 'INTERNAL_CANCEL' });

    signIn('admin');
    const before = await paperView(chain.orderCode);
    expect(before).not.toContain('メーカー到達の事後確認を記録する（記録のみ・代表者のみ）');
    expect(before).not.toContain('取り消し承認を記録する（メーカー取消確認・代表者のみ）');

    // Recheck 8 Low-4: the server may refuse this record for unsent paper; while it
    // takes it, the screen must say what it is.
    const direct = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, { note: '直接記録' });
    if (direct.status === 201) {
      expect(direct.body).toMatchObject({ acknowledgementKind: 'POST_DELIVERY_CONFIRMATION' });
      const card = await paperView(chain.orderCode);
      expect(card).toContain('メーカー到達の事後確認（記録のみ）: 記録済み');
      expect(card).not.toContain('送信ずみの発注書の取消に対する取り消し承認は記録済みです');
      expect(card).not.toContain('次のアクション: 訂正後の発注書を新しく作成してください（「手順1: 発注書の作成」のフォームから）');
    } else {
      expect(direct.status).toBe(422);
    }
  });
});

describe('Medium-B: the 取り消し承認 of a proven send keeps its meaning', () => {
  it('the action says 取り消し承認, and the card says 送信ずみ…記録済み', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    await verifiedSend(poId, chain);
    expect((await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '送信ずみを訂正' })).body)
      .toMatchObject({ cancellationKind: 'MAKER_PO_CANCELLED' });
    signIn('admin');
    const owed = await paperView(chain.orderCode);
    expect(owed).toContain('取り消し承認を記録する（メーカー取消確認・代表者のみ）');
    expect(owed).not.toContain('メーカー到達の事後確認を記録する（記録のみ・代表者のみ）');
    expect(await acknowledgeMakerPoCancellationAction(null, form({ poId, note: 'メーカーが取り消しを承諾' })))
      .toEqual({ ok: true, message: '取り消し承認を記録しました。', changedId: expect.any(String) });
    const after = await paperView(chain.orderCode);
    expect(after).toContain('取り消し承認（メーカー取消確認）: 記録済み');
    expect(after).toContain('送信ずみの発注書の取消に対する取り消し承認は記録済みです。');
  });
});

describe('Low-5: an order with live maker paper is not a revision choice', () => {
  it('the form leaves it out and names it; the 409 is told in Japanese; after the cancel it is offered', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    signIn('staff');
    // P4 §0: the 版 of a design change is registered from the order screen's 「その他の操作」 — with live paper it names it instead.
    const blocked = menuPanel(await render(orderScreen(chain.orderCode)), 'design-change');
    expect(blocked).not.toContain('<form');
    expect(blocked).toContain('取り消されていないメーカー発注書（');
    expect(blocked).toContain(ARTWORK_REVISION_LIVE_PAPER_REFUSAL);

    // A submit anyway (a stale page): the API's 409, said with the real way out.
    const refused = await registerArtworkRevisionAction(null, form({
      orderId: chain.orderId, designKey: 'label-front', fileDocumentVersionId: uuidv7()
    }));
    expect(refused).toMatchObject({ ok: false, message: ARTWORK_REVISION_LIVE_PAPER_REFUSAL });
    const direct = await postAs(staffToken, `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, {
      designKey: 'label-front', fileDocumentVersionId: uuidv7()
    });
    expect(direct.body).toMatchObject({ code: 'MAKER_PO_ACTIVE_ARTWORK_REVISION_BLOCKED' });

    signIn('admin');
    expect(await cancelMakerPoAction(null, form({ poId, note: '原稿を差し替えるため取り消す' }))).toMatchObject({ ok: true });
    signIn('staff');
    const open = menuPanel(await render(orderScreen(chain.orderCode)), 'design-change');
    expect(open).toContain(`name="orderId"`);
    expect(open).toMatch(/<button type="submit"[^>]*>版を登録する（変更依頼）/);
  });
});
