import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  accounts,
  artworkRevisions,
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
import { projectScreen } from './helpers/project-screen.js';

/**
 * UI batch F (demo-eml/ui-batch-f/REPORT.md) against the REAL API on the
 * isolated test database — callApi and the download relay's fetch are routed
 * into the real Hono app, as in the earlier parity files.
 *
 * - R1-9 / F2: a design with approval history shows the change request as
 *   required; the action posts the facts and the API stores them; an
 *   incomplete request is refused before anything is written; the print-start
 *   gate refuses staff and records the representative.
 * - R1-4: the documents screen links downloads for staff/admin only; the relay
 *   serves an attachment and records DOCUMENT_VERSION_DOWNLOADED; a viewer's or
 *   an unknown version's refusal comes back as a Japanese notice.
 * - Review M5: rendering /approvals reads Message-IDs only for the evidence an
 *   open approval form offers (DOCUMENT_VERSION_VIEWED rows counted).
 */

const databaseUrl = process.env.DATABASE_URL!;
const { db, pool } = createDatabase(databaseUrl);

type Role = 'admin' | 'staff' | 'viewer';
const userIds: Record<Role, string> = { admin: uuidv7(), staff: uuidv7(), viewer: uuidv7() };
const tokens: Record<Role, string> = { admin: '', staff: '', viewer: '' };
const projectId = uuidv7();
let app: ReturnType<typeof createApp>;
const signedIn = vi.hoisted(() => ({ token: '', role: 'admin' as 'admin' | 'staff' | 'viewer', userId: '', projectId: '', paths: [] as string[] }));

vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://in-process',
  readSessionToken: async () => signedIn.token,
  readSelectedProjectId: async () => signedIn.projectId,
  loadSessionUser: async () => ({ id: signedIn.userId, role: signedIn.role, displayName: '合成' }),
  loadSession: async () => ({ kind: 'user', user: ({ id: signedIn.userId, role: signedIn.role, displayName: '合成' }) }),
  callApi: async (apiPath: string, options: { method?: string; body?: unknown } = {}) => {
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

const ApprovalsPage = projectScreen((await import('../apps/web/src/screens/ApprovalsScreen.js')).ApprovalsScreen);
const DocumentsPage = projectScreen((await import('../apps/web/src/screens/DocumentsScreen.js')).DocumentsScreen);
const { registerArtworkRevisionAction } = await import('../apps/web/src/app/actions.js');
const { GET: downloadRelay } = await import('../apps/web/src/app/api/document-versions/[versionId]/download/route.js');
const { loadWorkspace } = await import('../apps/web/src/lib/project-data.js');
const { approvalHistoryKeys, changeRequestKey } = await import('../apps/web/src/lib/change-request.js');

function signIn(role: Role) {
  signedIn.role = role;
  signedIn.userId = userIds[role];
  signedIn.token = tokens[role];
  signedIn.projectId = projectId;
}

let counter = 0;
const nextTag = () => String(++counter).padStart(4, '0');

async function postAs(role: Role, url: string, body: unknown = {}) {
  const response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${tokens[role]}` },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  data.set('_kaneiRenderedProjectId', signedIn.projectId); // P0 R03: the form was drawn for the selected project
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

async function render(page: () => Promise<unknown>): Promise<string> {
  const { prelude } = await prerenderToNodeStream((await page()) as Parameters<typeof prerenderToNodeStream>[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of prelude) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8').replaceAll('<!-- -->', '');
}

async function uploadDocument(input: { documentType: string; issuerEntity: string; designKey?: string; orderId?: string; sevenPoId?: string; content?: string }) {
  const tag = nextTag();
  const response = await postAs('staff', `/api/projects/${projectId}/documents`, {
    documentType: input.documentType,
    issuerEntity: input.issuerEntity,
    filename: `uf-doc-${tag}.txt`,
    contentType: 'text/plain',
    contentBase64: Buffer.from(input.content ?? `composite batch F document ${tag}\n`, 'utf8').toString('base64'),
    ...(input.sevenPoId ? { sevenPurchaseOrderId: input.sevenPoId } : {}),
    ...(input.orderId ? { filmSupplyOrderId: input.orderId } : {}),
    ...(input.designKey ? { designKey: input.designKey } : {})
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as unknown as { document: { id: string }; version: { id: string } };
}

/**
 * An order whose design `label-front` is dual approved (the real chain, no
 * maker paper) — or, given `decisions`, carries exactly those recorded
 * decisions on its first revision (server-batch-f4 M-6 history shapes).
 */
async function dualApprovedOrder(
  decisions: ReadonlyArray<readonly ['customer' | 'seven', 'APPROVE' | 'REVOKE']> = [['customer', 'APPROVE'], ['seven', 'APPROVE']]
) {
  const tag = nextTag();
  const sevenPo = await postAs('staff', `/api/projects/${projectId}/seven-purchase-orders`, { poNumber: `SEVEN-UF-${tag}` });
  const sevenPoId = sevenPo.body.id as string;
  expect((await postAs('staff', `/api/seven-purchase-orders/${sevenPoId}/verification-checklist`, {
    issuerNameRecorded: true, issuerName: '合成セブン化学事業', documentNumberRecorded: true,
    documentNumber: `PO-2026-UF-${tag}`, issueDateRecorded: true, issueDate: '2026-11-15',
    sendingChannelRecorded: true, sendingChannel: '専用ポータル', pastTransactionCompared: true,
    pastTransactionNote: '過去の発注書と様式が一致', quoteCompared: true, quoteMatchesPo: true,
    quoteComparisonNote: '見積と一致', tamperHints: '', uncertain: false,
    confirmationReplyRecorded: false, confirmationReplyNote: '', verificationNote: '合成チェックリスト'
  })).status).toBe(200);
  expect((await postAs('staff', `/api/seven-purchase-orders/${sevenPoId}/register-official`, {
    officialRegisteredAt: '2026-11-14T09:00:00.000Z'
  })).status).toBe(200);
  const orderCode = `FSO-UF-${tag}`;
  const order = await postAs('staff', `/api/seven-purchase-orders/${sevenPoId}/supply-orders`, {
    code: orderCode, paymentTerms: 'prepaid',
    lines: [{ lineNumber: 1, description: '合成フィルム本体', orderedQuantity: 1000, unit: 'sheets' }]
  });
  const orderId = order.body.id as string;
  for (const to of ['SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING']) {
    expect((await postAs('staff', `/api/film-supply-orders/${orderId}/transitions`, { to })).status).toBe(200);
  }
  const proof = await uploadDocument({ documentType: 'proof', issuerEntity: 'kanei', designKey: 'label-front', orderId, sevenPoId });
  const revision = await postAs('staff', `/api/film-supply-orders/${orderId}/artwork-revisions`, {
    designKey: 'label-front', fileDocumentVersionId: proof.version.id
  });
  expect(revision.status).toBe(201);
  for (const [organization, decision] of decisions) {
    const identifier = `MSG-UF-${organization.toUpperCase()}-${nextTag()}`;
    const evidence = await uploadDocument({
      documentType: 'approval_evidence', issuerEntity: organization === 'seven' ? 'seven' : 'customer_generated',
      designKey: 'label-front', orderId, sevenPoId, content: `composite approval evidence\nidentifier: ${identifier}\n`
    });
    expect((await postAs('staff', `/api/artwork-revisions/${revision.body.id as string}/approvals`, {
      organization, decision, evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
      evidenceIdentifier: identifier, evidenceDocumentVersionId: evidence.version.id
    })).status).toBe(201);
  }
  const newProof = await uploadDocument({ documentType: 'proof', issuerEntity: 'kanei', designKey: 'label-front', orderId, sevenPoId });
  const changeEvidence = await uploadDocument({
    documentType: 'approval_evidence', issuerEntity: 'customer_generated', designKey: 'label-front', orderId, sevenPoId,
    content: 'composite change request mail: 成分表示の修正を依頼します\n'
  });
  return { orderId, orderCode, sevenPoId, newProofVersionId: newProof.version.id, changeEvidenceVersionId: changeEvidence.version.id };
}

function revisionCard(html: string): string {
  const start = html.indexOf('校正ゲラの版を登録する');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('承認の記録履歴', start));
}

const FACTS = {
  changeRequest: 'on',
  changeRequestedOrganization: 'customer',
  changeReason: '顧客依頼：成分表示の修正',
  impactSchedule: '納期 2日遅延',
  impactQuantity: '0',
  impactAmount: '-1500',
  actualCost: '0',
  lotMarking: 'LOT-UF-B'
};

async function revisionsOf(orderId: string) {
  return db.select().from(artworkRevisions).where(eq(artworkRevisions.filmSupplyOrderId, orderId));
}

async function countAudit(action: string) {
  const rows = await db.select({ id: auditEvents.id }).from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.projectId, projectId)));
  return rows.length;
}

beforeAll(async () => {
  process.env.DOCUMENT_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'kanei-ui-batch-f-'));
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
  await db.insert(users).values((['admin', 'staff', 'viewer'] as const).map((role) => ({
    id: userIds[role], username: `${role}_uf_test`, passwordHash: '', displayName: `合成${role}F`, role
  })));
  await db.update(users).set({ passwordHash: await hashPassword('composite-pass') });
  const [customer, seven, maker] = [uuidv7(), uuidv7(), uuidv7()];
  await db.insert(accounts).values([
    { id: customer, name: '合成Fエンドカスタマー', role: 'end_customer', externalCode: 'TEST-UF-CUST' },
    { id: seven, name: '合成Fセブン', role: 'seven', externalCode: 'TEST-UF-SEVEN' },
    { id: maker, name: '合成Fメーカー', role: 'maker', externalCode: 'TEST-UF-MAKER' }
  ]);
  await db.insert(projects).values({
    id: projectId, code: 'TEST-UF-PROJECT', name: '合成F案件', businessUnit: 'F1' as const, route: 'F1' as const,
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
  // The download relay's own fetch goes to the same in-process API.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://in-process/')) return app.request(url.slice('http://in-process'.length), init);
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  await pool.end();
});

describe('R1-9 / F2: the controlled change request through the revision form', () => {
  it('a design with approval history: the form requires the facts, the API stores them, the order enters CHANGE_REVIEW', async () => {
    const chain = await dualApprovedOrder();
    signIn('staff');
    const card = revisionCard(await render(ApprovalsPage));
    expect(card).toContain('変更依頼（承認済みデザインの差し替え）');
    expect(card).toContain('ロット表記（変更依頼では必須）');
    expect(card).toContain('依頼組織・変更理由・証憑・影響（納期／数量／金額）・');

    // The API asks for the facts even when the form did not send them.
    const bare = await registerArtworkRevisionAction(null, form({
      orderId: chain.orderId, designKey: 'label-front', fileDocumentVersionId: chain.newProofVersionId
    }));
    expect(bare).toMatchObject({
      ok: false,
      message: 'このデザインには承認の記録があるため、変更依頼として登録する必要があります。「変更依頼として登録する」にチェックを入れ、各項目を入力してください。'
    });
    // Incomplete: refused on the web, nothing sent or written.
    const incomplete = await registerArtworkRevisionAction(null, form({
      orderId: chain.orderId, designKey: 'label-front', fileDocumentVersionId: chain.newProofVersionId,
      ...FACTS, changeEvidenceDocumentVersionId: chain.changeEvidenceVersionId, actualCost: ''
    }));
    expect(incomplete).toEqual({ ok: false, message: '実費を入力してください（実費がなければ0）。' });
    // Evidence of another order: the API's binding refusal in the form's words.
    const other = await dualApprovedOrder();
    signIn('staff');
    const foreign = await registerArtworkRevisionAction(null, form({
      orderId: chain.orderId, designKey: 'label-front', fileDocumentVersionId: chain.newProofVersionId,
      ...FACTS, changeEvidenceDocumentVersionId: other.changeEvidenceVersionId
    }));
    expect(foreign).toMatchObject({
      ok: false,
      message: '変更依頼の証憑は、この発注（デザインを指定した証跡はそのデザイン）に紐付けた承認証跡から選んでください。'
    });
    expect(await revisionsOf(chain.orderId)).toHaveLength(1);

    const recorded = await registerArtworkRevisionAction(null, form({
      orderId: chain.orderId, designKey: 'label-front', fileDocumentVersionId: chain.newProofVersionId,
      ...FACTS, changeEvidenceDocumentVersionId: chain.changeEvidenceVersionId
    }));
    expect(recorded).toEqual({ ok: true, message: '記録しました。', changedId: expect.any(String) });
    const stored = (await revisionsOf(chain.orderId)).find((row) => row.revisionNo === 2)!;
    expect(stored).toMatchObject({
      changeRequestedOrganization: 'customer',
      changeReason: '顧客依頼：成分表示の修正',
      changeEvidenceDocumentVersionId: chain.changeEvidenceVersionId,
      impactSchedule: '納期 2日遅延',
      impactQuantity: '0.000',
      impactAmount: '-1500.00',
      actualCost: '0.00',
      lotMarking: 'LOT-UF-B',
      createdByUserId: userIds.staff,
      printedChangeApprovedByUserId: null
    });
    const [order] = await db.select({ status: filmSupplyOrders.status }).from(filmSupplyOrders).where(eq(filmSupplyOrders.id, chain.orderId));
    expect(order?.status).toBe('CHANGE_REVIEW');
  });

  it('after print start: staff is refused with nothing written; the representative is recorded as the approver', async () => {
    const chain = await dualApprovedOrder();
    // Synthetic fixture (review M8: the real chain cannot reach this without
    // accepted maker paper, which blocks revisions first).
    await db.update(filmSupplyOrders).set({ status: 'FILM_IN_PRODUCTION' }).where(eq(filmSupplyOrders.id, chain.orderId));
    const entries = {
      orderId: chain.orderId, designKey: 'label-front', fileDocumentVersionId: chain.newProofVersionId,
      ...FACTS, changeEvidenceDocumentVersionId: chain.changeEvidenceVersionId
    };
    signIn('staff');
    expect(await registerArtworkRevisionAction(null, form(entries))).toMatchObject({
      ok: false,
      message: '印刷開始後の変更は代表者だけが登録できます。代表者に登録を依頼してください（版も状態も記録されていません）。'
    });
    expect(await revisionsOf(chain.orderId)).toHaveLength(1);

    signIn('admin');
    expect(await registerArtworkRevisionAction(null, form(entries))).toMatchObject({ ok: true });
    const stored = (await revisionsOf(chain.orderId)).find((row) => row.revisionNo === 2)!;
    expect(stored.printedChangeApprovedByUserId).toBe(userIds.admin);
    expect(stored.printedChangeApprovedAt).toBeInstanceOf(Date);
  });

  it('a viewer gets no revision form at all (role hiding kept; the API is the rule)', async () => {
    signIn('viewer');
    const card = revisionCard(await render(ApprovalsPage));
    expect(card).not.toContain('name="changeReason"');
    expect(card).not.toContain('変更依頼として登録する');
  });
});

describe('R1-4: document downloads from the documents screen', () => {
  it('staff and admin get links; the relay serves the attachment and the API records the download', async () => {
    const document = await uploadDocument({ documentType: 'film_quote_kanei', issuerEntity: 'kanei', content: 'composite quote bytes F\n' });
    for (const role of ['staff', 'admin'] as const) {
      signIn(role);
      const html = await render(DocumentsPage);
      expect(html).toContain(`href="/api/document-versions/${document.version.id}/download"`);
      expect(html).toContain('各版の「ダウンロード」で書類ファイルを保存できます（ダウンロードは記録されます）。');
    }
    const before = await countAudit('DOCUMENT_VERSION_DOWNLOADED');
    signIn('staff');
    const response = await downloadRelay(new Request('http://web/x'), { params: Promise.resolve({ versionId: document.version.id }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('composite quote bytes F\n');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''uf-doc-\d+\.txt$/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await countAudit('DOCUMENT_VERSION_DOWNLOADED')).toBe(before + 1);
  });

  it('a viewer gets no links and a direct try comes back as the Japanese 403 notice; an unknown version as 404', async () => {
    const document = await uploadDocument({ documentType: 'film_quote_kanei', issuerEntity: 'kanei' });
    signIn('viewer');
    const html = await render(DocumentsPage);
    expect(html).not.toContain('/download"');
    expect(html).toContain('閲覧者は書類ファイルをダウンロードできません（一覧の閲覧のみ）。');
    const refused = await downloadRelay(new Request('http://web/x'), { params: Promise.resolve({ versionId: document.version.id }) });
    expect(refused.status).toBe(303);
    expect(refused.headers.get('location')).toBe('/documents?download=forbidden');
    const notice = await render(() => DocumentsPage({ searchParams: Promise.resolve({ download: 'forbidden' }) }));
    expect(notice).toContain('<div class="ui-info" role="alert">');
    expect(notice).toContain('この書類をダウンロードする権限がありません（閲覧者、または担当外の案件です）。');

    signIn('staff');
    const unknown = await downloadRelay(new Request('http://web/x'), { params: Promise.resolve({ versionId: uuidv7() }) });
    expect(unknown.headers.get('location')).toBe('/documents?download=missing');
    const ignored = await render(() => DocumentsPage({ searchParams: Promise.resolve({ download: '<b>x</b>' }) }));
    expect(ignored).not.toContain('<b>x</b>');
  });
});

describe('review M5: /approvals reads Message-IDs only for evidence an open approval form offers', () => {
  // The workspace is replayed from audit history, so rows are counted as deltas.
  async function viewedDuring(role: Role): Promise<{ added: number; html: string; reads: string[] }> {
    const before = await countAudit('DOCUMENT_VERSION_VIEWED');
    signIn(role);
    signedIn.paths.length = 0;
    const html = await render(ApprovalsPage);
    const reads = signedIn.paths.filter((apiPath) => apiPath.endsWith('/evidence-message-id'));
    return { added: (await countAudit('DOCUMENT_VERSION_VIEWED')) - before, html, reads };
  }

  it('nothing for a viewer or a fully approved design; the current version only for a pending design', async () => {
    // Designs so far are dual approved or in change review with stored text evidence.
    const chain = await dualApprovedOrder();
    expect((await viewedDuring('staff')).added).toBe(0);

    // A pending design with one approval evidence EML in two versions.
    const pendingProof = await uploadDocument({ documentType: 'proof', issuerEntity: 'kanei', designKey: 'label-back', orderId: chain.orderId, sevenPoId: chain.sevenPoId });
    expect((await postAs('staff', `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, {
      designKey: 'label-back', fileDocumentVersionId: pendingProof.version.id
    })).status).toBe(201);
    const eml = (id: string) => `Message-ID: <${id}@example.invalid>\r\nFrom: a@example.invalid\r\nSubject: ok\r\n\r\nbody\r\n`;
    for (const content of [eml('uf-old'), eml('uf-new')]) {
      const response = await postAs('staff', `/api/projects/${projectId}/documents`, {
        documentType: 'approval_evidence', issuerEntity: 'customer_generated', filename: 'uf-back.eml',
        contentType: 'message/rfc822', contentBase64: Buffer.from(content).toString('base64'),
        filmSupplyOrderId: chain.orderId, sevenPurchaseOrderId: chain.sevenPoId, designKey: 'label-back'
      });
      // The first upload creates the document (201), the second adds version 2 (200).
      expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
    }
    const viewer = await viewedDuring('viewer');
    expect(viewer.added).toBe(0);
    expect(viewer.reads).toEqual([]);
    const staff = await viewedDuring('staff');
    // One read: the current version of the pending design's EML (not v1, not the approved designs').
    expect(staff.added).toBe(1);
    const [latestView] = await db.select({ entityId: auditEvents.entityId }).from(auditEvents)
      .where(and(eq(auditEvents.action, 'DOCUMENT_VERSION_VIEWED'), eq(auditEvents.projectId, projectId)))
      .orderBy(sql`${auditEvents.occurredAt} desc`).limit(1);
    const backVersions = (await db.execute(sql`select dv.id from document_versions dv where dv.original_filename = 'uf-back.eml' order by dv.version_number`)).rows as Array<{ id: string }>;
    const readOf = (versionId: string | undefined) => `/api/document-versions/${versionId}/evidence-message-id`;
    expect(latestView?.entityId).toBe(backVersions[1]?.id);
    // v2 is asked for, v1 is not (the API would refuse it).
    expect(staff.reads).toContain(readOf(backVersions[1]?.id));
    expect(staff.reads).not.toContain(readOf(backVersions[0]?.id));
    expect(staff.html).toContain('承認を記録する：デザイン label-back');
    // Once the design is approved, its evidence is no longer read.
    const revision = (await revisionsOf(chain.orderId)).find((row) => row.designKey === 'label-back')!;
    for (const organization of ['customer', 'seven'] as const) {
      const identifier = `MSG-UF-BACK-${organization}-${nextTag()}`;
      const evidence = await uploadDocument({
        documentType: 'approval_evidence', issuerEntity: organization === 'seven' ? 'seven' : 'customer_generated',
        designKey: 'label-back', orderId: chain.orderId, sevenPoId: chain.sevenPoId,
        content: `composite approval evidence\nidentifier: ${identifier}\n`
      });
      expect((await postAs('staff', `/api/artwork-revisions/${revision.id}/approvals`, {
        organization, decision: 'APPROVE', evidenceSource: 'email', eventTime: '2026-11-15T10:00:00.000Z',
        evidenceIdentifier: identifier, evidenceDocumentVersionId: evidence.version.id
      })).status).toBe(201);
    }
    for (const role of ['staff', 'admin'] as const) {
      const after = await viewedDuring(role);
      expect(after.added).toBe(0);
      expect(after.reads).not.toContain(readOf(backVersions[1]?.id));
    }
  });
});

