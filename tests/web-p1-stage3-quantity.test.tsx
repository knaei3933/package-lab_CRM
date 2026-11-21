import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1 R31 on the screens: line quantities read 「500 m」「2 ロール」, never 「500.000 meters」. */
const callApi = vi.hoisted(() => vi.fn());
const loadWorkspace = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session', PROJECT_COOKIE: 'kanei_web_project', apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token', readSelectedProjectId: async () => null,
  loadSessionUser: async () => ({ id: 'u1', role: 'admin', displayName: 'a' }),
  loadSession: async () => ({ kind: 'user' }),
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadWorkspace: (...args: unknown[]) => loadWorkspace(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: () => undefined, usePathname: () => '/p/PRJ/orders', useRouter: () => ({ refresh: () => undefined }) }));

const { OrdersScreen } = await import('../apps/web/src/screens/OrdersScreen.js');

const workspace = () => ({
  error: null, project: null, labels: null, fillingOrders: [], sevenPurchaseOrders: [], documents: [], revisions: [], approvalEvents: [],
  deliveries: [], readiness: null, documentVersionsWithheld: false, revisionsWithheld: 0, makerPaperCleanup: [],
  filmOrders: [{
    id: 'ord-1', code: 'FSO-1', status: 'DRAFT', sevenPurchaseOrderId: null, lineCount: 2, detailsHidden: false, statusHidden: false,
    lastNormalStatus: null, paymentTerms: 'prepaid', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
    lines: [
      { id: 'l1', lineNumber: 1, description: '合成フィルム', orderedQuantity: '500.000', unit: 'meters' },
      { id: 'l2', lineNumber: 2, description: 'ロール巻', orderedQuantity: '2.000', unit: 'rolls' }
    ]
  }]
});

beforeEach(() => {
  callApi.mockReset();
  callApi.mockResolvedValue({ ok: false, status: 404, data: null, error: 'x', code: null });
  loadWorkspace.mockReset();
  loadWorkspace.mockResolvedValue(workspace());
});

describe('OrdersScreen line cells (R31)', () => {
  it('shows the quantity with the short unit and without trailing zeros', async () => {
    const tree = await OrdersScreen({ projectId: 'p1', projectCode: 'PRJ' } as never);
    const html = renderToStaticMarkup(tree as never).replaceAll('<!-- -->', '');
    expect(html).toMatch(/1\. 合成フィルム ／ 500 m(?![A-Za-z])/);
    expect(html).toContain('2. ロール巻 ／ 2 ロール');
    expect(html).not.toContain('500.000 meters');
    expect(html).not.toContain('／ 500.000');
    expect(html).not.toContain('／ 2.000');
  });
});
