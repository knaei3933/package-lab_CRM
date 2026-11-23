import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
/**
 * p5/web (base p4/rc a5dd052): the web-only part of the audit44b leftovers (REMAINING.md) — R4, H14 left, M16 left, M4, R7 (T-8),
 * R9, R10, R11, R12, R13, R14, R15, the send dialog's seconds, R2/M12 (390px approval card) and the H12 submit counter.
 * One describe per item; each holds tests that fail on a5dd052's code (evidence: demo-eml/p5-web/evidence/*-base-red.log) and render the real
 * components (renderToStaticMarkup — never CSS text). Server rules, amounts (staff / viewer / auditor see none), idempotency
 * semantics and P-7 (Japanese-only screens carry no Hangul) are untouched: the API is mocked and still decides.
 */
const session = vi.hoisted(() => ({
  user: null as { id: string; role: string; displayName?: string | null } | null,
  projects: [] as Array<{ id: string; code: string; name: string; status: string }>,
  cookies: new Map<string, string>(),
  cookieWrites: [] as Array<{ op: 'set' | 'delete'; name: string; value?: string; options?: Record<string, unknown> }>,
  path: '/' as string
}));
const callApi = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  apiTimeoutMs: () => 10_000,
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => session.user,
  loadSession: async () => (session.user ? { kind: 'user', user: session.user } : { kind: 'anonymous' }),
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (session.cookies.has(name) ? { name, value: session.cookies.get(name)! } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      session.cookies.set(name, value);
      session.cookieWrites.push({ op: 'set', name, value, options });
    },
    delete: (name: string) => {
      session.cookies.delete(name);
      session.cookieWrites.push({ op: 'delete', name });
    }
  }),
  headers: async () => ({ get: (name: string) => (name === 'x-kanei-request-path' ? session.path : null) })
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  usePathname: () => '/p/PRJ-1/o/FSO-1',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
}));
/** FocusOnMount renders nothing (its work is an effect): the test double leaves a marker so the DOM says WHICH element is handed the focus. */
vi.mock('../apps/web/src/components/FocusOnMount.js', () => ({
  focusHeadingIfIdle: () => false,
  FocusOnMount: ({ targetId, signal }: { targetId: string; signal?: string }) => <span data-focus-on-mount={targetId} data-focus-signal={signal} />
}));
const board = vi.hoisted(() => ({ value: null as unknown }));
const workspaceFixture = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../apps/web/src/lib/maker-po-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/maker-po-data.js')>()),
  loadMakerPoBoard: async () => board.value,
  loadMakerPoDetail: async () => ({ purchaseOrder: null, events: [], error: null })
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadWorkspace: async () => workspaceFixture.value,
  loadSelectableProjectList: async () => ({ projects: session.projects, error: null })
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src');
const readSrc = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
/** A module / export this change adds: on the base commit the import is empty and only the tests needing it fail. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const optional = (load: () => Promise<any>): Promise<any> => load().catch(() => ({}));

const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { StepPanelView } = await import('../apps/web/src/components/StepPanel.js');
const { ApprovalCard } = await import('../apps/web/src/components/ApprovalCard.js');
const { PendingVerificationSection } = await import('../apps/web/src/components/EvidenceVerificationSection.js');
const { buildOrderFlow } = await import('../apps/web/src/lib/order-flow.js');
const { OrderDetailScreen } = await import('../apps/web/src/screens/OrderDetailScreen.js');
const { IDEMPOTENCY_FIELD, RENDERED_PROJECT_FIELD } = await import('../apps/web/src/lib/project-context.js');
/** The real project-data module (the mock above only replaces the workspace read). */
const apiAuditView = await import('../apps/api/src/audit-view.js');
const { EVIDENCE_VERIFICATION_RESULTS } = await import('@kanei/core');
const realData = await vi.importActual<typeof import('../apps/web/src/lib/project-data.js')>('../apps/web/src/lib/project-data.js');

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const SHA = 'a'.repeat(64);
const KEY = '0f6c2c3e-9a51-4b8e-8d1c-2b7f1e6a9c02';
const B64 = Buffer.from('%PDF-1.4 test').toString('base64');
const FILE = { contentBase64: B64, filename: 'receipt.pdf', contentType: 'application/pdf' };

