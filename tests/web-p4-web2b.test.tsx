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

const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { ApprovalCard } = await import('../apps/web/src/components/ApprovalCard.js');
const { NewOrderForm } = await import('../apps/web/src/components/NewOrderForm.js');
const { ProjectAssignmentsPanel } = await import('../apps/web/src/components/ProjectAssignmentsPanel.js');
const { AssignmentRequest, assignmentRequestText } = await import('../apps/web/src/components/AssignmentRequest.js');
const { ProjectChooser } = await import('../apps/web/src/components/ProjectChooser.js');
const { ProjectNotFound } = await import('../apps/web/src/components/ProjectNotFound.js');
const { QueueRowExtras } = await import('../apps/web/src/components/QueueRowExtras.js');
const { RepresentativeQueuePanel } = await import('../apps/web/src/components/RepresentativeQueue.js');
const { ActionForm } = await import('../apps/web/src/components/ActionForm.js');
const { SelectField } = await import('../apps/web/src/components/fields.js');
const approvalActions = await import('../apps/web/src/app/approval-actions.js');
const assignmentActions = await import('../apps/web/src/app/assignment-actions.js');
const stepActions = await import('../apps/web/src/app/step-actions.js');
const { RENDERED_PROJECT_FIELD, IDEMPOTENCY_FIELD } = await import('../apps/web/src/lib/project-context.js');
const approvalCardLib = await import('../apps/web/src/lib/approval-card.js');
const assignmentsLib = await import('../apps/web/src/lib/assignments.js');
const bindingLib = await import('../apps/web/src/lib/binding-conflict.js');
const duplicateLib = await import('../apps/web/src/lib/duplicate-check.js');
const queueLib = await import('../apps/web/src/lib/representative-queue.js');
const senderLib = await import('../apps/web/src/lib/sender-check.js');
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
    expect(callApi.mock.calls[0]![1]).toMatchObject({ method: 'PATCH', body: { requestedDeliveryDate: '2026-12-01' }, idempotencyKey: 'form-key-0001', expectedProjectId: 'proj-1' });
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
