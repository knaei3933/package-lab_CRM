import { isValidElement, cloneElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P2 web lane X3: the auditor's home (監査履歴), the evidence list, the auditor's
 * safety on the screens it can open, and the design-submission upload.
 */
const state = vi.hoisted(() => ({
  user: { role: 'auditor' } as { role: string } | null,
  projects: [] as Array<{ id: string; code: string; name: string; status: string }>
}));
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => 'p-a',
  loadSession: async () => ({ kind: 'anonymous' }),
  loadSessionUser: async () => state.user,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadSelectableProjectList: async () => ({ projects: state.projects, error: null })
}));
vi.mock('../apps/web/src/lib/my-work.js', () => ({ loadMyWork: async () => ({ rows: [], unreadProjects: [], skippedProjects: 0 }) }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: () => undefined, useRouter: () => ({ replace: () => undefined, refresh: () => undefined }), usePathname: () => '/documents' }));

const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
const { EvidenceScreen } = await import('../apps/web/src/screens/EvidenceScreen.js');
const { taskFromServerItem } = await import('../apps/web/src/lib/representative-queue.js');
const { evidencePath, parseEvidenceMetadata } = await import('../apps/web/src/lib/evidence-data.js');
const { DocumentUploadForm } = await import('../apps/web/src/components/DocumentUploadForm.js');
const actions = await import('../apps/web/src/app/actions.js');
const { RENDERED_PROJECT_FIELD } = await import('../apps/web/src/lib/project-context.js');

async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    return resolve(await (element.type as (props: unknown) => Promise<ReactNode>)(element.props));
  }
  const children = element.props.children;
  if (children === undefined) return element;
  const resolved = await resolve(children);
  return Array.isArray(resolved) ? cloneElement(element, undefined, ...resolved) : cloneElement(element, undefined, resolved);
}
const render = async (tree: ReactNode) => renderToStaticMarkup((await resolve(tree)) as ReactElement);

const A = { id: 'p-a', code: 'PRS-A', name: '案件A', status: 'ACTIVE' };
const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, code: null });
const fail = (status: number) => ({ ok: false, status, data: null, error: '失敗しました', code: null });
const SHA = 'ab12' + '0'.repeat(56) + 'ef90';

const event = (id: string, over: Record<string, unknown> = {}) => ({
  id, action: 'MAKER_PO_CEO_APPROVED', entityType: 'maker_purchase_order', entityId: 'e', beforeState: null,
  afterState: { orderCode: 'FSO-1', displayNumber: 'MPO-2026-0001' }, occurredAt: '2026-11-21T01:12:00Z', requestMetadata: null,
  actor: { id: 'u1', displayName: '金井', role: 'admin' }, ...over
});
const doc = (over: Record<string, unknown> = {}) => ({
  documentId: 'doc-1', documentType: 'approval_evidence', issuerEntity: 'customer_generated', originalFilename: 'approval.eml',
  filmSupplyOrderId: 'o-1', orderCode: 'FSO-1', designKey: '表面A', verificationStatus: 'verified', verifiedAt: '2026-11-20T02:00:00Z',
  verifiedBy: { id: 'u1', displayName: '金井', role: 'admin' }, createdAt: '2026-11-20T01:00:00Z', createdBy: { id: 'u2', displayName: '佐藤', role: 'staff' },
  versions: [{ versionId: 'v-1', versionNumber: 1, originalFilename: 'approval.eml', sha256: SHA, byteSize: 10, detectedMimeType: 'message/rfc822', uploadedAt: '2026-11-20T01:00:00Z', uploadedBy: { id: 'u2', displayName: '佐藤', role: 'staff' } }],
  ...over
});

function routes(history: unknown[], evidence: unknown) {
  callApi.mockImplementation(async (path: string) => {
    if (String(path).includes('/audit-history')) return ok({ events: history });
    if (String(path).includes('/evidence-metadata')) return typeof evidence === 'number' ? fail(evidence) : ok(evidence);
    if (String(path).includes('/film-supply-orders')) return ok({ orders: [{ id: 'o-1', code: 'FSO-1' }, { id: 'o-2', code: 'FSO-2' }] });
    return fail(404);
  });
}

beforeEach(() => {
  state.user = { role: 'auditor' };
  state.projects = [A];
  callApi.mockReset();
});