const render = (node: ReactNode, showKorean = false) => renderToStaticMarkup(
  <RenderedContextProvider value={{ projectId: 'project-a', showKorean }}>{node}</RenderedContextProvider>
).replaceAll('<!-- -->', '');
const ok = (data: unknown = { id: 'row-1' }, status = 200) => ({ ok: true, status, data, error: null, errorKo: null, code: null, failure: null });
/** An API refusal as lib/api shapes it (the dictionary text is what the form would show without a step's own words). */
const fail = (status: number, code: string, data: Record<string, unknown> = {}) => ({
  ok: false, status, data: { code, ...data }, error: `dictionary text for ${code}`, errorKo: `사전 ${code}`, code, failure: null
});
const outage = (status = 503) => ({ ok: false, status, data: null, error: 'API unreachable', errorKo: null, code: null, failure: 'unreachable' });
function form(entries: Record<string, string | string[]>, key: string | null = KEY): FormData {
  const data = new FormData();
  data.set(RENDERED_PROJECT_FIELD, 'project-a');
  if (key) data.set(IDEMPOTENCY_FIELD, key);
  for (const [name, value] of Object.entries(entries)) for (const one of Array.isArray(value) ? value : [value]) data.append(name, one);
  return data;
}
const submitLabels = (html: string) => [...html.matchAll(/<button type="submit"[^>]*>([\s\S]*?)<\/button>/g)]
  .map((match) => match[1]!.replace(/<span class="visually-hidden">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').trim());
const visibleText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const PO = { id: 'po-1', poNumber: 'SC-1', poNumberHidden: false, officialRegisteredAt: '2026-11-01', officiallyRegistered: true, verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false };
function order(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'order-1', code: 'FSO-1', status, sevenPurchaseOrderId: 'po-1', lineCount: 1,
    lines: [{ id: 'line-1', lineNumber: 1, description: '合成フィルム', orderedQuantity: '500', unit: 'meters' }],
    detailsHidden: false, statusHidden: false, lastNormalStatus: 'MAKER_PO_READY', paymentTerms: 'prepaid', paymentTermsHidden: false,
    hold: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...extra
  };
}
const slot = (valid: boolean, pending = false) => ({
  organization: 'customer', valid, latestDecision: valid ? 'APPROVE' : null, revoked: false, invalidatedByNewerRevision: false,
  pendingEvidenceIdentifier: pending, manualVerification: null
});
/** The step panel of one order state, built the way the order screen builds it. */
function panel(status: string, role: string, extra: { gate?: unknown; documents?: unknown[]; deliveryContext?: unknown; showKorean?: boolean; order?: Record<string, unknown> } = {}) {
  const o = order(status, extra.order ?? {});
  const flow = buildOrderFlow({
    order: o as never, role, po: PO as never, documents: (extra.documents ?? []) as never, revisions: [], gate: (extra.gate ?? null) as never,
    makerPos: [], makerEvents: [], settledSendEventIds: new Set(), paymentGate: null, deliveries: []
  });
  return render(
    <StepPanelView
      flow={flow} order={o as never} projectCode="PRJ-1" role={role} po={PO as never} gate={(extra.gate ?? null) as never}
      maker={null} makerEvents={[]} documents={(extra.documents ?? []) as never} stateLabel={(key) => key}
      deliveryContext={extra.deliveryContext as never}
    />,
    extra.showKorean ?? false
  );
}

beforeEach(() => {
  session.user = { id: 'u-admin', role: 'admin', displayName: '代表' };
  callApi.mockReset();
  callApi.mockResolvedValue(ok());
  revalidatePath.mockReset();
  board.value = null;
  workspaceFixture.value = null;
  session.projects = [];
  session.cookies = new Map();
  session.cookieWrites = [];
  session.path = '/';
});
// ------------------------------------------------------------------------------------------------
// shared fixtures
// ------------------------------------------------------------------------------------------------
const PRJ = { id: 'project-a', code: 'PRJ-1', name: 'A', route: 'F1' };
const delivery = (id: string, confirmed: boolean, over: Record<string, unknown> = {}) => ({
  id, kind: 'film', orderId: 'order-1', lineId: 'line-1', unit: 'meters', deliveredQuantity: '300', deliverySequence: 1,
  deliveredAt: '2026-11-22T01:00:00Z', recordedAt: '2026-11-22T01:00:00Z', note: null, confirmed, evidenceDocumentVersionId: null,
  confirmedAt: confirmed ? '2026-11-22T02:00:00Z' : null, detailsHidden: false, confirmationHidden: false, ...over
});
const receiptContext = (userId: string, deliveries: unknown[], over: Record<string, unknown> = {}) => ({
  deliveries, userId, filmOnly: true, readiness: null, readinessLabel: (key: string) => key, ...over
});
/** A role's screen of one order: the workspace and the order board as the order screen reads them. */
function serveOrder(role: string, status: string, over: { deliveries?: unknown[]; readiness?: unknown; orderOver?: Record<string, unknown>; documents?: unknown[]; events?: unknown[] } = {}) {
  session.user = { id: `u-${role}`, role };
  const o = order(status, { lines: [], ...(over.orderOver ?? {}) });
  workspaceFixture.value = {
    error: null, projectRefused: false, project: PRJ, labels: null, filmOrders: [o], fillingOrders: [], sevenPurchaseOrders: [PO],
    documents: over.documents ?? [], revisions: [], approvalEvents: [], deliveries: over.deliveries ?? [], readiness: over.readiness ?? null,
    documentVersionsWithheld: false, revisionsWithheld: 0
  };
  board.value = { workspace: workspaceFixture.value, boards: [{ order: o, closure: null, makerPurchaseOrders: [], makerPoError: null, paymentGate: null, paymentGateError: null }] };
  callApi.mockImplementation(async (url: string) => {
    if (url.endsWith('/order-facts')) return ok({ orderedQuantity: '500', orderedUnit: 'meters', updatedAt: null });
    if (url.endsWith('/delivery-status')) return ok({ status: status, lines: [] });
    if (/\/audit-history/.test(url) || /\/film-supply-orders\/[^/]+\/(activity|events)/.test(url)) return ok({ events: over.events ?? [] });
    return ok({ events: over.events ?? [] });
  });
}
const orderScreen = async (started = false, step?: number) => render(await OrderDetailScreen({ projectId: 'project-a', projectCode: 'PRJ-1', orderCode: 'FSO-1', started, ...(step ? { step } : {}) } as never));

// ================================================================================================
// R4 — the auditor's order screen: a masked delivery is not 「確認待ち」
// ================================================================================================
describe('R4 an auditor reads a masked delivery as read-only, never as 「確認待ち」', () => {
  const maskedRow = delivery('del-m', false, { deliveredQuantity: '—', unit: '—', detailsHidden: true });
  const readiness = { readinessState: 'NOT_READY', evaluatedAt: '2026-11-22T03:00:00Z', blocking: ['FILM_ORDER_NOT_DELIVERED'], hidden: false };

  it('step 12 for an auditor: no 「確認待ち」, no 「担当者か代表が…確認します」; it says the view is read-only and where the history is', () => {
    const html = panel('FILM_RECEIPT_ASSUMED_NO_ISSUE', 'auditor', { deliveryContext: receiptContext('u-auditor', [maskedRow]) });
    expect(html).not.toContain('確認待ち');
    expect(html).not.toContain('担当者か代表が受領証跡で納品を確認します');
    expect(html).toContain('閲覧のみ（確認状態は監査履歴で見られます）');
  });

  it('a delivery the auditor CAN read as confirmed still reads 「確認済み」 (the honest case is kept)', () => {
    const html = panel('FILM_RECEIPT_ASSUMED_NO_ISSUE', 'auditor', { deliveryContext: receiptContext('u-auditor', [delivery('del-ok', true)]) });
    expect(html).toContain('フィルムの納品確認済み');
    expect(html).not.toContain('閲覧のみ（確認状態は監査履歴で見られます）');
  });

  it('the project-wide commission readiness is withheld from the auditor (閲覧権限なし), not a 「納品確認待ち」 state', () => {
    const html = panel('FILM_RECEIPT_ASSUMED_NO_ISSUE', 'auditor', { deliveryContext: receiptContext('u-auditor', [maskedRow], { readiness, readinessLabel: () => '納品確認待ち' }) });
    expect(html).not.toContain('納品確認待ち');
    expect(html).not.toContain('未達');
    expect(html).toContain('閲覧権限なし');
  });

  it('staff are untouched: an unconfirmed delivery still waits for the representative', () => {
    const html = panel('FILM_DELIVERED', 'staff', { deliveryContext: receiptContext('u-staff', [delivery('del-s', false)]) });
    expect(html).toContain('フィルムの納品確認待ち');
    expect(html).not.toContain('閲覧のみ（確認状態は監査履歴で見られます）');
  });

  it('T-6: the whole order screen of an auditor (completed order) carries no 「確認待ち」 anywhere, and no Hangul', async () => {
    serveOrder('auditor', 'FILM_RECEIPT_ASSUMED_NO_ISSUE', { deliveries: [maskedRow], readiness });
    const html = await orderScreen();
    expect(html).not.toContain('確認待ち');
    expect(html).not.toMatch(HANGUL);
    expect(html).toContain('閲覧のみ（確認状態は監査履歴で見られます）');
  });
});

// ================================================================================================
// H14 left — a completed order is not read through the project's commission readiness
// ================================================================================================
describe('H14 left: the order says its own delivery first; the project-wide readiness is named as the project\'s', () => {
  const notReady = { readinessState: 'NOT_READY', evaluatedAt: '2026-11-22T03:00:00Z', blocking: ['FILM_ORDER_NOT_DELIVERED'], hidden: false };
  const ctx = (over: Record<string, unknown> = {}) => receiptContext('u-admin', [delivery('del-1', true)], { readiness: notReady, readinessLabel: () => '手数料準備未達', ...over });

  it('a completed order with confirmed deliveries: 「この発注の納品: …確認済み」 first, then 「案件全体の手数料準備（ほかの発注を含む）」', () => {
    const html = panel('FILM_RECEIPT_ASSUMED_NO_ISSUE', 'admin', { deliveryContext: ctx() });
    expect(html).toContain('この発注の納品: フィルムの納品確認済み');
    expect(html).toContain('案件全体の手数料準備（ほかの発注を含む）: 手数料準備未達');
    expect(html.indexOf('この発注の納品: フィルムの納品確認済み')).toBeLessThan(html.indexOf('案件全体の手数料準備（ほかの発注を含む）'));
    expect(html).not.toContain('手数料準備: ');
  });

  it('not evaluated yet: the same project-wide name', () => {
    const html = panel('FILM_RECEIPT_ASSUMED_NO_ISSUE', 'admin', { deliveryContext: ctx({ readiness: null }) });
    expect(html).toContain('案件全体の手数料準備（ほかの発注を含む）: まだ評価されていません');
    expect(html).not.toContain('手数料準備: ');
  });

  it('a delivery still waiting keeps its own line out of the 「確認済み」 wording', () => {
    const html = panel('FILM_DELIVERED', 'admin', { deliveryContext: ctx({ deliveries: [delivery('del-2', false)] }) });
    expect(html).not.toContain('この発注の納品: フィルムの納品確認済み');
    expect(html).toContain('フィルムの納品確認待ち');
  });
});

// ================================================================================================
// M16 left — the old lists use the product's words
// ================================================================================================
const docRow = (over: Record<string, unknown> = {}) => ({
  id: 'doc-1', documentType: 'proof', issuerEntity: 'kanei', filename: 'omote.pdf', verificationStatus: 'unverified', verificationNote: null,
  sevenPurchaseOrderId: 'po-1', filmSupplyOrderId: 'order-1', designKey: '表面A', makerPurchaseOrderId: null, detailsHidden: false, typeHidden: false,
  verificationHidden: false, createdAt: '2026-11-22T01:00:00Z', updatedAt: '2026-11-22T01:00:00Z',
  versions: [{ id: 'ver-1', versionNumber: 1, filename: 'omote.pdf', sha256: SHA, byteSize: 10, createdAt: '2026-11-22T01:00:00Z', detailsHidden: false }], ...over
});
describe('M16 left: 「デザインキー」 / 「製造先」 are gone from the old lists', () => {
  const { LEGACY_TERMS } = { LEGACY_TERMS: [] as ReadonlyArray<readonly [string, string]> };
  it('the documents list names the design 「デザイン名」, never 「デザインキー」', async () => {
    session.user = { id: 'u-admin', role: 'admin' };
    workspaceFixture.value = {
      error: null, projectRefused: false, project: PRJ, labels: null, filmOrders: [order('FILM_SHIPPED')], fillingOrders: [], sevenPurchaseOrders: [PO],
      documents: [docRow()], revisions: [], approvalEvents: [], deliveries: [], readiness: null, documentVersionsWithheld: false, revisionsWithheld: 0
    };
    const { DocumentsScreen } = await import('../apps/web/src/screens/DocumentsScreen.js');
    const html = render(await DocumentsScreen({ projectId: 'project-a', projectCode: 'PRJ-1' } as never));
    expect(html).toContain('デザイン名: 表面A');
    expect(html).not.toContain('デザインキー');
  });

  it('/status: the labels the API serves are drawn in the product\'s words (製造先 → メーカー); the reference codes stay', async () => {
    session.cookies.set('kanei_mvp_session', 'token');
    callApi.mockResolvedValue(ok({
      filmSupplyOrderStates: [{ key: 'MAKER_PO_READY', label: '製造先発注準備完了' }],
      makerPurchaseOrderStatuses: [{ key: 'MAKER_PO_SENT_MANUALLY', label: '製造先送信済み' }, { key: 'DRAFT', label: '製造先発注承認待ち' }],
      commissionReadinessStates: [], fillingDeliveryConfirmationStates: [], approvalOrganizations: []
    }));
    const { default: StatusPage } = await import('../apps/web/src/app/status/page.js');
    const html = render(await StatusPage());
    expect(html).not.toContain('製造先');
    expect(html).toContain('メーカー送信済み');
    expect(html).toContain('メーカー発注承認待ち');
    expect(html).toContain('MAKER_PO_READY');
    expect(html).toContain('メーカー発注準備完了');
  });

  it('modernizeLegacyWords replaces every legacy word and nothing else', async () => {
    const { modernizeLegacyWords } = await import('../apps/web/src/lib/terms.js');
    expect(modernizeLegacyWords('デザインキー')).toBe('デザイン名');
    expect(modernizeLegacyWords('製造先送信済み')).toBe('メーカー送信済み');
    expect(modernizeLegacyWords('メーカー発注準備完了')).toBe('メーカー発注準備完了');
  });

  it('the legacy-word scan knows 「デザインキー」, and covers the documents list and the status page sources', async () => {
    const terms = await import('../apps/web/src/lib/terms.js');
    const words = terms.LEGACY_TERMS.map(([word]: readonly [string, string]) => word);
    expect(words).toContain('デザインキー');
    for (const file of ['screens/DocumentsScreen.tsx', 'app/status/page.tsx', 'components/DocumentUploadForm.tsx', 'lib/form-messages.ts', 'app/actions.ts']) {
      for (const word of words) expect(readSrc(file), `${file}: ${word}`).not.toContain(word);
    }
    void LEGACY_TERMS;
  });
});

// ================================================================================================
// R15 / M4 — the order's records say WHICH file and WHAT note
// ================================================================================================
describe('R15 / M4 the 記録 list names the registered file and shows the memo', () => {
  const { orderRecordText, orderRecordDetail } = { orderRecordText: null as never, orderRecordDetail: null as never };
  void orderRecordText; void orderRecordDetail;
  const events = [
    { id: 'e3', action: 'FILM_SUPPLY_ORDER_TRANSITIONED', entityType: 'film_supply_order', entityId: 'order-1', occurredAt: '2026-11-22T03:00:00Z', actor: { id: 'u1', displayName: '担当 花子' }, afterState: { status: 'ARTWORK_RECEIVED', evidenceNote: '表面Aの最終データ（合成・M4確認）' } },
    { id: 'e2', action: 'DOCUMENT_VERSION_UPLOADED', entityType: 'document_version', entityId: 'ver-1', occurredAt: '2026-11-22T02:00:00Z', actor: { id: 'u1', displayName: '担当 花子' }, afterState: { documentType: 'acceptance_evidence', originalFilename: 'receipt-0007.pdf', versionNumber: 1, filmSupplyOrderId: 'order-1' } },
    { id: 'e1', action: 'DOCUMENT_CREATED', entityType: 'document', entityId: 'doc-1', occurredAt: '2026-11-22T01:00:00Z', actor: { id: 'u1', displayName: '担当 花子' }, afterState: { documentType: 'proof', filename: 'omote.pdf', filmSupplyOrderId: 'order-1' } }
  ];
  const records = (html: string) => /<ol class="p1-record-list">[\s\S]*?<\/ol>/.exec(html)?.[0] ?? '';

  it('R15: 「書類を登録」 / 「書類の版を登録」 carry the file name and the kind of document', async () => {
    serveOrder('admin', 'FILM_SHIPPED', { events });
    const list = records(await orderScreen());
    expect(list).toMatch(/書類を登録[\s\S]*?omote\.pdf/);
    expect(list).toContain('校正ゲラ');
    expect(list).toMatch(/書類の版を登録[\s\S]*?receipt-0007\.pdf/);
    expect(list).toContain('受領証跡（検収）');
  });

  it('M4: a transition\'s memo (evidenceNote) is on the row as 「メモ: …」, printed as text', async () => {
    serveOrder('admin', 'FILM_SHIPPED', { events: [{ ...events[0], afterState: { status: 'ARTWORK_RECEIVED', evidenceNote: '<b>x</b>最終データ' } }] });
    const list = records(await orderScreen());
    expect(list).toContain('メモ: ');
    expect(list).toContain('&lt;b&gt;x&lt;/b&gt;最終データ');
    expect(list).not.toContain('<b>x</b>');
  });

  it('M4: only a transition\'s memo is a memo — an evidenceNote key on another kind of record is not drawn', async () => {
    serveOrder('admin', 'FILM_SHIPPED', { events: [{ ...events[2], afterState: { documentType: 'proof', filename: 'omote.pdf', filmSupplyOrderId: 'order-1', evidenceNote: '別の記録のメモ' } }] });
    const list = records(await orderScreen());
    expect(list).toContain('omote.pdf');
    expect(list).not.toContain('別の記録のメモ');
  });

  it('M4: the real memo of the base fixture shows, and a record without a memo or file shows neither label', async () => {
    serveOrder('admin', 'FILM_SHIPPED', { events });
    const list = records(await orderScreen());
    expect(list).toContain('メモ: 表面Aの最終データ（合成・M4確認）');
    serveOrder('admin', 'FILM_SHIPPED', { events: [{ id: 'e9', action: 'FILM_SUPPLY_ORDER_TRANSITIONED', entityType: 'film_supply_order', entityId: 'order-1', occurredAt: '2026-11-22T03:00:00Z', actor: null, afterState: { status: 'ARTWORK_RECEIVED' } }] });
    expect(records(await orderScreen())).not.toContain('メモ');
    // A role whose answer carries no file name (trimmed state) says nothing invented.
    serveOrder('staff', 'FILM_SHIPPED', { events: [{ ...events[2], afterState: { id: 'doc-1', status: 'x', filmSupplyOrderId: 'order-1' } }] });
    expect(records(await orderScreen())).not.toContain('omote.pdf');
  });
});

// ================================================================================================
// R10 — the assignment records have words
// ================================================================================================
describe('R10 an assignment is 「担当を割り当て」 / 「担当を外す」 in the recent records, not 「記録を記録」', () => {
  const NOW = new Date('2026-11-23T03:00:00.000Z');
  const labels = { filmSupplyOrderStates: [], makerPurchaseOrderStatuses: [], commissionReadinessStates: [], fillingDeliveryConfirmationStates: [], approvalOrganizations: [] };
  const row = (id: string, action: string) => ({ id, action, entityType: 'project_assignment', entityId: id, occurredAt: '2026-11-23T02:00:00Z', actor: { id: 'u1', displayName: '代表' }, afterState: {}, beforeState: null, requestMetadata: {} });
  it('the dashboard activity', async () => {
    const { buildDashboard } = await import('../apps/web/src/lib/dashboard.js');
    const view = buildDashboard({
      role: 'admin', now: NOW, projectCode: 'PRJ-1', boards: [], activity: [row('a1', 'PROJECT_ASSIGNMENT_CREATED'), row('a2', 'PROJECT_ASSIGNMENT_REMOVED')],
      workspace: { labels, filmOrders: [], sevenPurchaseOrders: [], revisions: [], revisionsWithheld: 0, documents: [], deliveries: [], readiness: null }
    } as never);
    const texts = view.activity.map((item: { text: string }) => item.text);
    expect(texts).toEqual(expect.arrayContaining(['担当を割り当て', '担当を外す']));
    expect(texts.join('\n')).not.toContain('記録を記録');
  });
  it('the order screen\'s record list (same wording table)', async () => {
    const { ACTION_LABELS } = await import('../apps/web/src/lib/dashboard.js');
    expect(ACTION_LABELS.PROJECT_ASSIGNMENT_CREATED).toBe('担当を割り当て');
    expect(ACTION_LABELS.PROJECT_ASSIGNMENT_REMOVED).toBe('担当を外す');
  });
});

// ================================================================================================
// R11 — the evidence list tells the document check from the identifier check of an approval evidence
// (round 2, review M-1: the server writes `confirmed`, and staff rows carry no result — the rows below are the REAL answers of
//  apps/api/src/audit-view.ts per role, built from full server states; nothing here is a hand-written web-side shape)
// ================================================================================================
describe('R11 an approval evidence says its identifier check: 自動確認済み / 手動確認待ち / 手動確認済み / 却下', () => {
  const { buildAuditViewForRole } = apiAuditView;
  const [CONFIRMED, REJECTED] = EVIDENCE_VERIFICATION_RESULTS;
  const SLOT_ORG = 'customer';
  const doc = (id: string, designKey: string, over: Record<string, unknown> = {}) => ({
    documentId: id, documentType: 'approval_evidence', issuerEntity: 'customer_generated', originalFilename: `${id}.eml`, orderCode: 'FSO-1', designKey,
    verificationStatus: 'unverified', verifiedAt: null, verifiedBy: null, createdAt: '2026-11-22T01:00:00Z', createdBy: { displayName: '担当' },
    versions: [{ versionId: `v-${id}`, versionNumber: 1, originalFilename: `${id}.eml`, sha256: SHA, uploadedAt: '2026-11-22T01:00:00Z', uploadedBy: { displayName: '担当' } }], ...over
  });
  /** The FULL server rows (what the database holds), before any role trimming. */
  const row = (id: string, action: string, entityType: string, entityId: string, at: string, afterState: Record<string, unknown>) =>
    ({ id, action, entityType, entityId, beforeState: null, afterState, occurredAt: new Date(at), requestMetadata: {}, actor: null });
  const approval = (id: string, designKey: string, status: string, at = '2026-11-22T02:00:00Z', org = SLOT_ORG) =>
    row(`a-${id}`, 'ARTWORK_APPROVAL_RECORDED', 'artwork_approval_event', `ev-${id}`, at, {
      id: `ev-${id}`, artworkRevisionId: 'rev-1', organization: org, decision: 'APPROVE', recordedByUserId: 'u1', evidenceDocumentVersionId: `v-${id}`,
      evidenceIdentifier: 'REV-0001 ¥480,000', evidenceIdentifierStatus: status, evidenceSource: 'email', approvedFileSha256: SHA, designKey, revisionNo: 1,
      evidenceIssuerEntity: 'customer_generated', issuerMatchesOrganization: true
    });
  const check = (id: string, designKey: string, result: string, at: string) =>
    row(`m-${id}-${at}`, 'EVIDENCE_MANUAL_VERIFICATION_RECORDED', 'artwork_approval_event', `ev-${id}`, at, {
      id: `ver-${id}`, approvalEventId: `ev-${id}`, artworkRevisionId: 'rev-1', evidenceDocumentVersionId: `v-${id}`, approvedFileSha256: SHA, result,
      verifierName: '代表', verifiedAt: at, reasonNote: '金額 ¥480,000 の発注書と照合', recordedByUserId: 'u-admin', recordedAt: at,
      designKey, revisionNo: 1, organization: SLOT_ORG, evidenceIdentifier: 'REV-0001 ¥480,000', verificationType: 'evidence_manual_verification', verifiedByUserId: 'u-admin'
    });
  /** The approval gate's slot, as GET …/approval-gate answers every role that may read it. */
  const gateSlot = (decided: boolean, result: string | null, over: Record<string, unknown> = {}) => ({
    organization: SLOT_ORG, valid: decided && result !== REJECTED, latestDecision: decided ? 'APPROVE' : null, revoked: false, invalidatedByNewerRevision: false,
    pendingEvidenceIdentifier: decided && result !== CONFIRMED, manualVerification: result ? { result, verifierName: '代表', verifiedAt: '2026-11-22T03:00:00Z', recordedAt: '2026-11-22T03:00:00Z' } : null, ...over
  });
  const gateFor = (slots: Record<string, unknown>) => ({
    orderId: 'order-1', orderStatus: 'APPROVAL_PENDING', dualApproved: false, missingApprovals: [], pendingManualVerifications: [],
    designs: Object.entries(slots).map(([designKey, slotValue]) => ({ designKey, currentRevisionId: 'rev-1', currentRevisionNo: 1, fileSha256: SHA, customer: slotValue, seven: gateSlot(false, null), dualApproved: false }))
  });
  const serve = (documents: unknown[], rows: unknown[] | 'fail', role: string, gate: unknown | 'fail' = 'fail') => {
    session.user = { id: `u-${role}`, role };
    callApi.mockImplementation(async (url: string) => {
      if (url.includes('/evidence-metadata')) return ok({ documents, truncated: false, limit: 200 });
      if (url.includes('/audit-history')) return rows === 'fail' ? fail(500, 'X') : ok({ events: buildAuditViewForRole(role as never, (rows as never[]).slice().sort((a: never, b: never) => (b as { occurredAt: Date }).occurredAt.getTime() - (a as { occurredAt: Date }).occurredAt.getTime())) });
      if (url.includes('/approval-gate')) return gate === 'fail' ? fail(403, 'FORBIDDEN') : ok(gate);
      return ok({ orders: [{ id: 'order-1', code: 'FSO-1' }] });
    });
  };
  const evidenceHtml = async () => {
    const { EvidenceScreen } = await import('../apps/web/src/screens/EvidenceScreen.js');
    return render(await EvidenceScreen({ projectId: 'project-a', projectCode: 'PRJ-1' } as never));
  };
  const cell = (html: string, id: string) => new RegExp(`id="doc-${id}"[\\s\\S]*?data-label="確認状態">([\\s\\S]*?)</td>`).exec(html)?.[1] ?? '';
  const DOCS = [doc('d1', '表面A'), doc('d2', '表面B'), doc('d3', '表面C'), doc('d4', '表面D'), doc('d5', '表面E')];
  /** d1 auto · d2 pending, nobody checked · d3 checked 確認 · d4 checked 却下 · d5 not applicable — as the database holds them. */
  const ROWS = () => [
    approval('d1', '表面A', 'verified_in_document'), approval('d2', '表面B', 'pending_manual_verification'), approval('d3', '表面C', 'pending_manual_verification'),
    approval('d4', '表面D', 'pending_manual_verification'), approval('d5', '表面E', 'not_applicable'),
    check('d3', '表面C', CONFIRMED, '2026-11-22T03:00:00Z'), check('d4', '表面D', REJECTED, '2026-11-22T03:00:00Z')
  ];
  const GATE = () => gateFor({ 表面A: gateSlot(true, null, { pendingEvidenceIdentifier: false }), 表面B: gateSlot(true, null), 表面C: gateSlot(true, CONFIRMED), 表面D: gateSlot(true, REJECTED), 表面E: gateSlot(true, null, { pendingEvidenceIdentifier: false }) });

  it('the server\'s own vocabulary is the one read: 確認 is `confirmed` (core EVIDENCE_VERIFICATION_RESULTS), not `verified`', () => {
    expect([CONFIRMED, REJECTED]).toEqual(['confirmed', 'rejected']);
  });

  it.each(['admin', 'auditor'])('%s (rows carry the result): 自動確認済み / 手動確認待ち / 手動確認済み / 却下 / 対象外, each on its own row, the document check on its own line', async (role) => {
    serve(DOCS, ROWS(), role);
    const html = await evidenceHtml();
    expect(cell(html, 'd1')).toContain('識別子: 自動確認済み');
    expect(cell(html, 'd2')).toContain('識別子: 手動確認待ち');
    expect(cell(html, 'd3')).toContain('識別子: 手動確認済み');
    expect(cell(html, 'd4')).toContain('識別子: 却下');
    expect(cell(html, 'd5')).toContain('識別子: 確認の対象外');
    expect(cell(html, 'd1')).toContain('書類の確認: 未確認');
    // The gate is not needed for these roles.
    expect(callApi.mock.calls.some((call) => String(call[0]).includes('/approval-gate'))).toBe(false);
    expect(html).not.toMatch(HANGUL);
  });

  it('staff (the rows carry NO result): a checked evidence is never 「手動確認待ち」; the result comes from the order\'s approval gate, and no amount is drawn', async () => {
    serve(DOCS, ROWS(), 'staff', GATE());
    const html = await evidenceHtml();
    expect(cell(html, 'd1')).toContain('識別子: 自動確認済み');
    expect(cell(html, 'd2')).toContain('識別子: 手動確認待ち'); // really nobody checked it
    expect(cell(html, 'd3')).toContain('識別子: 手動確認済み');
    expect(cell(html, 'd4')).toContain('識別子: 却下');
    expect(html).not.toContain('480,000');
    expect(html).not.toContain('金額');
    expect(html).not.toMatch(HANGUL);
    // Only the orders that have a check without a readable result are asked (one gate read for FSO-1).
    expect(callApi.mock.calls.filter((call) => String(call[0]).includes('/approval-gate'))).toHaveLength(1);
  });

  it('staff and the gate cannot be read: the checked evidence says 「手動確認を記録済み（結果は代表・監査が確認）」 — true, and never 「待ち」', async () => {
    serve(DOCS, ROWS(), 'staff', 'fail');
    const html = await evidenceHtml();
    for (const id of ['d3', 'd4']) {
      expect(cell(html, id)).toContain('識別子: 手動確認を記録済み（結果は代表・監査が確認）');
      expect(cell(html, id)).not.toContain('待ち');
    }
    expect(cell(html, 'd2')).toContain('識別子: 手動確認待ち');
  });

  it('staff: a superseded approval (a newer approval of the same slot exists) keeps 「記録済み」 — the gate speaks only for the newest', async () => {
    const older = doc('d6', '表面F'); const newer = doc('d7', '表面F', { createdAt: '2026-11-22T05:00:00Z' });
    const rows = [
      approval('d6', '表面F', 'pending_manual_verification', '2026-11-22T02:00:00Z'), check('d6', '表面F', REJECTED, '2026-11-22T03:00:00Z'),
      approval('d7', '表面F', 'pending_manual_verification', '2026-11-22T05:00:00Z'), check('d7', '表面F', CONFIRMED, '2026-11-22T06:00:00Z')
    ];
    serve([older, newer], rows, 'staff', gateFor({ 表面F: gateSlot(true, CONFIRMED) }));
    const html = await evidenceHtml();
    expect(cell(html, 'd7')).toContain('識別子: 手動確認済み');
    expect(cell(html, 'd6')).toContain('識別子: 手動確認を記録済み');
    expect(cell(html, 'd6')).not.toContain('却下');
  });

  it('staff: a revoked slot, a slot of another revision or a slot with no decision is not read as the result', async () => {
    for (const odd of [{ revoked: true }, { invalidatedByNewerRevision: true }, { latestDecision: null }]) {
      serve([doc('d3', '表面C')], [approval('d3', '表面C', 'pending_manual_verification'), check('d3', '表面C', CONFIRMED, '2026-11-22T03:00:00Z')], 'staff', gateFor({ 表面C: gateSlot(true, CONFIRMED, odd) }));
      expect(cell(await evidenceHtml(), 'd3'), JSON.stringify(odd)).toContain('識別子: 手動確認を記録済み');
    }
  });

  it('the newest manual check wins (a rejection followed by a later 確認 reads 手動確認済み)', async () => {
    serve([doc('d6', '表面F')], [approval('d6', '表面F', 'pending_manual_verification'), check('d6', '表面F', REJECTED, '2026-11-22T03:00:00Z'), check('d6', '表面F', CONFIRMED, '2026-11-22T04:00:00Z')], 'admin');
    expect(cell(await evidenceHtml(), 'd6')).toContain('識別子: 手動確認済み');
  });

  it('a document that is not an approval evidence keeps the plain check; an unreadable history invents nothing', async () => {
    serve([doc('p1', '表面A', { documentType: 'proof' }), doc('d7', '表面B')], 'fail', 'staff');
    const html = await evidenceHtml();
    expect(cell(html, 'p1')).not.toContain('識別子');
    expect(cell(html, 'd7')).not.toContain('識別子');
    expect(cell(html, 'd7')).toContain('未確認');
  });

  it('review L-7: when the read window is full, the list says it judges from the newest 500 approval records', async () => {
    const filler = Array.from({ length: 500 }, (_, index) => approval(`f${index}`, `表面${index}`, 'verified_in_document', new Date(Date.parse('2026-11-22T00:00:00Z') + index * 1000).toISOString()));
    serve([doc('d1', '表面0')], filler, 'auditor');
    expect(await evidenceHtml()).toContain('data-identifier-window="full"');
    serve([doc('d1', '表面A')], ROWS(), 'auditor');
    expect(await evidenceHtml()).not.toContain('data-identifier-window');
  });
});

// ================================================================================================
// R7 / T-8 — Japanese-only roles read no Hangul on the guide, the session notice, the outage and the 404
// ================================================================================================
describe('R7 / T-8 staff, viewer and auditor read no Korean on the guide, the notices and the 404', () => {
  const ROLES = ['staff', 'viewer', 'auditor'];
  it.each(ROLES)('/guide for %s: no Hangul (the 「한국어 설명」 blocks follow the display language)', async (role) => {
    session.user = { id: `u-${role}`, role };
    const { default: GuidePage } = await import('../apps/web/src/app/guide/page.js');
    expect(render(await GuidePage())).not.toMatch(HANGUL);
  });

  it('/guide for the representative (bilingual by default) still carries the Korean explanation; with the Japanese-only mode it does not', async () => {
    session.user = { id: 'u-admin', role: 'admin' };
    const { default: GuidePage } = await import('../apps/web/src/app/guide/page.js');
    const bilingual = render(await GuidePage());
    expect(bilingual).toContain('한국어 설명');
    session.cookies.set('kanei_web_lang', 'u-admin.ja');
    expect(render(await GuidePage())).not.toMatch(HANGUL);
  });

  it.each(['login', 'expired', 'outage'] as const)('SessionNotice (%s) with the Korean line off: no Hangul; on: the Korean line is there', async (kind) => {
    const { SessionNotice } = await import('../apps/web/src/components/SessionNotice.js');
    const off = render(<SessionNotice kind={kind} path="/home" code={kind === 'outage' ? 'DB_UNAVAILABLE' : null} showKorean={false} />);
    expect(off).not.toMatch(HANGUL);
    const on = render(<SessionNotice kind={kind} path="/home" code={kind === 'outage' ? 'DB_UNAVAILABLE' : null} showKorean />);
    expect(on).toMatch(HANGUL);
  });

  it('no session: the Korean line follows the display language kept in the browser (cookie), hidden when there is none', async () => {
    const { languageWithoutSession } = await import('../apps/web/src/lib/locale.js');
    expect(languageWithoutSession(undefined)).toBe('ja');
    expect(languageWithoutSession('')).toBe('ja');
    expect(languageWithoutSession('garbage')).toBe('ja');
    expect(languageWithoutSession('u-admin.ja-ko')).toBe('ja-ko');
    expect(languageWithoutSession('u-admin.ko')).toBe('ko');
    expect(languageWithoutSession('u-staff.ja')).toBe('ja');
    const { displayLanguage } = await import('../apps/web/src/lib/locale-server.js');
    expect((await displayLanguage(null)).showKorean).toBe(false);
    session.cookies.set('kanei_web_lang', 'u-admin.ja-ko');
    expect((await displayLanguage(null)).showKorean).toBe(true);
  });

  it('the root layout hands the display language to the notice of a lost session (cookie → Korean line; none → Japanese only)', async () => {
    session.user = null;
    session.path = '/home';
    const { default: RootLayout } = await import('../apps/web/src/app/layout.js');
    const layout = async () => renderToStaticMarkup(await RootLayout({ children: <p>screen</p> })).replaceAll('<!-- -->', '');
    expect(await layout()).not.toMatch(HANGUL);
    session.cookies.set('kanei_web_lang', 'u-admin.ja-ko');
    const html = await layout();
    expect(html).toContain('session-notice');
    expect(html).toMatch(HANGUL);
    session.cookies.set('kanei_web_lang', 'u-staff.ja');
    expect(await layout()).not.toMatch(HANGUL);
  });

  it.each(['site', 'project'] as const)('the 404 (%s) with the Korean line off: no Hangul', async (scope) => {
    const { NotFoundNotice } = await import('../apps/web/src/components/NotFoundNotice.js');
    expect(render(<NotFoundNotice scope={scope} />, false)).not.toMatch(HANGUL);
    expect(render(<NotFoundNotice scope={scope} />, true)).toMatch(HANGUL);
  });
});

// ================================================================================================
// R9 — focus lands somewhere after the wizard and after an assignment
// ================================================================================================
describe('R9 focus: the order heading after the wizard, the result sentence after an assignment', () => {
  it('?started=1: the screen hands the focus to its heading (it is focusable); without it nothing is moved', async () => {
    serveOrder('staff', 'SEVEN_PO_VERIFIED');
    const started = await orderScreen(true);
    expect(started).toContain('data-focus-on-mount="order-title"');
    expect(started).toMatch(/<h1 id="order-title"[^>]*tabindex="-1"/);
    serveOrder('staff', 'SEVEN_PO_VERIFIED');
    expect(await orderScreen(false)).not.toContain('data-focus-on-mount');
  });

  const view = { assignments: [{ userId: '0192a000-0000-7000-8000-0000000000b1', displayName: '担当 花子', role: 'staff', isActive: true, assignedAt: '2026-11-23T01:00:00Z' }], error: null, truncated: false };
  const directory = { candidates: [], truncated: false, error: null };
  it('after an assignment the result sentence takes the focus; with no notice the panel moves nothing', async () => {
    const { ProjectAssignmentsPanel } = await import('../apps/web/src/components/ProjectAssignmentsPanel.js');
    const notice = { projectId: 'project-a', kind: 'added', userId: '0192a000-0000-7000-8000-0000000000b1', at: '2026-11-23T01:00:00Z' };
    const withNotice = render(<ProjectAssignmentsPanel view={view as never} directory={directory as never} notice={notice as never} />);
    expect(withNotice).toMatch(/<p id="assignment-status"[^>]*tabindex="-1"[^>]*role="status"|<p id="assignment-status"[^>]*role="status"[^>]*tabindex="-1"/);
    expect(withNotice).toContain('data-focus-on-mount="assignment-status"');
    expect(withNotice).toContain('担当 花子 を担当者に割り当てました');
    // review L-1: the same element is told again after a REMOVAL — the signal differs, so the focus effect runs again.
    const removed = render(<ProjectAssignmentsPanel view={view as never} directory={directory as never} notice={{ ...notice, kind: 'removed', at: '2026-11-23T01:05:00Z' } as never} />);
    const signalOf = (html: string) => /data-focus-signal="([^"]*)"/.exec(html)?.[1];
    expect(signalOf(withNotice)).toBeTruthy();
    expect(signalOf(removed)).toBeTruthy();
    expect(signalOf(removed)).not.toBe(signalOf(withNotice));
    const without = render(<ProjectAssignmentsPanel view={view as never} directory={directory as never} notice={null} />);
    expect(without).not.toContain('data-focus-on-mount');
  });
});

