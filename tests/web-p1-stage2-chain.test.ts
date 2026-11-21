import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1 R23: AUTO_TRANSITION_ONLY fallback in runChain and the step actions that use it. */
const state = vi.hoisted(() => ({ selected: 'project-COOKIE' as string | null }));
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => state.selected,
  loadSessionUser: async () => null,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: () => undefined }));

const chain = await import('../apps/web/src/lib/step-chain.js');
const stepActions = await import('../apps/web/src/app/step-actions.js');
const { RENDERED_PROJECT_FIELD, IDEMPOTENCY_FIELD } = await import('../apps/web/src/lib/project-context.js');
const { runChain, answeredOrderStatus, alreadyAt, autoAdvanceRequest, AUTO_TRANSITION_CODES } = chain;

const KEY = 'chain-key-00001';
const RENDERED = 'proj-RENDERED';
const form = (entries: Record<string, string | string[]> = {}, key: string | null = KEY) => {
  const data = new FormData();
  data.set(RENDERED_PROJECT_FIELD, RENDERED);
  if (key) data.set(IDEMPOTENCY_FIELD, key);
  for (const [name, value] of Object.entries(entries)) for (const item of Array.isArray(value) ? value : [value]) data.append(name, item);
  return data;
};
const ok = (data: unknown = { id: 'r-1' }) => ({ ok: true, status: 201, data, error: null, code: null, failure: null });
const refuse = (status: number, code: string | null, error = '拒否') => ({ ok: false, status, data: code ? { code } : null, error, code, failure: null });

beforeEach(() => {
  callApi.mockReset();
  callApi.mockResolvedValue(ok());
});

describe('answeredOrderStatus', () => {
  it('reads status only when autoAdvanced is an array', () => {
    expect(answeredOrderStatus({ status: 'APPROVAL_PENDING', autoAdvanced: ['PROOF_READY'] })).toBe('APPROVAL_PENDING');
    expect(answeredOrderStatus({ status: 'APPROVAL_PENDING', autoAdvanced: [] })).toBe('APPROVAL_PENDING');
  });
  it('does not trust a status without an autoAdvanced array', () => {
    expect(answeredOrderStatus({ status: 'APPROVAL_PENDING' })).toBeNull();
    expect(answeredOrderStatus({ status: 'APPROVAL_PENDING', autoAdvanced: 'PROOF_READY' })).toBeNull();
    expect(answeredOrderStatus({ status: 'APPROVAL_PENDING', autoAdvanced: null })).toBeNull();
  });
  it('prefers orderStatus over status', () => {
    expect(answeredOrderStatus({ status: 'DRAFT', orderStatus: 'PROOF_READY', autoAdvanced: [] })).toBe('PROOF_READY');
  });
  it('is null for non-objects and a non-string status', () => {
    expect(answeredOrderStatus(null)).toBeNull();
    expect(answeredOrderStatus('x')).toBeNull();
    expect(answeredOrderStatus({ status: 5, autoAdvanced: [] })).toBeNull();
  });
});

describe('alreadyAt', () => {
  it('is true at or past the target in flow order', () => {
    expect(alreadyAt('PROOF_READY', 'PROOF_READY')).toBe(true);
    expect(alreadyAt('APPROVAL_PENDING', 'PROOF_READY')).toBe(true);
    expect(alreadyAt('MAKER_PO_READY', 'APPROVAL_PENDING')).toBe(true);
  });
  it('is false before the target', () => {
    expect(alreadyAt('ARTWORK_RECEIVED', 'PROOF_READY')).toBe(false);
    expect(alreadyAt('PROOF_READY', 'APPROVAL_PENDING')).toBe(false);
  });
  it('is false for an unknown state, an unknown target or no answer', () => {
    expect(alreadyAt(null, 'PROOF_READY')).toBe(false);
    expect(alreadyAt('ON_HOLD', 'PROOF_READY')).toBe(false);
    expect(alreadyAt('APPROVAL_PENDING', 'SOMETHING')).toBe(false);
  });
});

describe('autoAdvanceRequest / AUTO_TRANSITION_CODES', () => {
  it('posts to the order auto-advance route with the expected project', () => {
    expect(autoAdvanceRequest('ord/1', 'p1')).toEqual({ path: '/api/film-supply-orders/ord%2F1/auto-advance', body: { expectedProjectId: 'p1' } });
    expect(autoAdvanceRequest('o', null).body).toEqual({});
  });
  it('knows AUTO_TRANSITION_ONLY', () => {
    expect([...AUTO_TRANSITION_CODES]).toEqual(['AUTO_TRANSITION_ONLY']);
  });
});

