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

describe('M9 (boot) the review H-1 scenario, driven through the installed guard', () => {
  /** A fake browser: a Navigation API target, a history that records every write, a confirm that answers from a script. */
  function fakeBrowser() {
    const handlers: Array<(event: unknown) => void> = [];
    const historyWrites: string[] = [];
    const answers: boolean[] = [];
    const asked: string[] = [];
    const windowListeners: string[] = [];
    (globalThis as { window?: unknown }).window = {
      addEventListener: (type: string) => { windowListeners.push(type); },
      location: { pathname: '/p/R4-A/o/FILM-001', search: '' },
      history: { state: { tree: 'FILM-001' }, pushState: () => historyWrites.push('pushState'), replaceState: () => historyWrites.push('replaceState') },
      navigation: { addEventListener: (type: string, handler: (event: unknown) => void) => { if (type === 'navigate') handlers.push(handler); } },
      confirm: (message: string) => { asked.push(message); return answers.shift() ?? false; }
    };
    (globalThis as { document?: unknown }).document = { addEventListener: () => undefined };
    const traverse = (cancelable = true) => {
      let prevented = false;
      for (const handler of handlers) handler({ navigationType: 'traverse', cancelable, preventDefault: () => { prevented = true; } });
      return prevented;
    };
    return { answers, asked, historyWrites, windowListeners, traverse, handlerCount: () => handlers.length };
  }

  it('Back → いいえ → Back → はい → Forward: the first is cancelled before anything changes, later ones pass, the history is never written', async () => {
    vi.resetModules();
    const browser = fakeBrowser();
    try {
      await import('../apps/web/src/components/UnsavedGuardBoot.js');
      const guard = await import('../apps/web/src/lib/unsaved-guard.js');
      expect(browser.handlerCount()).toBe(1);
      // No popstate listener at all, so there is no code that runs after the address has changed.
      expect(browser.windowListeners).not.toContain('popstate');
      const form = {};
      guard.markDirty(form, true);
      browser.answers.push(false, true);
      expect(browser.traverse(), 'Back, いいえ').toBe(true);
      expect(guard.hasUnsavedInput(), 'input is kept after 「いいえ」').toBe(true);
      expect(browser.traverse(), 'Back, はい').toBe(false);
      expect(guard.hasUnsavedInput(), 'forgotten after 「はい」').toBe(false);
      expect(browser.traverse(), 'Forward with nothing typed').toBe(false);
      expect(browser.asked).toHaveLength(2);
      expect(browser.historyWrites, 'the guard never writes to the history').toEqual([]);
    } finally {
      delete (globalThis as { window?: unknown }).window;
      delete (globalThis as { document?: unknown }).document;
      vi.resetModules();
    }
    expect(code(readSrc('app/layout.tsx'))).toContain('<UnsavedGuardBoot />');
  });

  it('a traversal the browser does not let the page cancel is not asked about', async () => {
    vi.resetModules();
    const browser = fakeBrowser();
    try {
      await import('../apps/web/src/components/UnsavedGuardBoot.js');
      const guard = await import('../apps/web/src/lib/unsaved-guard.js');
      guard.markDirty({}, true);
      expect(browser.traverse(false)).toBe(false);
      expect(browser.asked).toEqual([]);
    } finally {
      delete (globalThis as { window?: unknown }).window;
      delete (globalThis as { document?: unknown }).document;
      vi.resetModules();
    }
  });

  it('a browser without the Navigation API installs the other guards (beforeunload, links) and no navigate handler', async () => {
    vi.resetModules();
    const listeners: string[] = [];
    (globalThis as { window?: unknown }).window = { addEventListener: (type: string) => listeners.push(`window:${type}`), location: { pathname: '/', search: '' } };
    (globalThis as { document?: unknown }).document = { addEventListener: (type: string) => listeners.push(`document:${type}`) };
    try {
      await import('../apps/web/src/components/UnsavedGuardBoot.js');
      expect(listeners).toEqual(expect.arrayContaining(['window:beforeunload', 'document:click']));
      expect(listeners).not.toContain('window:popstate');
    } finally {
      delete (globalThis as { window?: unknown }).window;
      delete (globalThis as { document?: unknown }).document;
      vi.resetModules();
    }
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
