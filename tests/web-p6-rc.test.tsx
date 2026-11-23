import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * p6/rc (a): since H10 the viewer reads order codes and stages, but the order screen stays refused to it
 * by role (orderScreenRefused). Nothing the viewer is shown may point there — the overview's order rows,
 * its dashboard lists and activity, and the progress strip of the read-only screens. The operators keep
 * every link (positive control, so a test that never renders a link cannot pass).
 * The real screen is rendered; the API is mocked with the API's own viewer view of the audit rows.
 */
const session = vi.hoisted(() => ({
  user: null as { id: string; role: string; displayName?: string | null } | null
}));
const callApi = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  apiTimeoutMs: () => 10_000,
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => session.user,
  loadSession: async () => (session.user ? { kind: 'user', user: session.user } : { kind: 'anonymous' }),
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => ({ get: () => null })
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  usePathname: () => '/p/PRJ-RC/',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
}));

const { ProjectOverviewScreen } = await import('../apps/web/src/screens/ProjectOverviewScreen.js');
const { ProjectProgress } = await import('../apps/web/src/components/ProjectProgress.js');
const { ProjectOrderList } = await import('../apps/web/src/components/ProjectOrderList.js');
const { DashboardActivity, DashboardItemList, isOrderScreenHref } = await import('../apps/web/src/components/DashboardParts.js');
const { orderPath } = await import('../apps/web/src/lib/project-route.js');
const realData = await vi.importActual<typeof import('../apps/web/src/lib/project-data.js')>('../apps/web/src/lib/project-data.js');
const { buildAuditViewForRole } = await import('../apps/api/src/audit-view.js');

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
const renderAsync = async (tree: ReactNode) => renderToStaticMarkup((await resolve(tree)) as ReactElement).replaceAll('<!-- -->', '');
const render = (tree: ReactNode) => renderToStaticMarkup(tree as ReactElement).replaceAll('<!-- -->', '');
const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, errorKo: null, code: null, failure: null });
const ORDER_HREF = /href="\/p\/[^"/]+\/o\//;

const PROJECT_ID = 'p-rc';
const PROJECT_CODE = 'PRJ-RC';
const OLD = '2026-10-01T00:00:00.000Z'; // older than STALE_AFTER_DAYS: the order also lands in the stalled list
const row = (id: number, entityType: string, action: string, entityId: string, afterState: Record<string, unknown>) => ({
  id: `e-${id}`, action, entityType, entityId, beforeState: null, afterState, occurredAt: OLD,
  requestMetadata: { operation: 'x' }, actor: { id: 'u1', displayName: '担当', role: 'staff' }
});
const ROWS = [
  row(1, 'film_supply_order', 'FILM_SUPPLY_ORDER_CREATED', 'f-1', { id: 'f-1', code: 'FSO-RC-1', status: 'DRAFT', lineCount: 1, paymentTerms: 'prepaid' }),
  row(2, 'film_supply_order', 'FILM_SUPPLY_ORDER_TRANSITIONED', 'f-1', { status: 'ARTWORK_RECEIVED' }),
  row(3, 'film_supply_order', 'FILM_SUPPLY_ORDER_CREATED', 'f-2', { id: 'f-2', code: 'FSO-RC-2', status: 'DRAFT', lineCount: 1, paymentTerms: 'prepaid' }),
  row(4, 'film_supply_order', 'FILM_SUPPLY_ORDER_TRANSITIONED', 'f-2', { status: 'ON_HOLD', holdReason: '保留理由RC' })
];

function serveAs(role: 'viewer' | 'staff' | 'admin') {
  callApi.mockImplementation(async (url: string) => {
    const target = String(url);
    if (target.includes('/audit-history')) {
      const view = buildAuditViewForRole(role, ROWS.map((entry) => ({ ...entry, occurredAt: new Date(entry.occurredAt) })) as never);
      const events = JSON.parse(JSON.stringify(view)) as unknown[];
      return ok({ events: target.includes('order=desc') ? [...events].reverse() : events });
    }
    if (target.includes('/status-labels')) return ok({ filmSupplyOrderStates: [] });
    if (target === `/api/projects/${PROJECT_ID}`) return ok({ id: PROJECT_ID, code: PROJECT_CODE, name: '合成', route: 'F1', status: 'ACTIVE' });
    if (target.startsWith('/api/projects?') || target === '/api/projects') return ok({ projects: [] });
    return ok({});
  });
}

beforeEach(() => {
  callApi.mockReset();
});

