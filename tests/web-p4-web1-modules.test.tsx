import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4 web 1 — the two checks that need a fresh module registry (vi.resetModules would poison the other file's imports). One
 * describe per item id, each holding a test that fails on the base commit and passes with the fix
 * (mutation evidence: demo-eml/p4-web1/evidence/mutation-*.log). Server rules, amounts and the
 * idempotency semantics are untouched; amounts appear only in the admin-only paths they already had.
 */
const callApi = vi.hoisted(() => vi.fn());
const cookieJar = vi.hoisted(() => ({ headers: {} as Record<string, string> }));
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session',
  PROJECT_COOKIE: 'kanei_web_project',
  apiBaseUrl: 'http://api.test',
  apiTimeoutMs: () => 10_000,
  readSessionToken: async () => 'token',
  readSelectedProjectId: async () => null,
  loadSessionUser: async () => null,
  loadSession: async () => ({ kind: 'user' }),
  callApi: (...args: unknown[]) => callApi(...args)
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
  headers: async () => ({ get: (name: string) => cookieJar.headers[name.toLowerCase()] ?? null })
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  usePathname: () => '/p/PRJ-1/o/FSO-1',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams()
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src');
const readSrc = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('M9 (boot) the guard is on the page before the router\'s own popstate listener', () => {
  it('the root layout\'s boot module registers popstate (capture) as it loads — before the router\'s own listener exists (live finding)', async () => {
    vi.resetModules();
    const registered: Array<{ target: string; type: string; capture: boolean }> = [];
    const recorder = (target: string) => (type: string, _listener: unknown, options?: boolean | { capture?: boolean }) => {
      registered.push({ target, type, capture: options === true || (typeof options === 'object' && options?.capture === true) });
    };
    (globalThis as { window?: unknown }).window = { addEventListener: recorder('window'), location: { pathname: '/', search: '' } };
    (globalThis as { document?: unknown }).document = { addEventListener: recorder('document') };
    try {
      await import('../apps/web/src/components/UnsavedGuardBoot.js');
      expect(registered).toContainEqual({ target: 'window', type: 'popstate', capture: true });
      expect(registered.map((entry) => `${entry.target}:${entry.type}`)).toEqual(expect.arrayContaining(['window:beforeunload', 'document:click']));
    } finally {
      delete (globalThis as { window?: unknown }).window;
      delete (globalThis as { document?: unknown }).document;
      vi.resetModules();
    }
    expect(code(readSrc('app/layout.tsx'))).toContain('<UnsavedGuardBoot />');
  });

});

describe('H8 (page) a page called for a closed route', () => {
  it('a page called for an expired session returns the gate element (the T-4 client-navigation case)', async () => {
    vi.resetModules();
    vi.doMock('../apps/web/src/lib/project-route-server.js', () => ({
      resolveRouteProject: async () => ({ kind: 'no-session', session: { kind: 'expired' } })
    }));
    const page = await import('../apps/web/src/app/p/[project]/orders/page.js');
    const element = await page.default({ params: Promise.resolve({ project: 'PRJ-1' }) });
    expect(element).not.toBeNull();
    const { RouteGate } = await import('../apps/web/src/components/RouteGate.js');
    expect((element as { type: unknown }).type).toBe(RouteGate);
    vi.doUnmock('../apps/web/src/lib/project-route-server.js');
  });
});