describe('runChain fallback', () => {
  const steps = (codes: readonly string[], alt: (() => { path: string; body?: unknown } | null) = () => ({ path: '/alt', body: { alt: true } })) => [
    { label: '一手目', request: () => ({ path: '/first' }) },
    { label: '二手目', request: () => ({ path: '/second', body: { to: 'X' } }), fallback: { codes, request: alt } }
  ];

  it('retries the step once with its fallback request on 422 AUTO_TRANSITION_ONLY, key suffix a', async () => {
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce(refuse(422, 'AUTO_TRANSITION_ONLY')).mockResolvedValueOnce(ok());
    const result = await runChain(form(), steps(['AUTO_TRANSITION_ONLY']), { success: '済み' });
    expect(callApi.mock.calls.map((call) => call[0])).toEqual(['/first', '/second', '/alt']);
    expect(callApi.mock.calls[1]![1].idempotencyKey).toBe(`${KEY}.2`);
    expect(callApi.mock.calls[2]![1]).toMatchObject({ method: 'POST', body: { alt: true }, idempotencyKey: `${KEY}.2a` });
    expect(result).toMatchObject({ ok: true, message: '済み' });
  });

  it('does not retry on another code', async () => {
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce(refuse(422, 'SOME_OTHER_CODE', '別の拒否'));
    const result = await runChain(form(), steps(['AUTO_TRANSITION_ONLY']), { success: 's' });
    expect(callApi).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, code: 'SOME_OTHER_CODE' });
    expect(result.message).toContain('別の拒否');
  });

  it('does not retry when the refusal carries no code in its body', async () => {
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce(refuse(422, null));
    await runChain(form(), steps(['AUTO_TRANSITION_ONLY']), { success: 's' });
    expect(callApi).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the fallback code list is empty', async () => {
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce(refuse(422, 'AUTO_TRANSITION_ONLY'));
    const result = await runChain(form(), steps([]), { success: 's' });
    expect(callApi).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
  });

  it('does not retry when the step has no fallback', async () => {
    callApi.mockResolvedValueOnce(refuse(422, 'AUTO_TRANSITION_ONLY'));
    const result = await runChain(form(), [{ label: 'x', request: () => ({ path: '/x' }) }], { success: 's' });
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it('keeps the refusal when the fallback request is null', async () => {
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce(refuse(422, 'AUTO_TRANSITION_ONLY'));
    const result = await runChain(form(), steps(['AUTO_TRANSITION_ONLY'], () => null), { success: 's' });
    expect(callApi).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
  });

  it('retries only once: a refused fallback ends the chain with the fallback refusal, not settled after an earlier write', async () => {
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce(refuse(422, 'AUTO_TRANSITION_ONLY')).mockResolvedValueOnce(refuse(409, 'AUTO_TRANSITION_ONLY', '二度目'));
    const result = await runChain(form(), steps(['AUTO_TRANSITION_ONLY']), { success: 's' });
    expect(callApi).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    expect(result.settled).toBe(false);
    expect(result.message.startsWith('「二手目」で止まりました')).toBe(true);
    expect(result.message).toContain('二度目');
  });

  it('sends no fallback key without a form key and does not use the fallback when the step succeeds', async () => {
    callApi.mockResolvedValueOnce(ok()).mockResolvedValueOnce(refuse(422, 'AUTO_TRANSITION_ONLY')).mockResolvedValueOnce(ok());
    await runChain(form({}, null), steps(['AUTO_TRANSITION_ONLY']), { success: 's' });
    expect(callApi.mock.calls[2]![1].idempotencyKey).toBeUndefined();
    callApi.mockReset();
    callApi.mockResolvedValue(ok());
    await runChain(form(), steps(['AUTO_TRANSITION_ONLY']), { success: 's' });
    expect(callApi).toHaveBeenCalledTimes(2);
  });

  it('a fallback answer counts as the step answer for later steps', async () => {
    callApi.mockResolvedValueOnce(refuse(422, 'AUTO_TRANSITION_ONLY')).mockResolvedValueOnce(ok({ id: 'from-alt' }));
    const seen: unknown[] = [];
    await runChain(form(), [
      { label: 'a', request: () => ({ path: '/a' }), fallback: { codes: ['AUTO_TRANSITION_ONLY'], request: () => ({ path: '/alt' }) } },
      { label: 'b', request: (answers) => { seen.push(answers[0]); return null; } }
    ], { success: 's' });
    expect(seen).toEqual([{ id: 'from-alt' }]);
  });
});