describe('p6/rc (a): the viewer is shown the order code and stage, never a link to the refused order screen', () => {
  it('isOrderScreenHref: the order screen address with or without a step, nothing else', () => {
    expect(isOrderScreenHref(orderPath(PROJECT_CODE, 'FSO-RC-1'))).toBe(true);
    expect(isOrderScreenHref(orderPath(PROJECT_CODE, 'FSO-RC-1', 7))).toBe(true);
    expect(isOrderScreenHref(`${orderPath(PROJECT_CODE, 'FSO-RC-1')}#payment-terms`)).toBe(true);
    for (const other of ['/orders', '/orders#order-f-1', `/p/${PROJECT_CODE}`, `/p/${PROJECT_CODE}/orders`, `/p/${PROJECT_CODE}/new`, `/p/${PROJECT_CODE}/maker-po`]) {
      expect(isOrderScreenHref(other), other).toBe(false);
    }
  });

  it('the whole overview: the viewer reads both codes and their stages with no order-screen link; staff gets the links', async () => {
    session.user = { id: 'u-viewer', role: 'viewer', displayName: '閲覧' };
    serveAs('viewer');
    const viewerHtml = await renderAsync(await ProjectOverviewScreen({ projectId: PROJECT_ID, projectCode: PROJECT_CODE } as never));
    expect(viewerHtml).toContain('FSO-RC-1');
    expect(viewerHtml).toContain('FSO-RC-2');
    expect(viewerHtml).toContain('デザイン受領');
    expect(viewerHtml).not.toMatch(ORDER_HREF);
    expect(viewerHtml).not.toContain('この発注を開く');
    expect(viewerHtml).not.toContain('発注の画面を開く');
    expect(viewerHtml).not.toContain('保留理由RC');

    session.user = { id: 'u-staff', role: 'staff', displayName: '担当' };
    serveAs('staff');
    const staffHtml = await renderAsync(await ProjectOverviewScreen({ projectId: PROJECT_ID, projectCode: PROJECT_CODE } as never));
    expect(staffHtml).toContain(`href="${orderPath(PROJECT_CODE, 'FSO-RC-1')}"`);
    expect(staffHtml).toContain(`href="${orderPath(PROJECT_CODE, 'FSO-RC-2')}"`);
  });

  it('the progress strip of the read-only screens (/orders, /maker-po, /deliveries): the viewer\'s code is text, staff\'s a link', async () => {
    for (const [role, linked] of [['viewer', false], [null, false], ['superuser', false], ['staff', true], ['admin', true], ['auditor', true]] as const) {
      session.user = { id: 'u', role: String(role) };
      serveAs(role === 'admin' || role === 'staff' ? role : 'viewer');
      const workspace = await realData.loadWorkspace(PROJECT_ID);
      const html = render(<ProjectProgress workspace={workspace} role={role} currentPath="/orders" projectCode={PROJECT_CODE} />);
      expect(html, String(role)).toContain('FSO-RC-1');
      if (linked) expect(html, String(role)).toMatch(ORDER_HREF);
      else expect(html, String(role)).not.toMatch(ORDER_HREF);
    }
  });

  it('ProjectOrderList: a row per order either way; only the operators\' rows open the order', async () => {
    session.user = { id: 'u-viewer', role: 'viewer' };
    serveAs('viewer');
    const workspace = await realData.loadWorkspace(PROJECT_ID);
    const viewer = render(<ProjectOrderList workspace={workspace} projectCode={PROJECT_CODE} loadFailed={false} role="viewer" />);
    const staff = render(<ProjectOrderList workspace={workspace} projectCode={PROJECT_CODE} loadFailed={false} role="staff" />);
    expect(viewer.match(/class="p1-order-row[ "]/g)?.length).toBe(2);
    expect(viewer).toContain('p1-order-row--static');
    expect(viewer).not.toMatch(ORDER_HREF);
    expect(viewer).not.toContain('開く');
    expect(staff.match(new RegExp(ORDER_HREF.source, 'g'))?.length).toBe(2);
    expect(staff).toContain('開く');
  });

  it('DashboardItemList / DashboardActivity with orderLinks=false: order items and records are text, other links stay', () => {
    const item = (key: string, href: string, orderCode: string | null) => ({
      key, kind: 'order' as const, orderCode, title: `題-${key}`, detail: null, owner: null, href, linkLabel: '発注の一覧画面を開く', paymentTerms: null, amount: null, step: null
    });
    const items = [item('a', orderPath(PROJECT_CODE, 'FSO-RC-1'), 'FSO-RC-1'), item('b', '/orders', null)];
    const off = render(<DashboardItemList items={items as never} label="x" empty="" projectCode={PROJECT_CODE} orderLinks={false} />);
    expect(off).toContain('題-a');
    expect(off).not.toMatch(ORDER_HREF);
    expect(off).toContain(`href="/p/${PROJECT_CODE}/orders"`);
    const on = render(<DashboardItemList items={items as never} label="x" empty="" projectCode={PROJECT_CODE} />);
    expect(on).toMatch(ORDER_HREF);

    const view = { activity: [{ key: 'r1', at: '11/24 10:00', actor: '担当', text: 'FSO-RC-1 記録', href: orderPath(PROJECT_CODE, 'FSO-RC-1') }, { key: 'r2', at: '11/24 10:01', actor: '担当', text: '一覧の記録', href: '/orders' }], activityNote: null };
    const actOff = render(<DashboardActivity view={view as never} projectCode={PROJECT_CODE} orderLinks={false} />);
    expect(actOff).toContain('FSO-RC-1 記録');
    expect(actOff).not.toMatch(ORDER_HREF);
    expect(actOff).toContain('href="/p/PRJ-RC/orders"');
    expect(render(<DashboardActivity view={view as never} projectCode={PROJECT_CODE} />)).toMatch(ORDER_HREF);
  });
});
