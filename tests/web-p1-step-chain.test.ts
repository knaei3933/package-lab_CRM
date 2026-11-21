import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1 R21-R23: runChain — ordered API writes with derived idempotency keys. */
const callApi = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath }));

const { runChain, chainKey, MISSING_ANSWER, MISSING_ANSWER_MESSAGE, withAnswer, uploadedVersionId, answerId } = await import('../apps/web/src/lib/step-chain.js');
const { IDEMPOTENCY_FIELD } = await import('../apps/web/src/lib/project-context.js');

const KEY = 'form-key-0001';
const form = (key: string | null = KEY) => {
  const data = new FormData();
  if (key !== null) data.set(IDEMPOTENCY_FIELD, key);
  return data;
};
const ok = (data: unknown = { id: 'r-1' }) => ({ ok: true, status: 201, data, error: null, code: null, failure: null });
const refused = (status: number, code: string, error = 'refused') => ({ ok: false, status, data: { code }, error, code, failure: null });
const timeout = () => ({ ok: false, status: 0, data: null, error: '応答がありません', code: 'API_TIMEOUT', failure: 'timeout' });

const fixed = (path: string, label = path) => ({ label, request: () => ({ path, body: { path } }) });

beforeEach(() => {
  callApi.mockReset();
  revalidatePath.mockReset();
});

describe('chainKey', () => {
  it('derives the n-th key (1-based) from the form key', () => {
    expect(chainKey(KEY, 0)).toBe(`${KEY}.1`);
    expect(chainKey(KEY, 3)).toBe(`${KEY}.4`);
  });
  it('has no key without a form key', () => {
    expect(chainKey(undefined, 0)).toBeUndefined();
  });
  it('drops a derived key longer than the API limit of 128', () => {
    expect(chainKey('k'.repeat(127), 0)).toBeUndefined();
    expect(chainKey('k'.repeat(125), 0)).toBe(`${'k'.repeat(125)}.1`);
  });
});

