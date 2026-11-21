import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1 R24: approveFromCardAction / returnMakerPoAction. */
const callApi = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => 'project-COOKIE',
  loadSessionUser: async () => null,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const { approveFromCardAction, returnMakerPoAction } = await import('../apps/web/src/app/approval-actions.js');
const { RENDERED_PROJECT_FIELD, PROJECT_CONTEXT_MISMATCH, IDEMPOTENCY_FIELD } = await import('../apps/web/src/lib/project-context.js');

const RENDERED = 'proj-RENDERED';
const KEY = 'approval-key-0001';
const SHA = 'ab12'.repeat(16);

function form(entries: Record<string, string>, rendered: string | File | null = RENDERED, key: string | null = KEY): FormData {
  const data = new FormData();
  if (rendered !== null) data.set(RENDERED_PROJECT_FIELD, rendered);
  if (key !== null) data.set(IDEMPOTENCY_FIELD, key);
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
}
const ok = (data: unknown = {}) => ({ ok: true, status: 200, data, error: null, code: null, failure: null });
const fail = (status: number, code: string | null, error = '拒否されました') => ({ ok: false, status, data: code ? { code } : null, error, code, failure: null });

const CARD_SHA = 'cd34'.repeat(16);
beforeEach(() => {
  callApi.mockReset();
  revalidatePath.mockReset();
  // P1 integration: an approve form without the card's hash reads it from the API's approval card.
  callApi.mockImplementation(async (path: string) => (String(path).endsWith('/approval-card')
    ? ok({ makerPurchaseOrder: { approvalSnapshotSha256: CARD_SHA }, snapshot: { amounts: { currency: 'JPY', totalAmount: '1' } } })
    : ok()));
});

/** The approval write itself (the approval-card read, when there is one, comes first). */
const approvalCall = () => callApi.mock.calls.find((call) => !String(call[0]).endsWith('/approval-card'))!;

describe.each([
  ['approveFromCardAction', approveFromCardAction, { poId: 'mpo-1', expectedPaymentTerms: 'prepaid' }],
  ['returnMakerPoAction', returnMakerPoAction, { poId: 'mpo-1', reason: '金額違い' }]
] as const)('%s: the write guard', (_name, action, valid) => {
  it.each([
    ['no rendered field', null],
    ['an empty field', ''],
    ['a space', ' '],
    ['a path-like value', 'a/b'],
    ['a File', new File(['x'], 'x.txt')]
  ] as Array<[string, string | File | null]>)('refuses %s with PROJECT_CONTEXT_MISMATCH and no API call', async (_label, rendered) => {
    const result = await action(null, form(valid, rendered));
    expect(result).toMatchObject({ ok: false, code: PROJECT_CONTEXT_MISMATCH });
    expect(callApi).not.toHaveBeenCalled();
  });
});

describe('approveFromCardAction', () => {
  it('posts the approval to the paper with the terms, the hash and the idempotency key', async () => {
    const result = await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA }));
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi).toHaveBeenCalledWith('/api/maker-purchase-orders/mpo-1/ceo-approval', {
      method: 'POST', body: { expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA }, idempotencyKey: KEY, expectedProjectId: RENDERED
    });
    expect(result).toMatchObject({ ok: true, changedId: 'mpo-1' });
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it.each(['prepaid', 'on_delivery', 'undetermined'])('accepts the terms %s', async (terms) => {
    await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: terms }));
    expect(approvalCall()[1].body.expectedPaymentTerms).toBe(terms);
  });

  it.each(['', ' ', 'Prepaid', 'later', 'prepaid;x'])('refuses terms %j before any API call', async (terms) => {
    const result = await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: terms }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('支払条件');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('refuses a missing terms field', async () => {
    expect((await approveFromCardAction(null, form({ poId: 'mpo-1' }))).ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('refuses a missing paper id', async () => {
    expect((await approveFromCardAction(null, form({ expectedPaymentTerms: 'prepaid' }))).ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('sends the snapshot hash only when it is exactly 64 lowercase hex characters', async () => {
    await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA }));
    expect(approvalCall()[1].body).toHaveProperty('expectedSnapshotSha256', SHA);
    for (const bad of [SHA.toUpperCase(), SHA.slice(1), `${SHA}0`, 'g'.repeat(64), '', ' ', `x${SHA.slice(1)}`]) {
      callApi.mockClear();
      const result = await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: bad }));
      expect(approvalCall()[1].body, JSON.stringify(bad)).toEqual({ expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: CARD_SHA });
      expect(result.ok).toBe(true);
    }
  });

  it('sends no idempotency key when the form has none valid', async () => {
    await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid' }, RENDERED, null));
    expect(approvalCall()[1].idempotencyKey).toBeUndefined();
  });

  it('encodes the paper id into the path', async () => {
    await approveFromCardAction(null, form({ poId: 'a b/c', expectedPaymentTerms: 'prepaid' }));
    expect(approvalCall()[0]).toBe('/api/maker-purchase-orders/a%20b%2Fc/ceo-approval');
  });

  it('returns the refusal (and settles a 4xx) when the API refuses, e.g. a changed snapshot', async () => {
    callApi.mockResolvedValue(fail(409, 'MAKER_PO_SNAPSHOT_CHANGED', '発注書が変わりました'));
    const result = await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA }));
    expect(result).toMatchObject({ ok: false, message: '発注書が変わりました', code: 'MAKER_PO_SNAPSHOT_CHANGED', settled: true });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('does not settle a timeout (the key is kept)', async () => {
    callApi.mockResolvedValue({ ok: false, status: 0, data: null, error: '応答なし', code: 'API_TIMEOUT', failure: 'timeout' });
    expect((await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA }))).settled).toBe(false);
  });
});

