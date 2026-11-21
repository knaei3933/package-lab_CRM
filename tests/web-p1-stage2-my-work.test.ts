import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1 R26: 自分の作業 — grouping (pure) and loadMyWork with mocked maker-po reads. */
const loadMakerPoBoard = vi.hoisted(() => vi.fn());
const loadMakerPoDetail = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  callApi: async () => ({ ok: false, status: 0, data: null, error: 'x' })
}));
vi.mock('../apps/web/src/lib/maker-po-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/maker-po-data.js')>()),
  loadMakerPoBoard: (...args: unknown[]) => loadMakerPoBoard(...args),
  loadMakerPoDetail: (...args: unknown[]) => loadMakerPoDetail(...args)
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const { workGroupOf, workText, loadMyWork, MY_WORK_PROJECT_LIMIT } = await import('../apps/web/src/lib/my-work.js');
const { buildOrderFlow } = await import('../apps/web/src/lib/order-flow.js');

const PO = { id: 'po-1', poNumber: 'N', poNumberHidden: false, officialRegisteredAt: '2026-11-01', officiallyRegistered: true, verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false };

function order(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: `ord-${status}`, code: `FSO-${status}`, status, sevenPurchaseOrderId: 'po-1', lineCount: 1, lines: [],
    detailsHidden: false, statusHidden: false, lastNormalStatus: null, paymentTerms: 'prepaid', createdAt: '', updatedAt: '2026-11-10T00:00:00Z', ...extra
  };
}

function flowOf(status: string, role: string, over: Record<string, unknown> = {}) {
  const { orderExtra, ...rest } = over as { orderExtra?: Record<string, unknown> };
  return buildOrderFlow({
    order: order(status, orderExtra) as never, role, po: PO as never, documents: [], revisions: [], gate: null,
    makerPos: [], makerEvents: [], settledSendEventIds: new Set(), paymentGate: null, deliveries: [], ...rest
  } as never);
}

const labelOf = (key: string) => `[${key}]`;

describe('workGroupOf', () => {
  it.each([['FILM_RECEIPT_ASSUMED_NO_ISSUE'], ['CANCELLED']])('%s is not listed (null)', (status) => {
    expect(workGroupOf(flowOf(status, 'staff'))).toBeNull();
  });

  it('a hidden status is not listed', () => {
    expect(workGroupOf(flowOf('DRAFT', 'viewer', { orderExtra: { statusHidden: true } }))).toBeNull();
  });

  it.each(['ON_HOLD', 'CANCELLATION_REVIEW', 'CHANGE_REVIEW'])('exception %s is stuck', (status) => {
    expect(workGroupOf(flowOf(status, 'staff'))).toBe('stuck');
  });

  it('an unknown status is stuck', () => {
    expect(workGroupOf(flowOf('SOMETHING_NEW', 'staff'))).toBe('stuck');
  });

  it('a blocked step is stuck, even when the role can act on the blocker', () => {
    const flow = flowOf('DUAL_APPROVED', 'staff', { orderExtra: { paymentTerms: 'undetermined' } });
    expect(flow.panel.canAct).toBe(true);
    expect(workGroupOf(flow)).toBe('stuck');
  });

  it('a step this role can do is now', () => {
    expect(workGroupOf(flowOf('ARTWORK_RECEIVED', 'staff'))).toBe('now');
  });

  it('a representative step is waiting for staff and now for the representative', () => {
    expect(workGroupOf(flowOf('DUAL_APPROVED', 'staff'))).toBe('waiting');
    expect(workGroupOf(flowOf('DUAL_APPROVED', 'admin'))).toBe('now');
  });

  it('a viewer only ever waits (never now)', () => {
    expect(workGroupOf(flowOf('ARTWORK_RECEIVED', 'viewer'))).toBe('waiting');
  });
});