describe('submitProofStepAction and the server-side automatic moves', () => {
  const proof = (extra: Record<string, string> = {}) => form({
    orderId: 'ord-1', sevenPurchaseOrderId: 'po-1', designKey: '表面A', currentStatus: 'ARTWORK_RECEIVED',
    contentBase64: Buffer.from('%PDF-1.7').toString('base64'), filename: 'a.pdf', contentType: 'application/pdf', ...extra
  });
  const answerFor = (revisionAnswer: unknown) => async (path: string) => {
    if (path.endsWith('/documents')) return ok({ document: { id: 'doc-1' }, version: { id: 'ver-1' } });
    if (path.endsWith('/artwork-revisions')) return ok(revisionAnswer);
    return ok();
  };
  const paths = () => callApi.mock.calls.map((call) => call[0] as string);

  it('skips both manual moves when the revision answer says APPROVAL_PENDING with autoAdvanced', async () => {
    callApi.mockImplementation(answerFor({ revision: { id: 'rev-1' }, status: 'APPROVAL_PENDING', autoAdvanced: ['PROOF_READY', 'APPROVAL_PENDING'] }));
    const result = await stepActions.submitProofStepAction(null, proof());
    expect(paths()).toEqual([`/api/projects/${RENDERED}/documents`, '/api/film-supply-orders/ord-1/artwork-revisions']);
    expect(result.ok).toBe(true);
  });

  it('skips only the PROOF_READY move when the answer says PROOF_READY', async () => {
    callApi.mockImplementation(answerFor({ revision: { id: 'rev-1' }, status: 'PROOF_READY', autoAdvanced: ['PROOF_READY'] }));
    await stepActions.submitProofStepAction(null, proof());
    expect(paths().filter((path) => path.endsWith('/transitions'))).toHaveLength(1);
    expect(callApi.mock.calls[2]![1].body).toEqual({ to: 'APPROVAL_PENDING' });
  });

  it('does not trust a status without an autoAdvanced array (the manual moves are sent)', async () => {
    callApi.mockImplementation(answerFor({ revision: { id: 'rev-1' }, status: 'APPROVAL_PENDING' }));
    await stepActions.submitProofStepAction(null, proof());
    expect(paths().filter((path) => path.endsWith('/transitions'))).toHaveLength(2);
  });

  it('sends the manual moves when the answer has no status (the current API)', async () => {
    callApi.mockImplementation(answerFor({ revision: { id: 'rev-1' } }));
    await stepActions.submitProofStepAction(null, proof());
    expect(callApi.mock.calls.slice(2).map((call) => call[1].body)).toEqual([{ to: 'PROOF_READY' }, { to: 'APPROVAL_PENDING' }]);
  });

  it('turns AUTO_TRANSITION_ONLY on the PROOF_READY move into auto-advance with the rendered project', async () => {
    callApi.mockImplementation(async (path: string, options: { body?: { to?: string } }) => {
      if (path.endsWith('/transitions') && options.body?.to === 'PROOF_READY') return refuse(422, 'AUTO_TRANSITION_ONLY');
      return answerFor({ revision: { id: 'rev-1' } })(path);
    });
    const result = await stepActions.submitProofStepAction(null, proof());
    const advance = callApi.mock.calls.find((call) => (call[0] as string).endsWith('/auto-advance'))!;
    expect(advance[0]).toBe('/api/film-supply-orders/ord-1/auto-advance');
    expect(advance[1]).toMatchObject({ body: { expectedProjectId: RENDERED }, idempotencyKey: `${KEY}.3a` });
    expect(result.ok).toBe(true);
  });

  it('with a status other than ARTWORK_RECEIVED/PROOF_READY makes no manual move at all', async () => {
    callApi.mockImplementation(answerFor({ revision: { id: 'rev-1' } }));
    await stepActions.submitProofStepAction(null, proof({ currentStatus: 'APPROVAL_PENDING' }));
    expect(paths()).toHaveLength(2);
  });
});