describe('auditor home: 監査履歴', () => {
  it('shows who / when / what / evidence, the MPO number, a short hash and no amount, form or download link', async () => {
    routes(
      [
        event('e1'),
        event('e2', { action: 'ARTWORK_APPROVAL_RECORDED', occurredAt: '2026-11-20T07:40:00Z', actor: { id: 'u2', displayName: '佐藤', role: 'staff' }, afterState: { orderCode: 'FSO-2', evidenceDocumentVersionId: 'v-1', totalAmount: '999999' } })
      ],
      { projectId: 'p-a', limit: 500, truncated: false, documents: [doc()] }
    );
    const html = await render(await HomeScreen());
    expect(html).toContain('監査履歴');
    expect(html).toContain('金額は表示しません');
    expect(html).toContain('金井');
    expect(html).toContain('（代表者）');
    expect(html).toContain('（担当者）');
    expect(html).toContain('2026/11/21');
    expect(html).toContain('JST');
    expect(html).toContain('メーカー発注書の代表承認を記録');
    expect(html).toContain('MPO-2026-0001');
    expect(html).toContain('FSO-1');
    expect(html).toContain('記録のみ（証跡なし）');
    expect(html).toContain('approval.eml');
    expect(html).toContain('SHA-256 ab12…ef90');
    expect(html).toContain('href="/p/PRS-A/evidence#doc-doc-1"');
    for (const bad of ['¥', '円', 'totalAmount', '999999', '<form', '<input', '/download']) expect(html, bad).not.toContain(bad);
    // newest first
    expect(html.indexOf('金井')).toBeLessThan(html.indexOf('佐藤'));
  });

  it('a hidden filename is said so (never the name), and unreadable evidence is said so', async () => {
    const hiddenDoc = doc({ documentType: 'film_quote_kanei', issuerEntity: 'kanei', originalFilename: null, originalFilenameHidden: true, versions: [{ versionId: 'v-1', versionNumber: 1, originalFilename: null, sha256: SHA, uploadedAt: null, uploadedBy: null }] });
    const history = [event('e2', { afterState: { evidenceDocumentVersionId: 'v-1' } })];
    routes(history, { projectId: 'p-a', limit: 500, truncated: false, documents: [hiddenDoc] });
    let html = await render(await HomeScreen());
    expect(html).toContain('ファイル名は非表示');
    expect(html).toContain('SHA-256 ab12…ef90');
    routes(history, 403);
    html = await render(await HomeScreen());
    expect(html).toContain('証跡の情報を読み込めませんでした');
    expect(html).not.toContain('SHA-256');
  });

  it('empty, failed and no-project states', async () => {
    routes([], { documents: [] });
    expect(await render(await HomeScreen())).toContain('まだ承認・確認の記録はありません。');
    callApi.mockResolvedValue(fail(500));
    const failed = await render(await HomeScreen());
    expect(failed).toContain('履歴を読み込めませんでした。');
    expect(failed).toContain('読み込めなかった案件: PRS-A');
    state.projects = [];
    expect(await render(await HomeScreen())).toContain('監査する案件が、まだ割り当てられていません。');
  });

  it('the viewer keeps the plain 履歴 (no 根拠 column, no evidence read)', async () => {
    state.user = { role: 'viewer' };
    routes([event('e1', { afterState: { evidenceDocumentVersionId: 'v-1' } })], { documents: [doc()] });
    const html = await render(await HomeScreen());
    expect(html).toContain('>履歴<');
    expect(html).not.toContain('監査履歴');
    expect(html).not.toContain('根拠');
    expect(callApi.mock.calls.some(([path]) => String(path).includes('/evidence-metadata'))).toBe(false);
  });
});

describe('admin inbox: the MPO number', () => {
  const item = (paper: Record<string, unknown>) => ({
    kind: 'maker_po_ceo_approval', label: '代表承認', project: { id: 'p-a', code: 'PRS-A', name: '案件A' },
    order: { id: 'o-1', code: 'FSO-1', status: 'MAKER_PO_READY' }, makerPurchaseOrder: paper
  });
  it('taskFromServerItem carries displayNumber (absent → undefined)', () => {
    expect(taskFromServerItem(item({ displayNumber: 'MPO-2026-0007' }))?.displayNumber).toBe('MPO-2026-0007');
    expect(taskFromServerItem(item({}))?.displayNumber).toBeUndefined();
  });
  it('the row shows it, and only when present', async () => {
    state.user = { role: 'admin' };
    callApi.mockResolvedValue(ok({ items: [item({ displayNumber: 'MPO-2026-0007' }), { ...item({}), order: { id: 'o-2', code: 'FSO-2', status: 'MAKER_PO_READY' } }], blocked: [] }));
    const html = await render(await HomeScreen());
    expect(html).toContain('MPO-2026-0007');
    expect(html.match(/MPO-/g)?.length).toBe(2); // visible + visually-hidden name of the one row
    expect(html).toContain('承認箱');
  });
});

