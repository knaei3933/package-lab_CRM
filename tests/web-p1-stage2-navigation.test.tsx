import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_PATH, HOME_PATH, navGroupsForRole, navHrefsForRole } from '../apps/web/src/lib/navigation.js';
import { DEFAULT_AFTER_LOGIN, safeReturnPath } from '../apps/web/src/lib/return-path.js';

/** P1 R26: the /home menu item per role, the login default and the anonymous redirect. */
const session = vi.hoisted(() => ({ value: { kind: 'user' } as { kind: string } }));
const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }));
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  loadSession: async () => session.value,
  callApi: async () => ({ ok: false, status: 0, data: null, error: 'x' })
}));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

const homeItems = (role: string | null) => navGroupsForRole(role).flatMap((group) => group.items).filter((item) => item.href === HOME_PATH);

describe('the /home menu item', () => {
  it.each([['admin', '承認箱'], ['staff', '自分の作業'], ['viewer', '履歴']])('%s sees exactly one /home item labelled %s', (role, label) => {
    const items = homeItems(role);
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe(label);
  });

  it.each([[null, '履歴'], [undefined, '履歴'], ['auditor', '履歴']])('an unknown role (%s) sees the viewer item', (role, label) => {
    expect(homeItems(role as never).map((item) => item.label)).toEqual([label]);
  });

  it('/home is the first menu entry of every role, before the dashboard', () => {
    for (const role of ['admin', 'staff', 'viewer']) {
      const hrefs = navHrefsForRole(role);
      expect(hrefs[0]).toBe('/home');
      expect(hrefs.indexOf('/home')).toBeLessThan(hrefs.indexOf(DASHBOARD_PATH));
      expect(hrefs.filter((href) => href === '/home')).toHaveLength(1);
    }
  });

  it('keeps the dashboard for every role', () => {
    for (const role of ['admin', 'staff', 'viewer']) expect(navHrefsForRole(role)).toContain(DASHBOARD_PATH);
  });
});

describe('after login', () => {
  it('DEFAULT_AFTER_LOGIN is /home', () => {
    expect(DEFAULT_AFTER_LOGIN).toBe('/home');
  });

  it('/home is an allowed return path, the login page and API relays are not', () => {
    expect(safeReturnPath('/home')).toBe('/home');
    expect(safeReturnPath('/')).toBeNull();
    expect(safeReturnPath('//evil.example')).toBeNull();
  });
});

describe('app/home/page', () => {
  beforeEach(() => { redirect.mockClear(); });
  const load = async () => (await import('../apps/web/src/app/home/page.js')).default;

  it('redirects an anonymous visitor to the login page', async () => {
    session.value = { kind: 'anonymous' };
    await expect((await load())()).rejects.toThrow('REDIRECT:/');
    expect(redirect).toHaveBeenCalledWith('/');
  });

  it('draws nothing (the layout shows its notice) for any other non-user session', async () => {
    session.value = { kind: 'unavailable' };
    expect(await (await load())()).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('draws the home for a signed-in user', async () => {
    session.value = { kind: 'user' };
    const { HomeScreen } = await import('../apps/web/src/screens/HomeScreen.js');
    const result = await (await load())();
    expect(result).not.toBeNull();
    expect((result as { type: unknown }).type).toBe(HomeScreen);
    expect(redirect).not.toHaveBeenCalled();
  });
});