describe('runChain: normal', () => {
  it('sends each write in order with derived keys .1 .2 .3', async () => {
    callApi.mockResolvedValue(ok());
    await runChain(form(), [fixed('/a'), fixed('/b'), fixed('/c')], { success: 'done' });
    expect(callApi.mock.calls.map((call) => call[0])).toEqual(['/a', '/b', '/c']);
    expect(callApi.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([`${KEY}.1`, `${KEY}.2`, `${KEY}.3`]);
  });

  it('defaults to POST and passes PATCH and the body through', async () => {
    callApi.mockResolvedValue(ok());
    await runChain(form(), [fixed('/a'), { label: 'p', request: () => ({ path: '/b', method: 'PATCH', body: { x: 1 } }) }], { success: 's' });
    expect(callApi.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: { path: '/a' } });
    expect(callApi.mock.calls[1]![1]).toMatchObject({ method: 'PATCH', body: { x: 1 } });
  });

  it('sends no key when the form has no valid key', async () => {
    callApi.mockResolvedValue(ok());
    await runChain(form(null), [fixed('/a')], { success: 's' });
    expect(callApi.mock.calls[0]![1].idempotencyKey).toBeUndefined();
    callApi.mockClear();
    await runChain(form('short'), [fixed('/a')], { success: 's' });
    expect(callApi.mock.calls[0]![1].idempotencyKey).toBeUndefined();
  });

  it('a skipped step (null) makes no call and keeps the later keys stable (.3 stays .3)', async () => {
    callApi.mockResolvedValue(ok());
    await runChain(form(), [fixed('/a'), { label: 'skip', request: () => null }, fixed('/c')], { success: 's' });
    expect(callApi.mock.calls.map((call) => call[0])).toEqual(['/a', '/c']);
    expect(callApi.mock.calls[1]![1].idempotencyKey).toBe(`${KEY}.3`);
  });

  it('hands earlier answers to later steps (null for a skipped one)', async () => {
    callApi.mockResolvedValueOnce(ok({ id: 'first' }));
    callApi.mockResolvedValueOnce(ok({ id: 'second' }));
    const seen: unknown[][] = [];
    await runChain(form(), [
      fixed('/a'),
      { label: 'skip', request: () => null },
      { label: 'c', request: (answers) => { seen.push([...answers]); return { path: '/c' }; } }
    ], { success: 's' });
    expect(seen[0]).toEqual([{ id: 'first' }, null]);
  });

  it('returns ok with the success text, the link and the last written id', async () => {
    callApi.mockResolvedValueOnce(ok({ id: 'one' })).mockResolvedValueOnce(ok({ id: 'two' }));
    const link = { href: '/p/A/o/X', label: 'go' };
    const result = await runChain(form(), [fixed('/a'), fixed('/b')], { success: '完了しました', link });
    expect(result).toEqual({ ok: true, message: '完了しました', changedId: 'two', link });
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('returns link null when none is given', async () => {
    callApi.mockResolvedValue(ok());
    expect((await runChain(form(), [fixed('/a')], { success: 's' })).link).toBeNull();
  });
});

describe('runChain: first write fails', () => {
  it('an answered 4xx is settled and the message is not prefixed', async () => {
    callApi.mockResolvedValue(refused(409, 'SOME_CODE', '重複しています'));
    const result = await runChain(form(), [fixed('/a', '一番目'), fixed('/b')], { success: 's' });
    expect(result).toMatchObject({ ok: false, settled: true, message: '重複しています', code: 'SOME_CODE' });
    expect(callApi).toHaveBeenCalledTimes(1);
  });

  it('a timeout is not settled (the key is kept)', async () => {
    callApi.mockResolvedValue(timeout());
    const result = await runChain(form(), [fixed('/a'), fixed('/b')], { success: 's' });
    expect(result.ok).toBe(false);
    expect(result.settled).toBe(false);
    expect(result.code).toBe('API_TIMEOUT');
    expect(callApi).toHaveBeenCalledTimes(1);
  });

  it('a 5xx is not settled', async () => {
    callApi.mockResolvedValue(refused(500, 'INTERNAL'));
    expect((await runChain(form(), [fixed('/a')], { success: 's' })).settled).toBe(false);
  });

  it('IDEMPOTENCY_KEY_REUSED is not settled and refreshes the page', async () => {
    callApi.mockResolvedValue(refused(409, 'IDEMPOTENCY_KEY_REUSED'));
    const result = await runChain(form(), [fixed('/a')], { success: 's' });
    expect(result.settled).toBe(false);
    expect(revalidatePath).toHaveBeenCalled();
  });

  it('a step-specific refusal text is used and its settled flag follows the HTTP answer', async () => {
    const refusal = vi.fn((code: string | null) => code === 'SPECIAL' ? { ok: false, message: '専用の文言' } : null);
    callApi.mockResolvedValue(refused(422, 'SPECIAL'));
    expect(await runChain(form(), [fixed('/a')], { success: 's', refusal })).toMatchObject({ message: '専用の文言', settled: true, code: 'SPECIAL' });
    callApi.mockResolvedValue({ ...timeout(), data: { code: 'SPECIAL' } });
    expect(await runChain(form(), [fixed('/a')], { success: 's', refusal })).toMatchObject({ message: '専用の文言', settled: false });
  });

  it('passes the failing step index to the refusal mapper', async () => {
    const refusal = vi.fn(() => null);
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce(refused(400, 'X'));
    await runChain(form(), [fixed('/a'), fixed('/b')], { success: 's', refusal });
    expect(refusal).toHaveBeenCalledWith('X', 1);
  });
});

describe('runChain: a later write fails after an earlier one was stored', () => {
  it('is never settled, even for a 4xx, and says which step stopped', async () => {
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce(refused(400, 'BAD', '内容が不正です'));
    const result = await runChain(form(), [fixed('/a', '校正ファイルの登録'), fixed('/b', '版の登録'), fixed('/c')], { success: 's' });
    expect(result.ok).toBe(false);
    expect(result.settled).toBe(false);
    expect(result.message.startsWith('「版の登録」で止まりました')).toBe(true);
    expect(result.message).toContain('その前の手順は記録済みです');
    expect(result.message).toContain('内容が不正です');
    expect(result.code).toBe('BAD');
    expect(callApi).toHaveBeenCalledTimes(2);
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('is not settled even with a step-specific refusal text', async () => {
    const refusal = () => ({ ok: false, message: '専用' });
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce(refused(422, 'SPECIAL'));
    const result = await runChain(form(), [fixed('/a'), fixed('/b', '二番目')], { success: 's', refusal });
    expect(result.settled).toBe(false);
    expect(result.message).toBe('「二番目」で止まりました（その前の手順は記録済みです）。専用');
  });

  it('a skipped first step does not count as written (the failure of the next one is a first-write failure)', async () => {
    callApi.mockResolvedValueOnce(refused(400, 'BAD', '不正'));
    const result = await runChain(form(), [{ label: 's', request: () => null }, fixed('/b', '二番目')], { success: 's' });
    expect(result.settled).toBe(true);
    expect(result.message).toBe('不正');
  });

  it('a retry of the same form key re-sends the stored writes with the same derived keys', async () => {
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce(timeout());
    await runChain(form(), [fixed('/a'), fixed('/b')], { success: 's' });
    callApi.mockResolvedValue(ok());
    await runChain(form(), [fixed('/a'), fixed('/b')], { success: 's' });
    const keys = callApi.mock.calls.map((call) => call[1].idempotencyKey);
    expect(keys).toEqual([`${KEY}.1`, `${KEY}.2`, `${KEY}.1`, `${KEY}.2`]);
  });
});

describe('runChain: MISSING_ANSWER', () => {
  it('at the first step sends nothing and says to reload, unprefixed and unsettled', async () => {
    const result = await runChain(form(), [{ label: 'x', request: () => MISSING_ANSWER }, fixed('/b')], { success: 's' });
    expect(callApi).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, message: MISSING_ANSWER_MESSAGE, settled: false });
  });

  it('after a stored step sends nothing further and names the step that stopped', async () => {
    callApi.mockResolvedValueOnce(ok());
    const result = await runChain(form(), [fixed('/a'), { label: '版の登録', request: () => MISSING_ANSWER }, fixed('/c')], { success: 's' });
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(result.settled).toBe(false);
    expect(result.message.startsWith('「版の登録」で止まりました')).toBe(true);
    expect(result.message).toContain(MISSING_ANSWER_MESSAGE);
  });

  it('a step built with withAnswer is MISSING_ANSWER when the earlier answer has no id', async () => {
    callApi.mockResolvedValueOnce(ok({ unexpected: true }));
    const result = await runChain(form(), [
      fixed('/a'),
      { label: '版の登録', request: (answers) => withAnswer(uploadedVersionId(answers[0]), (id) => ({ path: `/v/${id}` })) }
    ], { success: 's' });
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });
});

describe('answer readers', () => {
  it('uploadedVersionId reads { version: { id } } and nothing else', () => {
    expect(uploadedVersionId({ document: { id: 'd' }, version: { id: 'v1' } })).toBe('v1');
    expect(uploadedVersionId({ version: {} })).toBeNull();
    expect(uploadedVersionId(null)).toBeNull();
    expect(uploadedVersionId('x')).toBeNull();
  });

  it('answerId reads the id of a created record or its wrapper', () => {
    expect(answerId({ id: 'a' })).toBe('a');
    expect(answerId({ purchaseOrder: { id: 'po' } })).toBe('po');
    expect(answerId({ order: { id: 'o' } })).toBe('o');
    expect(answerId(null)).toBeNull();
  });

  it('withAnswer builds the request from a value and is MISSING_ANSWER without one', () => {
    expect(withAnswer('x', (value) => ({ path: `/p/${value}` }))).toEqual({ path: '/p/x' });
    expect(withAnswer(null, () => ({ path: '/never' }))).toBe(MISSING_ANSWER);
  });
});
