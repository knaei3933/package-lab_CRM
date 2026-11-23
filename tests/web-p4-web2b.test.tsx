import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4 web 2b (base p4/int 5faa6c6): the web half of H4① H7② N1 N4 N13 M18 N11/M13, the B1 final check, the
 * M16 remainder and the web review leftovers R-1 R-2. One describe per item id; each test fails on the base
 * commit and passes with the change (evidence: demo-eml/p4-web2b/evidence/mutation-*.log). Screens are
 * rendered (real components, real markup) — no test reads CSS text. Server rules, amounts (staff / viewer /
 * auditor see none) and the idempotency semantics are not touched.
 */
const state = vi.hoisted(() => ({
  user: { id: 'u-admin', role: 'admin', displayName: '代表' } as { id: string; role: string; displayName?: string } | null,
  projects: [] as Array<{ id: string; code: string; name: string; status: string }>
}));
const callApi = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  apiTimeoutMs: () => 10_000,
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => state.user,
  loadSession: async () => ({ kind: 'user', user: state.user }),
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadSelectableProjectList: async () => ({ projects: state.projects, error: null })
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/navigation', () => ({
  redirect,
  usePathname: () => '/p/PRJ-1/o/FSO-1',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src');
const readSrc = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
/** The source with its comments removed (a word in a comment is not on a screen). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/**
 * A module this change adds. On the base commit it does not exist: the import is then empty, and each test
 * that needs it fails on its own (instead of the whole file failing to load) — the red/green evidence per item.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const optional = (load: () => Promise<any>): Promise<any> => load().catch(() => ({}));

const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { ApprovalCard } = await import('../apps/web/src/components/ApprovalCard.js');
const { NewOrderForm } = await import('../apps/web/src/components/NewOrderForm.js');
const { ProjectAssignmentsPanel } = await optional(() => import('../apps/web/src/components/ProjectAssignmentsPanel.js'));
const { AssignmentRequest, assignmentRequestText } = await optional(() => import('../apps/web/src/components/AssignmentRequest.js'));
const { ProjectChooser } = await import('../apps/web/src/components/ProjectChooser.js');
const { ProjectNotFound } = await import('../apps/web/src/components/ProjectNotFound.js');
const { QueueRowExtras } = await optional(() => import('../apps/web/src/components/QueueRowExtras.js'));
const { RepresentativeQueuePanel } = await import('../apps/web/src/components/RepresentativeQueue.js');
const { ActionForm } = await import('../apps/web/src/components/ActionForm.js');
const { SelectField } = await import('../apps/web/src/components/fields.js');
const approvalActions = await import('../apps/web/src/app/approval-actions.js');
const assignmentActions = await optional(() => import('../apps/web/src/app/assignment-actions.js'));
const stepActions = await import('../apps/web/src/app/step-actions.js');
const { RENDERED_PROJECT_FIELD, IDEMPOTENCY_FIELD } = await import('../apps/web/src/lib/project-context.js');
const approvalCardLib = await import('../apps/web/src/lib/approval-card.js');
const assignmentsLib = await optional(() => import('../apps/web/src/lib/assignments.js'));
const bindingLib = await optional(() => import('../apps/web/src/lib/binding-conflict.js'));
const duplicateLib = await import('../apps/web/src/lib/duplicate-check.js');
const queueLib = await import('../apps/web/src/lib/representative-queue.js');
const senderLib = await optional(() => import('../apps/web/src/lib/sender-check.js'));
const guardLib = await import('../apps/web/src/lib/unsaved-guard.js');
const { refusalState } = await import('../apps/web/src/lib/action-result.js');

const SHA = 'a'.repeat(64);
const NEW_SHA = 'b'.repeat(64);
const USER_A = '0192a000-0000-7000-8000-00000000000a';
const USER_B = '0192a000-0000-7000-8000-00000000000b';

const ok = (data: unknown = {}) => ({ ok: true, status: 200, data, error: null, code: null, failure: null });
const fail = (status: number, code: string, data: Record<string, unknown> = {}) => ({
  ok: false, status, data: { code, ...data }, error: `dictionary text for ${code}`, errorKo: null, code, failure: null
});

function form(entries: Record<string, string>, key: string | null = 'form-key-0001'): FormData {
  const data = new FormData();
  data.set(RENDERED_PROJECT_FIELD, 'proj-1');
  if (key) data.set(IDEMPOTENCY_FIELD, key);
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
}

function inContext(node: ReactNode, korean = false): string {
  return renderToStaticMarkup(<RenderedContextProvider value={{ projectId: 'proj-1', showKorean: korean }}>{node}</RenderedContextProvider>);
}

/** Resolves async server components so a static render can print them. */
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

beforeEach(() => {
  callApi.mockReset();
  revalidatePath.mockReset();
  redirect.mockReset();
  state.user = { id: 'u-admin', role: 'admin', displayName: '代表' };
  state.projects = [];
});

