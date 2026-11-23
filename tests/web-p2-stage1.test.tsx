import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P2 web stage 1 (contract v1.2): durable Idempotency-Key answers (§1), the
 * server-stored display language (§5), the auditor's role wording and menu (§7),
 * the viewer/auditor project note (§8-1), the delivery dates sent at creation
 * (§3-1) and the stored MPO numbers merged into the maker-PO rows (§2).
 */
const state = vi.hoisted(() => ({ user: { id: 'user-1', role: 'admin' } as { id: string; role: string; displayLanguage?: string | null } | null }));
const callApi = vi.hoisted(() => vi.fn());
const cookieSet = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => state.user,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: cookieSet }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/',
  redirect: () => undefined
}));

const actionResult = await import('../apps/web/src/lib/action-result.js');
const projectContext = await import('../apps/web/src/lib/project-context.js');
const notice = await import('../apps/web/src/lib/idempotency-notice.js');
const actions = await import('../apps/web/src/app/actions.js');
const makerActions = await import('../apps/web/src/app/maker-po/actions.js');
const stepActions = await import('../apps/web/src/app/step-actions.js');
const { setLanguageAction } = await import('../apps/web/src/app/settings-actions.js');
const { languageFor, LANGUAGE_COOKIE } = await import('../apps/web/src/lib/locale.js');
const { FeedbackForm, FormResult } = await import('../apps/web/src/components/form-feedback.js');
const { RenderedContextProvider } = await import('../apps/web/src/components/RenderedContext.js');
const { navHrefsForRole, navRole, navRoleNote, SCREEN_GUIDES } = await import('../apps/web/src/lib/navigation.js');
const { roleLabel } = await import('../apps/web/src/lib/session-display.js');
const permissions = await import('../apps/web/src/lib/permissions.js');
const { ViewerPageNotice } = await import('../apps/web/src/components/RoleGate.js');
const { noneMessage, READ_ONLY_PROJECT_NOTE } = await import('../apps/web/src/components/ProjectChooser.js');
const { deliveryDatesFromForm, deliveryDateText, readDeliveryDate } = await import('../apps/web/src/lib/delivery-dates.js');
const { mergeDeliveryDates } = await import('../apps/web/src/lib/project-data.js');
const { makerPoName, makerPoNumberOf, withDisplayNumbers } = await import('../apps/web/src/lib/maker-po-data.js');
const { scopeHref, unscopedPath, legacyScreenOf } = await import('../apps/web/src/lib/project-route.js');
const { ERROR_DICTIONARY } = await import('../apps/web/src/lib/error-dictionary-data.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { RENDERED_PROJECT_FIELD, IDEMPOTENCY_FIELD } = projectContext;
const KEY = 'p2-stage1-key-0001';

function form(entries: Record<string, string>, key: string | null = KEY): FormData {
  const data = new FormData();
  data.set(RENDERED_PROJECT_FIELD, 'project-a');
  if (key) data.set(IDEMPOTENCY_FIELD, key);
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
}
const ok = (data: unknown = { id: 'new-1' }, status = 201) => ({ ok: true, status, data, error: null, code: null, failure: null });
const refused = (status: number, code: string, error = '辞書の文') => ({ ok: false, status, data: { code }, error, errorKo: '사전 문장', code, failure: null });

beforeEach(() => {
  state.user = { id: 'user-1', role: 'admin' };
  callApi.mockReset();
  cookieSet.mockReset();
  revalidatePath.mockReset();
});

// ---------------------------------------------------------------------------
describe('§1 durable Idempotency-Key answers', () => {
  it('the dictionary has the four v1.2 codes', () => {
    for (const code of ['IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_OUTCOME_UNKNOWN', 'DELIVERY_TERMS_LOCKED', 'READ_ONLY_ROLE']) {
      expect(ERROR_DICTIONARY[code]?.ja, code).toBeTruthy();
      expect(ERROR_DICTIONARY[code]?.ko, code).toBeTruthy();
    }
  });

  it('the client copy of the key-keeping codes equals the server-side list', () => {
    expect([...projectContext.KEY_KEEPING_STATE_CODES]).toEqual([...actionResult.KEY_KEEPING_CODES]);
    expect([...actionResult.KEY_KEEPING_CODES].sort()).toEqual(['IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_OUTCOME_UNKNOWN', 'SESSION_EXPIRED']);
  });

  it.each([
    [409, 'IDEMPOTENCY_IN_PROGRESS'],
    [409, 'IDEMPOTENCY_OUTCOME_UNKNOWN'],
    [422, 'IDEMPOTENCY_KEY_REUSED'],
    [401, 'SESSION_EXPIRED']
  ])('%i %s is not settled and keeps the key', (status, code) => {
    expect(actionResult.isSettledRefusal({ status, failure: null, code })).toBe(false);
    expect(actionResult.refusalState({ status, failure: null, code, error: 'x', errorKo: null }).settled).toBe(false);
    // Even a state that claims settled never renews the key for these codes.
    expect(projectContext.shouldRenewSubmitKey({ ok: false, settled: true, code })).toBe(false);
  });

  it('other 409/422 answers stay settled (a new key for the corrected submit)', () => {
    for (const code of ['CONFLICT', 'DELIVERY_TERMS_LOCKED', 'DUPLICATE', 'DELIVERY_DATE_INVALID']) {
      expect(actionResult.isSettledRefusal({ status: 409, failure: null, code }), code).toBe(true);
      expect(projectContext.shouldRenewSubmitKey({ ok: false, settled: true, code }), code).toBe(true);
    }
  });

  it('only KEY_REUSED and OUTCOME_UNKNOWN refresh the list', () => {
    expect(actionResult.refreshesListOn('IDEMPOTENCY_KEY_REUSED')).toBe(true);
    expect(actionResult.refreshesListOn('IDEMPOTENCY_OUTCOME_UNKNOWN')).toBe(true);
    expect(actionResult.refreshesListOn('IDEMPOTENCY_IN_PROGRESS')).toBe(false);
    expect(actionResult.refreshesListOn('SESSION_EXPIRED')).toBe(false);
    expect(actionResult.refreshesListOn(null)).toBe(false);
  });

  it('a 5xx, a failure without an answer and a non-4xx status are never settled (the key is kept)', () => {
    for (const status of [500, 502, 503, 599]) {
      expect(actionResult.isSettledRefusal({ status, failure: null, code: 'INTERNAL' }), String(status)).toBe(false);
    }
    expect(actionResult.isSettledRefusal({ status: 0, failure: 'timeout', code: null })).toBe(false);
    expect(actionResult.isSettledRefusal({ status: 399, failure: null, code: null })).toBe(false);
    expect(actionResult.isSettledRefusal({ status: 400, failure: null, code: 'BAD' })).toBe(true);
    expect(actionResult.isSettledRefusal({ status: 499, failure: null, code: 'BAD' })).toBe(true);
  });

  it('the form announces the list refresh (SAVED_RECORD_EVENT) after OUTCOME_UNKNOWN as well as KEY_REUSED', () => {
    // No DOM here to run the effect; the condition is pinned in the source (a pure helper would be better).
    const source = readFileSync(path.join(root, 'apps/web/src/components/form-feedback.tsx'), 'utf8');
    expect(source).toMatch(/if \(locksForKeyReuse\(state\) \|\| \(state !== null && !state\.ok && state\.code === OUTCOME_UNKNOWN_CODE\)\) \{\s+const detail: SavedRecordDetail = \{ changedId: null \};\s+window\.dispatchEvent\(new CustomEvent\(SAVED_RECORD_EVENT/);
  });

  it('KEY_REUSED still locks the form; OUTCOME_UNKNOWN waits for the check and never locks', () => {
    const reused = { ok: false, code: 'IDEMPOTENCY_KEY_REUSED' };
    const unknown = { ok: false, code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' };
    expect(projectContext.locksForKeyReuse(reused)).toBe(true);
    expect(projectContext.locksForKeyReuse(unknown)).toBe(false);
    expect(projectContext.awaitsOutcomeCheck(unknown, null)).toBe(true);
    expect(projectContext.awaitsOutcomeCheck(unknown, unknown)).toBe(false);
    expect(projectContext.awaitsOutcomeCheck(reused, null)).toBe(false);
    expect(projectContext.awaitsOutcomeCheck({ ok: false, code: 'IDEMPOTENCY_IN_PROGRESS' }, null)).toBe(false);
  });

  it('post(): OUTCOME_UNKNOWN keeps the code, is not settled and refreshes the list', async () => {
    callApi.mockResolvedValue(refused(409, 'IDEMPOTENCY_OUTCOME_UNKNOWN'));
    const result = await actions.registerSevenPurchaseOrderAction(null, form({ poId: 'p', officialRegisteredAt: '2026-11-20' }));
    expect(result).toMatchObject({ ok: false, code: 'IDEMPOTENCY_OUTCOME_UNKNOWN', settled: false });
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
    expect(callApi.mock.calls[0]![1].idempotencyKey).toBe(KEY);
  });

  it('post(): IN_PROGRESS keeps the key and does not refresh', async () => {
    callApi.mockResolvedValue(refused(409, 'IDEMPOTENCY_IN_PROGRESS'));
    const result = await actions.registerSevenPurchaseOrderAction(null, form({ poId: 'p', officialRegisteredAt: '2026-11-20' }));
    expect(result).toMatchObject({ ok: false, code: 'IDEMPOTENCY_IN_PROGRESS', settled: false });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('maker-po send(): OUTCOME_UNKNOWN refreshes; the chain keeps it unsettled too', async () => {
    callApi.mockResolvedValue(refused(409, 'IDEMPOTENCY_OUTCOME_UNKNOWN'));
    const result = await makerActions.cancelMakerPoAction(null, form({ poId: 'p', note: '訂正のため' }));
    expect(result).toMatchObject({ code: 'IDEMPOTENCY_OUTCOME_UNKNOWN', settled: false });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    revalidatePath.mockReset();
    const LINES = JSON.stringify([{ description: '合成フィルム', orderedQuantity: '10', unit: 'rolls' }]);
    const chained = await stepActions.startFilmOrderAction(null, form({ existingPoId: 'po-1', code: 'FSO-1', paymentTerms: 'prepaid', lines: LINES }));
    expect(chained).toMatchObject({ ok: false, code: 'IDEMPOTENCY_OUTCOME_UNKNOWN', settled: false });
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  const render = (result: { ok: boolean; message: string; code?: string; messageKo?: string }) => renderToStaticMarkup(
    <RenderedContextProvider value={{ projectId: 'p', showKorean: false }}>
      <FormResult state={result} />
    </RenderedContextProvider>
  );

  it('FormResult: OUTCOME_UNKNOWN shows the fixed line (and its Korean line in every mode)', () => {
    const html = render({ ok: false, message: '前回の送信の結果を確認できませんでした。', messageKo: '이전 전송의 결과', code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' });
    expect(notice.OUTCOME_UNKNOWN_LINE).toBe('処理結果が確認できません。一覧で確認してください。');
    expect(html).toContain(notice.OUTCOME_UNKNOWN_LINE);
    expect(html).toContain('이전 전송의 결과');
  });

  it('FormResult: IN_PROGRESS says to wait and send the same input again', () => {
    const html = render({ ok: false, message: '同じ送信をまだ処理しています。', code: 'IDEMPOTENCY_IN_PROGRESS' });
    expect(html).toContain(notice.IN_PROGRESS_HINT);
    expect(html).not.toContain(notice.OUTCOME_UNKNOWN_LINE);
  });

  it('inside a form, OUTCOME_UNKNOWN offers the 「一覧を確認しました」 button; KEY_REUSED keeps its own lock button', () => {
    const inForm = (code: string) => renderToStaticMarkup(
      <RenderedContextProvider value={{ projectId: 'p', showKorean: false }}>
        <FeedbackForm action={() => undefined} state={{ ok: false, message: 'x', code }} pending={false}>
          <FormResult state={{ ok: false, message: 'x', code }} />
        </FeedbackForm>
      </RenderedContextProvider>
    );
    const unknown = inForm('IDEMPOTENCY_OUTCOME_UNKNOWN');
    expect(unknown).toContain(notice.OUTCOME_UNKNOWN_CHECKED_LABEL);
    const reused = inForm('IDEMPOTENCY_KEY_REUSED');
    expect(reused).toContain('一覧を確認しました（新しい入力として送信できるようにする）');
    expect(reused).not.toContain(notice.OUTCOME_UNKNOWN_LINE);
  });
});

// ---------------------------------------------------------------------------
describe('§5 the display language is stored on the server per user', () => {
  const ADMIN = { id: 'user-1', role: 'admin' };
  it('the server choice wins over the cookie and the role default', () => {
    expect(languageFor('user-1.ja', { ...ADMIN, displayLanguage: 'ko' })).toBe('ko');
    expect(languageFor(undefined, { id: 's', role: 'staff', displayLanguage: 'ja-ko' })).toBe('ja-ko');
  });

  it('null (not chosen) falls back to the own cookie, then the role default', () => {
    expect(languageFor('user-1.ko', { ...ADMIN, displayLanguage: null })).toBe('ko');
    expect(languageFor(undefined, { ...ADMIN, displayLanguage: null })).toBe('ja-ko');
  });

  it('another user\'s cookie is never read, and an unknown server value is ignored', () => {
    expect(languageFor('user-1.ko', { id: 'user-2', role: 'staff', displayLanguage: null })).toBe('ja');
    expect(languageFor('user-1.ko', { id: 'user-2', role: 'staff', displayLanguage: 'fr' })).toBe('ja');
  });

  const choose = (mode: string) => form({ language: mode });

  it('saves with PUT /api/me/preferences (the submit key), then keeps the cookie bound to the id', async () => {
    callApi.mockResolvedValue(ok({ id: 'user-1', displayLanguage: 'ko' }, 200));
    const result = await setLanguageAction(null, choose('ko'));
    expect(callApi).toHaveBeenCalledTimes(1);
    const [apiPath, options] = callApi.mock.calls[0]!;
    expect(apiPath).toBe('/api/me/preferences');
    expect(options).toMatchObject({ method: 'PUT', body: { displayLanguage: 'ko' }, idempotencyKey: KEY });
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toContain('ほかの端末でも');
    expect(cookieSet).toHaveBeenCalledWith(LANGUAGE_COOKIE, 'user-1.ko', expect.objectContaining({ httpOnly: true }));
  });

  it('a refusal (422 DISPLAY_LANGUAGE_INVALID) changes nothing', async () => {
    callApi.mockResolvedValue(refused(422, 'DISPLAY_LANGUAGE_INVALID'));
    const result = await setLanguageAction(null, choose('ja'));
    expect(result).toMatchObject({ ok: false, code: 'DISPLAY_LANGUAGE_INVALID' });
    expect(cookieSet).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('an outage changes nothing either (never a browser-only choice that looks saved)', async () => {
    callApi.mockResolvedValue({ ok: false, status: 0, data: null, error: 'つながりません', code: 'API_UNREACHABLE', failure: 'unreachable' });
    expect((await setLanguageAction(null, choose('ja'))).ok).toBe(false);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it('an API without the route (404, no code) keeps the P1 cookie and says so', async () => {
    callApi.mockResolvedValue({ ok: false, status: 404, data: null, error: 'x', code: null, failure: null });
    const result = await setLanguageAction(null, choose('ja-ko'));
    expect(result.ok).toBe(true);
    expect(result.message).toContain('このブラウザだけ');
    expect(cookieSet).toHaveBeenCalledWith(LANGUAGE_COOKIE, 'user-1.ja-ko', expect.anything());
  });

  it('an invalid mode is refused before the API is asked', async () => {
    expect((await setLanguageAction(null, choose('fr'))).ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('§7 the auditor role: label, notices, menu', () => {
  it('is labelled 監査 and has its own nav role', () => {
    expect(roleLabel('auditor')).toBe('監査');
    expect(navRole('auditor')).toBe('auditor');
    expect(navRole('superuser')).toBe('viewer');
  });

  it('sees only the screens whose reads it is allowed: home, orders, maker POs, evidence, reference', () => {
    // P4 H10②: the approval history (read-only) is in the auditor's menu.
    expect(navHrefsForRole('auditor')).toEqual(['/home', '/orders', '/approvals', '/maker-po', '/evidence', '/guide', '/status']);
    expect(navHrefsForRole('viewer')).not.toContain('/evidence');
    expect(navHrefsForRole('staff')).not.toContain('/makers');
    expect(navHrefsForRole('auditor')).not.toContain('/makers');
  });

  it('every new menu screen has a guide line', () => {
    expect(SCREEN_GUIDES['/makers']).toBeDefined();
    expect(SCREEN_GUIDES['/evidence']).toBeDefined();
  });

  it('notes and refusals name the audit role', () => {
    expect(navRoleNote('auditor')).toContain('監査');
    expect(navRoleNote('auditor')).toContain('金額');
    expect(permissions.operationRefusal('auditor', 'seven_po:create', '発注書の登録')).toBe('発注書の登録は、監査の権限のため操作できません。');
    expect(permissions.operationRefusal('viewer', 'seven_po:create', '発注書の登録')).toBe('発注書の登録は、閲覧権限のため操作できません。');
    expect(renderToStaticMarkup(<ViewerPageNotice role="auditor" />)).toContain(permissions.AUDITOR_PAGE_NOTICE);
    expect(renderToStaticMarkup(<ViewerPageNotice role="viewer" />)).toContain(permissions.VIEWER_PAGE_NOTICE);
  });

  it('no write form is shown to the auditor (read as viewer for every write)', () => {
    for (const operation of ['project:create', 'seven_po:create', 'film_order:create', 'document:create', 'maker_po:create', 'ceo_approve'] as const) {
      expect(permissions.canRoleOperate('auditor', operation), operation).toBe(false);
    }
  });

  it('/evidence is a project-scoped screen with a legacy redirect', () => {
    expect(scopeHref('PRJ-1', '/evidence')).toBe('/p/PRJ-1/evidence');
    expect(unscopedPath('/p/PRJ-1/evidence')).toBe('/evidence');
    expect(legacyScreenOf('/evidence')).toBe('evidence');
    expect(scopeHref('PRJ-1', '/makers')).toBe('/makers');
  });
});

// ---------------------------------------------------------------------------
describe('§8-1 viewer and auditor cannot register a project', () => {
  it('the empty-project screen says so for viewer and auditor only', () => {
    expect(noneMessage('viewer').next).toContain(READ_ONLY_PROJECT_NOTE);
    expect(noneMessage('auditor').next).toContain(READ_ONLY_PROJECT_NOTE);
    expect(noneMessage('auditor').text).toContain('監査');
    expect(noneMessage('staff').next).not.toContain(READ_ONLY_PROJECT_NOTE);
    expect(noneMessage('admin').next).not.toContain(READ_ONLY_PROJECT_NOTE);
  });

  it('the web has no project-create call (no POST /api/projects) to show to any role', () => {
    const dir = path.join(root, 'apps/web/src');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => /\.(ts|tsx)$/.test(name) && !name.includes('.omc'));
    const posts = files.filter((name) => /callApi[^(]*\(\s*['"`]\/api\/projects['"`]\s*,\s*\{[^}]*method:\s*['"]POST/.test(readFileSync(path.join(dir, name), 'utf8')));
    expect(posts).toEqual([]);
    expect(permissions.canRoleOperate('viewer', 'project:create')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('§3-1 delivery dates at creation', () => {
  it('reads YYYY-MM-DD from the screen\'s date text; empty is not sent; a non-date is refused', () => {
    expect(readDeliveryDate('2026/12/01', 'requestedDeliveryDate')).toEqual({ value: '2026-12-01' });
    expect(readDeliveryDate('  ', 'plannedDeliveryDate')).toEqual({ value: undefined });
    expect(readDeliveryDate('2026/02/30', 'requestedDeliveryDate')).toEqual({ error: expect.stringContaining('希望納期') });
    expect(deliveryDateText('2026-12-01')).toBe('2026/12/01');
    expect(deliveryDateText('2026-12-01T00:00:00Z')).toBeNull();
    expect(deliveryDateText(null)).toBeNull();
  });

  it('deliveryDatesFromForm sends only the typed dates', () => {
    expect(deliveryDatesFromForm(form({ requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: '' }))).toEqual({ body: { requestedDeliveryDate: '2026-12-01' } });
    expect(deliveryDatesFromForm(form({ plannedDeliveryDate: '12月1日' }))).toEqual({ error: expect.stringContaining('納品予定日') });
  });

  const LINES = JSON.stringify([{ description: '合成フィルム', orderedQuantity: '10', unit: 'rolls' }]);

  it('the list create form posts the dates with the order', async () => {
    callApi.mockResolvedValue(ok());
    await actions.createFilmSupplyOrderAction(null, form({ code: 'FSO-1', lines: LINES, sevenPurchaseOrderId: 'po-1', paymentTerms: 'prepaid', requestedDeliveryDate: '2026/12/01', plannedDeliveryDate: '2026/12/10' }));
    expect(callApi.mock.calls[0]![1].body).toMatchObject({ requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: '2026-12-10' });
  });

  it('a wrong date writes nothing', async () => {
    const result = await actions.createFilmSupplyOrderAction(null, form({ code: 'FSO-1', lines: LINES, sevenPurchaseOrderId: 'po-1', paymentTerms: 'prepaid', requestedDeliveryDate: '2026/13/01' }));
    expect(result.ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
    const wizard = await stepActions.startFilmOrderAction(null, form({ existingPoId: 'po-1', code: 'FSO-1', paymentTerms: 'prepaid', lines: LINES, plannedDeliveryDate: 'x' }));
    expect(wizard.ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('the wizard posts the dates on the order create step only', async () => {
    callApi.mockResolvedValue(ok({ id: 'o-1', status: 'SEVEN_PO_VERIFIED', autoAdvanced: [] }));
    await stepActions.startFilmOrderAction(null, form({ existingPoId: 'po-1', code: 'FSO-1', paymentTerms: 'prepaid', lines: LINES, requestedDeliveryDate: '2026-12-01' }));
    const create = callApi.mock.calls.find((call) => String(call[0]).endsWith('/film-supply-orders'))!;
    expect(create[1].body).toMatchObject({ requestedDeliveryDate: '2026-12-01' });
    expect(create[1].body).not.toHaveProperty('plannedDeliveryDate');
  });

  it('mergeDeliveryDates: list dates by id; an unread list never reads as 未記録', () => {
    const order = (id: string) => ({ id, code: id, status: 'DRAFT', sevenPurchaseOrderId: null, lineCount: 0, lines: [], detailsHidden: false, statusHidden: false, lastNormalStatus: null, createdAt: 'x', updatedAt: 'x' });
    const orders = [order('a'), order('b')];
    mergeDeliveryDates(orders, new Map([['a', { id: 'a', requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: 'bad', updatedAt: '2026-11-21T00:00:00Z' }]]));
    expect(orders[0]).toMatchObject({ deliveryDatesRead: true, requestedDeliveryDate: '2026-12-01', plannedDeliveryDate: null, rowUpdatedAt: '2026-11-21T00:00:00Z' });
    expect(orders[1]).toMatchObject({ deliveryDatesRead: false, requestedDeliveryDate: null });
    const unread = [order('c')];
    mergeDeliveryDates(unread, null);
    expect(unread[0]!.deliveryDatesRead).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('§2 stored MPO numbers', () => {
  it('only the MPO-YYYY-NNNN shape is shown', () => {
    expect(makerPoNumberOf('MPO-2026-0001')).toBe('MPO-2026-0001');
    expect(makerPoNumberOf('MPO-2026-10000')).toBe('MPO-2026-10000');
    expect(makerPoNumberOf('<b>x</b>')).toBeNull();
    // The whole value must have the shape (no prefix or suffix smuggled around a valid number).
    expect(makerPoNumberOf('<b>MPO-2026-0001</b>')).toBeNull();
    expect(makerPoNumberOf('xMPO-2026-0001')).toBeNull();
    expect(makerPoNumberOf('MPO-2026-0001 ')).toBeNull();
    expect(makerPoNumberOf('MPO-2026-001')).toBeNull();
    expect(makerPoNumberOf(42)).toBeNull();
  });

  it('withDisplayNumbers merges the list map by id', () => {
    const rows = withDisplayNumbers([{ id: 'p1', status: 'DRAFT' }, { id: 'p2', status: 'CANCELLED' }], { p1: 'MPO-2026-0007' });
    expect(rows.map((row) => row.displayNumber)).toEqual(['MPO-2026-0007', null]);
    expect(withDisplayNumbers([{ id: 'p1', status: 'DRAFT' }], null)[0]!.displayNumber).toBeNull();
  });

  it('makerPoName names the paper by its number, else by the order code', () => {
    expect(makerPoName({ displayNumber: 'MPO-2026-0007' }, 'FSO-1')).toBe('メーカー発注書 MPO-2026-0007');
    expect(makerPoName({ displayNumber: null }, 'FSO-1')).toBe('FSO-1 のメーカー発注書');
  });
});
