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
import { projectScreen } from './helpers/project-screen.js';

/**
 * Recheck 9 (demo-eml/server-rules-recheck9/RECHECK_REPORT.md) Medium-3, against
 * the REAL API on the isolated test database — the same harness as
 * tests/web-ui-recheck8-parity.test.tsx (callApi routed into the real Hono app).
 *
 * The staff audit view carries neither acknowledgementKind nor the send
 * decisions' results. The staff screen rendered the kind of a cancellation
 * acknowledgement inverted (N3a: a record-only post-delivery confirmation as
 * 「取り消し承認」 on the audit dashboard; N3b: the 取り消し承認 of a send proven
 * by the manual check as 「内部の訂正…事後確認（記録のみ）は記録済み」). The
 * same data is rendered as admin and as staff: staff shows the right kind or
 * says it cannot tell — never the opposite one.
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
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const MakerPoPage = projectScreen((await import('../apps/web/src/screens/MakerPoScreen.js')).MakerPoScreen);
const { loadMakerPaperCleanup } = await import('../apps/web/src/lib/maker-po-data.js');

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
  const content = input.content ?? `composite recheck9 document bytes ${tag}\n`;
  const response = await postAs(staffToken, `/api/projects/${projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `r9w-doc-${tag}.txt`,
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
  const sevenPo = await postAs(staffToken, `/api/projects/${projectId}/seven-purchase-orders`, { poNumber: `SEVEN-R9W-${tag}` });
  expect(sevenPo.status).toBe(201);
  const sevenPoId = sevenPo.body.id as string;
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${sevenPoId}/verification-checklist`, {
    issuerNameRecorded: true, issuerName: '合成セブン化学事業', documentNumberRecorded: true,
    documentNumber: `PO-2026-R9W-${tag}`, issueDateRecorded: true, issueDate: '2026-11-15',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル', pastTransactionCompared: true,
    pastTransactionNote: '過去の発注書と様式が一致', quoteCompared: true, quoteMatchesPo: true,
    quoteComparisonNote: '見積と一致', tamperHints: '', uncertain: false,
    confirmationReplyRecorded: false, confirmationReplyNote: '', verificationNote: '合成チェックリスト'
  })).status).toBe(200);
  expect((await postAs(staffToken, `/api/seven-purchase-orders/${sevenPoId}/register-official`, {
    officialRegisteredAt: '2026-11-14T09:00:00.000Z'
  })).status).toBe(200);
  const orderCode = `FSO-R9W-${tag}`;
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
  const artworkBytes = `composite recheck9 artwork bytes ${tag}\n`;
  const proof = await uploadDocument({
    documentType: 'proof', issuerEntity: 'kanei', designKey: 'label-front', orderId, sevenPoId, content: artworkBytes
  });
  const revision = await postAs(staffToken, `/api/film-supply-orders/${orderId}/artwork-revisions`, {
    designKey: 'label-front', fileDocumentVersionId: proof.version.id
  });
  expect(revision.status).toBe(201);
  for (const organization of ['customer', 'seven'] as const) {
    const identifier = `MSG-R9W-${organization.toUpperCase()}-${nextTag()}`;
    const evidence = await uploadDocument({
      documentType: 'approval_evidence',
      issuerEntity: organization === 'seven' ? 'seven' : 'customer_generated',
      designKey: 'label-front', orderId, sevenPoId,
      content: `composite recheck9 approval evidence\nidentifier: ${identifier}\n`
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
  expect((await postAs(adminToken, `/api/maker-purchase-orders/${poId}/ceo-approval`, {})).status).toBe(200);
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
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-ui-recheck9-'));
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
    { id: adminId, username: 'admin_r9w_test', passwordHash: await hashPassword('composite-admin-pass'), displayName: '合成代表者R9', role: 'admin' },
    { id: staffId, username: 'staff_r9w_test', passwordHash: await hashPassword('composite-staff-pass'), displayName: '合成担当者R9', role: 'staff' }
  ]);
  const [customer, seven, maker] = [uuidv7(), uuidv7(), uuidv7()];
  await db.insert(accounts).values([
    { id: customer, name: '合成R9エンドカスタマー', role: 'end_customer', externalCode: 'TEST-R9W-CUST' },
    { id: seven, name: '合成R9セブン', role: 'seven', externalCode: 'TEST-R9W-SEVEN' },
    { id: maker, name: '合成R9メーカー', role: 'maker', externalCode: 'TEST-R9W-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId, code: 'TEST-R9W-PROJECT', name: '合成R9案件', businessUnit: 'F1' as const, route: 'F1' as const,
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


/** The representative's manual confirmation of a pending send: the send is now proven. */
async function confirmSend(eventId: string) {
  const confirmed = await postAs(adminToken, `/api/maker-po-events/${eventId}/send-manual-verification`, {
    // An explicit offset (the contract: offset-bearing ISO-8601).
    result: 'confirmed', verifierName: '合成代表者R9', verifiedAt: new Date().toISOString().replace('Z', '+00:00'),
    reasonNote: 'メーカー宛の送信を原本で確認した'
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
}

/** The audit dashboard row (⑤) of one audit entity, e.g. an acknowledgement event. */
function dashboardRow(html: string, entityId: string): string {
  const dashboard = html.slice(html.indexOf('⑤ 監査ダッシュボード'));
  let at = dashboard.indexOf(`>${entityId}<`);
  while (at !== -1) {
    const row = dashboard.slice(dashboard.lastIndexOf('<tr', at), dashboard.indexOf('</tr>', at));
    if (row.includes('MAKER_CANCELLATION_ACKNOWLEDGED')) return row;
    at = dashboard.indexOf(`>${entityId}<`, at + 1);
  }
  throw new Error(`no dashboard row for ${entityId}`);
}

const POST_DELIVERY_LABEL = 'メーカー到達の事後確認（記録のみ）';
const ACKNOWLEDGEMENT_LABEL = '取り消し承認（メーカー取消確認）';
const UNKNOWN_KIND_LABEL = '取り消し承認またはメーカー到達の事後確認';

/** The label cell of a dashboard row (the second cell, 記録の内容). */
function rowLabel(row: string): string {
  const cells = row.split('<td').slice(1);
  const cell = cells[1] ?? '';
  return cell.slice(cell.indexOf('>') + 1).replace(/<[^>]*>/g, '').trim();
}

describe('Medium-3 (N3a): record-only post-delivery confirmation of an internal cancel', () => {
  it('admin and staff both call it 事後確認（記録のみ） on the card and on the audit dashboard', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    await pendingSend(poId, chain.orderCode);
    expect((await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '未確認の送信を訂正' })).body)
      .toMatchObject({ cancellationKind: 'INTERNAL_CANCEL' });
    const ack = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, { note: 'メーカーに届いていた' });
    expect(ack.status).toBe(201);
    expect(ack.body).toMatchObject({ acknowledgementKind: 'POST_DELIVERY_CONFIRMATION' });
    const ackId = (ack.body.event as { id: string }).id;

    signIn('admin');
    const adminHtml = await render(MakerPoPage);
    expect(orderCard(adminHtml, chain.orderCode)).toContain(`${POST_DELIVERY_LABEL}: 記録済み`);
    expect(rowLabel(dashboardRow(adminHtml, ackId))).toBe(POST_DELIVERY_LABEL);

    signIn('staff');
    const staffHtml = await render(MakerPoPage);
    const staffCard = orderCard(staffHtml, chain.orderCode);
    // No decision exists for the send, so the staff screen knows the cancel was internal.
    expect(staffCard).toContain(`「${POST_DELIVERY_LABEL}」は記録済みです。`);
    expect(staffCard).not.toContain(`「${ACKNOWLEDGEMENT_LABEL}」は記録済みです。`);
    // The e77cce7 staff dashboard said 「取り消し承認（メーカー取消確認）」 here.
    expect(rowLabel(dashboardRow(staffHtml, ackId))).toBe(POST_DELIVERY_LABEL);
  });
});