describe('createMakerPoStepAction auto-advance fallback', () => {
  const maker = () => form({ orderId: 'ord-1', recipientAddress: 'order@maker.example', totalAmount: '480000', needsReadyTransition: 'true' });

  it('falls back to POST auto-advance with {expectedProjectId} on AUTO_TRANSITION_ONLY, then creates the paper', async () => {
    callApi.mockImplementation(async (path: string) => path.endsWith('/transitions') ? refuse(422, 'AUTO_TRANSITION_ONLY') : ok());
    const result = await stepActions.createMakerPoStepAction(null, maker());
    expect(callApi.mock.calls.map((call) => call[0])).toEqual([
      '/api/film-supply-orders/ord-1/transitions',
      '/api/film-supply-orders/ord-1/auto-advance',
      '/api/film-supply-orders/ord-1/maker-purchase-orders'
    ]);
    expect(callApi.mock.calls[1]![1]).toMatchObject({ method: 'POST', body: { expectedProjectId: RENDERED }, idempotencyKey: `${KEY}.1a` });
    expect(result.ok).toBe(true);
  });

  it('does not use auto-advance for another refusal code and stops before the paper', async () => {
    callApi.mockImplementation(async (path: string) => path.endsWith('/transitions') ? refuse(422, 'PAYMENT_GATE_UNSATISFIED') : ok());
    const result = await stepActions.createMakerPoStepAction(null, maker());
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_GATE_UNSATISFIED' });
  });
});

describe('startFilmOrderAction with an existing PO', () => {
  const LINES = JSON.stringify([{ description: '合成フィルム', orderedQuantity: '10', unit: 'rolls' }]);
  const start = (extra: Record<string, string>) => form({ code: 'FSO-NEW', paymentTerms: 'prepaid', lines: LINES, projectCode: 'PRJ-1', ...extra });
  const paths = () => callApi.mock.calls.map((call) => call[0] as string);

  it('runChecklist=true sends the checklist to THAT PO and does not create a PO', async () => {
    const result = await stepActions.startFilmOrderAction(null, start({ existingPoId: 'po-existing', runChecklist: 'true', issuerNameRecorded: 'on', issuerName: 'セブン化学' }));
    expect(paths()).toEqual([
      '/api/seven-purchase-orders/po-existing/verification-checklist',
      `/api/projects/${RENDERED}/film-supply-orders`,
      '/api/film-supply-orders/r-1/transitions'
    ]);
    expect(paths().some((path) => path.endsWith('/seven-purchase-orders'))).toBe(false);
    expect(callApi.mock.calls[0]![1].body).toMatchObject({ issuerNameRecorded: true, issuerName: 'セブン化学', documentNumberRecorded: false });
    expect(callApi.mock.calls[1]![1].body).toMatchObject({ sevenPurchaseOrderId: 'po-existing' });
    expect(result.ok).toBe(true);
  });

  it('without runChecklist skips both the PO create and the checklist', async () => {
    await stepActions.startFilmOrderAction(null, start({ existingPoId: 'po-existing' }));
    expect(paths()).toEqual([`/api/projects/${RENDERED}/film-supply-orders`, '/api/film-supply-orders/r-1/transitions']);
  });

  it.each(['false', 'on', '1', ''])('runChecklist=%j does not run the checklist', async (value) => {
    await stepActions.startFilmOrderAction(null, start({ existingPoId: 'po-existing', runChecklist: value }));
    expect(paths().some((path) => path.includes('verification-checklist'))).toBe(false);
  });

  it('runChecklist without an existing PO changes nothing: the new PO is created and checked once', async () => {
    await stepActions.startFilmOrderAction(null, start({ poNumber: 'PO-9', officialRegisteredAt: '2026-11-01', runChecklist: 'true' }));
    expect(paths().filter((path) => path.includes('verification-checklist'))).toHaveLength(1);
    expect(paths()[0]).toBe(`/api/projects/${RENDERED}/seven-purchase-orders`);
  });

  it('skips the 発注内容の確定 move when the order answer says SEVEN_PO_VERIFIED with autoAdvanced', async () => {
    callApi.mockImplementation(async (path: string) => path.endsWith('/film-supply-orders') ? ok({ order: { id: 'ord-9' }, id: 'ord-9', status: 'SEVEN_PO_VERIFIED', autoAdvanced: ['SEVEN_PO_VERIFIED'] }) : ok());
    await stepActions.startFilmOrderAction(null, start({ existingPoId: 'po-existing' }));
    expect(paths().some((path) => path.endsWith('/transitions'))).toBe(false);
  });
});