describe('evidence list', () => {
  const props = { projectId: 'p-a', projectCode: 'PRS-A' };
  const body = { projectId: 'p-a', limit: 200, truncated: false, documents: [doc()] };

  it('auditor: rows, short hash, no form other than the GET filter, no download link, no amount', async () => {
    routes([], body);
    const html = await render(await EvidenceScreen({ ...props, searchParams: Promise.resolve({}) }));
    expect(html).toContain('証跡の一覧');
    expect(html).toContain('approval.eml');
    expect(html).toContain('SHA-256');
    expect(html).toContain('ab12…ef90');
    expect(html).toContain('見積書・セブン化学発注書のファイル名は非表示です');
    expect(html).toContain('閲覧のみ');
    expect(html).toContain('class="p2-evidence-filter" method="get"');
    expect(html.match(/<form/g)?.length).toBe(1);
    expect(html).not.toContain('method="post"');
    for (const bad of ['href="/api', '/download', SHA, '¥', 'note']) expect(html, bad).not.toContain(bad);
    expect(html).toContain('確認済み');
    expect(html).toContain('FSO-2');
  });

  it('admin ok; viewer gets the notice and no read', async () => {
    state.user = { role: 'admin' };
    routes([], body);
    expect(await render(await EvidenceScreen({ ...props }))).toContain('approval.eml');
    callApi.mockClear();
    state.user = { role: 'viewer' };
    const html = await render(await EvidenceScreen({ ...props }));
    expect(html).toContain('閲覧者はこの画面を使えません。');
    expect(html).not.toContain('approval.eml');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('the order filter is sent to the API; the form keeps it selected', async () => {
    routes([], { ...body, documents: [] });
    const html = await render(await EvidenceScreen({ ...props, searchParams: Promise.resolve({ filmSupplyOrderId: 'o-2' }) }));
    const evidenceCall = callApi.mock.calls.map(([path]) => String(path)).find((path) => path.includes('/evidence-metadata'));
    expect(evidenceCall).toBe('/api/projects/p-a/evidence-metadata?filmSupplyOrderId=o-2&limit=200');
    expect(html).toContain('<option value="o-2" selected="">FSO-2</option>');
    expect(html).toContain('FSO-2 の証跡はまだありません。');
    expect(evidencePath('p/x', {})).toBe('/api/projects/p%2Fx/evidence-metadata');
  });

  it('truncated warning, hidden filename, failed and forbidden states', async () => {
    routes([], { ...body, truncated: true, limit: 200, documents: [doc({ documentType: 'seven_po', originalFilename: null, originalFilenameHidden: true })] });
    let html = await render(await EvidenceScreen({ ...props }));
    expect(html).toContain('新しい順に200件まで表示しています');
    expect(html).toContain('ファイル名は非表示');
    routes([], 500);
    html = await render(await EvidenceScreen({ ...props }));
    expect(html).toContain('証跡の一覧を読み込めませんでした');
    expect(html).not.toContain('この案件の証跡はまだありません');
    callApi.mockResolvedValue(fail(403));
    html = await render(await EvidenceScreen({ ...props }));
    expect(html).toContain('この画面を使える権限がありません。');
    routes([], { ...body, documents: [] });
    expect(await render(await EvidenceScreen({ ...props }))).toContain('この案件の証跡はまだありません。');
  });

  it('parseEvidenceMetadata drops anything it does not show (notes, paths)', () => {
    const parsed = parseEvidenceMetadata({ documents: [{ ...doc(), note: 'secret', storagePath: '/x' }], truncated: false });
    expect(JSON.stringify(parsed)).not.toMatch(/secret|storagePath/);
    expect(parseEvidenceMetadata({ nope: 1 })).toBeNull();
  });
});

describe('auditor on the screens it can open: no write form, no amount', () => {
  it('the project overview and the orders list', async () => {
    const { ProjectOverviewScreen } = await import('../apps/web/src/screens/ProjectOverviewScreen.js');
    const { OrdersScreen } = await import('../apps/web/src/screens/OrdersScreen.js');
    callApi.mockImplementation(async (path: string) => {
      if (String(path).endsWith('/api/projects/p-a') || String(path) === '/api/projects/p-a') return ok({ project: A });
      return fail(403);
    });
    for (const screen of [ProjectOverviewScreen, OrdersScreen]) {
      const html = await render(await screen({ projectId: 'p-a', projectCode: 'PRS-A' }));
      expect(html).not.toMatch(/<form[^>]*method="post"/);
      expect(html).not.toMatch(/<button[^>]*type="submit"/);
      for (const bad of ['¥', 'totalAmount', '円']) expect(html, bad).not.toContain(bad);
    }
    const overview = await render(await ProjectOverviewScreen({ projectId: 'p-a', projectCode: 'PRS-A' }));
    expect(overview).toContain('href="/p/PRS-A/evidence"');
  });
});

describe('design submission upload (artwork_submission)', () => {
  const noop = (async () => ({ ok: true, message: '' })) as never;
  const choices = (orders: Array<{ value: string; label: string }>) => (
    <DocumentUploadForm
      action={noop}
      documentTypeChoices={[{ value: 'artwork_submission', label: 'デザイン入稿データ' }, { value: 'film_quote_kanei', label: '見積書' }]}
      issuerEntityChoices={[{ value: 'customer_generated', label: '顧客作成' }]}
      contentTypeChoices={[{ value: 'application/pdf', label: 'PDF' }]}
      sevenPurchaseOrderChoices={[{ value: 'po-1', label: 'SC-1', ready: true }]}
      filmSupplyOrderChoices={orders}
    />
  );
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    data.set(RENDERED_PROJECT_FIELD, 'p-a');
    for (const [key, value] of Object.entries(entries)) data.set(key, value);
    return data;
  };
  const base = { filename: 'a.pdf', contentBase64: 'YQ==', issuerEntity: 'customer_generated', contentType: 'application/pdf' };
  const lastBody = () => (callApi.mock.calls.at(-1)?.[1] as { body?: Record<string, unknown> } | undefined)?.body;

  it('the form: a type that is not the submission keeps the optional order and the PO select', () => {
    const html = renderToStaticMarkup(choices([{ value: 'o-1', label: 'FSO-1' }, { value: 'o-2', label: 'FSO-2' }]));
    // the first listed type is the submission: order required, PO select hidden
    expect(html).toContain('フィルム発注の紐付け<span style="color:var(--danger)">（必須）</span>');
    expect(html).toMatch(/<select name="filmSupplyOrderId" required=""/);
    expect(html).toContain('選んでください');
    expect(html).not.toContain('name="sevenPurchaseOrderId"');
    expect(html).toContain('セブン化学発注書は、選んだ発注のものが自動で紐付きます。');
  });

  it('refuses the submission without an order before calling the API', async () => {
    callApi.mockResolvedValue(ok({ document: { id: 'd' }, warnings: [] }));
    const result = await actions.uploadDocumentAction(null, form({ ...base, documentType: 'artwork_submission' }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('フィルム発注を選んで');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('sends filmSupplyOrderId and never a sevenPurchaseOrderId', async () => {
    callApi.mockResolvedValue(ok({ document: { id: 'd' }, warnings: [] }));
    const result = await actions.uploadDocumentAction(null, form({ ...base, documentType: 'artwork_submission', filmSupplyOrderId: 'o-1', sevenPurchaseOrderId: 'po-1', designKey: '表面A' }));
    expect(result.ok).toBe(true);
    expect(lastBody()).toMatchObject({ documentType: 'artwork_submission', filmSupplyOrderId: 'o-1', designKey: '表面A' });
    expect(lastBody()).not.toHaveProperty('sevenPurchaseOrderId');
  });

  it('other types are unchanged: the PO is still sent, a proof still needs it', async () => {
    callApi.mockResolvedValue(ok({ document: { id: 'd' }, warnings: [] }));
    await actions.uploadDocumentAction(null, form({ ...base, documentType: 'film_quote_kanei', sevenPurchaseOrderId: 'po-1' }));
    expect(lastBody()).toMatchObject({ sevenPurchaseOrderId: 'po-1' });
    expect(lastBody()).not.toHaveProperty('filmSupplyOrderId');
    callApi.mockClear();
    const refused = await actions.uploadDocumentAction(null, form({ ...base, documentType: 'proof' }));
    expect(refused.ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });
});