// ---------------------------------------------------------------------------------------------
// H4① the representative's approval: 金額・希望納期 are entered, never waived
// ---------------------------------------------------------------------------------------------
const org = (s: string) => ({ state: s, eventTime: null, evidence: null });
function card(over: Record<string, unknown> = {}) {
  return {
    source: 'server', poId: 'mpo-1', orderId: 'ord-1', displayNumber: 'MPO-2026-0007', status: 'DRAFT', orderCode: 'FSO-1', paymentTerms: 'prepaid',
    amountDisplay: '¥312,000',
    items: [{ lineNumber: 1, description: '合成フィルム', quantityDisplay: '500 m' }],
    artworkFiles: [{ designKey: '表面A', revisionNo: 2, sha256: SHA, filename: 'proof.pdf', matchesApprovedRevision: true }],
    recipient: { address: 'order@maker.example', isEmail: true },
    sevenPo: { poNumber: 'SC-1', officialRegisteredAt: '2026-11-01T00:00:00Z', verificationStatus: 'verified' },
    designs: [{ designKey: '表面A', revisionNo: 2, customer: org('approved'), seven: org('approved') }],
    dualApproved: true, blockers: [], warnings: [], canApprove: true, canReturn: true,
    expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA,
    ...over
  };
}
const AMOUNT_BLOCKER = { code: 'AMOUNT_REQUIRED', message: '金額が入力されていません' };
const DATE_BLOCKER = { code: 'DELIVERY_DATE_REQUIRED', message: '希望納期が記録されていません' };
/** The whole <input> tag of a field (React prints `required` before `name`), or '' when there is none. */
const inputTag = (html: string, name: string) => html.match(new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`))?.[0] ?? '';
const renderCard = (c: unknown, korean = false) => inContext(<ApprovalCard card={c as never} korean={korean} />, korean);

describe('H4① the approval card asks for the missing 金額 / 希望納期 (no 「金額未入力のまま承認する」)', () => {
  it('a paper without an amount (server blocker AMOUNT_REQUIRED) shows a REQUIRED amount input in the approve form — and no waiver check', () => {
    const html = renderCard(card({ amountDisplay: null, canApprove: false, blockers: [AMOUNT_BLOCKER], warnings: [{ code: 'MAKER_PO_AMOUNT_MISSING', message: '' }] }));
    expect(html).toContain('MPO-2026-0007 を代表承認する');
    expect(inputTag(html, 'totalAmount')).toContain('required=""');
    expect(html).toContain('name="amountRequired" value="true"');
    expect(html).not.toContain('acknowledgeMissingAmount');
    expect(html).not.toContain('金額未入力のまま承認する');
    expect(html).not.toContain('type="checkbox"');
  });

  it('says what to enter (data-need) instead of listing the code as a dead-end 「承認できません」', () => {
    const html = renderCard(card({ amountDisplay: null, canApprove: false, blockers: [AMOUNT_BLOCKER] }));
    expect(html).toContain('data-need="amount"');
    expect(html).toContain('承認の前に、次を入力してください');
    expect(html).not.toContain('承認できません');
    // the old amount-missing warning (a thing to accept) is not repeated
    expect(html).not.toContain('field-warning');
  });

  it('a paper without a 希望納期 shows the date form (orderId, required date) and no approve form until it is recorded', () => {
    const html = renderCard(card({ canApprove: false, blockers: [DATE_BLOCKER] }));
    expect(html).toContain('data-need="requestedDeliveryDate"');
    expect(html).toContain('希望納期を記録する');
    expect(html).toContain('name="orderId" value="ord-1"');
    expect(inputTag(html, 'requestedDeliveryDate')).toContain('required=""');
    expect(html).not.toContain('を代表承認する');
    expect(html).not.toContain('name="expectedSnapshotSha256"');
  });

  it('both missing: the date comes first (the card is drawn again with a new hash), the amount follows', () => {
    const html = renderCard(card({ amountDisplay: null, canApprove: false, blockers: [AMOUNT_BLOCKER, DATE_BLOCKER] }));
    expect(html).toContain('data-need="requestedDeliveryDate"');
    expect(html).toContain('data-need="amount"');
    expect(html).toContain('name="requestedDeliveryDate"');
    expect(html).not.toContain('を代表承認する');
  });

  it('nothing missing: the approve form has an OPTIONAL correction field, no amountRequired and no guidance', () => {
    const html = renderCard(card());
    expect(html).toContain('を代表承認する');
    expect(html).not.toContain('amountRequired');
    expect(html).not.toContain('data-need');
    expect(inputTag(html, 'totalAmount')).not.toBe('');
    expect(inputTag(html, 'totalAmount')).not.toContain('required');
  });

  it('another blocker (payment terms) is still a 「承認できません」 and hides the approve form; the amount guidance stays', () => {
    const html = renderCard(card({ amountDisplay: null, canApprove: false, blockers: [AMOUNT_BLOCKER, { code: 'PAYMENT_GATE_UNSATISFIED', message: '支払条件が未定' }] }));
    expect(html).toContain('承認できません');
    expect(html).not.toContain('を代表承認する');
    expect(html).toContain('data-need="amount"');
  });

  it('the Korean line follows showKorean (P-7)', () => {
    const html = renderCard(card({ amountDisplay: null, canApprove: false, blockers: [AMOUNT_BLOCKER] }), true);
    expect(html).toContain('승인 전에 다음을 입력하세요');
    expect(renderCard(card({ amountDisplay: null, canApprove: false, blockers: [AMOUNT_BLOCKER] }), false)).not.toContain('lang="ko"');
  });

  it('approvalCardNeeds: the pure table', () => {
    const needs = approvalCardLib.approvalCardNeeds;
    const base = { blockers: [], amountDisplay: '¥1', status: 'DRAFT', canApprove: true, expectedPaymentTerms: 'prepaid' };
    expect(needs(base)).toMatchObject({ amount: false, requestedDeliveryDate: false, canSubmitApproval: true });
    expect(needs({ ...base, amountDisplay: null, canApprove: false, blockers: [AMOUNT_BLOCKER] })).toMatchObject({ amount: true, canSubmitApproval: true });
    // web fallback card: no blocker, no amount → still required
    expect(needs({ ...base, amountDisplay: null })).toMatchObject({ amount: true, canSubmitApproval: true });
    expect(needs({ ...base, canApprove: false, blockers: [DATE_BLOCKER] })).toMatchObject({ requestedDeliveryDate: true, canSubmitApproval: false });
    expect(needs({ ...base, status: 'APPROVED_FOR_MANUAL_SEND' }).canSubmitApproval).toBe(false);
    expect(needs({ ...base, expectedPaymentTerms: null }).canSubmitApproval).toBe(false);
    expect(needs({ ...base, canApprove: false, blockers: [{ code: 'X', message: '' }] }).otherBlockers).toHaveLength(1);
  });

  it('the server card carries the order id the 希望納期 is recorded on', () => {
    const view = approvalCardLib.cardFromServer('mpo-1', {
      makerPurchaseOrder: { status: 'DRAFT' }, order: { id: 'ord-9', code: 'FSO-9' }, snapshot: {}, blockers: [DATE_BLOCKER], canApprove: false
    });
    expect(view?.orderId).toBe('ord-9');
  });

  it('approveFromCardAction: a paper that needs an amount is not approved without one (a leftover check box does not help), no API call', async () => {
    for (const extra of [{}, { acknowledgeMissingAmount: 'on' }, { totalAmount: '  ' }]) {
      callApi.mockReset();
      const result = await approvalActions.approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA, amountRequired: 'true', ...extra }));
      expect(result).toMatchObject({ ok: false, code: 'AMOUNT_REQUIRED' });
      expect(callApi).not.toHaveBeenCalled();
    }
  });

  it('approveFromCardAction: with the amount typed it saves it (pinned to the drawn hash) and approves with the answered hash', async () => {
    callApi.mockImplementation(async (url: string) => (url.endsWith('/amounts') ? ok({ approvalSnapshotSha256: NEW_SHA }) : ok()));
    const result = await approvalActions.approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA, amountRequired: 'true', totalAmount: '480,000', currency: 'JPY' }));
    expect(result.ok).toBe(true);
    expect(callApi.mock.calls[0]![0]).toBe('/api/maker-purchase-orders/mpo-1/amounts');
    expect(callApi.mock.calls[0]![1]).toMatchObject({ method: 'PATCH', body: { amounts: { currency: 'JPY', totalAmount: '480000' }, expectedSnapshotSha256: SHA } });
    expect(callApi.mock.calls[1]![0]).toBe('/api/maker-purchase-orders/mpo-1/ceo-approval');
    expect(callApi.mock.calls[1]![1].body).toEqual({ expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: NEW_SHA });
  });

  it('approveFromCardAction: when the API still says AMOUNT_REQUIRED / DELIVERY_DATE_REQUIRED the card is drawn again (4xx is not stored: the retry runs)', async () => {
    for (const refused of ['AMOUNT_REQUIRED', 'DELIVERY_DATE_REQUIRED']) {
      revalidatePath.mockReset();
      callApi.mockResolvedValue(fail(422, refused, { missing: ['x'] }));
      const result = await approvalActions.approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA }));
      expect(result).toMatchObject({ ok: false, code: refused, settled: true });
      expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
    }
  });

  it('recordRequestedDeliveryDateAction: PATCHes only the 希望納期 to that order, with the key and the rendered project; the card is read again', async () => {
    callApi.mockResolvedValue(ok({ id: 'ord-1' }));
    const result = await approvalActions.recordRequestedDeliveryDateAction(null, form({ orderId: 'ord-1', requestedDeliveryDate: '2026/12/01' }));
    expect(result.ok).toBe(true);
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0]![0]).toBe('/api/film-supply-orders/ord-1/delivery-dates');
    expect(callApi.mock.calls[0]![1]).toEqual({ method: 'PATCH', body: { requestedDeliveryDate: '2026-12-01' }, idempotencyKey: 'form-key-0001', expectedProjectId: 'proj-1' });
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('recordRequestedDeliveryDateAction: an empty or impossible date and a missing order never reach the API', async () => {
    const empty = await approvalActions.recordRequestedDeliveryDateAction(null, form({ orderId: 'ord-1', requestedDeliveryDate: '' }));
    expect(empty).toMatchObject({ ok: false, code: 'DELIVERY_DATE_REQUIRED' });
    const bad = await approvalActions.recordRequestedDeliveryDateAction(null, form({ orderId: 'ord-1', requestedDeliveryDate: '2026/13/45' }));
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('希望納期');
    const noOrder = await approvalActions.recordRequestedDeliveryDateAction(null, form({ requestedDeliveryDate: '2026/12/01' }));
    expect(noOrder.ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('recordRequestedDeliveryDateAction: a paper approved meanwhile (DELIVERY_TERMS_LOCKED) is passed on as the API said it', async () => {
    callApi.mockResolvedValue(fail(409, 'DELIVERY_TERMS_LOCKED'));
    const result = await approvalActions.recordRequestedDeliveryDateAction(null, form({ orderId: 'ord-1', requestedDeliveryDate: '2026-12-01' }));
    expect(result).toMatchObject({ ok: false, code: 'DELIVERY_TERMS_LOCKED', settled: true });
  });

  it('recordRequestedDeliveryDateAction refuses a form drawn for no project (fail closed)', async () => {
    const data = form({ orderId: 'ord-1', requestedDeliveryDate: '2026-12-01' });
    data.delete(RENDERED_PROJECT_FIELD);
    expect((await approvalActions.recordRequestedDeliveryDateAction(null, data)).ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('no screen source offers the waiver any more', () => {
    for (const file of sources(root)) {
      expect(code(readFileSync(file, 'utf8')), file).not.toMatch(/acknowledgeMissingAmount|金額未入力のまま承認する/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// H7② 発注コード: an empty code is numbered by the server (the key is required and kept)
// ---------------------------------------------------------------------------------------------
const LINES = JSON.stringify([{ description: '合成フィルム', orderedQuantity: '10', unit: 'rolls' }]);
const startForm = (extra: Record<string, string> = {}) => ({
  poNumber: 'PO-100', officialRegisteredAt: '2026-11-01', code: '', paymentTerms: 'prepaid', lines: LINES, projectCode: 'PRJ-1', ...extra
});
const created = (id: string, orderCode: string) => ({ ok: true, status: 201, error: null, code: null, failure: null, data: { id, code: orderCode, codeSource: 'auto', status: 'DRAFT' } });
const chainOk = (orderCode = 'PRJ-1-FILM-004') => callApi
  .mockResolvedValueOnce(ok({ id: 'po-1' })) // seven PO
  .mockResolvedValueOnce(ok({ id: 'chk-1' })) // checklist
  .mockResolvedValueOnce(created('ord-1', orderCode)) // order
  .mockResolvedValueOnce(ok({ id: 'ord-1' })); // confirm

const renderNewOrder = () => inContext(
  <NewOrderForm
    action={(async () => ({ ok: true, message: '' })) as never}
    projectCode="PRJ-1"
    unitChoices={[{ value: 'rolls', label: 'ロール' }]}
    paymentTermsChoices={[{ value: 'prepaid', label: '前払い' }]}
    existingPoChoices={[]}
    unverifiedPoIds={[]}
  />
);

describe('H7② the new-order form: 発注コード blank = numbered automatically', () => {
  it('the code input is optional and says it is numbered automatically, with the project\'s format', () => {
    const html = renderNewOrder();
    const input = inputTag(html, 'code');
    expect(input).not.toBe('');
    expect(input).not.toContain('required');
    expect(html).toContain('空欄なら自動で付けます');
    expect(html).toContain('PRJ-1-FILM-001');
    expect(html).not.toContain('placeholder="PRS-A-FILM-003"');
  });

  it('a blank code is not sent: the server numbers it, the derived key is the same one a retry would use, and the screen opens on the numbered order', async () => {
    chainOk('PRJ-1-FILM-004');
    const result = await stepActions.startFilmOrderAction(null, form(startForm()));
    expect(result.ok).toBe(true);
    const orderCall = callApi.mock.calls[2]!;
    expect(orderCall[0]).toBe('/api/projects/proj-1/film-supply-orders');
    expect(orderCall[1].body).not.toHaveProperty('code');
    expect(orderCall[1].idempotencyKey).toBe('form-key-0001.4');
    expect(result.message).toContain('PRJ-1-FILM-004');
    expect(result.message).toContain('自動');
    expect(redirect).toHaveBeenCalledWith('/p/PRJ-1/o/PRJ-1-FILM-004?started=1');
  });

  it('a typed code is sent as typed and the screen opens on it (unchanged)', async () => {
    chainOk('X-1');
    await stepActions.startFilmOrderAction(null, form(startForm({ code: 'PRJ-1-FILM-777' })));
    expect(callApi.mock.calls[2]![1].body).toMatchObject({ code: 'PRJ-1-FILM-777' });
    expect(redirect).toHaveBeenCalledWith('/p/PRJ-1/o/PRJ-1-FILM-777?started=1');
  });

  it('without a usable Idempotency-Key a blank code stops before the API (the server would answer 400 — and a keyless double submit would create two orders)', async () => {
    const result = await stepActions.startFilmOrderAction(null, form(startForm(), null));
    expect(result).toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(result.message).toContain('再読み込み');
    expect(callApi).not.toHaveBeenCalled();
    // …and a typed code needs no such key
    chainOk('T-1');
    expect((await stepActions.startFilmOrderAction(null, form(startForm({ code: 'T-1' }), null))).ok).toBe(true);
  });

  it('the server\'s own 400 IDEMPOTENCY_KEY_REQUIRED is shown in the dictionary\'s words, and an answered 4xx with nothing written renews the key', async () => {
    callApi.mockResolvedValueOnce(fail(400, 'IDEMPOTENCY_KEY_REQUIRED'));
    const result = await stepActions.startFilmOrderAction(null, form({ ...startForm(), poNumber: '', officialRegisteredAt: '', existingPoId: 'po-9' }));
    expect(result).toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_REQUIRED', settled: true });
    expect(result.message).toContain('dictionary text for IDEMPOTENCY_KEY_REQUIRED');
    expect(callApi.mock.calls[0]![1].body).not.toHaveProperty('code');
  });

  it('the same-key rule: a stop after the PO was written keeps the key, and the retry sends the SAME derived keys (blank code again)', async () => {
    callApi.mockResolvedValueOnce(ok({ id: 'po-1' })).mockResolvedValueOnce(ok({ id: 'chk-1' })).mockResolvedValueOnce({ ok: false, status: 503, data: null, error: 'down', code: 'API_TIMEOUT', failure: 'timeout' });
    const first = await stepActions.startFilmOrderAction(null, form(startForm()));
    expect(first).toMatchObject({ ok: false, settled: false });
    const firstKeys = callApi.mock.calls.map((call) => call[1].idempotencyKey);
    callApi.mockReset();
    chainOk('PRJ-1-FILM-004');
    await stepActions.startFilmOrderAction(null, form(startForm()));
    const retryKeys = callApi.mock.calls.map((call) => call[1].idempotencyKey);
    expect(retryKeys.slice(0, 3)).toEqual(firstKeys);
    expect(firstKeys).toEqual(['form-key-0001.1', 'form-key-0001.3', 'form-key-0001.4']);
    expect(retryKeys).toEqual(['form-key-0001.1', 'form-key-0001.3', 'form-key-0001.4', 'form-key-0001.5']);
  });

  it('a duplicate code names the registered order in the link (「登録済みのフィルム発注 X を開く」) and opens its own screen', async () => {
    callApi.mockResolvedValueOnce(ok({ id: 'po-1' })).mockResolvedValueOnce(ok({ id: 'chk-1' })).mockResolvedValueOnce(
      fail(409, 'DUPLICATE', { existing: { id: 'ord-existing', projectId: 'proj-1', projectCode: 'PRJ-1' } })
    );
    const result = await stepActions.startFilmOrderAction(null, form(startForm({ code: 'PRJ-1-FILM-002' })));
    expect(result.code).toBe('DUPLICATE');
    expect(result.link).toEqual({ href: '/p/PRJ-1/o/PRJ-1-FILM-002', label: '登録済みのフィルム発注 PRJ-1-FILM-002 を開く' });
  });

  it('duplicateLinkLabel names the record, and falls back to the kind alone for an empty or oversized name', () => {
    expect(duplicateLib.duplicateLinkLabel('seven_po', ' SC-9 ')).toBe('登録済みのセブン化学発注書 SC-9 を開く');
    expect(duplicateLib.duplicateLinkLabel('film_order', '')).toBe('登録済みのフィルム発注を開く');
    expect(duplicateLib.duplicateLinkLabel('filling_order', 'x'.repeat(65))).toBe('登録済みの充填発注を開く');
  });
});

// ---------------------------------------------------------------------------------------------
// N13 a file refused because it is filed elsewhere says where
// ---------------------------------------------------------------------------------------------
describe('N13 the refusal names the existing 発注コード and デザイン名', () => {
  it('existingBindingOf / withExistingBinding: the three codes, trimmed, control characters dropped, nothing for other codes', () => {
    const data = { existing: { orderCode: ' FSO-7\u0000 ', designKey: '表面A', orderId: 'o', makerPurchaseOrderId: 'm' } };
    for (const refused of ['DOCUMENT_BINDING_CONFLICT', 'FILE_DOCUMENT_ORDER_MISMATCH', 'FILE_DOCUMENT_DESIGN_MISMATCH']) {
      expect(bindingLib.existingBindingOf(refused, data)).toEqual({ orderCode: 'FSO-7', designKey: '表面A' });
      expect(bindingLib.withExistingBinding('基本の文', refused, data)).toBe('基本の文 すでに登録されている先: 発注 FSO-7・デザイン 表面A。');
    }
    expect(bindingLib.withExistingBinding('基本の文', 'DUPLICATE', data)).toBe('基本の文');
    expect(bindingLib.withExistingBinding('基本の文', 'DOCUMENT_BINDING_CONFLICT', {})).toBe('基本の文');
    expect(bindingLib.withExistingBinding('基本の文', 'DOCUMENT_BINDING_CONFLICT', { existing: { orderCode: 'a'.repeat(200) } })).toContain('a'.repeat(64));
    expect(bindingLib.withExistingBinding('基本の文', 'DOCUMENT_BINDING_CONFLICT', { existing: { designKey: '裏面B' } })).toContain('デザイン 裏面B');
  });

  it('refusalState puts it on the form result (every action that refuses through it)', () => {
    const state = refusalState({ status: 422, failure: null, code: 'FILE_DOCUMENT_ORDER_MISMATCH', error: '別の発注に登録されています', data: { existing: { orderCode: 'FSO-7', designKey: '表面A' } } });
    expect(state.message).toBe('別の発注に登録されています すでに登録されている先: 発注 FSO-7・デザイン 表面A。');
    expect(state.settled).toBe(true);
    expect(refusalState({ status: 422, failure: null, code: 'X', error: '別の文', data: null }).message).toBe('別の文');
  });

  it('a step upload refused as already filed (校正の登録) shows the order code and the design on the screen', async () => {
    callApi.mockResolvedValueOnce(fail(422, 'DOCUMENT_BINDING_CONFLICT', { existing: { documentId: 'd1', orderId: 'o1', orderCode: 'PRJ-1-FILM-002', designKey: '裏面B', makerPurchaseOrderId: null } }));
    const result = await stepActions.submitProofStepAction(null, form({
      orderId: 'ord-1', sevenPurchaseOrderId: 'po-1', designKey: '表面A', currentStatus: 'ARTWORK_RECEIVED',
      contentBase64: Buffer.from('%PDF-1.7').toString('base64'), filename: 'a.pdf', contentType: 'application/pdf'
    }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('発注 PRJ-1-FILM-002');
    expect(result.message).toContain('デザイン 裏面B');
  });
});

// ---------------------------------------------------------------------------------------------
// N1 担当者: the representative assigns; a person with no project can ask
// ---------------------------------------------------------------------------------------------
const view = (rows: Array<Record<string, unknown>> = [], over: Record<string, unknown> = {}) => ({
  assignments: rows.map((row) => ({ id: `as-${row.userId}`, role: 'staff', isActive: true, assignedAt: '2026-11-20T01:00:00Z', ...row })),
  assignableRoles: ['staff', 'viewer', 'auditor'], error: null, ...over
});
const renderPanel = (v: unknown, candidates: unknown[] = []) => inContext(<ProjectAssignmentsPanel view={v as never} candidates={candidates as never} />);

describe('N1 担当者 panel (representative only)', () => {
  it('lists the people with their role and a confirmed 外す form each (userId in a hidden field)', () => {
    const html = renderPanel(view([{ userId: USER_A, displayName: '佐藤' }, { userId: USER_B, displayName: '鈴木', role: 'viewer' }]));
    expect(html).toContain('data-section="assignments"');
    expect(html).toContain('佐藤');
    expect(html).toContain('担当者');
    expect(html).toContain('閲覧');
    expect(html.match(/name="userId" value="[0-9a-f-]{36}"/g)).toHaveLength(2);
    expect(html.match(/<button type="submit"[^>]*>外す/g)).toHaveLength(2);
  });

  it('the add form offers the people assigned elsewhere and a typed 利用者ID — and says the representative needs no assignment', () => {
    const html = renderPanel(view([]), [{ userId: USER_A, displayName: '佐藤', role: 'staff' }]);
    expect(html).toContain('name="candidateUserId"');
    expect(html).toContain(`value="${USER_A}"`);
    expect(html).toContain('佐藤（担当者）');
    expect(html).toContain('name="typedUserId"');
    expect(html).toContain('担当者に割り当てる');
    expect(html).toContain('代表者は、すべての案件を開けるため');
    expect(html).toContain('担当者はまだいません');
  });

  it('without candidates only the typed field is offered; a failed read says so instead of 「いません」', () => {
    const html = renderPanel(view([]), []);
    expect(html).not.toContain('name="candidateUserId"');
    expect(html).toContain('name="typedUserId"');
    const failed = renderPanel(view([], { error: '読み込めません' }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('担当者の一覧を読み込めませんでした');
    expect(failed).not.toContain('担当者はまだいません');
  });

  it('the panel never prints an amount', () => {
    expect(renderPanel(view([{ userId: USER_A, displayName: '佐藤' }]))).not.toMatch(/[¥￥]\d|金額/);
  });

  it('the Korean title and note follow showKorean', () => {
    const html = renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'proj-1', showKorean: true }}><ProjectAssignmentsPanel view={view([]) as never} candidates={[]} /></RenderedContextProvider>
    );
    expect(html).toContain('담당자');
  });

  it('assignmentsFrom / candidatesFrom / isUserId / chosenUserId (pure)', () => {
    const rows = assignmentsLib.assignmentsFrom({ assignments: [{ id: 'a', userId: USER_A, displayName: '佐藤', role: 'staff', isActive: true, assignedAt: 'x' }, { userId: '', displayName: 'x' }, null], assignableRoles: ['staff', 7] });
    expect(rows.assignments).toHaveLength(1);
    expect(rows.assignableRoles).toEqual(['staff']);
    const here = [{ id: 'h', userId: USER_A, displayName: '佐藤', role: 'staff', isActive: true, assignedAt: null }];
    const elsewhere = [[
      { id: '1', userId: USER_A, displayName: '佐藤', role: 'staff', isActive: true, assignedAt: null },
      { id: '2', userId: USER_B, displayName: '鈴木', role: 'viewer', isActive: true, assignedAt: null },
      { id: '3', userId: 'c'.repeat(8) + '-0000-7000-8000-000000000000', displayName: '無効', role: 'staff', isActive: false, assignedAt: null }
    ], [{ id: '4', userId: USER_B, displayName: '鈴木', role: 'viewer', isActive: true, assignedAt: null }]];
    expect(assignmentsLib.candidatesFrom(here, elsewhere)).toEqual([{ userId: USER_B, displayName: '鈴木', role: 'viewer' }]);
    expect(assignmentsLib.isUserId(USER_A)).toBe(true);
    expect(assignmentsLib.isUserId('not-an-id')).toBe(false);
    expect(assignmentsLib.chosenUserId(form({ candidateUserId: USER_B, typedUserId: USER_A }))).toBe(USER_B);
    expect(assignmentsLib.chosenUserId(form({ candidateUserId: '', typedUserId: ` ${USER_A} ` }))).toBe(USER_A);
    expect(assignmentsLib.chosenUserId(form({ typedUserId: 'zzz' }))).toBeNull();
  });
});

describe('N1 add / remove actions', () => {
  it('addAssignmentAction: POSTs {userId} to the rendered project with the key and the expected-project header', async () => {
    callApi.mockResolvedValue(ok({ assignment: { userId: USER_A } }));
    const result = await assignmentActions.addAssignmentAction(null, form({ candidateUserId: USER_A }));
    expect(result.ok).toBe(true);
    expect(callApi).toHaveBeenCalledWith('/api/projects/proj-1/assignments', { method: 'POST', body: { userId: USER_A }, idempotencyKey: 'form-key-0001', expectedProjectId: 'proj-1' });
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('addAssignmentAction: nothing chosen, or a typed value that is not an id, never reaches the API (and says what an id looks like)', async () => {
    const none = await assignmentActions.addAssignmentAction(null, form({ candidateUserId: '', typedUserId: '' }));
    expect(none).toMatchObject({ ok: false, code: 'ASSIGNMENT_USER_REQUIRED' });
    const typed = await assignmentActions.addAssignmentAction(null, form({ typedUserId: 'taro' }));
    expect(typed.ok).toBe(false);
    expect(typed.message).toContain('利用者ID');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('addAssignmentAction: the API decides — 403 CEO_ONLY, 409 already assigned, 422 unknown user are shown as answered, nothing is refreshed', async () => {
    for (const [status, refused] of [[403, 'CEO_ONLY'], [409, 'PROJECT_ASSIGNMENT_EXISTS'], [422, 'ASSIGNMENT_USER_NOT_FOUND']] as const) {
      revalidatePath.mockReset();
      callApi.mockResolvedValue(fail(status, refused));
      const result = await assignmentActions.addAssignmentAction(null, form({ typedUserId: USER_A }));
      expect(result).toMatchObject({ ok: false, code: refused, settled: true });
      expect(revalidatePath).not.toHaveBeenCalled();
    }
  });

  it('addAssignmentAction refuses a form drawn for no project (fail closed)', async () => {
    const data = form({ candidateUserId: USER_A });
    data.delete(RENDERED_PROJECT_FIELD);
    expect((await assignmentActions.addAssignmentAction(null, data)).ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('removeAssignmentAction: DELETEs that user from the rendered project; a bad id is refused first', async () => {
    callApi.mockResolvedValue(ok({ removed: {} }));
    expect((await assignmentActions.removeAssignmentAction(null, form({ userId: USER_B }))).ok).toBe(true);
    expect(callApi).toHaveBeenCalledWith(`/api/projects/proj-1/assignments/${USER_B}`, { method: 'DELETE', idempotencyKey: 'form-key-0001', expectedProjectId: 'proj-1' });
    callApi.mockReset();
    expect((await assignmentActions.removeAssignmentAction(null, form({ userId: '../x' }))).ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('removeAssignmentAction: 404 PROJECT_ASSIGNMENT_NOT_FOUND is shown as answered', async () => {
    callApi.mockResolvedValue(fail(404, 'PROJECT_ASSIGNMENT_NOT_FOUND'));
    expect(await assignmentActions.removeAssignmentAction(null, form({ userId: USER_B }))).toMatchObject({ ok: false, code: 'PROJECT_ASSIGNMENT_NOT_FOUND' });
  });
});

describe('N1 the screen with no project: 「代表者に割り当てを依頼」', () => {
  const requester = { id: USER_A, displayName: '佐藤', role: 'staff' };

  it('assignmentRequestText carries the name, the role and the 利用者ID the representative pastes', () => {
    const text = assignmentRequestText(requester);
    expect(text).toContain('佐藤');
    expect(text).toContain('担当者');
    expect(text).toContain(USER_A);
    expect(assignmentRequestText({ id: USER_B, role: 'auditor' })).toContain('監査');
  });

  it('a staff member with no project sees the request (a read-only textarea holding it)', () => {
    const html = inContext(<ProjectChooser selection={{ kind: 'none' } as never} role="staff" requester={requester} />);
    expect(html).toContain('代表者に割り当てを依頼');
    expect(html).toMatch(/<textarea[^>]*readOnly=""[^>]*>[^<]*佐藤/);
    expect(html).toContain(USER_A);
  });

  it('viewer and auditor too; the representative has nobody to ask and does not get it', () => {
    expect(inContext(<ProjectChooser selection={{ kind: 'none' } as never} role="viewer" requester={{ ...requester, role: 'viewer' }} />)).toContain('代表者に割り当てを依頼');
    expect(inContext(<ProjectChooser selection={{ kind: 'none' } as never} role="admin" requester={{ ...requester, role: 'admin' }} />)).not.toContain('代表者に割り当てを依頼');
    // a failed list read is not 「no project」: no request
    expect(inContext(<ProjectChooser selection={{ kind: 'error', error: 'x' } as never} role="staff" requester={requester} />)).not.toContain('代表者に割り当てを依頼');
  });

  it('the not-found screen with an empty project list carries it too (a link to a project the person cannot open)', () => {
    const html = inContext(<ProjectNotFound code="PRJ-9" projects={[]} listError={null} requester={requester} />);
    expect(html).toContain('代表者に割り当てを依頼');
    expect(html).toContain(USER_A);
    expect(inContext(<ProjectNotFound code="PRJ-9" projects={[{ id: 'p', code: 'PRJ-1', name: 'A', status: 'ACTIVE' }]} listError={null} requester={requester} />)).not.toContain('代表者に割り当てを依頼');
  });

  it('AssignmentRequest in Korean mode adds the Korean line', () => {
    const html = renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'p', showKorean: true }}><AssignmentRequest requester={requester} /></RenderedContextProvider>
    );
    expect(html).toContain('대표자에게 배정을 요청');
  });
});

describe('N1 the project overview draws the panel for the representative only', () => {
  async function overview(role: string) {
    vi.resetModules();
    vi.doMock('../apps/web/src/lib/dashboard-data.js', () => ({
      loadDashboardData: async () => ({
        board: {
          workspace: {
            labels: { filmSupplyOrderStates: [], makerPurchaseOrderStatuses: [], commissionReadinessStates: [], fillingDeliveryConfirmationStates: [], approvalOrganizations: [] },
            filmOrders: [], sevenPurchaseOrders: [], revisions: [], revisionsWithheld: 0, documents: [], deliveries: [], readiness: null,
            project: { id: 'proj-1', code: 'PRJ-1', name: '案件A' }, projectRefused: false, error: null
          },
          boards: []
        },
        activity: []
      })
    }));
    state.user = { id: 'u', role, displayName: 'X' };
    state.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }, { id: 'proj-2', code: 'PRJ-2', name: '案件B', status: 'ACTIVE' }];
    callApi.mockImplementation(async (url: string) => {
      if (url === '/api/projects/proj-1/assignments') return ok({ assignments: [{ id: 'a1', userId: USER_A, displayName: '佐藤', role: 'staff', isActive: true, assignedAt: null }], assignableRoles: ['staff'] });
      if (url === '/api/projects/proj-2/assignments') return ok({ assignments: [{ id: 'a2', userId: USER_B, displayName: '鈴木', role: 'staff', isActive: true, assignedAt: null }], assignableRoles: ['staff'] });
      if (url === '/api/representative-queue') return ok({ items: [], blocked: [] });
      return ok({});
    });
    const { ProjectOverviewScreen } = await import('../apps/web/src/screens/ProjectOverviewScreen.js');
    const { RenderedContextProvider: Provider } = await import('../apps/web/src/components/RenderedContext.js');
    const tree = await ProjectOverviewScreen({ projectId: 'proj-1', projectCode: 'PRJ-1' } as never);
    return renderToStaticMarkup(<Provider value={{ projectId: 'proj-1', showKorean: false }}>{(await resolve(tree)) as ReactElement}</Provider>);
  }

  it('the representative sees 担当者 with the people of this project and, as candidates, the people of the other project', async () => {
    const html = await overview('admin');
    expect(html).toContain('data-section="assignments"');
    expect(html).toContain('佐藤');
    expect(html).toContain(`value="${USER_B}"`);
    expect(html).not.toContain(`<option value="${USER_A}"`);
    expect(callApi.mock.calls.some((call) => call[0] === '/api/projects/proj-1/assignments')).toBe(true);
  });

  it.each(['staff', 'viewer', 'auditor'])('%s gets no 担当者 section and the web never even asks the API for the list', async (role) => {
    const html = await overview(role);
    expect(html).not.toContain('data-section="assignments"');
    expect(callApi.mock.calls.some((call) => String(call[0]).includes('/assignments'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// N4 the evidence the representative confirms: file, From, who registered it, and the sender warnings
// ---------------------------------------------------------------------------------------------
const evidenceItem = (over: Record<string, unknown> = {}) => ({
  key: 'approval_evidence_verification:1', kind: 'approval_evidence_verification', label: '承認証跡の確認',
  project: { id: 'proj-1', code: 'PRJ-1', name: '案件A' }, order: { id: 'ord-1', code: 'FSO-1', status: 'APPROVAL_PENDING', requestedDeliveryDate: '2026-12-15', plannedDeliveryDate: null },
  organization: 'customer', designKey: '表面A', waitingSince: '2026-11-20T01:00:00Z', requestedBy: { displayName: '佐藤' },
  detail: {
    evidence: { documentVersionId: 'v1', filename: 'ok-mail.eml', uploadedAt: '2026-11-20T01:00:00Z', uploadedBy: { id: 'u1', displayName: '佐藤' }, fromAddress: 'someone@other.example', senderDomainCheck: { status: 'mismatch', fromAddress: 'someone@other.example', fromDomain: 'other.example', registeredDomain: 'customer.example' } },
    warnings: [{ code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH', message: 'x', fromDomain: 'other.example', registeredDomain: 'customer.example' }]
  },
  ...over
});
const multipleFrom = () => evidenceItem({
  detail: {
    evidence: { documentVersionId: 'v2', filename: 'two-from.eml', uploadedBy: { id: 'u1', displayName: '鈴木' }, fromAddress: null, senderDomainCheck: { status: 'multiple_from', fromAddress: null, fromDomain: null, registeredDomain: 'customer.example' } },
    warnings: [{ code: 'EVIDENCE_SENDER_UNVERIFIABLE', message: 'y' }]
  }
});
const NOW = new Date('2026-11-23T03:00:00.000Z'); // 12:00 JST

describe('N4 the sender check is shown (warn only — the confirmation itself is unchanged)', () => {
  it('taskFromServerItem keeps the file, From, uploader, sender status and the warnings of an 承認証跡の確認 row', () => {
    const task = queueLib.taskFromServerItem(evidenceItem())!;
    expect(task.evidence).toEqual({ filename: 'ok-mail.eml', fromAddress: 'someone@other.example', uploadedBy: '佐藤', senderStatus: 'mismatch' });
    expect(task.warnings?.map((warning) => warning.code)).toEqual(['EVIDENCE_SENDER_DOMAIN_MISMATCH']);
    const none = queueLib.taskFromServerItem({ ...evidenceItem(), detail: undefined })!;
    expect(none.evidence).toBeNull();
    expect(none.warnings).toEqual([]);
  });

  it('a row shows 発行元（登録時の申告）, the file name, the From address, the uploader and the mismatch warning', () => {
    const html = inContext(<QueueRowExtras task={queueLib.taskFromServerItem(evidenceItem())!} now={NOW} />);
    expect(html).toContain('発行元（登録時の申告）');
    expect(html).toContain('ok-mail.eml');
    expect(html).toContain('someone@other.example');
    expect(html).toContain('登録した人 佐藤');
    expect(html).toContain('差出人のドメインが登録と違います');
    expect(html).toContain('data-warning="EVIDENCE_SENDER_DOMAIN_MISMATCH"');
    expect(html).toContain('承認証跡メールの差出人のドメインが、登録されている取引先のドメインと違います');
  });

  it('multiple_from (and a missing From) shows the UNVERIFIABLE warning and says the From is plural', () => {
    const html = inContext(<QueueRowExtras task={queueLib.taskFromServerItem(multipleFrom())!} now={NOW} />);
    expect(html).toContain('data-warning="EVIDENCE_SENDER_UNVERIFIABLE"');
    expect(html).toContain('差出人（From）が複数あります');
    expect(html).toContain('承認証跡メールの差出人を確認できません');
    expect(html).toContain('two-from.eml');
    const none = inContext(<QueueRowExtras task={queueLib.taskFromServerItem(evidenceItem({ detail: { evidence: { filename: 'm.eml', uploadedBy: { displayName: 'x' }, fromAddress: 'a@customer.example', senderDomainCheck: { status: 'match' } }, warnings: [] } }))!} now={NOW} />);
    expect(none).not.toContain('data-warning');
    expect(none).not.toContain('差出人のドメイン');
  });

  it('the Korean lines of the warning and the status follow showKorean (P-7)', () => {
    const task = queueLib.taskFromServerItem(multipleFrom())!;
    const ko = renderToStaticMarkup(<RenderedContextProvider value={{ projectId: 'p', showKorean: true }}><QueueRowExtras task={task} now={NOW} /></RenderedContextProvider>);
    expect(ko).toContain('발신자(From)가 여러 개입니다');
    expect(ko).toContain('lang="ko"');
    expect(inContext(<QueueRowExtras task={task} now={NOW} />)).not.toContain('lang="ko"');
  });

  it('the home inbox draws it on the row (the real screen, not the helper)', async () => {
    state.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockResolvedValue(ok({ items: [evidenceItem(), multipleFrom()], blocked: [] }));
    const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
    const html = renderToStaticMarkup((await resolve(await HomeScreen())) as ReactElement);
    expect(html).toContain('ok-mail.eml');
    expect(html).toContain('data-warning="EVIDENCE_SENDER_UNVERIFIABLE"');
    expect(html).toContain('data-warning="EVIDENCE_SENDER_DOMAIN_MISMATCH"');
  });

  it('the approval card names the issuer a declaration (not 「発行元」 alone) and shows the file name of the evidence', () => {
    const evidence = { filename: 'customer-ok.eml', issuerEntity: 'customer_generated', expectedIssuerEntity: 'customer_generated', issuerMatchesOrganization: true, evidenceSource: 'email', identifierStatus: 'verified' };
    const html = renderCard(card({ designs: [{ designKey: '表面A', revisionNo: 2, customer: { state: 'approved', eventTime: null, evidence }, seven: org('approved') }] }));
    expect(html).toContain('発行元（登録時の申告）');
    expect(html).toContain('申告どおり');
    expect(html).toContain('customer-ok.eml');
    expect(html).not.toMatch(/ ・ 発行元 /);
  });

  it('recording an approval: the server\'s sender warnings are added to the success line (and nothing is added without them)', async () => {
    const answers = (warnings: unknown) => callApi
      .mockResolvedValueOnce({ ok: true, status: 201, error: null, code: null, failure: null, data: { document: { id: 'd' }, version: { id: 'v1' } } })
      .mockResolvedValueOnce({ ok: true, status: 201, error: null, code: null, failure: null, data: { id: 'ap-1', ...(warnings ? { warnings } : {}) } });
    const approvalForm = () => form({
      orderId: 'ord-1', sevenPurchaseOrderId: 'po-1', revisionId: 'rev-1', designKey: '表面A', organization: 'customer',
      contentBase64: Buffer.from('x').toString('base64'), filename: 'ok.eml', contentType: 'message/rfc822',
      mailMessageId: '<msg-1234@customer.example>', mailDate: '2026-11-20T01:00:00.000Z'
    });
    answers([{ code: 'EVIDENCE_SENDER_UNVERIFIABLE', message: 'z', fromDomain: null }]);
    const warned = await stepActions.recordApprovalStepAction(null, approvalForm());
    expect(warned.ok).toBe(true);
    expect(warned.message).toContain('顧客の承認を記録しました');
    expect(warned.message).toContain('⚠');
    expect(warned.message).toContain('承認証跡メールの差出人を確認できません');
    callApi.mockReset();
    answers(null);
    const clean = await stepActions.recordApprovalStepAction(null, approvalForm());
    expect(clean.message).not.toContain('⚠');
  });

  it('senderWarningsOf: only the two sender codes, once each, in the dictionary\'s words', () => {
    const list = senderLib.senderWarningsOf([{ code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH' }, { code: 'EVIDENCE_SENDER_DOMAIN_MISMATCH' }, { code: 'OTHER' }, null, { code: 3 }]);
    expect(list.map((warning) => warning.code)).toEqual(['EVIDENCE_SENDER_DOMAIN_MISMATCH']);
    expect(list[0]!.ko).toContain('발신자');
    expect(senderLib.senderWarningsOf(undefined)).toEqual([]);
    expect(senderLib.senderStatusOf({ status: 'bogus' })).toBeNull();
    expect(senderLib.senderStatusOf({ status: 'multiple_from' })).toBe('multiple_from');
    expect(senderLib.senderWarningSentence([])).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// M18 / N11 / M13 the rows of the 承認箱: 希望納期・あと○日, and which organization / design
// ---------------------------------------------------------------------------------------------
describe('M18 希望納期 and the days left on a queue row', () => {
  const due = queueLib.queueDueText;
  it('future / today / past, in Japan time (a UTC evening is already tomorrow in JST)', () => {
    expect(due({ requestedDeliveryDate: '2026-12-15' }, NOW)).toEqual({ text: '希望納期 12/15（あと22日）', late: false });
    expect(due({ requestedDeliveryDate: '2026-11-23' }, NOW)).toEqual({ text: '希望納期 11/23（今日）', late: false });
    expect(due({ requestedDeliveryDate: '2026-11-20' }, NOW)).toEqual({ text: '希望納期 11/20（3日超過）', late: true });
    // 2026-11-22 16:00 UTC = 2026-11-23 01:00 JST
    expect(due({ requestedDeliveryDate: '2026-11-23' }, new Date('2026-11-22T16:00:00Z'))?.text).toBe('希望納期 11/23（今日）');
    expect(due({ requestedDeliveryDate: null }, NOW)).toBeNull();
    expect(due({ requestedDeliveryDate: '2026/12/15' }, NOW)).toBeNull();
    expect(due({}, NOW)).toBeNull();
  });

  it('taskFromServerItem reads both dates of the order (null when the order does not carry them)', () => {
    const task = queueLib.taskFromServerItem(evidenceItem())!;
    expect(task).toMatchObject({ requestedDeliveryDate: '2026-12-15', plannedDeliveryDate: null });
    expect(queueLib.taskFromServerItem(evidenceItem({ order: { id: 'o', code: 'F-1', requestedDeliveryDate: 'soon' } }))!.requestedDeliveryDate).toBeNull();
  });

  it('the home row prints 「希望納期 12/15（あと22日）」 and marks a late one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      state.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
      callApi.mockResolvedValue(ok({
        items: [evidenceItem(), evidenceItem({ organization: 'seven', designKey: '裏面B', order: { id: 'ord-2', code: 'FSO-2', requestedDeliveryDate: '2026-11-20' } })],
        blocked: []
      }));
      const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
      const html = renderToStaticMarkup((await resolve(await HomeScreen())) as ReactElement);
      expect(html).toContain('希望納期 12/15（あと22日）');
      expect(html).toContain('希望納期 11/20（3日超過）');
      expect(html).toContain('data-due="late"');
      expect(html).toContain('data-due="ok"');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the cross-project panel shows it too', () => {
    const tasks = [queueLib.taskFromServerItem(evidenceItem())!];
    const html = inContext(<RepresentativeQueuePanel queue={{ tasks, unreadProjects: [], skippedProjects: 0 }} currentProjectId={null} now={NOW} />);
    expect(html).toContain('希望納期 12/15（あと22日）');
  });
});

describe('N11 / M13 two rows of one order are told apart (組織・デザイン)', () => {
  const customerRow = evidenceItem();
  const sevenRow = evidenceItem({ organization: 'seven', designKey: '表面A', detail: undefined });

  it('queueRowTitle: 「承認証跡の確認（顧客／表面A）」; a row about the whole order is unchanged', () => {
    expect(queueLib.queueRowTitle(queueLib.taskFromServerItem(customerRow)!)).toBe('承認証跡の確認（顧客／表面A）');
    expect(queueLib.queueRowTitle(queueLib.taskFromServerItem(sevenRow)!)).toBe('承認証跡の確認（セブン化学／表面A）');
    expect(queueLib.queueRowTitle(queueLib.taskFromServerItem(evidenceItem({ organization: null, designKey: null }))!)).toBe('承認証跡の確認');
    expect(queueLib.queueRowTitle({ work: '代表承認', organization: null, designKey: '表面A' })).toBe('代表承認（表面A）');
    expect(queueLib.queueRowSuffixKo({ organization: 'seven', designKey: '表面A' })).toBe('(세븐화학／表面A)');
    expect(queueLib.queueRowSuffixKo({ organization: null, designKey: null })).toBeNull();
  });

  it('the home shows both rows with their own titles and does not collapse them (distinct keys, one link each)', async () => {
    state.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockResolvedValue(ok({ items: [customerRow, sevenRow], blocked: [] }));
    const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const html = renderToStaticMarkup((await resolve(await HomeScreen())) as ReactElement);
    expect(html).toContain('承認証跡の確認（顧客／表面A）');
    expect(html).toContain('承認証跡の確認（セブン化学／表面A）');
    expect(html.match(/href="\/p\/PRJ-1\/o\/FSO-1\?step=6"/g)).toHaveLength(2);
    // each link's hidden name says which row it opens
    expect(errors.mock.calls.filter((call) => String(call[0]).includes('same key'))).toHaveLength(0);
    errors.mockRestore();
  });

  it('queueRowKey: two rows of one order (organization / design) get different keys; the blocked prefix keeps them apart from items', () => {
    const [a, b] = [customerRow, sevenRow].map((row) => queueLib.taskFromServerItem(row)!);
    expect(queueLib.queueRowKey(a!)).not.toBe(queueLib.queueRowKey(b!));
    expect(queueLib.queueRowKey(a!, 'b-')).toBe(`b-${queueLib.queueRowKey(a!)}`);
    expect(queueLib.queueRowKey({ ...a!, designKey: '裏面B' })).not.toBe(queueLib.queueRowKey(a!));
  });

  it('the cross-project panel keeps both rows too (it used to key on order alone)', () => {
    const tasks = [customerRow, sevenRow].map((row) => queueLib.taskFromServerItem(row)!);
    const html = inContext(<RepresentativeQueuePanel queue={{ tasks, unreadProjects: [], skippedProjects: 0 }} currentProjectId={null} now={NOW} />);
    expect(html).toContain('承認証跡の確認（顧客／表面A）');
    expect(html).toContain('承認証跡の確認（セブン化学／表面A）');
  });
});

// ---------------------------------------------------------------------------------------------
// B1 final check: 「未定」 is in 「止まっている」 from the moment the order exists
// ---------------------------------------------------------------------------------------------
describe('B1 final: a just-created order with 支払条件「未定」 is listed as stopped, on the real overview screen', () => {
  async function overviewWith(orders: unknown[]) {
    vi.resetModules();
    vi.doMock('../apps/web/src/lib/dashboard-data.js', () => ({
      loadDashboardData: async () => ({
        board: {
          workspace: {
            labels: { filmSupplyOrderStates: [{ key: 'DRAFT', label: '下書き' }], makerPurchaseOrderStatuses: [], commissionReadinessStates: [], fillingDeliveryConfirmationStates: [], approvalOrganizations: [] },
            filmOrders: orders, sevenPurchaseOrders: [], revisions: [], revisionsWithheld: 0, documents: [], deliveries: [], readiness: null,
            project: { id: 'proj-1', code: 'PRJ-1', name: '案件A' }, projectRefused: false, error: null
          },
          boards: []
        },
        activity: []
      })
    }));
    state.user = { id: 'u', role: 'admin', displayName: 'X' };
    state.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockImplementation(async (url: string) => (url.endsWith('/assignments') ? ok({ assignments: [], assignableRoles: [] }) : ok({ items: [], blocked: [] })));
    const { ProjectOverviewScreen } = await import('../apps/web/src/screens/ProjectOverviewScreen.js');
    const { RenderedContextProvider: Provider } = await import('../apps/web/src/components/RenderedContext.js');
    const tree = await ProjectOverviewScreen({ projectId: 'proj-1', projectCode: 'PRJ-1' } as never);
    return renderToStaticMarkup(<Provider value={{ projectId: 'proj-1', showKorean: false }}>{(await resolve(tree)) as ReactElement}</Provider>);
  }
  const fresh = (over: Record<string, unknown> = {}) => ({
    id: 'ord-1', code: 'PRJ-1-FILM-001', status: 'DRAFT', sevenPurchaseOrderId: 'po-1', lineCount: 1, lines: [], detailsHidden: false, statusHidden: false,
    lastNormalStatus: 'DRAFT', hold: null, paymentTerms: 'undetermined', paymentTermsHidden: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    paymentTermsUndetermined: true, ...over
  });

  it('the stopped list holds the order from creation (status DRAFT), with a link to its own screen — and a decided one is not listed', async () => {
    const html = await overviewWith([fresh()]);
    const blocked = html.match(/<ul class="dash-items" aria-label="止まっている発注">[\s\S]*?<\/ul>/)?.[0] ?? 'NO LIST';
    expect(blocked).toContain('PRJ-1-FILM-001');
    expect(blocked).toContain('未定');
    expect(blocked).toContain('href="/p/PRJ-1/o/PRJ-1-FILM-001"');
    expect(blocked).not.toContain('/orders#');
    const decided = await overviewWith([fresh({ paymentTerms: 'prepaid', paymentTermsUndetermined: false })]);
    expect(decided).not.toContain('aria-label="止まっている発注"');
    expect(decided).toContain('止まっている発注はありません');
  });

  it('the home 承認箱 lists the server\'s blocked row (kind payment_terms_undetermined) with a 直す link to step 7', async () => {
    state.projects = [{ id: 'proj-1', code: 'PRJ-1', name: '案件A', status: 'ACTIVE' }];
    callApi.mockResolvedValue(ok({
      items: [], blocked: [{ kind: 'payment_terms_undetermined', project: { id: 'proj-1', code: 'PRJ-1' }, order: { id: 'ord-1', code: 'PRJ-1-FILM-001', requestedDeliveryDate: '2026-12-15' }, reason: { message: '支払条件が「未定」です。' } }]
    }));
    const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
    const html = renderToStaticMarkup((await resolve(await HomeScreen())) as ReactElement);
    expect(html).toContain('止まっている（代表が直せるもの）');
    expect(html).toContain('支払条件が「未定」です。');
    expect(html).toMatch(/href="\/p\/PRJ-1\/o\/PRJ-1-FILM-001\?step=7">直す/);
    // M18: the blocked row carries the 希望納期 too
    expect(html).toMatch(/希望納期 12\/15（/);
  });
});

// ---------------------------------------------------------------------------------------------
// M16 remainder: one 「確認」 (納品確認), glossary words in the guide / status / dashboard
// ---------------------------------------------------------------------------------------------
describe('M16 remainder: 受領確認 is 納品確認 (受領証跡 is the evidence)', () => {
  it('the guide steps and terms no longer call the delivery check 受領確認 / 受領確認済', async () => {
    const { GUIDE_STEPS, GUIDE_TERMS, GUIDE_DAYS, GUIDE_TROUBLES } = await import('../apps/web/src/lib/guide.js');
    const text = JSON.stringify([GUIDE_STEPS, GUIDE_TERMS, GUIDE_DAYS, GUIDE_TROUBLES]);
    expect(text).not.toContain('受領確認');
    expect(text).toContain('納品確認');
    expect(GUIDE_TERMS.some((entry: { term: string }) => entry.term === '納品確認')).toBe(true);
  });

  it('the guide page and the status page say 納品の確認', () => {
    expect(code(readSrc('app/guide/page.tsx'))).not.toContain('受領確認');
    expect(code(readSrc('app/status/page.tsx'))).not.toContain('受領確認');
    expect(code(readSrc('app/status/page.tsx'))).toContain('納品の確認');
  });

  it('the dashboard says a delivered order waits for 「納品の確認」', async () => {
    const { buildDashboard } = await import('../apps/web/src/lib/dashboard.js');
    const old = '2026-10-01T00:00:00.000Z';
    const view = buildDashboard({
      role: 'admin',
      workspace: {
        labels: { filmSupplyOrderStates: [{ key: 'FILM_DELIVERED', label: '納品済み' }], makerPurchaseOrderStatuses: [], commissionReadinessStates: [], fillingDeliveryConfirmationStates: [], approvalOrganizations: [] },
        filmOrders: [{ id: 'o', code: 'FSO-1', status: 'FILM_DELIVERED', sevenPurchaseOrderId: 'po', lineCount: 1, lines: [], detailsHidden: false, statusHidden: false, lastNormalStatus: 'FILM_DELIVERED', hold: null, paymentTerms: 'prepaid', paymentTermsHidden: false, createdAt: old, updatedAt: old }],
        sevenPurchaseOrders: [], revisions: [], revisionsWithheld: 0, documents: [], deliveries: [], readiness: null
      },
      boards: [], activity: [], now: new Date('2026-11-23T03:00:00Z')
    } as never);
    const text = JSON.stringify(view);
    expect(text).toContain('納品の確認');
    expect(text).not.toContain('受領確認');
  });

  it('LEGACY_TERMS now lists the words so a screen cannot bring them back', async () => {
    const { LEGACY_TERMS } = await import('../apps/web/src/lib/terms.js');
    const words = LEGACY_TERMS.map(([word]: readonly [string, string]) => word);
    expect(words).toEqual(expect.arrayContaining(['受領確認済', '納品・受領確認']));
  });
});

// ---------------------------------------------------------------------------------------------
// R-1 a form on an order screen keeps its draft (so an uncancelable 「戻る」 does not lose the input)
// R-2 SelectField hands its `value` to the <select>
// ---------------------------------------------------------------------------------------------
describe('R-1 step forms keep a draft; the guard comment says which forms', () => {
  it('isOrderScreenPath: the order screen only (not the list, the wizard or a step query)', () => {
    expect(guardLib.isOrderScreenPath('/p/PRJ-1/o/PRJ-1-FILM-001')).toBe(true);
    expect(guardLib.isOrderScreenPath('/p/PRJ-1/o/PRJ-1-FILM-001/')).toBe(true);
    for (const other of ['/p/PRJ-1', '/p/PRJ-1/new', '/p/PRJ-1/orders', '/p/PRJ-1/o', '/dashboard', '/p/PRJ-1/o/A/b']) expect(guardLib.isOrderScreenPath(other), other).toBe(false);
  });

  it('draftIdentity: built from the record ids only (not the per-render key, project or hash)', () => {
    const controls = [
      { name: '_kaneiRenderedProjectId', value: 'p1' }, { name: '_kaneiIdempotencyKey', value: 'k' }, { name: 'expectedSnapshotSha256', value: 'h' },
      { name: 'orderId', value: 'ord-1' }, { name: 'designKey', value: '表面A' }, { name: 'organization', value: 'seven' }
    ];
    expect(guardLib.draftIdentity(controls)).toBe('#ord-1|表面A|seven');
    expect(guardLib.draftIdentity([{ name: 'other', value: 'x' }])).toBe('');
    // two forms with the same button for two designs do not share a draft
    expect(guardLib.draftIdentity([{ name: 'designKey', value: '裏面B' }])).not.toBe(guardLib.draftIdentity([{ name: 'designKey', value: '表面A' }]));
  });

  it('every ActionForm mounts the draft keeper (the step panel forms are ActionForms); draft={false} opts out', () => {
    const noop = (async () => ({ ok: true, message: '' })) as never;
    const withDraft = inContext(<ActionForm action={noop} submitLabel="校正を登録する"><input name="designKey" /></ActionForm>);
    expect(withDraft).toContain('class="p1-draft-anchor"');
    const without = inContext(<ActionForm action={noop} submitLabel="校正を登録する" draft={false}><input name="designKey" /></ActionForm>);
    expect(without).not.toContain('p1-draft-anchor');
  });

  it('the guard\'s comment no longer claims every form survives (it names the forms that keep a draft)', () => {
    const comment = readSrc('lib/unsaved-guard.ts');
    expect(comment).not.toContain('The typed input still survives through DraftAutosave.');
    expect(comment).toContain('survives only for a form that keeps a draft');
  });
});

describe('R-2 SelectField value', () => {
  const render = (value: string | undefined) => inContext(
    <SelectField
      name="existingPoId"
      label="登録済みのセブン化学発注書"
      choices={[{ value: 'a', label: 'PO-A' }, { value: 'b', label: 'PO-B' }, { value: 'c', label: 'PO-C' }]}
      {...(value !== undefined ? { value, onChange: () => undefined } : { defaultValue: 'a' })}
    />
  );
  it('the option named by `value` is the selected one — and it follows a changed value (the partial PO the wizard re-opens on)', () => {
    expect(render('b')).toMatch(/<option value="b" selected="">PO-B<\/option>/);
    expect(render('b')).not.toMatch(/<option value="a" selected/);
    expect(render('c')).toMatch(/<option value="c" selected="">PO-C<\/option>/);
  });
  it('without `value` the defaultValue is used', () => {
    expect(render(undefined)).toMatch(/<option value="a" selected="">PO-A<\/option>/);
  });
});
