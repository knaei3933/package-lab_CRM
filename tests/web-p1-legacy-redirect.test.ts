import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1 R20: old addresses (/orders …) move into the last project's URL; pickLegacyProject. */
const state = vi.hoisted(() => ({
  cookies: {} as Record<string, string>,
  session: { kind: 'user' } as { kind: string },
  projects: [] as Array<{ id: string; code: string; name: string; status: string }>,
  listError: null as string | null
}));
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  loadSession: async () => state.session,
  callApi: async () => ({ ok: false, status: 0, data: null, error: 'x' })
}));
vi.mock('../apps/web/src/lib/project-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/project-data.js')>()),
  loadSelectableProjectList: async () => ({ projects: state.listError ? [] : state.projects, error: state.listError })
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name in state.cookies ? { name, value: state.cookies[name] } : undefined), set: () => undefined })
}));
const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }));
vi.mock('next/navigation', () => ({ redirect }));

const { legacyScreenPage } = await import('../apps/web/src/screens/LegacyScreenRedirect.js');
const { pickLegacyProject } = await import('../apps/web/src/lib/project-route-server.js');
const { LAST_PROJECT_COOKIE } = await import('../apps/web/src/lib/project-route.js');

const A = { id: 'id-a', code: 'PRJ-A', name: 'A', status: 'ACTIVE' };
const B = { id: 'id-b', code: '案件B', name: 'B', status: 'ACTIVE' };

async function target(screen: string, search: Record<string, string | string[] | undefined> = {}): Promise<string | null> {
  try {
    const result = await legacyScreenPage(screen, search);
    expect(result).toBeNull();
    return null;
  } catch (error) {
    const match = /^REDIRECT:(.*)$/.exec((error as Error).message);
    if (!match) throw error;
    return match[1]!;
  }
}

beforeEach(() => {
  state.cookies = {};
  state.session = { kind: 'user' };
  state.projects = [A, B];
  state.listError = null;
  redirect.mockClear();
});

describe('pickLegacyProject', () => {
  it('prefers the last code over the legacy id', () => {
    expect(pickLegacyProject({ lastCode: 'PRJ-A', legacyId: 'id-b' }, [A, B])).toBe(A);
  });

  it('falls back to the legacy id when the last code is not listed', () => {
    expect(pickLegacyProject({ lastCode: 'GONE', legacyId: 'id-b' }, [A, B])).toBe(B);
  });

  it('ignores unknown values and, with several projects, returns null', () => {
    expect(pickLegacyProject({ lastCode: 'GONE', legacyId: 'nope' }, [A, B])).toBeNull();
    expect(pickLegacyProject({ lastCode: null, legacyId: null }, [A, B])).toBeNull();
  });

  it('falls back to the only project when nothing matches', () => {
    expect(pickLegacyProject({ lastCode: 'GONE', legacyId: null }, [B])).toBe(B);
  });

  it('returns null without any project', () => {
    expect(pickLegacyProject({ lastCode: 'PRJ-A', legacyId: 'id-a' }, [])).toBeNull();
  });

  it('does not match a code against another project id or an id against a code', () => {
    expect(pickLegacyProject({ lastCode: 'id-a', legacyId: null }, [A, B])).toBeNull();
    expect(pickLegacyProject({ lastCode: null, legacyId: 'PRJ-A' }, [A, B])).toBeNull();
  });
});

describe('legacyScreenPage', () => {
  it('redirects /orders to /p/{code}/orders when the last-project cookie names a listed project', async () => {
    state.cookies[LAST_PROJECT_COOKIE] = 'PRJ-A';
    expect(await target('orders')).toBe('/p/PRJ-A/orders');
  });

  it('percent-encodes a Japanese code in the target', async () => {
    state.cookies[LAST_PROJECT_COOKIE] = encodeURIComponent('案件B');
    expect(await target('maker-po')).toBe(`/p/${encodeURIComponent('案件B')}/maker-po`);
  });

  it('keeps the query string, including repeated keys', async () => {
    state.cookies[LAST_PROJECT_COOKIE] = 'PRJ-A';
    expect(await target('documents', { download: 'd1', tag: ['a', 'b'], skip: undefined })).toBe('/p/PRJ-A/documents?download=d1&tag=a&tag=b');
  });

  it('redirects to /dashboard when the cookie names a project the operator cannot open', async () => {
    state.cookies[LAST_PROJECT_COOKIE] = 'FOREIGN';
    expect(await target('orders')).toBe('/dashboard');
  });

  it('redirects to /dashboard when there is no cookie and several projects', async () => {
    expect(await target('orders')).toBe('/dashboard');
  });

  it('uses the legacy selection cookie (a project id) when there is no last-project cookie', async () => {
    state.cookies['kanei_web_project'] = 'id-b';
    expect(await target('deliveries')).toBe(`/p/${encodeURIComponent('案件B')}/deliveries`);
  });

  it('an undecodable last-project cookie is ignored', async () => {
    state.cookies[LAST_PROJECT_COOKIE] = 'a%2Fb';
    expect(await target('orders')).toBe('/dashboard');
  });

  it('uses the operator\'s only project without any cookie', async () => {
    state.projects = [A];
    expect(await target('approvals')).toBe('/p/PRJ-A/approvals');
  });

  it('redirects to /dashboard when the project list could not be read', async () => {
    state.cookies[LAST_PROJECT_COOKIE] = 'PRJ-A';
    state.listError = 'down';
    expect(await target('orders')).toBe('/dashboard');
  });

  it('does nothing without a usable session (no redirect, no read)', async () => {
    state.session = { kind: 'none' };
    state.cookies[LAST_PROJECT_COOKIE] = 'PRJ-A';
    expect(await target('orders')).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });
});