describe('server-batch-f4 M-6: the web approval-history judgement equals the API contract', () => {
  const SHAPES = [
    ['APPROVE by both organizations', [['customer', 'APPROVE'], ['seven', 'APPROVE']]],
    ['REVOKE only', [['customer', 'REVOKE']]],
    ['APPROVE then REVOKE', [['customer', 'APPROVE'], ['customer', 'REVOKE']]],
    ['no recorded decision', []]
  ] as const;

  it.each(['staff', 'admin'] as const)('as %s: every history shape is judged the same by the screen data and by the API', async (role) => {
    const chains = [];
    for (const [label, decisions] of SHAPES) chains.push({ label, chain: await dualApprovedOrder(decisions) });
    signIn(role);
    const workspace = await loadWorkspace(projectId);
    // Approval records alone (no gate fallback): the rule the API applies.
    const keys = new Set(approvalHistoryKeys(workspace.revisions, workspace.approvalEvents, []));
    const verdicts = [];
    for (const { label, chain } of chains) {
      const web = keys.has(changeRequestKey(chain.orderId, 'label-front'));
      const bare = await postAs(role, `/api/film-supply-orders/${chain.orderId}/artwork-revisions`, {
        designKey: 'label-front', fileDocumentVersionId: chain.newProofVersionId
      });
      const api = bare.status === 422 && bare.body.code === 'CHANGE_REQUEST_ORGANIZATION_REQUIRED';
      if (!api) expect(bare.status, JSON.stringify(bare.body)).toBe(201);
      verdicts.push({ label, web, api });
    }
    expect(verdicts).toEqual([
      { label: 'APPROVE by both organizations', web: true, api: true },
      { label: 'REVOKE only', web: true, api: true },
      { label: 'APPROVE then REVOKE', web: true, api: true },
      { label: 'no recorded decision', web: false, api: false }
    ]);
  });

  it('REVOKE-only design through the form: refused without facts, stored with them, the order enters CHANGE_REVIEW', async () => {
    const chain = await dualApprovedOrder([['customer', 'REVOKE']]);
    signIn('staff');
    const bare = await registerArtworkRevisionAction(null, form({
      orderId: chain.orderId, designKey: 'label-front', fileDocumentVersionId: chain.newProofVersionId
    }));
    expect(bare).toMatchObject({
      ok: false,
      message: 'このデザインには承認の記録があるため、変更依頼として登録する必要があります。「変更依頼として登録する」にチェックを入れ、各項目を入力してください。'
    });
    const recorded = await registerArtworkRevisionAction(null, form({
      orderId: chain.orderId, designKey: 'label-front', fileDocumentVersionId: chain.newProofVersionId,
      ...FACTS, changeEvidenceDocumentVersionId: chain.changeEvidenceVersionId
    }));
    expect(recorded).toEqual({ ok: true, message: '記録しました。', changedId: expect.any(String) });
    const stored = (await revisionsOf(chain.orderId)).find((row) => row.revisionNo === 2)!;
    expect(stored).toMatchObject({ changeRequestedOrganization: 'customer', changeReason: '顧客依頼：成分表示の修正', lotMarking: 'LOT-UF-B' });
    const [order] = await db.select({ status: filmSupplyOrders.status }).from(filmSupplyOrders).where(eq(filmSupplyOrders.id, chain.orderId));
    expect(order?.status).toBe('CHANGE_REVIEW');
  });

  it('facts opened by hand on a design without history: the API stores none of them and the form says so', async () => {
    const chain = await dualApprovedOrder([]);
    signIn('staff');
    const workspace = await loadWorkspace(projectId);
    expect(approvalHistoryKeys(workspace.revisions, workspace.approvalEvents, [])).not.toContain(changeRequestKey(chain.orderId, 'label-front'));
    const result = await registerArtworkRevisionAction(null, form({
      orderId: chain.orderId, designKey: 'label-front', fileDocumentVersionId: chain.newProofVersionId,
      ...FACTS, changeEvidenceDocumentVersionId: chain.changeEvidenceVersionId
    }));
    expect(result).toEqual({
      ok: true,
      changedId: expect.any(String),
      message: '版を記録しました。このデザインには承認の記録（承認・取消）がないため、変更依頼の項目（依頼組織・理由・証憑・影響・実費）は記録されていません（通常の版として登録されました）。'
    });
    const stored = (await revisionsOf(chain.orderId)).find((row) => row.revisionNo === 2)!;
    expect(stored).toMatchObject({
      changeRequestedOrganization: null, changeReason: null, changeEvidenceDocumentVersionId: null,
      impactSchedule: null, impactQuantity: null, impactAmount: null, actualCost: null
    });
    const [order] = await db.select({ status: filmSupplyOrders.status }).from(filmSupplyOrders).where(eq(filmSupplyOrders.id, chain.orderId));
    expect(order?.status).toBe('APPROVAL_PENDING');
  });
});
