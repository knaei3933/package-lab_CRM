import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1 R25: the representative queue — server rows (contract §3), the web replay fallback. */
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const queue = await import('../apps/web/src/lib/representative-queue.js');
const { taskFromServerItem, loadServerRepresentativeQueue, loadRepresentativeQueue, replayOrderStatuses, representativeTasks, REPRESENTATIVE_WORK, QUEUE_KIND_STEP, REPRESENTATIVE_QUEUE_PROJECT_LIMIT } = queue;

const item = (over: Record<string, unknown> = {}) => ({
  key: 'k', kind: 'maker_po_ceo_approval', label: '代表承認',
  project: { id: 'p1', code: 'PRS-A', name: '案件A' },
  order: { id: 'o1', code: 'FSO-1', status: 'MAKER_PO_READY' },
  makerPurchaseOrder: { id: 'mpo-1', amounts: { currency: 'JPY', totalAmount: '312000', display: '¥312,000' } },
  waitingSince: '2026-11-20T01:00:00Z',
  requestedBy: { id: 'u', displayName: '佐藤' },
  deepLink: { step: 'approval_card', projectCode: 'PRS-A', orderCode: 'FSO-1' },
  ...over
});
const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, code: null });
const fail = (status: number, code: string | null, error = '失敗') => ({ ok: false, status, data: code ? { code } : null, error, code });

beforeEach(() => { callApi.mockReset(); });

describe('QUEUE_KIND_STEP / REPRESENTATIVE_WORK', () => {
  it('maps each kind to its order step', () => {
    expect(QUEUE_KIND_STEP).toMatchObject({
      approval_evidence_verification: 6, maker_po_creation: 7, maker_po_ceo_approval: 8,
      send_verification: 9, maker_po_final_acceptance: 10, payment_terms_undetermined: 7,
      hold_release: null, cancellation_review: null, cancellation_acknowledgement: null
    });
  });
  it('lists DUAL_APPROVED as representative work (a 校了 order waits for the maker paper)', () => {
    expect(REPRESENTATIVE_WORK.DUAL_APPROVED).toBeTruthy();
    expect(Object.keys(REPRESENTATIVE_WORK)).toEqual(expect.arrayContaining(['DUAL_APPROVED', 'MAKER_PO_READY', 'MAKER_PO_SENT_MANUALLY', 'ON_HOLD', 'CANCELLATION_REVIEW']));
  });
});

describe('taskFromServerItem', () => {
  it('maps a ceo-approval row with step 8, amount, requester and waiting time', () => {
    expect(taskFromServerItem(item())).toEqual({
      projectId: 'p1', projectCode: 'PRS-A', orderId: 'o1', projectLabel: 'PRS-A（案件A）', orderCode: 'FSO-1',
      status: 'MAKER_PO_READY', work: '代表承認', kind: 'maker_po_ceo_approval', step: 8, amount: '¥312,000',
      waitingSince: '2026-11-20T01:00:00Z', requestedBy: '佐藤', blockedReason: null
    });
  });

  it.each(Object.entries({ approval_evidence_verification: 6, maker_po_creation: 7, send_verification: 9, maker_po_final_acceptance: 10, hold_release: null, cancellation_review: null }))('kind %s opens step %s', (kind, step) => {
    expect(taskFromServerItem(item({ kind }))!.step).toBe(step);
  });

  it('has step null for an unknown kind', () => {
    expect(taskFromServerItem(item({ kind: 'something_new' }))!.step).toBeNull();
    expect(taskFromServerItem(item({ kind: undefined }))!.kind).toBe('unknown');
  });

  it('formats the amount when no display text is given', () => {
    const task = taskFromServerItem(item({ makerPurchaseOrder: { amounts: { currency: 'JPY', totalAmount: '480000' } } }))!;
    expect(task.amount).toMatch(/^[¥￥]480,000$/);
  });

  it('has no amount for a row without a paper', () => {
    expect(taskFromServerItem(item({ makerPurchaseOrder: undefined }))!.amount).toBeNull();
  });

  it('takes the codes from deepLink when project/order lack them', () => {
    const task = taskFromServerItem(item({ project: { id: 'p1' }, order: { id: 'o1' }, deepLink: { projectCode: 'DL-P', orderCode: 'DL-O' } }))!;
    expect(task).toMatchObject({ projectCode: 'DL-P', orderCode: 'DL-O', projectLabel: 'DL-P' });
  });

  it.each([
    ['no project code', { project: { id: 'p' }, deepLink: { orderCode: 'O' } }],
    ['no order code', { order: { id: 'o' }, deepLink: { projectCode: 'P' } }],
    ['neither', { project: {}, order: {}, deepLink: {} }]
  ])('returns null for a row with %s', (_name, over) => {
    expect(taskFromServerItem(item(over))).toBeNull();
  });

  it.each([null, undefined, 'x', 5, []])('returns null for a non-row (%j)', (value) => {
    expect(taskFromServerItem(value)).toBeNull();
  });

  it('a blocked row carries blockedReason from reason.message and a default work text', () => {
    const task = taskFromServerItem({ kind: 'payment_terms_undetermined', project: { id: 'p1', code: 'P', name: 'n' }, order: { id: 'o1', code: 'O' }, reason: { code: 'PAYMENT_TERMS_UNDETERMINED', message: '支払条件が未定です' } }, true)!;
    expect(task).toMatchObject({ blockedReason: '支払条件が未定です', work: '止まっている', step: 7 });
  });

  it('a non-blocked row never carries a blockedReason even if reason is present', () => {
    expect(taskFromServerItem(item({ reason: { message: 'x' } }))!.blockedReason).toBeNull();
  });
});