describe('approveFromCardAction: a paper without an amount (P1 integration)', () => {
  it('refuses without the explicit 「金額未入力のまま承認する」 check and makes no API call', async () => {
    const result = await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA, amountMissing: 'true' }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('金額未入力のまま承認する');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('approves with the check (the API only warns about the amount)', async () => {
    const result = await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid', expectedSnapshotSha256: SHA, amountMissing: 'true', acknowledgeMissingAmount: 'on' }));
    expect(result.ok).toBe(true);
    expect(approvalCall()[0]).toBe('/api/maker-purchase-orders/mpo-1/ceo-approval');
  });

  it('holds the approval when no hash can be read (never sent without it)', async () => {
    callApi.mockImplementation(async () => ({ ok: false, status: 404, data: { code: 'MAKER_PO_NOT_FOUND' }, error: 'x', code: 'MAKER_PO_NOT_FOUND', failure: null }));
    const result = await approveFromCardAction(null, form({ poId: 'mpo-1', expectedPaymentTerms: 'prepaid' }));
    expect(result.ok).toBe(false);
    expect(callApi.mock.calls.every((call) => String(call[0]).endsWith('/approval-card'))).toBe(true);
  });
});

describe('returnMakerPoAction', () => {
  it.each(['', '   '])('requires a reason (%j) and makes no API call', async (reason) => {
    const result = await returnMakerPoAction(null, form({ poId: 'mpo-1', reason }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('理由');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('requires a paper id', async () => {
    expect((await returnMakerPoAction(null, form({ reason: 'x' }))).ok).toBe(false);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('posts /return with the trimmed reason and the rendered project, not the cookie project', async () => {
    const result = await returnMakerPoAction(null, form({ poId: 'mpo-1', reason: '  金額が見積と違います  ' }));
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi).toHaveBeenCalledWith('/api/maker-purchase-orders/mpo-1/return', {
      method: 'POST', body: { reason: '金額が見積と違います', expectedProjectId: RENDERED }, idempotencyKey: KEY, expectedProjectId: RENDERED
    });
    expect(result).toMatchObject({ ok: true, changedId: 'mpo-1' });
    expect(revalidatePath).toHaveBeenCalled();
  });

  it('falls back to /cancel with a 差し戻し note and key suffix .cancel on a 404 without a code', async () => {
    callApi.mockResolvedValueOnce(fail(404, null, 'Not Found'));
    const result = await returnMakerPoAction(null, form({ poId: 'mpo-1', reason: '金額違い' }));
    expect(callApi).toHaveBeenCalledTimes(2);
    expect(callApi.mock.calls[1]![0]).toBe('/api/maker-purchase-orders/mpo-1/cancel');
    expect(callApi.mock.calls[1]![1]).toEqual({ method: 'POST', body: { note: '差し戻し: 金額違い' }, idempotencyKey: `${KEY}.cancel`, expectedProjectId: RENDERED });
    expect(result).toMatchObject({ ok: true, changedId: 'mpo-1' });
    expect(result.message).toContain('差し戻しました');
  });

  it('sends no cancel key when the form has none', async () => {
    callApi.mockResolvedValueOnce(fail(404, null));
    await returnMakerPoAction(null, form({ poId: 'mpo-1', reason: 'x' }, RENDERED, null));
    expect(callApi.mock.calls[1]![1].idempotencyKey).toBeUndefined();
  });

  it('does NOT fall back to cancel on a 404 WITH a code (MAKER_PO_NOT_FOUND) and returns the refusal', async () => {
    callApi.mockResolvedValueOnce(fail(404, 'MAKER_PO_NOT_FOUND', '発注書が見つかりません'));
    const result = await returnMakerPoAction(null, form({ poId: 'mpo-1', reason: 'x' }));
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, code: 'MAKER_PO_NOT_FOUND', message: '発注書が見つかりません' });
  });

  it.each([
    [403, 'CEO_ONLY'],
    [422, 'MAKER_PO_RETURN_ONLY_DRAFT'],
    [422, 'MAKER_PO_RETURN_REASON_TOO_LONG'],
    [409, 'PROJECT_CONTEXT_MISMATCH'],
    [500, null]
  ])('does not retry %i %s as a cancel', async (status, code) => {
    callApi.mockResolvedValueOnce(fail(status, code, '拒否'));
    const result = await returnMakerPoAction(null, form({ poId: 'mpo-1', reason: 'x' }));
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.code ?? null).toBe(code);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('returns the cancel refusal when the fallback cancel is refused, settled by the HTTP answer', async () => {
    callApi.mockResolvedValueOnce(fail(404, null)).mockResolvedValueOnce(fail(422, 'MAKER_PO_STATE_CHANGED', '状態が変わりました'));
    const result = await returnMakerPoAction(null, form({ poId: 'mpo-1', reason: 'x' }));
    expect(result).toMatchObject({ ok: false, code: 'MAKER_PO_STATE_CHANGED', settled: true });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('does not settle a timed-out fallback cancel', async () => {
    callApi.mockResolvedValueOnce(fail(404, null)).mockResolvedValueOnce({ ok: false, status: 0, data: null, error: '応答なし', code: 'API_TIMEOUT', failure: 'timeout' });
    expect((await returnMakerPoAction(null, form({ poId: 'mpo-1', reason: 'x' }))).settled).toBe(false);
  });
});
