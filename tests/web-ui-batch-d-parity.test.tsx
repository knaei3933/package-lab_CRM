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
import { orderScreen, projectScreen } from './helpers/project-screen.js';
import { withApprovalSnapshot } from './helpers/approval-snapshot.js';

/**
 * UI batch D — recheck 6 (demo-eml/server-rules-recheck6/RECHECK_REPORT.md)
 * against the REAL API on the isolated test database.
 *
 * The web screens are rendered with their one API seam (lib/api.ts callApi)
 * routed into the real Hono app, signed in as the representative or staff, so
 * every assertion compares what the screen offers with what the server then
 * accepts or refuses:
 *
 * - High-A: a send confirmed by the representative's manual verification is a
 *   proven send for the API (cancel → MAKER_PO_CANCELLED, create → 422 until
 *   the 取り消し承認). The screen must say 送信ずみ in the cancel box and the
 *   dialog, and render the 取り消し承認 form after the cancel.
 * - Low-6: the 取り消し承認 evidence select offers only versions bound to the
 *   same order AND maker PO; an unbound version of the same order is refused by
 *   the API (422 MAKER_CANCELLATION_ACK_EVIDENCE_MISMATCH).
 * - Hold release / cancellation review: the generic transition form offers no
 *   target (the API refuses them); the dedicated admin-only forms post to the
 *   dedicated endpoints with the required reason; CANCELLED shows its badge.
 */

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

