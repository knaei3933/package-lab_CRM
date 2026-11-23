import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
/**
 * p6/web (base p5/rc b36e7bb): the web-only part of audit44c's REMAINING.md — X1 (payment-terms anchor), R2 left (the P06 path of the
 * 390px approval card), R3 left (監査履歴 by closureBasis), X2 (step-6 header), X4 (44px links), X6 (status line = the real action),
 * R7 left / T-8 (a Japanese-only role's 404). One describe per item; each holds tests that fail on b36e7bb's code
 * (evidence: demo-eml/p6-web/evidence/*-base-red.log) and render the real components (renderToStaticMarkup — the 390px geometry is
 * measured live in ego-browser: evidence/). Server rules, amounts (staff / viewer / auditor see none), idempotency
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
const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
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
const home = async (showKorean = false) => render((await resolve(await HomeScreen())) as ReactElement, showKorean);
const countOf = (html: string, needle: string | RegExp) => (html.match(typeof needle === 'string' ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : new RegExp(needle, 'g')) ?? []).length;

// ================================================================================================
// X1 / T-10 — the 承認箱 link 「支払条件を決める」 lands on an element that exists
// ================================================================================================
describe('X1 / T-10 the home link #payment-terms has exactly one target on the rendered order screen', () => {
  const undetermined = { paymentTerms: 'undetermined', paymentTermsUndetermined: true, paymentTermsEditable: true };
  const blockedRow = {
    key: 'payment_terms_undetermined:order-1', kind: 'payment_terms_undetermined',
    project: { id: 'project-a', code: 'PRJ-1', name: '案件A' }, order: { id: 'order-1', code: 'FSO-1', status: 'MAKER_PO_READY', paymentTerms: 'undetermined', requestedDeliveryDate: null, plannedDeliveryDate: null },
    reason: { code: 'PAYMENT_TERMS_UNDETERMINED', message: '支払条件が「未定」です。' }, fixableBy: ['admin', 'staff'],
    paymentTermsEditable: true, paymentTermsLock: null, waitingSince: '2026-11-23T01:00:00Z',
    deepLink: { step: 'payment_terms', projectCode: 'PRJ-1', orderCode: 'FSO-1', projectId: 'project-a', orderId: 'order-1', subjectId: 'order-1', action: { method: 'PATCH', path: '/api/film-supply-orders/order-1/payment-terms' } }
  };
  /** The element carrying the id, through the end of its form: what the link lands on. */
  const target = (html: string) => {
    const at = html.indexOf('id="payment-terms"');
    return at < 0 ? '' : html.slice(at, html.indexOf('</form>', at) + 7);
  };

  it('the 承認箱 link carries #payment-terms (the hash this test then looks for)', async () => {
    session.user = { id: 'u-admin', role: 'admin' };
    session.projects = [{ id: 'project-a', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockResolvedValue(ok({ items: [], blocked: [blockedRow] }));
    const html = await home();
    expect(html).toMatch(/href="\/p\/PRJ-1\/o\/FSO-1#payment-terms">支払条件を決める/);
  });

  it.each(['admin', 'staff'])('%s, 未定 at step 7 (MAKER_PO_READY): one #payment-terms, and it is the step panel\'s form', async (role) => {
    serveOrder(role, 'MAKER_PO_READY', { orderOver: undetermined });
    const html = await orderScreen();
    expect(html).toContain('進められません');
    expect(countOf(html, 'id="payment-terms"')).toBe(1);
    expect(target(html)).toContain('name="paymentTerms"');
    expect(target(html)).toContain('支払条件を記録する');
    // …and the 「発注の条件」 form stays hidden (R13): still ONE payment-terms select on the page.
    expect(countOf(html, /<select[^>]*name="paymentTerms"/)).toBe(1);
  });

  it.each(['admin', 'staff'])('%s, 未定 at an earlier step (SEVEN_PO_VERIFIED): one #payment-terms, held by the 「発注の条件」 form', async (role) => {
    serveOrder(role, 'SEVEN_PO_VERIFIED', { orderOver: undetermined });
    const html = await orderScreen();
    expect(countOf(html, 'id="payment-terms"')).toBe(1);
    expect(target(html)).toContain('name="paymentTerms"');
    expect(target(html)).toContain('支払条件を変更する');
  });

  it('a decided term at step 7 has no blocked panel: the anchor stays with the 「発注の条件」 form, once', async () => {
    serveOrder('admin', 'MAKER_PO_READY', { orderOver: { paymentTerms: 'prepaid', paymentTermsUndetermined: false, paymentTermsEditable: true } });
    const html = await orderScreen();
    expect(html).not.toContain('進められません');
    expect(countOf(html, 'id="payment-terms"')).toBe(1);
    expect(target(html)).toContain('支払条件を変更する');
  });

  it('a role that cannot record the term (viewer) gets no second anchor from the step panel', async () => {
    serveOrder('viewer', 'MAKER_PO_READY', { orderOver: undetermined });
    const html = await orderScreen();
    expect(countOf(html, 'id="payment-terms"')).toBeLessThanOrEqual(1);
    expect(html).not.toMatch(/<select[^>]*name="paymentTerms"/);
  });
});