// ================================================================================================
// R13 — one 支払条件 form at step 7 (the step panel's), not two
// ================================================================================================
describe('R13 a 「未定」 order at step 7 has ONE payment-terms form', () => {
  const forms = (html: string) => (html.match(/<select[^>]*name="paymentTerms"/g) ?? []).length;
  const undetermined = { paymentTerms: 'undetermined', paymentTermsUndetermined: true, paymentTermsEditable: true };

  it('MAKER_PO_READY with 未定: only the step panel\'s form (the 「発注の条件」 one is hidden)', async () => {
    serveOrder('admin', 'MAKER_PO_READY', { orderOver: undetermined });
    const html = await orderScreen();
    expect(html).toContain('進められません');
    expect(forms(html)).toBe(1);
  });

  it('MAKER_PO_READY with 未定 for staff: the same single form', async () => {
    serveOrder('staff', 'MAKER_PO_READY', { orderOver: undetermined });
    expect(forms(await orderScreen())).toBe(1);
  });

  it('where the step panel carries no such form the 「支払条件を変更する」 form stays (a decided term; an earlier step)', async () => {
    serveOrder('admin', 'MAKER_PO_READY', { orderOver: { paymentTerms: 'prepaid', paymentTermsUndetermined: false, paymentTermsEditable: true } });
    expect(forms(await orderScreen())).toBe(1);
    serveOrder('admin', 'SEVEN_PO_VERIFIED', { orderOver: undetermined });
    expect(forms(await orderScreen())).toBe(1);
  });
});