describe('Medium-3 (N3b): the 取り消し承認 of a send proven by the manual check', () => {
  it('admin says 取り消し承認; staff says 取り消し承認 or that it cannot tell — never 内部の訂正・事後確認', async () => {
    const chain = await reachMakerPoReady();
    const poId = await approvedPaper(chain.orderId);
    const sendId = await pendingSend(poId, chain.orderCode);
    await confirmSend(sendId);
    expect((await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancel`, { note: '送信ずみの発注書を取り消す' })).status).toBe(200);

    // Before the 取り消し承認: the cleanup judgement of the other screens (次にやること).
    signIn('admin');
    expect((await loadMakerPaperCleanup(projectId, [chain.orderId]))[chain.orderId]).toMatchObject({ state: 'cleanup', acknowledgementPapers: 1 });
    signIn('staff');
    // Staff cannot read the decision: it may be owed — never "nothing left" (was 'none').
    expect((await loadMakerPaperCleanup(projectId, [chain.orderId]))[chain.orderId]).toMatchObject({ state: 'unknown', acknowledgementPapers: 1 });
    const staffBefore = orderCard(await render(MakerPoPage), chain.orderCode);
    expect(staffBefore).not.toContain('手動確認待ちのまま残っています');
    expect(staffBefore).not.toContain('この取り消しは内部の訂正として扱われたため');
    expect(staffBefore).not.toContain(`代表者が「${POST_DELIVERY_LABEL}」を記録します`);
    expect(staffBefore).toContain('送信の手動確認の結果（確認・却下）がこの役割の画面には表示されないため、送信ずみとして取り消されたのか、内部の訂正として取り消されたのかをこの画面では判定できません。');

    const ack = await postAs(adminToken, `/api/maker-purchase-orders/${poId}/cancellation-acknowledgement`, { note: 'メーカーが取り消しを了承' });
    expect(ack.status).toBe(201);
    expect(ack.body).toMatchObject({ acknowledgementKind: 'CANCELLATION_ACKNOWLEDGEMENT' });
    const ackId = (ack.body.event as { id: string }).id;

    signIn('admin');
    const adminHtml = await render(MakerPoPage);
    const adminCard = orderCard(adminHtml, chain.orderCode);
    expect(adminCard).toContain(`${ACKNOWLEDGEMENT_LABEL}: 記録済み`);
    expect(adminCard).not.toContain(POST_DELIVERY_LABEL + '」は記録済み');
    expect(rowLabel(dashboardRow(adminHtml, ackId))).toBe(ACKNOWLEDGEMENT_LABEL);

    signIn('staff');
    const staffHtml = await render(MakerPoPage);
    const staffCard = orderCard(staffHtml, chain.orderCode);
    // The e77cce7 staff card said all three of these.
    expect(staffCard).not.toContain('手動確認待ちのまま残っています');
    expect(staffCard).not.toContain('この取り消しは内部の訂正として扱われたため、取り消し承認も不要です');
    expect(staffCard).not.toContain(`「${POST_DELIVERY_LABEL}」は記録済みです。`);
    // The right kind if the API discloses it to staff, else the honest "cannot tell".
    expect(staffCard).toMatch(new RegExp(`取り消し後の記録（(${ACKNOWLEDGEMENT_LABEL}|${UNKNOWN_KIND_LABEL})）はあります`.replace(/[（）]/g, (c) => `\\${c}`)));
    expect([ACKNOWLEDGEMENT_LABEL, UNKNOWN_KIND_LABEL]).toContain(rowLabel(dashboardRow(staffHtml, ackId)));
  });
});