describe('workText', () => {
  it('uses the blocker reason for a blocked step', () => {
    const flow = flowOf('DUAL_APPROVED', 'staff', { orderExtra: { paymentTerms: 'undetermined' } });
    expect(workText(flow, 'stuck', labelOf)).toBe(flow.panel.blocked!.reason);
  });

  it('names the state and the pending decision for an exception', () => {
    expect(workText(flowOf('ON_HOLD', 'staff'), 'stuck', labelOf)).toBe('[ON_HOLD]（解除・再開の判断待ち）');
  });

  it('says who is waited for in the waiting group', () => {
    expect(workText(flowOf('DUAL_APPROVED', 'staff'), 'waiting', labelOf)).toBe('代表の確認・承認待ち');
    expect(workText(flowOf('ARTWORK_RECEIVED', 'viewer'), 'waiting', labelOf)).toBe('担当者の記録待ち');
  });

  it('names the step to advance in the now group', () => {
    expect(workText(flowOf('ARTWORK_RECEIVED', 'staff'), 'now', labelOf)).toBe('校正を進める');
    expect(workText(flowOf('MAKER_PO_ACCEPTED', 'staff'), 'now', labelOf)).toBe('製造・出荷を進める');
  });
});

describe('loadMyWork', () => {
  const proj = (n: number) => ({ id: `p${n}`, code: `PRJ-${n}`, name: `n${n}`, status: 'ACTIVE' });
  const board = (orders: Array<ReturnType<typeof order>>, over: Record<string, unknown> = {}, makerByOrder: Record<string, unknown[]> = {}) => ({
    workspace: { error: null, labels: null, filmOrders: orders, sevenPurchaseOrders: [PO], documents: [], revisions: [], deliveries: [], ...over },
    boards: orders.map((entry) => ({ order: entry, makerPurchaseOrders: makerByOrder[entry.id] ?? [], paymentGate: null }))
  });

  beforeEach(() => {
    loadMakerPoBoard.mockReset();
    loadMakerPoDetail.mockReset();
    loadMakerPoDetail.mockResolvedValue({ events: [] });
  });

  it('builds a row per listed order with its project, step, text and an order link key', async () => {
    loadMakerPoBoard.mockResolvedValue(board([order('ARTWORK_RECEIVED')]));
    const work = await loadMyWork([proj(1)], 'staff');
    expect(work.rows).toEqual([{
      key: 'ord-ARTWORK_RECEIVED', group: 'now', projectCode: 'PRJ-1', orderCode: 'FSO-ARTWORK_RECEIVED', step: 5, stepTitle: '5 校正',
      text: '校正を進める', status: 'ARTWORK_RECEIVED', statusLabel: 'デザイン受領', updatedAt: '2026-11-10T00:00:00Z'
    }]);
    expect(work.unreadProjects).toEqual([]);
    expect(work.skippedProjects).toBe(0);
  });

  it('omits finished and cancelled orders', async () => {
    loadMakerPoBoard.mockResolvedValue(board([order('FILM_RECEIPT_ASSUMED_NO_ISSUE'), order('CANCELLED'), order('MAKER_PO_ACCEPTED')]));
    const work = await loadMyWork([proj(1)], 'staff');
    expect(work.rows.map((row) => row.status)).toEqual(['MAKER_PO_ACCEPTED']);
  });

  it('sorts across projects by updatedAt, oldest first', async () => {
    loadMakerPoBoard
      .mockResolvedValueOnce(board([order('ARTWORK_RECEIVED', { id: 'new', code: 'NEW', updatedAt: '2026-11-20T00:00:00Z' })]))
      .mockResolvedValueOnce(board([order('MAKER_PO_ACCEPTED', { id: 'old', code: 'OLD', updatedAt: '2026-11-01T00:00:00Z' })]));
    const work = await loadMyWork([proj(1), proj(2)], 'staff');
    expect(work.rows.map((row) => row.orderCode)).toEqual(['OLD', 'NEW']);
    expect(work.rows.map((row) => row.projectCode)).toEqual(['PRJ-2', 'PRJ-1']);
  });

  it('groups by who holds the ball', async () => {
    loadMakerPoBoard.mockResolvedValue(board([order('ARTWORK_RECEIVED'), order('DUAL_APPROVED'), order('ON_HOLD', { lastNormalStatus: 'ARTWORK_RECEIVED' })]));
    const work = await loadMyWork([proj(1)], 'staff');
    expect(Object.fromEntries(work.rows.map((row) => [row.status, row.group]))).toEqual({ ARTWORK_RECEIVED: 'now', DUAL_APPROVED: 'waiting', ON_HOLD: 'stuck' });
  });

  it('lists a project whose read failed with no orders as unread', async () => {
    loadMakerPoBoard.mockResolvedValueOnce(board([], { error: 'down' })).mockResolvedValueOnce(board([order('ARTWORK_RECEIVED')]));
    const work = await loadMyWork([proj(1), proj(2)], 'staff');
    expect(work.unreadProjects).toEqual(['PRJ-1']);
    expect(work.rows).toHaveLength(1);
  });

  it('still lists the orders of a project that has a workspace error but some orders', async () => {
    loadMakerPoBoard.mockResolvedValue(board([order('ARTWORK_RECEIVED')], { error: 'partial' }));
    const work = await loadMyWork([proj(1)], 'staff');
    expect(work.unreadProjects).toEqual([]);
    expect(work.rows).toHaveLength(1);
  });

  it('reads at most MY_WORK_PROJECT_LIMIT projects and counts the skipped ones', async () => {
    loadMakerPoBoard.mockResolvedValue(board([]));
    const projects = Array.from({ length: MY_WORK_PROJECT_LIMIT + 2 }, (_, index) => proj(index));
    const work = await loadMyWork(projects, 'staff');
    expect(loadMakerPoBoard).toHaveBeenCalledTimes(MY_WORK_PROJECT_LIMIT);
    expect(loadMakerPoBoard.mock.calls.map((call) => call[0])).toEqual(projects.slice(0, MY_WORK_PROJECT_LIMIT).map((project) => project.id));
    expect(work.skippedProjects).toBe(2);
  });

  it('reads the paper events only for the send and acceptance states that have a live paper', async () => {
    const maker = { id: 'mpo-1', status: 'MAKER_PO_SENT_MANUALLY' };
    loadMakerPoBoard.mockResolvedValue(board(
      [order('MAKER_PO_SENT_MANUALLY', { id: 'sent' }), order('MAKER_PO_ACCEPTED', { id: 'acc' }), order('MAKER_PO_SENT_MANUALLY', { id: 'nopaper' })],
      {}, { sent: [maker], acc: [{ id: 'mpo-2', status: 'MAKER_PO_ACCEPTED' }] }
    ));
    await loadMyWork([proj(1)], 'staff');
    expect(loadMakerPoDetail.mock.calls.map((call) => call[0])).toEqual(['mpo-1']);
  });

  it('uses the paper events: a pending send check makes the staff row wait for the representative', async () => {
    loadMakerPoDetail.mockResolvedValue({ events: [{ id: 'e1', eventType: 'SEND_EVIDENCE_REGISTERED', verificationStatus: 'PENDING_MANUAL_VERIFICATION' }] });
    loadMakerPoBoard.mockResolvedValue(board([order('MAKER_PO_SENT_MANUALLY', { id: 'sent' })], {}, { sent: [{ id: 'mpo-1', status: 'MAKER_PO_SENT_MANUALLY' }] }));
    const [row] = (await loadMyWork([proj(1)], 'staff')).rows;
    expect(row).toMatchObject({ group: 'waiting', text: '代表の確認・承認待ち' });
  });

  it('the same order is now for the representative', async () => {
    loadMakerPoBoard.mockResolvedValue(board([order('DUAL_APPROVED')]));
    expect((await loadMyWork([proj(1)], 'admin')).rows[0]!.group).toBe('now');
  });
});
