import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P0 server actions, mocked API: R01 (支払条件 required), R05 (duplicate number,
 * in-flight lock, idempotency key), R06 (refresh + changedId), R09 (refusal text
 * from the dictionary), R10 (recipient is an e-mail address).
 */
const state = vi.hoisted(() => ({ selected: 'project-a' as string | null }));
const callApi = vi.hoisted(() => vi.fn());
const loadWorkspace = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => state.selected,
  loadSessionUser: async () => null,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadWorkspace: (...args: unknown[]) => loadWorkspace(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: () => undefined }));

const actions = await import('../apps/web/src/app/actions.js');
const makerActions = await import('../apps/web/src/app/maker-po/actions.js');
const { createSubmitInFlight } = await import('../apps/web/src/lib/saved-record.js');
const { duplicateRefusal, duplicateState, findRegistered, mayBeDuplicate } = await import('../apps/web/src/lib/duplicate-check.js');
const { idempotencyKeyOf, isIdempotencyKey, IDEMPOTENCY_FIELD, RENDERED_PROJECT_FIELD } = await import('../apps/web/src/lib/project-context.js');
const { PAYMENT_TERMS_REQUIRED_MESSAGE, RECIPIENT_EMAIL_INVALID_MESSAGE, fieldForActionMessage } = await import('../apps/web/src/lib/form-messages.js');
const { refusalState, recordIdOf } = await import('../apps/web/src/lib/action-result.js');