const adminId = uuidv7();
const staffId = uuidv7();
const projectId = uuidv7();
let adminToken = '';
let staffToken = '';
let app: ReturnType<typeof createApp>;
const signedIn = vi.hoisted(() => ({ token: '', role: 'admin' as 'admin' | 'staff', failPaths: new Set<string>() }));

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
/** P4 web2a §0: the order screen of one order — the maker paper's cancellation forms are in its 「その他の操作」. */
const orderPage = (orderCode: string) => render(orderScreen(orderCode));
/** The markup of one 「その他の操作」 panel of the order screen. */
function menuPanel(html: string, key: string): string {
  const start = html.indexOf(`data-menu-panel="${key}"`);
  expect(start, `panel ${key}`).toBeGreaterThan(-1);
  const end = html.indexOf('data-menu-panel="', start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}
const {
  makerPoSendProof,
  sendManualVerificationsFromAuditEvents
} = await import('../apps/web/src/lib/maker-po-data.js');
const {
  releaseFilmOrderHoldAction,
  resolveCancellationReviewAction,
  transitionFilmSupplyOrderAction
} = await import('../apps/web/src/app/actions.js');

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
  const content = input.content ?? `composite batch-d document bytes ${tag}\n`;
  const response = await postAs(staffToken, `/api/projects/${projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `batchd-doc-${tag}.txt`,
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
  const sevenPo = await postAs(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, { poNumber: `SEVEN-BD-${tag}` });
  expect(sevenPo.status).toBe(201);
  const sevenPoId = sevenPo.body.id as string;
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${sevenPoId}/verification-checklist`, {
    issuerNameRecorded: true, issuerName: '合成セブン化学事業', documentNumberRecorded: true,
    documentNumber: `PO-2026-BD-${tag}`, issueDateRecorded: true, issueDate: '2026-11-15',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル', pastTransactionCompared: true,
    pastTransactionNote: '過去の発注書と様式が一致', quoteCompared: true, quoteMatchesPo: true,
    quoteComparisonNote: '見積と一致', tamperHints: '', uncertain: false,
    confirmationReplyRecorded: false, confirmationReplyNote: '', verificationNote: '合成チェックリスト'
  })).status).toBe(200);
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${sevenPoId}/register-official`, {
    officialRegisteredAt: '2026-11-14T09:00:00.000Z'
  })).status).toBe(200);
  const orderCode = `FSO-BD-${tag}`;
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
  const artworkBytes = `composite batch-d artwork bytes ${tag}\n`;
  const proof = await uploadDocument({
    documentType: 'proof', issuerEntity: 'kanei', designKey: 'label-front', orderId, sevenPoId, content: artworkBytes
  });
  const revision = await postAs(staffToken, `/api/film-supply-orders/${orderId}/artwork-revisions`, {
    designKey: 'label-front', fileDocumentVersionId: proof.version.id
  });
  expect(revision.status).toBe(201);
  for (const organization of ['customer', 'seven'] as const) {
    const identifier = `MSG-BD-${organization.toUpperCase()}-${nextTag()}`;
    const evidence = await uploadDocument({
      documentType: 'approval_evidence',
      issuerEntity: organization === 'seven' ? 'seven' : 'customer_generated',
      designKey: 'label-front', orderId, sevenPoId,
      content: `composite batch-d approval evidence\nidentifier: ${identifier}\n`
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

/** The web's proof for one paper, from the API answers the screen reads. */
async function webProof(poId: string) {
  const detail = await call(adminToken, 'GET', `/api/maker-purchase-orders/${poId}`);
  const audit = await call(adminToken, 'GET', `/api/projects/${projectId}/audit-history?entityType=maker_po_event&limit=200`);
  return makerPoSendProof(
    detail.body.events as Parameters<typeof makerPoSendProof>[0],
    sendManualVerificationsFromAuditEvents(audit.body.events as Parameters<typeof sendManualVerificationsFromAuditEvents>[0])
  );
}

/** The HTML of one order's card on /maker-po (from its heading to the next card). */
function orderCard(html: string, orderCode: string): string {
  const start = html.indexOf(`フィルム発注 ${orderCode}`);
  expect(start, `card of ${orderCode}`).toBeGreaterThan(-1);
  const next = html.indexOf('<h2 class="card-head">', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-ui-batch-d-'));
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
    { id: adminId, username: 'admin_bd_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者BD', role: 'admin' },
    { id: staffId, username: 'staff_bd_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者BD', role: 'staff' }
  ]);
  const [customer, seven, maker] = [uuidv7(), uuidv7(), uuidv7()];
  await db.insert(accounts).values([
    { id: customer, name: '合成BDエンドカスタマー', role: 'end_customer', externalCode: 'TEST-BD-CUST' },
    { id: seven, name: '合成BDセブン', role: 'seven', externalCode: 'TEST-BD-SEVEN' },
    { id: maker, name: '合成BDメーカー', role: 'maker', externalCode: 'TEST-BD-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId, code: 'TEST-BD-PROJECT', name: '合成BD案件', businessUnit: 'F1' as const, route: 'F1' as const,
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

describe('High-A: a manually confirmed send is a proven send on the screen, as on the server', () => {
  it('cancel box and dialog say 送信ずみ; after the cancel the 取り消し承認 form is there and works', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    const eventId = await pendingSend(poId, chain.orderCode);
    await confirmSend(eventId);
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_SENT_MANUALLY');
    expect(await webProof(poId)).toBe('proven');

    // Low-6 fixtures: a verified acceptance evidence bound to this paper (the
    // only valid citation), the same but unverified, and one bound only to the order.
    const bound = await uploadDocument({ documentType: 'acceptance_evidence', issuerEntity: 'maker', orderId: chain.orderId, sevenPoId: chain.sevenPoId, makerPoId: poId });
    expect((await postAs(adminToken, `/api/documents/${bound.document.id}/verify`, { verificationStatus: 'verified' })).status).toBe(200);
    const boundUnverified = await uploadDocument({ documentType: 'acceptance_evidence', issuerEntity: 'maker', orderId: chain.orderId, sevenPoId: chain.sevenPoId, makerPoId: poId });
    const unbound = await uploadDocument({ documentType: 'proof', issuerEntity: 'maker', orderId: chain.orderId, sevenPoId: chain.sevenPoId, designKey: 'label-back' });

    signIn('admin');
    const before = orderCard(await render(MakerPoPage), chain.orderCode);
    expect(before).toContain('この発注書の送信状態: </strong>送信ずみ（送信証跡の確認、または代表者による送信の手動確認があります）');
    expect(before).not.toContain('未送信');
    // The cancel box and its dialog are on the order screen now (P4 §0).
    expect(await orderPage(chain.orderCode)).toContain('この発注書は送信ずみです（送信証跡の確認、または送信の手動確認の記録があります）');

    const cancelled = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '送信済み発注の訂正' });
    expect(cancelled.status).toBe(200);
    // The server's own classification of the same paper.
    expect(cancelled.body).toMatchObject({ cancellationKind: 'MAKER_PO_CANCELLED', newMakerPoRequiresCancellationAcknowledgement: true });
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_SENT_MANUALLY');
    expect(await webProof(poId)).toBe('proven');

    // The list says the acknowledgement is owed and links the order screen, where it is recorded (P4 §0).
    expect(orderCard(await render(MakerPoPage), chain.orderCode)).toContain('送信ずみで取り消した発注書の取り消し承認が未記録です。');
    const after = menuPanel(await orderPage(chain.orderCode), 'maker-paper');
    expect(after).toContain('取り消し承認を記録する（メーカー取消確認・代表者のみ）');
    expect(after).toContain(`name="poId" value="${poId}"`);
    // Low-6: only the version bound to this paper is offered.
    expect(after).toContain(`value="${bound.version.id}"`);
    expect(after).not.toContain(`value="${unbound.version.id}"`);
    expect(after).not.toContain(`value="${boundUnverified.version.id}"`);

    // What the screen held back is what the server refuses, and vice versa.
    const replacementBeforeAck = await postAs(adminToken, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, { recipientAddress: 'maker-po@example.com' });
    expect(replacementBeforeAck.status).toBe(422);
    expect(replacementBeforeAck.body).toMatchObject({ code: 'MAKER_PO_CANCELLATION_ACK_REQUIRED' });
    const unboundAck = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'メーカーが取り消しを承諾', evidenceDocumentVersionId: unbound.version.id
    });
    expect(unboundAck.status).toBe(422);
    expect(unboundAck.body).toMatchObject({ code: 'MAKER_CANCELLATION_ACK_EVIDENCE_MISMATCH' });
    const boundAck = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, {
      note: 'メーカーが取り消しを承諾', evidenceDocumentVersionId: bound.version.id
    });
    expect(boundAck.status).toBe(201);
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_READY');

    const recorded = orderCard(await render(MakerPoPage), chain.orderCode);
    expect(recorded).toContain('取り消し承認（メーカー取消確認）: 記録済み');
    expect(recorded).not.toContain('取り消し承認を記録する（メーカー取消確認・代表者のみ）');
    expect(await orderPage(chain.orderCode)).not.toContain('取り消し承認を記録する（メーカー取消確認・代表者のみ）');
  });

  it('a send still waiting for the manual check is not proven: the box warns, the API cancels internally', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    await pendingSend(poId, chain.orderCode);
    expect(await webProof(poId)).toBe('unproven');

    signIn('admin');
    expect(orderCard(await render(MakerPoPage), chain.orderCode)).toContain('送信は記録されていますが、まだ確認されていません（手動確認待ち）');
    const card = await orderPage(chain.orderCode);
    expect(card).toContain('送信は記録されていますが、まだ確認されていません（手動確認待ち）');
    expect(card).toContain('取り消す前に送信の手動確認を記録してください');

    const cancelled = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '未確認の送信を訂正' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ cancellationKind: 'INTERNAL_CANCEL' });
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_READY');
    expect(orderCard(await render(MakerPoPage), chain.orderCode)).not.toContain('取り消し承認を記録する');
    expect(await orderPage(chain.orderCode)).not.toContain('取り消し承認を記録する');
  });

  it('a VERIFIED send stays proven (unchanged rule) and an unsent paper says 未送信', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    signIn('admin');
    const unsent = orderCard(await render(MakerPoPage), chain.orderCode);
    expect(unsent).toContain('未送信（送信証跡の確認も、送信の手動確認もありません）');

    const sent = await sendMakerPoEmlEvidence((url, body) => postAs(staffToken, url, body), poId, {
      orderCode: chain.orderCode, attachmentBytes: chain.artworkBytes
    });
    expect((sent.body as { verificationStatus: string }).verificationStatus).toBe('VERIFIED');
    expect(await webProof(poId)).toBe('proven');
    const cancelled = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '訂正' });
    expect(cancelled.body).toMatchObject({ cancellationKind: 'MAKER_PO_CANCELLED' });
    const after = await orderPage(chain.orderCode);
    expect(after).toContain('取り消し承認を記録する（メーカー取消確認・代表者のみ）');
    // No document is bound to this paper: the select is replaced by the guidance.
    expect(after).toContain('引用できる書類はありません（証跡は任意です）');

    // Review M1: the paper's own event read fails — the screen must not fall
    // back to "unsent" and hide the acknowledgement the server still requires.
    signedIn.failPaths.add(`/api/maker-purchase-orders/${poId}`);
    try {
      const outage = orderCard(await render(MakerPoPage), chain.orderCode);
      expect(outage).toContain('一時的に取得できません');
      const outageOrder = await orderPage(chain.orderCode);
      expect(outageOrder).toContain('取り消し承認を記録する（メーカー取消確認・代表者のみ）');
      expect(outageOrder).toContain('この発注書の送信の記録を読み込めなかったため');
    } finally {
      signedIn.failPaths.clear();
    }
    const replacement = await postAs(adminToken, `/api/film-supply-orders/${chain.orderId}/maker-purchase-orders`, { recipientAddress: 'maker-po@example.com' });
    expect(replacement.body).toMatchObject({ code: 'MAKER_PO_CANCELLATION_ACK_REQUIRED' });
  });
});

describe('hold release and cancellation review: dedicated admin forms, real endpoints', () => {
  it('hold: the transition form asks for the reason; release is the representative\'s, back to the origin', async () => {
    const chain = await reachMakerPoReady();
    signIn('admin');
    const noReason = await transitionFilmSupplyOrderAction(null, form({ orderId: chain.orderId, to: 'ON_HOLD' }));
    expect(noReason).toEqual({ ok: false, message: '保留にする理由は必須です。' });
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_READY');
    const held = await transitionFilmSupplyOrderAction(null, form({ orderId: chain.orderId, to: 'ON_HOLD', holdReason: '顧客確認待ち' }));
    expect(held.ok).toBe(true);
    expect(await orderStatus(chain.orderId)).toBe('ON_HOLD');

    // P4 §0: the release is the order screen's panel form (the list only reads).
    const adminHtml = await orderPage(chain.orderCode);
    expect(adminHtml).toMatch(/<button type="submit"[^>]*>保留を解除する/);
    expect(adminHtml).toContain('顧客確認待ち');
    // No generic resume target is offered for a hold any more.
    expect(adminHtml).not.toContain('<optgroup label="再開する状態"');
    expect(await render(OrdersPage)).not.toMatch(/<button type="submit"[^>]*>保留を解除する/);

    signIn('staff');
    const staffHtml = await orderPage(chain.orderCode);
    // Staff read who releases it (相手待ち), no form.
    expect(staffHtml).toContain('（保留の解除は代表）');
    expect(staffHtml).not.toMatch(/<button type="submit"[^>]*>保留を解除する/);
    const staffRelease = await releaseFilmOrderHoldAction(null, form({ orderId: chain.orderId, reason: '担当者' }));
    expect(staffRelease.ok).toBe(false);
    expect(await orderStatus(chain.orderId)).toBe('ON_HOLD');

    signIn('admin');
    expect(await releaseFilmOrderHoldAction(null, form({ orderId: chain.orderId, reason: '' })))
      .toEqual({ ok: false, message: '保留解除の理由は必須です。' });
    expect(await releaseFilmOrderHoldAction(null, form({ orderId: chain.orderId, reason: '顧客の確認が取れた' })))
      .toMatchObject({ ok: true });
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_READY');
    // The list replays FILM_SUPPLY_ORDER_HOLD_RELEASED: the row no longer reads 保留中.
    const releasedHtml = await render(OrdersPage);
    const row = releasedHtml.slice(releasedHtml.indexOf(`>${chain.orderCode}<`), releasedHtml.indexOf('</tr>', releasedHtml.indexOf(`>${chain.orderCode}<`)));
    expect(row).toContain('メーカー発注準備完了');
    expect(row).not.toContain('保留中');
    expect(row).not.toContain('保留を解除する（代表者のみ）');
  });

  it('cancellation review: resume returns to the origin; cancel ends it with the ✕ 取消済 badge', async () => {
    const chain = await reachMakerPoReady();
    signIn('admin');
    expect((await transitionFilmSupplyOrderAction(null, form({ orderId: chain.orderId, to: 'CANCELLATION_REVIEW' }))).ok).toBe(true);
    const reviewHtml = await orderPage(chain.orderCode);
    expect(reviewHtml).toMatch(/<button type="submit"[^>]*>取消確認を処理する/);
    expect(reviewHtml).toContain('<option value="resume">再開する（取消確認前の状態に戻す）</option>');
    expect(reviewHtml).toContain('<option value="cancel">取消で終了する（取消済・元に戻せません）</option>');

    expect(await resolveCancellationReviewAction(null, form({ orderId: chain.orderId, outcome: 'maybe', reason: 'x' })))
      .toEqual({ ok: false, message: '処理（再開する／取消で終了する）を選択してください。' });
    expect(await resolveCancellationReviewAction(null, form({ orderId: chain.orderId, outcome: 'resume', reason: '取消を見送る' })))
      .toMatchObject({ ok: true });
    expect(await orderStatus(chain.orderId)).toBe('MAKER_PO_READY');

    expect((await transitionFilmSupplyOrderAction(null, form({ orderId: chain.orderId, to: 'CANCELLATION_REVIEW' }))).ok).toBe(true);
    expect(await resolveCancellationReviewAction(null, form({ orderId: chain.orderId, outcome: 'cancel', reason: '顧客都合で取消' })))
      .toMatchObject({ ok: true });
    expect(await orderStatus(chain.orderId)).toBe('CANCELLED');

    const cancelledHtml = await render(OrdersPage);
    const badge = /<span class="status-badge status-badge--(\w+)"><span class="status-badge-mark" aria-hidden="true">(.)<\/span>([^<]*)<\/span>/g;
    const badges = [...cancelledHtml.matchAll(badge)].map((match) => [match[1], match[2], match[3]]);
    expect(badges, cancelledHtml.slice(cancelledHtml.indexOf('<table'), cancelledHtml.indexOf('<table') + 1500)).toContainEqual(['blocked', '✕', '取消済']);
    expect(cancelledHtml).toContain('この発注は取消で終了しました（取消済）。段階は進みません。');
    // P4 §0: the order screen says it is over (the list's transition cell is gone).
    expect(await orderPage(chain.orderCode)).toContain('この発注は取消で終了しました。これ以上の手順はありません。');
    // The terminal state really is terminal on the server.
    const reopen = await postAs(adminToken, `/api/film-supply-orders/${chain.orderId}/transitions`, { to: 'DRAFT' });
    expect(reopen.status).toBe(409);
  });
});

describe('High-A: a busy project — the confirmation lies past the capped audit window', () => {
  it('the per-event read still finds the confirmation: 送信ずみ, never 未送信; ③′ is not offered again', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    const eventId = await pendingSend(poId, chain.orderCode);
    await confirmSend(eventId);
    // 210 older maker_po_event audit rows fill the page's 200-row window (oldest first),
    // so the project-wide read no longer contains the confirmation.
    await db.insert(auditEvents).values(Array.from({ length: 210 }, (_, index) => ({
      id: uuidv7(new Date(Date.UTC(2020, 0, 1, 0, 0, index))),
      projectId,
      actorUserId: adminId,
      action: 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL',
      entityType: 'maker_po_event',
      entityId: uuidv7(),
      afterState: { provisional: true },
      occurredAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)),
      requestMetadata: { operation: 'filler' }
    })));
    const windowed = await call(adminToken, 'GET', `/api/projects/${projectId}/audit-history?entityType=maker_po_event&limit=200`);
    const windowRows = windowed.body.events as Array<{ action: string; entityId: string }>;
    expect(windowRows).toHaveLength(200);
    expect(windowRows.some((row) => row.action === 'MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED' && row.entityId === eventId)).toBe(false);
    // The window alone would read the paper as unproven — the bug class this guards.
    expect(await webProof(poId)).toBe('unproven');

    signIn('admin');
    const card = orderCard(await render(MakerPoPage), chain.orderCode);
    expect(card).toContain('この発注書の送信状態: </strong>送信ずみ');
    expect(card).not.toContain('未送信');
    expect(card).not.toContain('手順3の確認: 送信の手動確認（代表者のみ）');
    expect(card).toContain('手動確認: 確認（合成代表者');

    const cancelled = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '訂正' });
    expect(cancelled.body).toMatchObject({ cancellationKind: 'MAKER_PO_CANCELLED' });
    expect(await orderPage(chain.orderCode)).toContain('取り消し承認を記録する（メーカー取消確認・代表者のみ）');
  });
});

describe('review M2: a rejected send that is confirmed later is proven (real API sequence)', () => {
  it('reject → confirm is accepted by the API; the screen reads 送信ずみ and, after the cancel, asks for the 取り消し承認', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    const eventId = await pendingSend(poId, chain.orderCode);
    const rejected = await postAs(adminToken, `/api/maker-po-events/${eventId}/send-manual-verification`, {
      result: 'rejected', verifierName: '合成代表者', verifiedAt: new Date().toISOString(), reasonNote: '宛先を確認できなかった'
    });
    expect(rejected.status).toBe(201);
    await confirmSend(eventId);
    signIn('admin');
    const card = orderCard(await render(MakerPoPage), chain.orderCode);
    expect(card).toContain('この発注書の送信状態: </strong>送信ずみ');
    const cancelled = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '訂正' });
    expect(cancelled.body).toMatchObject({ cancellationKind: 'MAKER_PO_CANCELLED' });
    expect(await orderPage(chain.orderCode)).toContain('取り消し承認を記録する（メーカー取消確認・代表者のみ）');
  });
});
