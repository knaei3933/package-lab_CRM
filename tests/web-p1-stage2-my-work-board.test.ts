import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P1 R26: loadMyWork on top of the REAL loadMakerPoBoard (only the API and the
 * workspace read are mocked). loadMakerPoBoard keeps just the orders that carry
 * maker-paper work (MAKER_PO_READY onward), so the earlier steps never reach
 * 自分の作業 — every open order is listed, including steps 1–7 (fixed in stage 2).
 */
const callApi = vi.hoisted(() => vi.fn());
const loadWorkspace = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadWorkspace: (...args: unknown[]) => loadWorkspace(...args)
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const { loadMyWork } = await import('../apps/web/src/lib/my-work.js');

const PO = { id: 'po-1', poNumber: 'N', poNumberHidden: false, officialRegisteredAt: '2026-11-01', officiallyRegistered: true, verificationStatus: 'verified', reviewPending: false, officialRegistrationHidden: false, verificationHidden: false };
const order = (status: string) => ({
  id: `ord-${status}`, code: `FSO-${status}`, status, sevenPurchaseOrderId: 'po-1', lineCount: 1, lines: [], detailsHidden: false, statusHidden: false,
  lastNormalStatus: null, paymentTerms: 'prepaid', createdAt: '', updatedAt: '2026-11-10T00:00:00Z'
});
const STATUSES = ['DRAFT', 'SEVEN_PO_VERIFIED', 'ARTWORK_RECEIVED', 'PROOF_READY', 'APPROVAL_PENDING', 'DUAL_APPROVED', 'MAKER_PO_READY', 'MAKER_PO_ACCEPTED'];

beforeEach(() => {
  callApi.mockReset();
  callApi.mockResolvedValue({ ok: true, status: 200, data: { makerPurchaseOrders: [] }, error: null, code: null });
  loadWorkspace.mockReset();
  loadWorkspace.mockResolvedValue({
    error: null, labels: null, filmOrders: STATUSES.map(order), sevenPurchaseOrders: [PO], documents: [], revisions: [], deliveries: []
  });
});

describe('loadMyWork with the real maker-po board', () => {
  it('lists orders that carry maker-paper work', async () => {
    const work = await loadMyWork([{ id: 'p1', code: 'PRJ-1', name: 'n', status: 'ACTIVE' }], 'staff');
    expect(work.rows.map((row) => row.status)).toEqual(expect.arrayContaining(['MAKER_PO_READY', 'MAKER_PO_ACCEPTED']));
  });

  // Known gap (reported, not fixed here): steps 1-6 and DUAL_APPROVED are staff work too.
  it('lists every open order, including those before the maker paper (steps 1-7)', async () => {
    const work = await loadMyWork([{ id: 'p1', code: 'PRJ-1', name: 'n', status: 'ACTIVE' }], 'staff');
    expect(work.rows.map((row) => row.status)).toEqual(expect.arrayContaining(['DRAFT', 'ARTWORK_RECEIVED', 'APPROVAL_PENDING', 'DUAL_APPROVED']));
  });
});