// ================================================================================================
// R2 left — the P06 path of the 390px approval card: the change notice follows the approve button
// ================================================================================================
describe('R2 left: 「発注書の作成後に明細または版が変わりました」 is a notice that sits under the approve button on a phone', () => {
  const seal = (state: string) => ({ state, eventTime: '2026-11-20T01:00:00Z', evidence: null });
  const card = (over: Record<string, unknown> = {}) => ({
    source: 'server', poId: 'mpo-1', orderId: 'order-1', displayNumber: 'MPO-2026-0001', status: 'DRAFT', orderCode: 'FSO-1', paymentTerms: 'prepaid', amountDisplay: null,
    items: [{ lineNumber: 1, description: '合成フィルム', quantityDisplay: '500 m' }],
    artworkFiles: [{ designKey: '表面A', revisionNo: 1, sha256: SHA, filename: 'omote.pdf', matchesApprovedRevision: true }],
    recipient: { address: 'order@maker.example', isEmail: true, inMakerMaster: true },
    deliveryTerms: { requestedDeliveryDate: '2026-12-15', plannedDeliveryDate: null, sevenPo: { quantityDisplay: '500 メートル', amountDisplay: null } },
    sevenPo: { poNumber: 'SC-1', officialRegisteredAt: '2026-11-01', verificationStatus: 'verified' },
    designs: [{ designKey: '表面A', currentRevisionNo: 1, customer: seal('approved'), seven: seal('approved') }], dualApproved: true,
    blockers: [], warnings: [], canApprove: true, canReturn: true, expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA, ...over
  });
  const DRIFT = { code: 'MAKER_PO_SNAPSHOT_DRIFTED', message: '発注書の作成後に明細または版が変わりました。承認すると最新の内容で確定します' };
  const cardHtml = (c: unknown) => render(<ApprovalCard card={c as never} korean={false} />);
  const noticeTag = (html: string) => /<p[^>]*data-card-notice="MAKER_PO_SNAPSHOT_DRIFTED"[^>]*>/.exec(html)?.[0] ?? '';
  const css = () => readSrc('app/p6-web.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const p5css = () => readSrc('app/p5-web.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const orderOf = (stylesheet: string, cls: string) => Number(new RegExp(`\\.p1-card\\s*>\\s*\\.${cls}\\s*\\{\\s*order:\\s*(\\d+)`).exec(stylesheet)?.[1] ?? NaN);

  it('the drift notice says what it said, as a notice of its own — not as one of the 「入力が足りない」 blocks', () => {
    const html = cardHtml(card({ warnings: [DRIFT] }));
    expect(visibleText(html)).toContain('発注書の作成後に明細または版が変わりました。承認すると最新の内容で確定します');
    expect(noticeTag(html)).toContain('p6-card-notice');
    expect(noticeTag(html)).not.toContain('p5-card-needs');
  });

  it('on a phone its place is under the approve button and above the 「固定されます」 line (order 44: after the actions 40, before the fix note 45)', () => {
    const notice = orderOf(css(), 'p6-card-notice');
    expect(notice).toBe(44);
    expect(notice).toBeGreaterThan(orderOf(p5css(), 'p5-card-actions'));
    expect(notice).toBeLessThan(orderOf(p5css(), 'p5-card-fix'));
    expect(css()).toMatch(/@media \(max-width:\s*600px\)[^{]*\{[^@]*\.p1-card\s*>\s*\.p6-card-notice/);
  });

  it('the phone spacing that keeps the P06 path under 1688 is pinned (the geometry itself is measured live: evidence/20-p06-geometry.txt)', () => {
    const phone = /@media \(max-width:\s*600px\)\s*\{([\s\S]*)\}\s*$/.exec(css())![1]!;
    expect(phone).toMatch(/\.p1-card\s*\{\s*gap:\s*var\(--space-2\);?\s*\}/);
    expect(phone).toMatch(/\.p1-card\s*>\s*\.p5-card-needs\s*\{\s*margin-block:\s*0;?\s*\}/);
    expect(phone).toMatch(/\.p1-step\s*\{\s*gap:\s*var\(--space-2\);?\s*\}/);
    expect(phone).toMatch(/\.p1-announce\s*\{\s*padding-block:\s*var\(--space-2\);?\s*\}/);
    // spacing only: nothing is hidden on the card
    expect(phone).not.toMatch(/display:\s*none/);
  });

  it('on a wide screen (no order rules) the notice keeps its markup place before the buttons, and is still read before them', () => {
    const html = cardHtml(card({ warnings: [DRIFT] }));
    expect(html.indexOf('data-card-notice="MAKER_PO_SNAPSHOT_DRIFTED"')).toBeLessThan(html.indexOf('代表承認する'));
  });

  it('the 金額-missing warning is still not drawn as a notice (the 「金額」 input says it); other warnings are notices too', () => {
    const html = cardHtml(card({ warnings: [{ code: 'MAKER_PO_AMOUNT_MISSING', message: 'x' }, { code: 'SOME_OTHER_NOTICE', message: '別の注意です' }] }));
    expect(html).not.toContain('data-card-notice="MAKER_PO_AMOUNT_MISSING"');
    expect(html).toContain('data-card-notice="SOME_OTHER_NOTICE"');
  });

  it('nothing the approval rests on is dropped: the facts rows, the 取り消せません note and both buttons are all still there with a notice', () => {
    const html = cardHtml(card({ warnings: [DRIFT], deliveryTerms: { requestedDeliveryDate: null, plannedDeliveryDate: null, sevenPo: { quantityDisplay: null, amountDisplay: null } } }));
    for (const text of ['金額', '支払条件', '承認すると取り消せません', 'MPO-2026-0001 を代表承認する', '差し戻す']) expect(visibleText(html), text).toContain(text);
  });
});

// ================================================================================================
// R3 left — 監査履歴: a 完了 says what it rests on (closureBasis)
// ================================================================================================
describe('R3 left: the auditor\'s 監査履歴 names a 完了 by its closureBasis', () => {
  const DONE = 'FILM_RECEIPT_ASSUMPTION_RECORDED';
  const row = (id: string, afterState: unknown, requestMetadata: unknown, action = DONE) => ({
    id, action, entityType: 'film_supply_order', entityId: `e-${id}`, beforeState: { status: 'FILM_DELIVERED' }, afterState, occurredAt: new Date(`2026-11-22T0${id}:00:00Z`),
    requestMetadata, actor: { id: 'u-admin', displayName: '合成代表者', role: 'admin' }
  });
  const FULL_CONFIRMED = { status: 'FILM_RECEIPT_ASSUMED_NO_ISSUE', closureBasis: 'delivery_confirmations', deliveryConfirmations: ['d-1', 'd-2'], orderCode: 'FSO-1', receiptAssumedNote: 'メモ（金額は書かない）' };
  const FULL_FREE = { status: 'FILM_RECEIPT_ASSUMED_NO_ISSUE', closureBasis: 'evidence_free_acknowledgment', deliveryConfirmations: [], orderCode: 'FSO-2' };
  const CONFIRMED_META = { operation: 'film_order:close_receipt_on_confirmed_deliveries', closureBasis: 'delivery_confirmations' };
  const FREE_META = { operation: 'film_order:assume_receipt', closureBasis: 'evidence_free_acknowledgment' };

  /** The feed exactly as the API builds it for a role (the real allowlists decide what the screen can read). */
  const feed = (role: 'auditor' | 'admin', rows: unknown[]) => JSON.parse(JSON.stringify(apiAuditView.buildAuditViewForRole(role, rows as never)));
  async function auditorHome(rows: unknown[], role: 'auditor' | 'admin' = 'auditor') {
    session.user = { id: `u-${role}`, role };
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockImplementation(async (url: string) => (url.includes('/audit-history') ? ok({ events: feed(role, rows) }) : url.includes('/evidence-metadata') ? ok({ documents: [] }) : ok()));
    return home();
  }
  const cells = (html: string) => html.split('<tr role="row">').slice(2).map((tr) => ({
    what: visibleText(/data-label="何を">([\s\S]*?)<\/td>/.exec(tr)?.[1] ?? ''),
    basis: visibleText(/data-label="根拠">([\s\S]*?)<\/td>/.exec(tr)?.[1] ?? '')
  }));

  it('the auditor\'s feed really carries only the operation (not closureBasis) — the test below depends on it', () => {
    const [view] = feed('auditor', [row('1', FULL_CONFIRMED, CONFIRMED_META)]);
    expect(view!.afterState).not.toHaveProperty('closureBasis');
    expect(view!.afterState).not.toHaveProperty('deliveryConfirmations');
    expect(view!.requestMetadata).toEqual({ operation: 'film_order:close_receipt_on_confirmed_deliveries' });
  });

  it('a 完了 on confirmed deliveries: 「確認済みの納品にもとづく完了」, the row is named so, and it is not 「記録のみ（証跡なし）」', async () => {
    const [one] = cells(await auditorHome([row('1', FULL_CONFIRMED, CONFIRMED_META)]));
    expect(one!.what).toContain('確認済みの納品で完了を記録');
    expect(one!.what).not.toContain('問題なしで完了');
    expect(one!.basis).toContain('確認済みの納品にもとづく完了');
    expect(one!.basis).not.toContain('記録のみ（証跡なし）');
    expect(one!.basis).not.toContain('証跡なし（同意）');
  });

  it('a 完了 on the operator\'s consent alone: 「証跡なし（同意）」', async () => {
    const [one] = cells(await auditorHome([row('1', FULL_FREE, FREE_META)]));
    expect(one!.what).toContain('証跡なしで完了を記録');
    expect(one!.basis).toContain('証跡なし（同意）');
    expect(one!.basis).not.toContain('確認済みの納品');
  });

  it('a closure from before P4 (no operation, no basis) was evidence-free: it reads 「証跡なし（同意）」', async () => {
    const [one] = cells(await auditorHome([row('1', { status: 'FILM_RECEIPT_ASSUMED_NO_ISSUE' }, null)]));
    expect(one!.basis).toContain('証跡なし（同意）');
  });

  it('two rows in one table keep their own basis (newest first), none borrows the other\'s', async () => {
    const [newer, older] = cells(await auditorHome([row('2', FULL_CONFIRMED, CONFIRMED_META), row('1', FULL_FREE, FREE_META)]));
    expect(newer!.basis).toContain('確認済みの納品にもとづく完了');
    expect(older!.basis).toContain('証跡なし（同意）');
  });

  it('the auditor\'s row says nothing about a number of 受領証跡 (its feed cannot count them: the confirmations\' ids are not on its key list)', async () => {
    const [one] = cells(await auditorHome([row('1', FULL_CONFIRMED, CONFIRMED_META)]));
    expect(one!.basis.trim()).toBe('確認済みの納品にもとづく完了');
    expect(one!.basis).not.toMatch(/受領証跡 \d+件/);
  });

  it('no amount, no memo and no Hangul on the auditor\'s screen; other actions keep their labels', async () => {
    const html = await auditorHome([row('1', FULL_CONFIRMED, CONFIRMED_META), row('2', { orderCode: 'FSO-1', displayNumber: 'MPO-2026-0007' }, null, 'MAKER_PO_CEO_APPROVED')]);
    expect(html).not.toContain('メモ（金額は書かない）');
    expect(html).not.toMatch(/480,?000|totalAmount/);
    expect(HANGUL.test(html)).toBe(false);
    expect(visibleText(html)).toContain('メーカー発注書');
  });

  it('the pure rule: only the 完了 action has a closure; an unknown operation falls back to the pre-P4 reading', async () => {
    const { receiptClosureOf, auditActionLabel } = await import('../apps/web/src/lib/audit-history.js');
    expect(receiptClosureOf({ action: 'MAKER_PO_CEO_APPROVED', afterState: { closureBasis: 'delivery_confirmations' }, requestMetadata: null })).toBeNull();
    expect(receiptClosureOf({ action: DONE, afterState: null, requestMetadata: { operation: 'film_order:something_else' } })).toEqual({ basis: 'evidence_free_acknowledgment' });
    // the row's own stated basis outranks the operation name
    expect(receiptClosureOf({ action: DONE, afterState: { closureBasis: 'delivery_confirmations' }, requestMetadata: { operation: 'film_order:assume_receipt' } })).toEqual({ basis: 'delivery_confirmations' });
    expect(auditActionLabel({ action: 'FILM_DELIVERY_CONFIRMED', afterState: null, requestMetadata: null }, undefined)).toBe('納品の確認を記録');
    expect(auditActionLabel({ action: 'UNKNOWN_ACTION', afterState: null, requestMetadata: null }, undefined)).toBe('記録');
  });
});

// ================================================================================================
// X2 — the step-6 header names every kind of evidence that waits for the representative
// ================================================================================================
describe('X2 the step-6 header says what waits (rounds 2–3 decisions included)', () => {
  const rawSlotOf = (organization: string, pending: boolean) => ({
    organization, valid: !pending, latestDecision: 'APPROVE', revoked: false, invalidatedByNewerRevision: false, pendingEvidenceIdentifier: pending, rejected: false, manualVerification: null
  });
  const rawGate = {
    orderId: 'order-1', orderStatus: 'APPROVAL_PENDING', dualApproved: false, missingApprovals: [],
    designs: [{ designKey: '表面A', currentRevisionId: 'rev-1', currentRevisionNo: 1, fileSha256: 'ab'.repeat(32), customer: rawSlotOf('customer', false), seven: rawSlotOf('seven', true), dualApproved: false }],
    pendingManualVerifications: [{
      approvalEventId: 'ev-1', revisionId: 'rev-1', designKey: '表面A', revisionNo: 1, organization: 'seven', evidenceDocumentVersionId: 'ver-9', evidenceIdentifier: 'SEAL-1',
      approvedFileSha256: 'ab'.repeat(32), eventTime: '2026-11-20T00:00:00Z', recordedAt: '2026-11-20T00:00:10Z', manualVerification: null, evidenceIssuerEntity: 'seven',
      expectedIssuerEntity: 'seven', issuerMatchesOrganization: true, sharedEvidenceException: null, confirmable: true, sameContentUsedByOtherOrganization: false, recordedAsPending: true
    }]
  };
  async function gate() {
    callApi.mockImplementation(async (url: string) => (url.endsWith('/approval-gate') ? ok(rawGate) : ok()));
    const loaded = await realData.loadApprovalGate('order-1');
    expect(loaded).not.toBeNull();
    return loaded!;
  }
  const header = (html: string) => /承認証跡が [\s\S]*?記録します。/.exec(visibleText(html))?.[0] ?? '';

  it('the representative reads all three kinds: PDF・画像 / 差出人のドメインが違う・確認できないメール / メールでない証跡', async () => {
    const loaded = await gate();
    const o = order('APPROVAL_PENDING');
    const flow = buildOrderFlow({ order: o as never, role: 'admin', po: PO as never, documents: [] as never, revisions: [], gate: loaded as never, makerPos: [], makerEvents: [], settledSendEventIds: new Set(), paymentGate: null, deliveries: [] });
    const text = header(render(<StepPanelView flow={flow} order={o as never} projectCode="PRJ-1" role="admin" po={PO as never} gate={loaded as never} maker={null} makerEvents={[]} documents={[] as never} stateLabel={(key) => key} />));
    expect(text).not.toBe('');
    expect(text).toContain('承認証跡が 1 件、代表の確認を待っています');
    expect(text).toContain('PDF・画像');
    expect(text).toContain('差出人のドメインが違う・確認できないメール');
    expect(text).toContain('メールでない証跡');
    expect(text).not.toContain('または差出人のドメインが登録先と違うメール');
  });

  it('the Korean line follows the same three kinds in the bilingual mode, and a Japanese-only mode has none', async () => {
    const loaded = await gate();
    const o = order('APPROVAL_PENDING');
    const flow = buildOrderFlow({ order: o as never, role: 'admin', po: PO as never, documents: [] as never, revisions: [], gate: loaded as never, makerPos: [], makerEvents: [], settledSendEventIds: new Set(), paymentGate: null, deliveries: [] });
    const draw = (showKorean: boolean) => render(<StepPanelView flow={flow} order={o as never} projectCode="PRJ-1" role="admin" po={PO as never} gate={loaded as never} maker={null} makerEvents={[]} documents={[] as never} stateLabel={(key) => key} />, showKorean);
    const ko = draw(true);
    expect(ko).toContain('발신 도메인이 다르거나 확인할 수 없는 메일');
    expect(ko).toContain('메일이 아닌 증빙');
    expect(HANGUL.test(draw(false))).toBe(false);
  });

  it('the section\'s own title and note (the old list) say the same kinds', async () => {
    const loaded = await gate();
    const html = render(<PendingVerificationSection pending={loaded.pendingManualVerifications} role="admin" canVerify evidenceLabel={() => 'x'} organizationText={(key) => key} />);
    expect(visibleText(html)).toContain('承認証跡の手動確認（PDF・画像、差出人のドメインが違う・確認できないメール、メールでない証跡）— 1件');
    expect(visibleText(html)).toContain('差出人を確認できないメール、メールとして確認できない証跡も同じです');
  });
});

// ================================================================================================
// X4 — the 監査履歴 links are touch targets on a phone
// ================================================================================================
describe('X4 the links inside the auditor\'s 監査履歴 rows carry the 44px target class', () => {
  it('the project code and 「証跡の一覧で見る」 of every row (35 links in the audit) are .p6-audit-link; the stylesheet gives it 44px under 640px', async () => {
    session.user = { id: 'u-auditor', role: 'auditor' };
    session.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    const events = [
      { id: 'a1', action: 'FILM_DELIVERY_CONFIRMED', entityType: 'x', entityId: 'e1', beforeState: null, afterState: { evidenceDocumentVersionId: 'ver-1', orderCode: 'FSO-1' }, occurredAt: '2026-11-22T01:00:00Z', requestMetadata: null, actor: { id: 'u', displayName: '代表', role: 'admin' }, basis: { evidenceDocumentVersionId: 'ver-1' } },
      { id: 'a2', action: 'MAKER_PO_CEO_APPROVED', entityType: 'x', entityId: 'e2', beforeState: null, afterState: { orderCode: 'FSO-1' }, occurredAt: '2026-11-22T02:00:00Z', requestMetadata: null, actor: { id: 'u', displayName: '代表', role: 'admin' } }
    ];
    callApi.mockImplementation(async (url: string) => (url.includes('/audit-history') ? ok({ events })
      : url.includes('/evidence-metadata') ? ok({ documents: [{ documentId: 'doc-1', documentType: 'acceptance_evidence', issuerEntity: 'customer_generated', originalFilename: 'r.pdf', filenameHidden: false, versions: [{ versionId: 'ver-1', versionNumber: 1, originalFilename: 'r.pdf', sha256: 'ab'.repeat(32) }] }] }) : ok()));
    const html = await home();
    const table = /<table class="p1-history p2-audit-history"[\s\S]*?<\/table>/.exec(html)![0];
    const links = [...table.matchAll(/<a\b[^>]*>(?:PRJ-1|証跡の一覧で見る)<\/a>/g)].map((match) => match[0]);
    expect(links.length).toBe(3);
    for (const link of links) expect(link).toContain('p6-audit-link');
    const css = readSrc('app/p6-web.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/@media \(max-width:\s*640px\)[^{]*\{[^@]*\.p6-audit-link\s*\{[^}]*min-height:\s*44px/);
  });
});

// ================================================================================================
// X6 / T-13 — the status line names the submit's own action
// ================================================================================================
describe('X6 the status line after a submit is the action that was submitted', () => {
  it('pastTenseOf: the product\'s own button endings become the past tense; anything else is quoted, never guessed', async () => {
    const { pastTenseOf } = await import('../apps/web/src/lib/submit-intent.js');
    expect(pastTenseOf('手動確認を記録する')).toBe('手動確認を記録しました');
    expect(pastTenseOf('顧客の承認を記録する')).toBe('顧客の承認を記録しました');
    expect(pastTenseOf('MPO-2026-0001 を代表承認する')).toBe('MPO-2026-0001 を代表承認しました');
    expect(pastTenseOf('FSO-1 のメーカー発注書（下書き）を作る')).toBe('FSO-1 のメーカー発注書（下書き）を作りました');
    expect(pastTenseOf('差し戻す')).toBe('差し戻しました');
    expect(pastTenseOf('別の書類でセブン化学の承認を記録し直す')).toBe('別の書類でセブン化学の承認を記録し直しました');
    expect(pastTenseOf('受入記録（仮）を残す')).toBe('受入記録（仮）を残しました');
    // a closing 「（…）」 of the label is not part of the sentence
    expect(pastTenseOf('受領証跡を登録する（確認は代表）')).toBe('受領証跡を登録しました');
    expect(pastTenseOf('メーカーの受注を確定する（最終受入）')).toBe('メーカーの受注を確定しました');
    expect(pastTenseOf('校正を登録して校了の確認へ')).toBe('「校正を登録して校了の確認へ」を実行しました');
    expect(pastTenseOf('取り消し')).toBe('「取り消し」を実行しました');
    // the whole label is a parenthesis: nothing to strip, quoted
    expect(pastTenseOf('（確認）')).toBe('「（確認）」を実行しました');
  });

  it('announcementText: the submit\'s action first; the newest record only when the change was not this screen\'s submit', async () => {
    const { announcementText } = await import('../apps/web/src/lib/submit-intent.js');
    // the audit's case: the newest record said 「書類を登録」 after a manual check
    expect(announcementText({ intent: '手動確認を記録する', latest: '書類を登録', now: '7 メーカー発注書の作成' })).toBe('手動確認を記録しました。いまの手順: 7 メーカー発注書の作成');
    expect(announcementText({ intent: '手動確認を記録する', latest: '書類を登録', now: null })).not.toContain('書類を登録');
    expect(announcementText({ intent: null, latest: '顧客の承認を記録', now: '6 校了' })).toBe('記録しました（顧客の承認を記録）。いまの手順: 6 校了');
    expect(announcementText({ intent: null, latest: null, now: null })).toBe('記録しました。この発注の手順はすべて終わりました。');
  });

  it('the memory: noted at submit, taken once, withdrawn on a refusal, forgotten by an unlabeled form and after a minute', async () => {
    const lib = await import('../apps/web/src/lib/submit-intent.js');
    lib.noteSubmitIntent('手動確認を記録する', 1_000);
    expect(lib.takeSubmitIntent(2_000)).toBe('手動確認を記録する');
    expect(lib.takeSubmitIntent(2_000)).toBeNull(); // taken once
    lib.noteSubmitIntent('顧客の承認を記録する', 1_000);
    lib.withdrawSubmitIntent(); // refused
    expect(lib.takeSubmitIntent(2_000)).toBeNull();
    lib.noteSubmitIntent('顧客の承認を記録する', 1_000);
    lib.noteSubmitIntent(null, 1_500); // another form without a label submitted
    expect(lib.takeSubmitIntent(2_000)).toBeNull();
    lib.noteSubmitIntent('納期を保存する', 1_000);
    expect(lib.takeSubmitIntent(1_000 + lib.SUBMIT_INTENT_TTL_MS + 1)).toBeNull();
    lib.noteSubmitIntent('納期を保存する', 1_000);
    expect(lib.takeSubmitIntent(1_000 + lib.SUBMIT_INTENT_TTL_MS)).toBe('納期を保存する');
    lib.noteSubmitIntent('   ', 1_000);
    expect(lib.takeSubmitIntent(1_001)).toBeNull();
  });

  it('wiring: ActionForm hands its button label to the form shell (which notes it when the submit goes out)', async () => {
    vi.resetModules();
    const seen: Array<string | undefined> = [];
    vi.doMock('../apps/web/src/components/form-feedback.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../apps/web/src/components/form-feedback.js')>()),
      FeedbackForm: (props: { intentLabel?: string; children: ReactNode }) => { seen.push(props.intentLabel); return <form>{props.children}</form>; }
    }));
    try {
      const { ActionForm } = await import('../apps/web/src/components/ActionForm.js');
      render(<ActionForm action={(async () => ({ ok: true })) as never} submitLabel="手動確認を記録する"><span /></ActionForm>);
      expect(seen).toEqual(['手動確認を記録する']);
    } finally {
      vi.doUnmock('../apps/web/src/components/form-feedback.js');
      vi.resetModules();
    }
  });

  it('wiring: the shell notes the intent when a submit goes out and withdraws it on a refusal; the status region takes it', () => {
    const shell = readSrc('components/form-feedback.tsx');
    expect(shell).toMatch(/if \(!inFlight\.acquire\(state\)\) return;\s*noteSubmitIntent\(intentLabel \?\? null\);/);
    expect(shell).toMatch(/if \(state !== null && !state\.ok\) withdrawSubmitIntent\(\);/);
    expect(readSrc('components/StepAnnouncer.tsx')).toContain('announcementText({ intent: takeSubmitIntent(), latest, now })');
  });
});

