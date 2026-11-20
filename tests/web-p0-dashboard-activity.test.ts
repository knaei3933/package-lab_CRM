import { describe, expect, it, vi } from 'vitest';

/**
 * P0 review M3: the dashboard's recent activity reads the newest work rows —
 * order=desc and the read rows (DOCUMENT_VERSION_VIEWED / _DOWNLOADED) left out
 * by the API — so piled-up reads never push the latest work out of the window.
 */
const paths = vi.hoisted(() => [] as string[]);
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => 'project-a',
  loadSession: async () => ({ kind: 'anonymous' }),
  loadSessionUser: async () => null,
  callApi: async (path: string) => {
    paths.push(path);
    if (path.includes('/audit-history?limit=500&order=desc')) {
      return { ok: true, status: 200, data: { events: [{ id: 'new', action: 'X', occurredAt: '2026-11-20T09:00:00Z' }, { id: 'old', action: 'X', occurredAt: '2026-11-20T08:00:00Z' }] }, error: null };
    }
    return { ok: true, status: 200, data: { events: [] }, error: null };
  }
}));
vi.mock('../apps/web/src/lib/maker-po-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/maker-po-data.js')>()),
  loadMakerPoBoard: async () => ({ workspace: { filmOrders: [] }, boards: [] }),
  loadMakerPaperCleanup: async () => ({})
}));

const { loadDashboardData } = await import('../apps/web/src/lib/dashboard-data.js');

describe('dashboard activity read', () => {
  it('asks newest first without read rows, and hands the rows on oldest first', async () => {
    const data = await loadDashboardData('project-a');
    const activityPath = paths.find((path) => path.includes('/audit-history'))!;
    expect(activityPath).toContain('order=desc');
    expect(decodeURIComponent(activityPath)).toContain('excludeAction=DOCUMENT_VERSION_VIEWED,DOCUMENT_VERSION_DOWNLOADED');
    expect(data.activity?.map((event) => event.id)).toEqual(['old', 'new']);
  });
});