describe('loadServerRepresentativeQueue', () => {
  it('maps items and blocked rows and marks the source as server', async () => {
    callApi.mockResolvedValue(ok({ items: [item(), item({ kind: 'hold_release', label: '保留の解除' })], blocked: [{ kind: 'payment_terms_undetermined', project: { id: 'p1', code: 'P' }, order: { id: 'o', code: 'O' }, reason: { message: 'm' } }] }));
    const result = (await loadServerRepresentativeQueue())!;
    expect(callApi).toHaveBeenCalledWith('/api/representative-queue');
    expect(result.source).toBe('server');
    expect(result.tasks.map((task) => task.kind)).toEqual(['maker_po_ceo_approval', 'hold_release']);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked![0]!.blockedReason).toBe('m');
    expect(result.listError ?? null).toBeNull();
  });

  it('drops rows without codes instead of failing', async () => {
    callApi.mockResolvedValue(ok({ items: [item(), { kind: 'x' }], blocked: [] }));
    expect((await loadServerRepresentativeQueue())!.tasks).toHaveLength(1);
  });

  it('tolerates a body without items or blocked', async () => {
    callApi.mockResolvedValue(ok({}));
    const result = (await loadServerRepresentativeQueue())!;
    expect(result.tasks).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  it('is null when the route does not exist (404 without a code)', async () => {
    callApi.mockResolvedValue(fail(404, null));
    expect(await loadServerRepresentativeQueue()).toBeNull();
  });

  it('is null for a 403 (not the representative)', async () => {
    callApi.mockResolvedValue(fail(403, 'CEO_ONLY'));
    expect(await loadServerRepresentativeQueue()).toBeNull();
  });

  it.each([[500, null], [0, 'API_TIMEOUT'], [404, 'SOMETHING'], [422, 'X']])('reports a listError (never an empty queue) for %i %s', async (status, code) => {
    callApi.mockResolvedValue(fail(status, code, '読み込めません'));
    const result = (await loadServerRepresentativeQueue())!;
    expect(result).not.toBeNull();
    expect(result.listError).toBe('読み込めません');
    expect(result.tasks).toEqual([]);
    expect(result.source).toBe('server');
  });
});

describe('replayed (web) tasks carry the step', () => {
  const project = { id: 'p1', code: 'PRS-A', name: '案件A' };
  const orders = (status: string) => [{ id: 'o1', code: 'FSO-1', status }];

  it.each([['DUAL_APPROVED', 7], ['MAKER_PO_READY', 7], ['MAKER_PO_SENT_MANUALLY', 10], ['ON_HOLD', null], ['CANCELLATION_REVIEW', null]])('%s -> step %s', (status, step) => {
    const [task] = representativeTasks(project, orders(status));
    expect(task!.step).toBe(step);
    expect(task!.projectCode).toBe('PRS-A');
    expect(task!.work).toBe(REPRESENTATIVE_WORK[status]);
  });

  it('makes no task for a status without representative work', () => {
    expect(representativeTasks(project, orders('ARTWORK_RECEIVED'))).toEqual([]);
  });

  it('replays the audit rows to the latest status (a 校了 order shows up as DUAL_APPROVED)', () => {
    const events = [
      { entityId: 'o1', action: 'FILM_SUPPLY_ORDER_CREATED', afterState: { code: 'FSO-1', status: 'DRAFT' } },
      { entityId: 'o1', action: 'FILM_SUPPLY_ORDER_TRANSITIONED', afterState: { status: 'DUAL_APPROVED' } },
      { entityId: 'o2', action: 'FILM_SUPPLY_ORDER_CREATED', afterState: { code: 'FSO-2' } },
      { entityId: 'zz', action: 'FILM_SUPPLY_ORDER_TRANSITIONED', afterState: { status: 'ON_HOLD' } }
    ];
    expect(replayOrderStatuses(events as never)).toEqual([
      { id: 'o1', code: 'FSO-1', status: 'DUAL_APPROVED' }, { id: 'o2', code: 'FSO-2', status: 'DRAFT' }
    ]);
  });
});

describe('loadRepresentativeQueue', () => {
  const A = { id: 'p-a', code: 'PRS-A', name: 'A', status: 'ACTIVE' };
  const B = { id: 'p-b', code: 'PRS-B', name: 'B', status: 'ACTIVE' };
  const audit = (status: string) => ok({ events: [
    { entityId: 'o1', action: 'FILM_SUPPLY_ORDER_CREATED', afterState: { code: 'FSO-1', status: 'DRAFT' } },
    { entityId: 'o1', action: 'FILM_SUPPLY_ORDER_TRANSITIONED', afterState: { status } }
  ] });

  it('uses the server queue and filters it to the given projects', async () => {
    callApi.mockResolvedValue(ok({
      items: [item({ project: { id: 'p-a', code: 'PRS-A', name: 'A' } }), item({ project: { id: 'p-b', code: 'PRS-B', name: 'B' }, order: { id: 'o2', code: 'FSO-2' } })],
      blocked: [{ kind: 'payment_terms_undetermined', project: { id: 'p-b', code: 'PRS-B' }, order: { id: 'o3', code: 'FSO-3' }, reason: { message: 'm' } }]
    }));
    const result = await loadRepresentativeQueue([A], { server: true });
    expect(result.source).toBe('server');
    expect(result.tasks.map((task) => task.projectCode)).toEqual(['PRS-A']);
    expect(result.blocked).toEqual([]);
    expect(callApi).toHaveBeenCalledTimes(1);
  });

  it('keeps a server row that has no project id', async () => {
    callApi.mockResolvedValue(ok({ items: [item({ project: { code: 'PRS-X' } })], blocked: [] }));
    expect((await loadRepresentativeQueue([A], { server: true })).tasks).toHaveLength(1);
  });

  it('keeps the server listError (nothing is claimed) when the server read failed', async () => {
    callApi.mockResolvedValue(fail(500, null, '落ちています'));
    const result = await loadRepresentativeQueue([A], { server: true });
    expect(result.listError).toBe('落ちています');
    expect(result.tasks).toEqual([]);
  });

  it('replays the per-project audit when the server route is missing', async () => {
    callApi.mockImplementation(async (path: string) => path === '/api/representative-queue' ? fail(404, null) : audit('DUAL_APPROVED'));
    const result = await loadRepresentativeQueue([A, B], { server: true });
    expect(result.source).toBe('web');
    expect(result.tasks.map((task) => [task.projectCode, task.step])).toEqual([['PRS-A', 7], ['PRS-B', 7]]);
  });

  it('replays the per-project audit when the server answers 403', async () => {
    callApi.mockImplementation(async (path: string) => path === '/api/representative-queue' ? fail(403, 'CEO_ONLY') : audit('MAKER_PO_SENT_MANUALLY'));
    expect((await loadRepresentativeQueue([A], { server: true })).tasks[0]!.step).toBe(10);
  });

  it('without the server option never reads the server queue', async () => {
    callApi.mockResolvedValue(audit('ON_HOLD'));
    const result = await loadRepresentativeQueue([A]);
    expect(callApi.mock.calls.map((call) => call[0])).toEqual([`/api/projects/p-a/audit-history?entityType=film_supply_order&limit=500`]);
    expect(result).toMatchObject({ source: 'web', unreadProjects: [], skippedProjects: 0 });
    expect(result.tasks[0]).toMatchObject({ status: 'ON_HOLD', step: null });
  });

  it('names a project whose audit read failed', async () => {
    callApi.mockImplementation(async (path: string) => path.includes('p-b') ? fail(500, null) : audit('DUAL_APPROVED'));
    const result = await loadRepresentativeQueue([A, B]);
    expect(result.unreadProjects).toEqual(['PRS-B']);
    expect(result.tasks).toHaveLength(1);
  });

  it('reads at most REPRESENTATIVE_QUEUE_PROJECT_LIMIT projects and counts the rest', async () => {
    callApi.mockResolvedValue(audit('DUAL_APPROVED'));
    const many = Array.from({ length: REPRESENTATIVE_QUEUE_PROJECT_LIMIT + 3 }, (_, index) => ({ id: `p${index}`, code: `C${index}`, name: 'n', status: 'ACTIVE' }));
    const result = await loadRepresentativeQueue(many);
    expect(callApi).toHaveBeenCalledTimes(REPRESENTATIVE_QUEUE_PROJECT_LIMIT);
    expect(result.skippedProjects).toBe(3);
  });
});