function form(entries: Record<string, string>, project: string | null = 'project-a'): FormData {
  const data = new FormData();
  if (project !== null) data.set(RENDERED_PROJECT_FIELD, project);
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const LINES = JSON.stringify([{ description: '合成フィルム', orderedQuantity: '10', unit: 'rolls' }]);
const ok = (data: unknown = { id: 'new-1' }, status = 201) => ({ ok: true, status, data, error: null, code: null });
const refused = (status: number, error: string, data: unknown = null, code: string | null = null) => ({ ok: false, status, data, error, code });

const emptyWorkspace = { sevenPurchaseOrders: [], filmOrders: [], fillingOrders: [] };

beforeEach(() => {
  state.selected = 'project-a';
  callApi.mockReset();
  loadWorkspace.mockReset();
  revalidatePath.mockReset();
  loadWorkspace.mockResolvedValue(emptyWorkspace);
});

// ---------------------------------------------------------------------------
describe('R01: createFilmSupplyOrderAction requires a 支払条件', () => {
  const base = { code: 'FSO-P0-1', lines: LINES, sevenPurchaseOrderId: 'po-1' };

  it('refuses a missing paymentTerms with the required message, API not called', async () => {
    const result = await actions.createFilmSupplyOrderAction(null, form(base));
    expect(result).toEqual({ ok: false, message: PAYMENT_TERMS_REQUIRED_MESSAGE });
    expect(callApi).not.toHaveBeenCalled();
  });

  it('refuses an empty select value', async () => {
    const result = await actions.createFilmSupplyOrderAction(null, form({ ...base, paymentTerms: '' }));
    expect(result.message).toBe(PAYMENT_TERMS_REQUIRED_MESSAGE);
  });

  it.each(['barter', 'PREPAID', 'prepaid ; drop', 'on-delivery'])('refuses the unknown value %j', async (value) => {
    const result = await actions.createFilmSupplyOrderAction(null, form({ ...base, paymentTerms: value }));
    expect(result.ok).toBe(false);
    expect(result.message).toBe(PAYMENT_TERMS_REQUIRED_MESSAGE);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('the refusal belongs to the paymentTerms field', () => {
    expect(fieldForActionMessage(PAYMENT_TERMS_REQUIRED_MESSAGE)).toBe('paymentTerms');
  });

  it('the refusal names the way out (「未定」) and no enum value', () => {
    expect(PAYMENT_TERMS_REQUIRED_MESSAGE).toContain('未定');
    expect(PAYMENT_TERMS_REQUIRED_MESSAGE).not.toMatch(/prepaid|on_delivery|undetermined/);
  });

  it.each(['prepaid', 'on_delivery', 'undetermined'])('accepts %s and sends it', async (value) => {
    callApi.mockResolvedValue(ok());
    const result = await actions.createFilmSupplyOrderAction(null, form({ ...base, paymentTerms: value }));
    expect(result.ok).toBe(true);
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi.mock.calls[0]![0]).toBe('/api/projects/project-a/film-supply-orders');
    expect(callApi.mock.calls[0]![1].body).toMatchObject({ code: 'FSO-P0-1', paymentTerms: value, sevenPurchaseOrderId: 'po-1' });
  });

  it('the maker-po payment terms action refuses a missing choice too', async () => {
    const result = await makerActions.updatePaymentTermsAction(null, form({ orderId: 'o1' }));
    expect(result).toEqual({ ok: false, message: PAYMENT_TERMS_REQUIRED_MESSAGE });
    expect(callApi).not.toHaveBeenCalled();
  });

  it('updateFilmPaymentTermsAction: change with an optional reason, shown in glossary words', async () => {
    callApi.mockResolvedValue(ok({}, 200));
    const result = await actions.updateFilmPaymentTermsAction(null, form({ orderId: 'o1', paymentTerms: 'on_delivery', reason: ' 取引条件の変更 ' }));
    expect(result).toMatchObject({ ok: true, changedId: 'o1' });
    expect(result.message).toContain('納品後払い');
    expect(callApi.mock.calls[0]![1]).toMatchObject({ method: 'PATCH', body: { paymentTerms: 'on_delivery', reason: '取引条件の変更' } });
  });

  it('updateFilmPaymentTermsAction: without a reason none is sent', async () => {
    callApi.mockResolvedValue(ok({}, 200));
    await actions.updateFilmPaymentTermsAction(null, form({ orderId: 'o1', paymentTerms: 'prepaid' }));
    expect(callApi.mock.calls[0]![1].body).toEqual({ paymentTerms: 'prepaid' });
  });

  it('updateFilmPaymentTermsAction: an unknown value is refused before the API', async () => {
    const result = await actions.updateFilmPaymentTermsAction(null, form({ orderId: 'o1', paymentTerms: 'x' }));
    expect(result.message).toBe(PAYMENT_TERMS_REQUIRED_MESSAGE);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('updateFilmPaymentTermsAction: the API refusal after the approval is shown from the dictionary, with its code', async () => {
    callApi.mockResolvedValue(refused(409, 'x', { code: 'PAYMENT_TERMS_LOCKED' }, 'PAYMENT_TERMS_LOCKED'));
    const result = await actions.updateFilmPaymentTermsAction(null, form({ orderId: 'o1', paymentTerms: 'prepaid' }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PAYMENT_TERMS_LOCKED');
  });
});

// ---------------------------------------------------------------------------
describe('R10: the maker PO recipient is an e-mail address', () => {
  const base = { orderId: 'o1' };

  it.each(['東京都港区1-2-3', 'a@b', 'no-at-sign.example', 'a b@c.example', '<a@b.example>', 'a@b.example, c@d.example', '@maker.example', 'order@'])(
    'refuses %j with the email message and does not call the API',
    async (recipient) => {
      const result = await makerActions.createMakerPoAction(null, form({ ...base, recipientAddress: recipient }));
      expect(result).toEqual({ ok: false, message: RECIPIENT_EMAIL_INVALID_MESSAGE });
      expect(callApi).not.toHaveBeenCalled();
    }
  );

  it('the refusal maps to the recipientAddress field', () => {
    expect(fieldForActionMessage(RECIPIENT_EMAIL_INVALID_MESSAGE)).toBe('recipientAddress');
  });

  it('an empty recipient asks for the address (not the format message)', async () => {
    const result = await makerActions.createMakerPoAction(null, form({ ...base, recipientAddress: '' }));
    expect(result.message).toBe('メーカーの送信先メールアドレスを入力してください。');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('accepts order@maker.example and sends it (trimmed)', async () => {
    callApi.mockResolvedValue(ok());
    const result = await makerActions.createMakerPoAction(null, form({ ...base, recipientAddress: '  order@maker.example ' }));
    expect(result.ok).toBe(true);
    expect(callApi.mock.calls[0]![0]).toBe('/api/film-supply-orders/o1/maker-purchase-orders');
    expect(callApi.mock.calls[0]![1].body).toEqual({ recipientAddress: 'order@maker.example' });
  });

  it('an over-long address is refused', async () => {
    const result = await makerActions.createMakerPoAction(null, form({ ...base, recipientAddress: `${'a'.repeat(250)}@maker.example` }));
    expect(result.message).toBe(RECIPIENT_EMAIL_INVALID_MESSAGE);
  });

  it('an amount typed for an admin still has to be numeric', async () => {
    const result = await makerActions.createMakerPoAction(null, form({ ...base, recipientAddress: 'order@maker.example', totalAmount: 'abc' }));
    expect(result.ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('R06: a success refreshes the screen and reports the changed id', () => {
  it('post(): revalidatePath(/, layout) once and changedId from the answer', async () => {
    callApi.mockResolvedValue(ok({ id: 'po-77' }, 200));
    const result = await actions.registerSevenPurchaseOrderAction(null, form({ poId: 'po-77', officialRegisteredAt: '2026-11-20' }));
    expect(result).toMatchObject({ ok: true, changedId: 'po-77' });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('postCreate(): refresh and changedId', async () => {
    callApi.mockResolvedValue(ok({ id: 'new-po' }));
    const result = await actions.createSevenPurchaseOrderAction(null, form({ poNumber: 'SEVEN-1' }));
    expect(result).toMatchObject({ ok: true, message: '記録しました。', changedId: 'new-po' });
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('maker-po send(): refresh and changedId', async () => {
    callApi.mockResolvedValue(ok({ id: 'mpo-1' }));
    const result = await makerActions.cancelMakerPoAction(null, form({ poId: 'mpo-1', note: '訂正のため' }));
    expect(result).toMatchObject({ ok: true, changedId: 'mpo-1' });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('an answer that wraps the record still gives the id (upload: document)', async () => {
    expect(recordIdOf({ document: { id: 'doc-1' }, version: { id: 'v-1' } })).toBe('doc-1');
    expect(recordIdOf({ order: { id: 'o-1' } })).toBe('o-1');
    expect(recordIdOf({ purchaseOrder: { id: 'p-1' } })).toBe('p-1');
  });

  it.each([null, 'text', 5, {}, { id: '' }, { id: 7 }, { id: 'x'.repeat(65) }])('no usable id in %j => null', (data) => {
    expect(recordIdOf(data)).toBeNull();
  });

  it('post(): a refusal does not refresh and has no changedId', async () => {
    callApi.mockResolvedValue(refused(403, 'この操作は代表者のみ可能です', { code: 'ROLE_FORBIDDEN' }, 'ROLE_FORBIDDEN'));
    const result = await actions.registerSevenPurchaseOrderAction(null, form({ poId: 'po-1', officialRegisteredAt: '2026-11-20' }));
    expect(result.ok).toBe(false);
    expect(result.changedId).toBeUndefined();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('maker-po send(): a refusal does not refresh', async () => {
    callApi.mockResolvedValue(refused(409, 'x', null, 'MAKER_PO_NOT_APPROVABLE'));
    const result = await makerActions.cancelMakerPoAction(null, form({ poId: 'mpo-1', note: '訂正のため' }));
    expect(result.ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a guard refusal (no rendered project) does not refresh', async () => {
    const data = form({ poNumber: 'S-1' });
    data.set('_kaneiRenderedProjectId', '');
    await actions.createSevenPurchaseOrderAction(null, data);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(callApi).not.toHaveBeenCalled();
  });

  it('a client-side refusal (missing field) does not refresh', async () => {
    await actions.createSevenPurchaseOrderAction(null, form({ poNumber: '' }));
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(callApi).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('R09: the refusal text is the dictionary text, with its code and Korean line', () => {
  it('refusalState carries message, messageKo and code', () => {
    expect(refusalState({ error: 'テキスト', errorKo: '텍스트', code: 'X_CODE', status: 422 })).toMatchObject({ ok: false, message: 'テキスト', messageKo: '텍스트', code: 'X_CODE' });
  });

  it('refusalState without an error text still gives a Japanese sentence', () => {
    const state = refusalState({ error: null, status: 500 });
    expect(state.message).toContain('予期しないエラー');
    expect(state.code).toBeNull();
    expect(state.messageKo).toBeNull();
  });

  it('post() returns the callApi text, never the raw body text', async () => {
    callApi.mockResolvedValue({ ok: false, status: 422, data: { error: 'English core message', code: 'SOME_CODE' }, error: '辞書の文', errorKo: '사전 문장', code: 'SOME_CODE' });
    const result = await actions.registerSevenPurchaseOrderAction(null, form({ poId: 'p', officialRegisteredAt: '2026-11-20' }));
    expect(result).toMatchObject({ ok: false, message: '辞書の文', messageKo: '사전 문장', code: 'SOME_CODE' });
    expect(JSON.stringify(result)).not.toContain('English core message');
  });

  it('maker-po send() returns the same shape', async () => {
    callApi.mockResolvedValue({ ok: false, status: 401, data: null, error: 'ログイン切れ', errorKo: null, code: 'SESSION_EXPIRED' });
    const result = await makerActions.cancelMakerPoAction(null, form({ poId: 'p', note: '訂正のため' }));
    // P2 R05 (contract v1.2 §1): a lost session keeps the key — after logging in again the
    // same submit is answered with its first result (settled: false; it was true before P2).
    expect(result).toEqual({ ok: false, message: 'ログイン切れ', messageKo: null, code: 'SESSION_EXPIRED', settled: false });
  });
});

// ---------------------------------------------------------------------------
describe('R05: createSubmitInFlight', () => {
  it('a second acquire in the same tick is refused', () => {
    const lock = createSubmitInFlight();
    expect(lock.acquire(null)).toBe(true);
    expect(lock.acquire(null)).toBe(false);
    expect(lock.busy).toBe(true);
  });

  it('a new result releases the lock', () => {
    const lock = createSubmitInFlight();
    lock.acquire(null);
    lock.observe({ ok: true, message: 'done' }, false);
    expect(lock.busy).toBe(false);
    expect(lock.acquire({ ok: true, message: 'done' })).toBe(true);
  });

  it('the same result with no pending phase does not release (the action has not answered)', () => {
    const lock = createSubmitInFlight();
    const current = { ok: false, message: 'earlier refusal' };
    lock.acquire(current);
    lock.observe(current, false);
    expect(lock.busy).toBe(true);
  });

  it('pending going true then false releases even when the result object is the same', () => {
    const lock = createSubmitInFlight();
    const current = { ok: false, message: 'same' };
    lock.acquire(current);
    lock.observe(current, true);
    expect(lock.busy).toBe(true);
    lock.observe(current, false);
    expect(lock.busy).toBe(false);
  });

  it('observe on an idle lock is a no-op', () => {
    const lock = createSubmitInFlight();
    lock.observe({ ok: true, message: 'x' }, true);
    lock.observe(null, false);
    expect(lock.busy).toBe(false);
  });

  it('two forms have independent locks', () => {
    const a = createSubmitInFlight();
    const b = createSubmitInFlight();
    a.acquire(null);
    expect(b.acquire(null)).toBe(true);
  });
});

describe('R05: idempotency key', () => {
  it.each(['abcdefgh', '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 'k-m3x9z1-abcdef1234', 'A_b.c:d-1234'])('%s is a valid key', (key) => {
    expect(isIdempotencyKey(key)).toBe(true);
  });

  it.each(['short', 'has space inside', 'tab\tinside12', 'x'.repeat(129), '', 'ünïcode-key-12', 'semi;colon-12'])('%j is not a valid key', (key) => {
    expect(isIdempotencyKey(key)).toBe(false);
  });

  it('is forwarded to callApi when valid', async () => {
    callApi.mockResolvedValue(ok());
    await actions.createSevenPurchaseOrderAction(null, form({ poNumber: 'S-1', [IDEMPOTENCY_FIELD]: 'key-12345678' }));
    expect(callApi.mock.calls[0]![1].idempotencyKey).toBe('key-12345678');
  });

  it('is not forwarded when malformed', async () => {
    callApi.mockResolvedValue(ok());
    await actions.createSevenPurchaseOrderAction(null, form({ poNumber: 'S-1', [IDEMPOTENCY_FIELD]: 'bad key' }));
    expect(callApi.mock.calls[0]![1].idempotencyKey).toBeUndefined();
  });

  it('is not forwarded when absent', () => {
    expect(idempotencyKeyOf(new FormData())).toBeUndefined();
  });

  it('maker-po send() forwards it too', async () => {
    callApi.mockResolvedValue(ok());
    await makerActions.cancelMakerPoAction(null, form({ poId: 'p', note: '訂正のため', [IDEMPOTENCY_FIELD]: 'maker-key-0001' }));
    expect(callApi.mock.calls[0]![1].idempotencyKey).toBe('maker-key-0001');
  });
});

// ---------------------------------------------------------------------------
describe('R05: duplicateRefusal', () => {
  const sameProject = (id: string) => ({ existing: { id, projectId: 'project-a', projectCode: 'P-A' } });

  it('mayBeDuplicate: the server code, the pre-server 500, a 409; not a plain 422', () => {
    expect(mayBeDuplicate('DUPLICATE', 409)).toBe(true);
    expect(mayBeDuplicate('INTERNAL_ERROR', 500)).toBe(true);
    expect(mayBeDuplicate(null, 500)).toBe(true);
    expect(mayBeDuplicate(null, 409)).toBe(true);
    expect(mayBeDuplicate('VALIDATION_ERROR', 422)).toBe(false);
    expect(mayBeDuplicate('ROLE_FORBIDDEN', 403)).toBe(false);
  });

  it('server DUPLICATE with the existing record in the same project => message and a link to the seven PO', async () => {
    const state = await duplicateRefusal({ projectId: 'project-a', kind: 'seven_po', value: 'S-1', status: 409, code: 'DUPLICATE', data: sameProject('po-9') });
    expect(state).toMatchObject({ ok: false, code: 'DUPLICATE', link: { href: '/orders#seven-po-po-9' } });
    expect(state!.message).toContain('この番号はすでに登録されています');
    expect(loadWorkspace).not.toHaveBeenCalled();
  });

  it('server DUPLICATE: the film order and filling order links', async () => {
    const film = await duplicateRefusal({ projectId: 'project-a', kind: 'film_order', value: 'F', status: 409, code: 'DUPLICATE', data: sameProject('o-1') });
    const filling = await duplicateRefusal({ projectId: 'project-a', kind: 'filling_order', value: 'F', status: 409, code: 'DUPLICATE', data: sameProject('f-1') });
    expect(film?.link?.href).toBe('/orders#order-o-1');
    expect(filling?.link?.href).toBe('/orders#filling-order-f-1');
  });

  it('server DUPLICATE with the existing record in ANOTHER project => names that project code and gives no link', async () => {
    const state = await duplicateRefusal({
      projectId: 'project-a',
      kind: 'seven_po',
      value: 'S-1',
      status: 409,
      code: 'DUPLICATE',
      data: { existing: { id: 'po-x', projectId: 'project-b', projectCode: 'P-BETA' } }
    });
    expect(state!.message).toContain('P-BETA');
    expect(state!.message).toContain('別の案件');
    expect(state!.link).toBeNull();
    expect(state!.code).toBe('DUPLICATE');
  });

  it('another project without a code still says another project, no link', async () => {
    const state = await duplicateRefusal({
      projectId: 'project-a',
      kind: 'film_order',
      value: 'F',
      status: 409,
      code: 'DUPLICATE',
      data: { existing: { id: 'o-x', projectId: 'project-b' } }
    });
    expect(state!.message).toContain('別の案件');
    expect(state!.link).toBeNull();
  });

  it('a hostile project code is cut to 64 characters', async () => {
    const state = await duplicateRefusal({
      projectId: 'project-a',
      kind: 'film_order',
      value: 'F',
      status: 409,
      code: 'DUPLICATE',
      data: { existing: { id: 'o-x', projectId: 'project-b', projectCode: 'Z'.repeat(500) } }
    });
    expect(state!.message.length).toBeLessThan(200);
  });

  it('500 and the number is visible in the workspace => shown as the duplicate it is', async () => {
    loadWorkspace.mockResolvedValue({ ...emptyWorkspace, sevenPurchaseOrders: [{ id: 'po-5', poNumber: 'S-5', poNumberHidden: false }] });
    const state = await duplicateRefusal({ projectId: 'project-a', kind: 'seven_po', value: ' S-5 ', status: 500, code: 'INTERNAL_ERROR', data: { code: 'INTERNAL_ERROR' } });
    expect(state).toMatchObject({ code: 'DUPLICATE', link: { href: '/orders#seven-po-po-5' } });
    expect(loadWorkspace).toHaveBeenCalledWith('project-a');
  });

  it('500 and the number is not found => null (the refusal stays a server error)', async () => {
    expect(await duplicateRefusal({ projectId: 'project-a', kind: 'seven_po', value: 'S-404', status: 500, code: null, data: null })).toBeNull();
  });

  it('server DUPLICATE without a usable existing record and not in the list => the message without a link', async () => {
    const state = await duplicateRefusal({ projectId: 'project-a', kind: 'film_order', value: 'F', status: 409, code: 'DUPLICATE', data: null });
    expect(state).toMatchObject({ code: 'DUPLICATE', link: null });
  });

  it('a refusal that cannot be a duplicate does not read the workspace', async () => {
    expect(await duplicateRefusal({ projectId: 'project-a', kind: 'seven_po', value: 'S', status: 422, code: 'VALIDATION_ERROR', data: null })).toBeNull();
    expect(loadWorkspace).not.toHaveBeenCalled();
  });

  it('a hidden PO number (poNumberHidden) is never matched, even when the hidden label equals the typed value', () => {
    const workspace = { ...emptyWorkspace, sevenPurchaseOrders: [{ id: 'po-h', poNumber: '（閲覧権限なし）', poNumberHidden: true }] };
    expect(findRegistered(workspace as never, 'seven_po', '（閲覧権限なし）')).toBeNull();
  });

  it('a visible number is matched; blank input never is', () => {
    const workspace = { ...emptyWorkspace, sevenPurchaseOrders: [{ id: 'po-1', poNumber: 'S-1', poNumberHidden: false }] };
    expect(findRegistered(workspace as never, 'seven_po', 'S-1')).toBe('po-1');
    expect(findRegistered(workspace as never, 'seven_po', '   ')).toBeNull();
  });

  it('film and filling orders are matched by code, each in its own list', () => {
    const workspace = { sevenPurchaseOrders: [], filmOrders: [{ id: 'o-1', code: 'X-1' }], fillingOrders: [{ id: 'f-1', code: 'X-1' }] };
    expect(findRegistered(workspace as never, 'film_order', 'X-1')).toBe('o-1');
    expect(findRegistered(workspace as never, 'filling_order', 'X-1')).toBe('f-1');
  });

  it('duplicateState without an id has no link', () => {
    expect(duplicateState('film_order', null).link).toBeNull();
  });
});

describe('R05: the create actions answer a collision as a duplicate', () => {
  it('createSevenPurchaseOrderAction: server DUPLICATE => duplicate message and link, no "サーバーエラー"', async () => {
    callApi.mockResolvedValue(refused(409, 'raw', { code: 'DUPLICATE', existing: { id: 'po-3', projectId: 'project-a', projectCode: 'P-A' } }, 'DUPLICATE'));
    const result = await actions.createSevenPurchaseOrderAction(null, form({ poNumber: 'S-3' }));
    expect(result).toMatchObject({ ok: false, code: 'DUPLICATE', link: { href: '/orders#seven-po-po-3' } });
    expect(result.message).not.toContain('サーバー');
  });

  it('createFilmSupplyOrderAction: a 500 for a code that is in the workspace => duplicate with a link', async () => {
    loadWorkspace.mockResolvedValue({ ...emptyWorkspace, filmOrders: [{ id: 'o-8', code: 'FSO-8' }] });
    callApi.mockResolvedValue(refused(500, 'システムエラー', null, 'INTERNAL_ERROR'));
    const result = await actions.createFilmSupplyOrderAction(null, form({ code: 'FSO-8', lines: LINES, sevenPurchaseOrderId: 'po-1', paymentTerms: 'prepaid' }));
    expect(result).toMatchObject({ code: 'DUPLICATE', link: { href: '/orders#order-o-8' } });
  });

  it('createFillingOrderAction: a 500 that is not a duplicate stays the server error', async () => {
    callApi.mockResolvedValue({ ok: false, status: 500, data: null, error: 'システムエラーです', errorKo: null, code: 'INTERNAL_ERROR' });
    const result = await actions.createFillingOrderAction(null, form({ code: 'FIL-1', lines: JSON.stringify([{ description: 'x', orderedQuantity: '1', unit: 'pods' }]) }));
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR', message: 'システムエラーです' });
  });

  it('a duplicate answer refreshes the screen (the registered record may not be shown yet)', async () => {
    callApi.mockResolvedValue(refused(409, 'raw', { code: 'DUPLICATE', existing: { id: 'po-3', projectId: 'project-a' } }, 'DUPLICATE'));
    await actions.createSevenPurchaseOrderAction(null, form({ poNumber: 'S-3' }));
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });
});