// ================================================================================================
// R14 — the 44px download link
// ================================================================================================
describe('R14 the 「ダウンロード」 link of the documents list is a touch target', () => {
  it('every download link carries the touch-target class (its 44px is measured live in ego-browser: evidence/R14-*.txt)', async () => {
    session.user = { id: 'u-admin', role: 'admin' };
    workspaceFixture.value = {
      error: null, projectRefused: false, project: PRJ, labels: null, filmOrders: [order('FILM_SHIPPED')], fillingOrders: [], sevenPurchaseOrders: [PO],
      documents: [docRow(), docRow({ id: 'doc-2', versions: [{ id: 'ver-2', versionNumber: 1, filename: 'b.pdf', sha256: SHA, byteSize: 10, createdAt: '2026-11-22T01:00:00Z', detailsHidden: false }] })],
      revisions: [], approvalEvents: [], deliveries: [], readiness: null, documentVersionsWithheld: false, revisionsWithheld: 0
    };
    const { DocumentsScreen } = await import('../apps/web/src/screens/DocumentsScreen.js');
    const html = render(await DocumentsScreen({ projectId: 'project-a', projectCode: 'PRJ-1' } as never));
    const links = [...html.matchAll(/<a\b[^>]*>(?:ダウンロード)<\/a>/g)].map((match) => match[0]);
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toContain('class="p4w3-target"');
  });
});