// ================================================================================================
// R7 left / T-8 — a Japanese-only role's 404 carries no Hangul (the whole page, layout included)
// ================================================================================================
describe('R7 left / T-8 the 404 of staff, viewer and auditor, in the real layout', () => {
  const notFoundPages = async () => ({
    site: (await import('../apps/web/src/app/not-found.js')).default,
    project: (await import('../apps/web/src/app/p/[project]/not-found.js')).default
  });
  async function page(Component: () => ReactNode, path: string) {
    session.path = path;
    const { default: RootLayout } = await import('../apps/web/src/app/layout.js');
    return renderToStaticMarkup(await RootLayout({ children: <Component /> })).replaceAll('<!-- -->', '');
  }

  it.each(['staff', 'viewer', 'auditor'])('%s: /zzz-not-exist and /p/PRJ-1/zzz read 「ページが見つかりません」, with the way out, and no Hangul anywhere on the page', async (role) => {
    session.user = { id: `u-${role}`, role };
    const pages = await notFoundPages();
    for (const [scope, path] of [['site', '/zzz-not-exist'], ['project', '/p/PRJ-1/zzz']] as const) {
      const html = await page(pages[scope], path);
      expect(html, `${role} ${scope}`).toContain('ページが見つかりません');
      expect(html).toContain('href="/home"');
      expect(HANGUL.test(html), `${role} ${scope}: Hangul`).toBe(false);
    }
  });

  it('the representative (bilingual by default) reads the same 404 with its Korean line — the check above is not vacuous', async () => {
    session.user = { id: 'u-admin', role: 'admin' };
    const pages = await notFoundPages();
    expect(HANGUL.test(await page(pages.site, '/zzz-not-exist'))).toBe(true);
  });
});