// ================================================================================================
// the send dialog shows seconds (N2 left: display)
// ================================================================================================
describe('N2 left: the send confirmation shows the EML Date to the second', () => {
  it('the EML defaults keep the exact instant beside the minute value', async () => {
    const { readEmlFormDefaults, toDatetimeLocalValue } = await import('../apps/web/src/lib/eml-form.js');
    const defaults = readEmlFormDefaults('From: a@maker.example\r\nDate: Mon, 23 Nov 2026 08:09:40 +0900\r\n\r\nbody');
    expect(defaults.sentAtExact).toBe('2026-11-22T23:09:40.000Z');
    expect(defaults.sentAt).toBe(toDatetimeLocalValue(new Date('2026-11-22T23:09:40.000Z')));
  });

  it('the dialog row reads 日本時間 …08:09:40 while the value is the EML\'s; an edited time falls back to the minute', async () => {
    const { makerPoSendConfirmSpec } = await import('../apps/web/src/lib/confirm-summary.js');
    const { toDatetimeLocalValue } = await import('../apps/web/src/lib/eml-form.js');
    const exact = '2026-11-22T23:09:40.000Z';
    const base = { senderAddress: 'a@maker.example', recipients: 'b@kanei.example', emlFilename: 'a.eml', hasEmlContent: true, versionText: '' };
    const row = (spec: { summary: Array<{ label: string; value: string }> }) => spec.summary.find((item) => item.label === '送信日時')!.value;
    expect(row(makerPoSendConfirmSpec({ ...base, sentAtLocal: toDatetimeLocalValue(new Date(exact)), sentAtExactIso: exact }))).toMatch(/^日本時間 2026\/11\/23（月）08:09:40$/);
    expect(row(makerPoSendConfirmSpec({ ...base, sentAtLocal: toDatetimeLocalValue(new Date('2026-11-23T00:30:00.000Z')), sentAtExactIso: exact }))).toMatch(/^日本時間 2026\/11\/23（月）09:30$/);
    expect(row(makerPoSendConfirmSpec({ ...base, sentAtLocal: toDatetimeLocalValue(new Date(exact)) }))).toMatch(/^日本時間 2026\/11\/23（月）08:09$/);
  });
});

// ================================================================================================
// R12 — a successful submit drops the draft (after a re-draw too)
// ================================================================================================
describe('R12 the draft of a form that was submitted is dropped even when the form is re-drawn before its reset', () => {
  it('drop decision: submitted and not refused → drop at unmount; refused or never submitted → keep', async () => {
    const { draftLifecycle } = await import('../apps/web/src/lib/unsaved-guard.js');
    const lifecycle = draftLifecycle();
    expect(lifecycle.dropOnUnmount()).toBe(false);
    lifecycle.submitted();
    expect(lifecycle.dropOnUnmount()).toBe(true);
    lifecycle.refused();
    expect(lifecycle.dropOnUnmount()).toBe(false);
    lifecycle.submitted();
    expect(lifecycle.dropOnUnmount()).toBe(true);
    lifecycle.reset();
    expect(lifecycle.dropOnUnmount()).toBe(false);
  });
});

// ================================================================================================
// R2 / M12 — the approval card at 390px: what the representative types and the approve button first, the long evidence folded
// ================================================================================================
describe('R2 / M12 the approval card folds its long evidence and keeps the approval inputs outside the fold', () => {
  const seal = (state: string, evidence: Record<string, unknown> | null = null) => ({ state, eventTime: '2026-11-20T01:00:00Z', approvalEventId: 'ev', evidence });
  const clean = (over: Record<string, unknown> = {}) => ({
    source: 'server', poId: 'mpo-1', orderId: 'order-1', displayNumber: 'MPO-2026-0001', status: 'DRAFT', orderCode: 'FSO-1', paymentTerms: 'prepaid', amountDisplay: null,
    items: [{ lineNumber: 1, description: '合成フィルム', quantityDisplay: '500 m' }],
    artworkFiles: [{ designKey: '表面A', revisionNo: 1, sha256: SHA, filename: 'omote.pdf', matchesApprovedRevision: true }],
    recipient: { address: 'order@maker.example', isEmail: true, inMakerMaster: true },
    deliveryTerms: { requestedDeliveryDate: '2026-12-15', plannedDeliveryDate: null, sevenPo: { quantityDisplay: '500 メートル', amountDisplay: null } },
    sevenPo: { poNumber: 'SC-1', officialRegisteredAt: '2026-11-01', verificationStatus: 'verified' },
    designs: [{ designKey: '表面A', currentRevisionNo: 1, customer: seal('approved'), seven: seal('approved') }], dualApproved: true,
    blockers: [], warnings: [], canApprove: true, canReturn: true, expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA, ...over
  });
  const fold = (html: string) => /<details class="p5-fold"[\s\S]*?<\/details>/.exec(html)?.[0] ?? '';
  const cardHtml = (card: unknown) => render(<ApprovalCard card={card as never} korean={false} />);

  it('the fold holds the lines, the approved file, the 押印欄, the セブン化学発注書 and the recipient — all of it, nothing dropped', () => {
    const html = cardHtml(clean());
    const folded = fold(html);
    expect(folded).not.toBe('');
    for (const text of ['明細', '合成フィルム', '校了した版', 'omote.pdf', '承認の押印欄', 'セブン化学発注書', 'SC-1', '送信先', 'order@maker.example']) {
      expect(folded, text).toContain(text);
    }
    // The summary names the stamps, so a folded card still says what stands.
    expect(/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(folded)?.[1] ?? '').toMatch(/顧客[^<]*承認[\s\S]*セブン化学[^<]*承認/);
  });

  it('what the representative types and presses stays OUTSIDE the fold: the amount field, the approve button, the 希望納期 form', () => {
    const html = cardHtml(clean());
    const outside = html.replace(fold(html), '');
    expect(outside).toContain('name="totalAmount"');
    expect(outside).toContain('承認の前に、次を入力してください');
    expect(outside).toContain('MPO-2026-0001 を代表承認する');
    expect(fold(html)).not.toContain('name="totalAmount"');
    expect(fold(html)).not.toContain('代表承認する');
    const needsDate = cardHtml(clean({ blockers: [{ code: 'DELIVERY_DATE_REQUIRED', message: 'x' }] }));
    expect(needsDate.replace(fold(needsDate), '')).toContain('name="requestedDeliveryDate"');
    expect(fold(needsDate)).not.toContain('name="requestedDeliveryDate"');
  });

  it('a clean card may close on a phone (data-keep-open="false"); any warning keeps it open', () => {
    expect(fold(cardHtml(clean()))).toContain('data-keep-open="false"');
    const warned = { evidence: { filename: 'x.eml', issuerEntity: 'customer_generated', evidenceSource: 'email', declarationLine: { code: 'sender_domain_mismatch', tone: 'warning', label: '申告は承認組織と一致・差出人のドメインは不一致' }, warnings: [{ code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', ja: '差出人のドメインが登録先と一致しません' }] } };
    const cases: Array<[string, unknown]> = [
      ['a sender-domain warning on a stamp', clean({ designs: [{ designKey: '表面A', currentRevisionNo: 1, customer: seal('approved', warned.evidence), seven: seal('approved') }] })],
      ['a stamp that is not an approval', clean({ designs: [{ designKey: '表面A', currentRevisionNo: 1, customer: seal('approved'), seven: seal('pending_manual_verification') }], dualApproved: false })],
      ['a typed recipient outside the maker master', clean({ recipient: { address: 'x@maker.example', isEmail: true, inMakerMaster: false } })],
      ['a recipient that is no e-mail address', clean({ recipient: { address: 'not-mail', isEmail: false, inMakerMaster: null } })],
      ['a セブン化学発注書 not checked', clean({ sevenPo: { poNumber: 'SC-1', officialRegisteredAt: null, verificationStatus: null } })],
      ['an artwork file that differs from the approved version', clean({ artworkFiles: [{ designKey: '表面A', revisionNo: 1, sha256: SHA, filename: 'omote.pdf', matchesApprovedRevision: false }] })],
      ['a second design whose evidence carries a warning', clean({ designs: [{ designKey: '表面A', currentRevisionNo: 1, customer: seal('approved'), seven: seal('approved') }, { designKey: '裏面B', currentRevisionNo: 1, customer: seal('approved', warned.evidence), seven: seal('approved') }] })]
    ];
    for (const [name, card] of cases) expect(fold(cardHtml(card)), name).toContain('data-keep-open="true"');
  });

  it('the fold is closed on a phone and open elsewhere, unless something must be seen (pure rule the component applies)', async () => {
    const { foldOpenState } = await import('../apps/web/src/components/MobileFold.js');
    expect(foldOpenState({ narrow: true, keepOpen: false })).toBe(false);
    expect(foldOpenState({ narrow: true, keepOpen: true })).toBe(true);
    expect(foldOpenState({ narrow: false, keepOpen: false })).toBe(true);
    expect(foldOpenState({ narrow: false, keepOpen: true })).toBe(true);
  });

  it('the Korean mode keeps its lines inside the fold (the card is read the same way)', () => {
    const html = render(<ApprovalCard card={clean() as never} korean />, true);
    expect(fold(html)).toMatch(HANGUL);
    expect(html).not.toContain('class="p5-fold" open=""></details>');
  });
});

// ================================================================================================
// round 2 (review Lows + the memo decision)
// ================================================================================================
describe('round 2: the memo is the representative\'s — the screens tell the staff who typed it', () => {
  const NOTE = 'メモは代表のみ閲覧できます（担当者の画面には出ません）。';
  it('staff: the records say so, and the memo fields say so; the representative is not told', async () => {
    serveOrder('staff', 'SEVEN_PO_VERIFIED');
    const staff = await orderScreen();
    expect(staff).toContain('data-memo-note="staff"');
    expect(staff).toContain(NOTE);
    // the memo field of step 4 (ArtworkStep) and the generic memo field both carry it for staff
    expect(panel('SEVEN_PO_VERIFIED', 'staff')).toContain(NOTE);
    expect(panel('SEVEN_PO_VERIFIED', 'staff', { order: { sevenPurchaseOrderId: null } })).toContain(NOTE);
    serveOrder('admin', 'SEVEN_PO_VERIFIED');
    const admin = await orderScreen();
    expect(admin).not.toContain(NOTE);
    expect(panel('SEVEN_PO_VERIFIED', 'admin')).not.toContain(NOTE);
  });
  it('no memo and no amount is drawn for staff even when the record carries one (the server trims it; the screen adds nothing)', async () => {
    serveOrder('staff', 'FILM_SHIPPED', { events: [{ id: 'e', action: 'FILM_SUPPLY_ORDER_TRANSITIONED', entityType: 'film_supply_order', entityId: 'order-1', occurredAt: '2026-11-22T03:00:00Z', actor: null, afterState: { status: 'ARTWORK_RECEIVED' } }] });
    const html = await orderScreen();
    expect(html).not.toContain('メモ: ');
    expect(html).not.toMatch(HANGUL);
  });
});

describe('round 2 review Lows', () => {
  it('L-5: a record\'s file and memo are INSIDE its 「内容」 span (one grid column), not a fourth item of the row', async () => {
    serveOrder('admin', 'FILM_SHIPPED', { events: [{ id: 'e2', action: 'DOCUMENT_VERSION_UPLOADED', entityType: 'document_version', entityId: 'ver-1', occurredAt: '2026-11-22T02:00:00Z', actor: null, afterState: { documentType: 'acceptance_evidence', originalFilename: 'receipt-0007.pdf', filmSupplyOrderId: 'order-1' } }] });
    const html = await orderScreen();
    expect(html).toMatch(/<span class="p1-record-what">書類の版を登録<span class="p1-record-detail">[\s\S]*?receipt-0007\.pdf[\s\S]*?<\/span><\/span><\/li>/);
  });
  it('L-5: an auditor reads the long sentence ONCE and 「閲覧のみ」 on the rows', () => {
    const rows = [delivery('del-a', false, { deliveredQuantity: '—', unit: '—', detailsHidden: true }), delivery('del-b', false, { deliveredQuantity: '—', unit: '—', detailsHidden: true })];
    const html = panel('FILM_RECEIPT_ASSUMED_NO_ISSUE', 'auditor', { deliveryContext: receiptContext('u-auditor', rows) });
    expect(html.match(/閲覧のみ（確認状態は監査履歴で見られます）/g) ?? []).toHaveLength(1);
    expect(html.match(/<span class="p4w2-wait"> 閲覧のみ<\/span>|閲覧のみ<\/span>/g) ?? []).toHaveLength(2);
    expect(html).not.toContain('確認待ち');
  });
  it.each([['no cookie', undefined, false], ['ja-ko', 'u.ja-ko', true], ['ja', 'u.ja', false]] as const)('L-4: RouteGate (a project route without a session), %s → the Korean line is %s', async (_name, cookie, korean) => {
    session.user = null;
    if (cookie) session.cookies.set('kanei_web_lang', cookie);
    session.path = '/p/RE-A/o/FSO-1';
    const { RouteGate } = await import('../apps/web/src/components/RouteGate.js');
    const html = render(await RouteGate({ route: { kind: 'no-session', session: { kind: 'anonymous' } } as never }));
    expect(html).toContain('session-notice');
    expect(HANGUL.test(html)).toBe(korean);
  });
  it('§9: the folded summary also says whether ALL designs are approved (the stamps are the first design\'s)', () => {
    const seal = (state: string) => ({ state, eventTime: '2026-11-20T01:00:00Z', approvalEventId: 'ev', evidence: null });
    const card = (dual: boolean) => ({
      source: 'server', poId: 'mpo-1', orderId: 'order-1', displayNumber: 'MPO-2026-0001', status: 'DRAFT', orderCode: 'FSO-1', paymentTerms: 'prepaid', amountDisplay: null,
      items: [], artworkFiles: [], recipient: { address: 'order@maker.example', isEmail: true, inMakerMaster: true }, sevenPo: { poNumber: 'SC-1', officialRegisteredAt: '2026-11-01', verificationStatus: 'verified' },
      designs: [{ designKey: '表面A', currentRevisionNo: 1, customer: seal('approved'), seven: seal('approved') }, { designKey: '裏面B', currentRevisionNo: 1, customer: seal('approved'), seven: seal('missing') }],
      dualApproved: dual, blockers: [], warnings: [], canApprove: true, canReturn: true, expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA
    });
    const summary = (html: string) => /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? '';
    expect(summary(render(<ApprovalCard card={card(false) as never} korean={false} />))).toContain('全2デザイン: そろっていません');
    expect(summary(render(<ApprovalCard card={card(true) as never} korean={false} />))).toContain('全2デザイン: そろっています');
  });
});
