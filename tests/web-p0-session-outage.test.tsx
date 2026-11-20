import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P0 R04 (B4, H8, H9): the web gives up on a stalled API (timeout), tells a
 * lost session from an outage, shows no internal address, and replaces the
 * screen with a notice when there is no usable session.
 */
const cookieJar = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name in cookieJar.values ? { name, value: cookieJar.values[name] } : undefined), set: () => undefined })
}));

const api = await import('../apps/web/src/lib/api.js');
const { sessionGateFor, isPublicScreen, REQUEST_PATH_HEADER } = await import('../apps/web/src/lib/request-path.js');
const { SessionNotice } = await import('../apps/web/src/components/SessionNotice.js');
const { LOGIN_RELAY_TIMEOUT_MS, LOGIN_TIMEOUT_MS, LOGIN_TIMEOUT_MESSAGE } = await import('../apps/web/src/lib/login-messages.js');

const realFetch = globalThis.fetch;
const realTimeout = process.env.KANEI_API_TIMEOUT_MS;

/** A fetch that never answers; it rejects only when the request's AbortSignal fires. */
const stalledFetch = ((_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) reject(init.signal.reason);
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as unknown as typeof fetch;

function expectNoAddress(text: string | null | undefined): void {
  expect(text ?? '').not.toMatch(/https?:/i);
  expect(text ?? '').not.toContain(':3081');
  expect(text ?? '').not.toContain('127.0.0.1');
  expect(text ?? '').not.toContain('localhost');
  expect(text ?? '').not.toContain(api.apiBaseUrl);
}

beforeEach(() => {
  cookieJar.values = {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realTimeout === undefined) delete process.env.KANEI_API_TIMEOUT_MS;
  else process.env.KANEI_API_TIMEOUT_MS = realTimeout;
});

describe('apiTimeoutMs', () => {
  it('defaults to 10 seconds', () => {
    expect(api.apiTimeoutMs({})).toBe(10_000);
  });
  it('reads KANEI_API_TIMEOUT_MS', () => {
    expect(api.apiTimeoutMs({ KANEI_API_TIMEOUT_MS: '250' })).toBe(250);
  });
  it.each(['0', '-5', 'abc', ''])('ignores the unusable value %j', (value) => {
    expect(api.apiTimeoutMs({ KANEI_API_TIMEOUT_MS: value })).toBe(10_000);
  });
});

describe('callApi gives up on a stalled API (R04)', () => {
  it('a fetch that waits for the abort signal ends as a timeout with API_TIMEOUT and no address', async () => {
    process.env.KANEI_API_TIMEOUT_MS = '40';
    globalThis.fetch = stalledFetch;
    const started = Date.now();
    const result = await api.callApi('/api/anything', { sessionToken: 't' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ ok: false, status: 0, failure: 'timeout', code: 'API_TIMEOUT' });
    expect(result.error).toContain('応答していません');
    expectNoAddress(result.error);
    expectNoAddress(result.errorKo);
  });

  it('a body that stalls after the headers also times out', async () => {
    process.env.KANEI_API_TIMEOUT_MS = '40';
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
      })) as unknown as typeof fetch;
    const result = await api.callApi('/api/anything', { sessionToken: 't' });
    expect(result).toMatchObject({ ok: false, failure: 'timeout', code: 'API_TIMEOUT' });
  });

  it('passes an abort signal to every fetch', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await api.callApi('/api/x', { sessionToken: 't' });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it('an unreachable API (connection refused) is API_UNREACHABLE and the text has no address', async () => {
    globalThis.fetch = (async (url: string) => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${url}`);
    }) as unknown as typeof fetch;
    const result = await api.callApi('/api/anything', { sessionToken: 't' });
    expect(result).toMatchObject({ ok: false, status: 0, failure: 'unreachable', code: 'API_UNREACHABLE' });
    expect(result.error).toContain('接続できません');
    expectNoAddress(result.error);
    expectNoAddress(result.errorKo);
  });

  it('a successful answer is unchanged', async () => {
    globalThis.fetch = (async () => new Response('{"id":"a"}', { status: 200 })) as unknown as typeof fetch;
    expect(await api.callApi('/api/x', { sessionToken: 't' })).toMatchObject({ ok: true, status: 200, data: { id: 'a' }, error: null, failure: null });
  });
});

describe('loadSession tells the states apart (R04/R08)', () => {
  it('no session cookie => anonymous, and the API is not asked', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await api.loadSession()).toEqual({ kind: 'anonymous' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('200 => the user', async () => {
    cookieJar.values[api.SESSION_COOKIE] = 'tok';
    globalThis.fetch = (async () => new Response('{"id":"u1","role":"staff"}', { status: 200 })) as unknown as typeof fetch;
    expect(await api.loadSession()).toEqual({ kind: 'user', user: { id: 'u1', role: 'staff' } });
  });

  it('401 => expired (a session that ended, not an outage)', async () => {
    cookieJar.values[api.SESSION_COOKIE] = 'tok';
    globalThis.fetch = (async () => new Response('{"error":"auth","code":"AUTH_REQUIRED"}', { status: 401 })) as unknown as typeof fetch;
    expect(await api.loadSession()).toEqual({ kind: 'expired' });
  });

  it('5xx => unavailable, never expired', async () => {
    cookieJar.values[api.SESSION_COOKIE] = 'tok';
    globalThis.fetch = (async () => new Response('{"error":"boom"}', { status: 503 })) as unknown as typeof fetch;
    const session = await api.loadSession();
    expect(session.kind).toBe('unavailable');
  });

  it('a timeout => unavailable with API_TIMEOUT', async () => {
    cookieJar.values[api.SESSION_COOKIE] = 'tok';
    process.env.KANEI_API_TIMEOUT_MS = '40';
    globalThis.fetch = stalledFetch;
    expect(await api.loadSession()).toEqual({ kind: 'unavailable', code: 'API_TIMEOUT' });
  });

  it('an unreachable API => unavailable with API_UNREACHABLE', async () => {
    cookieJar.values[api.SESSION_COOKIE] = 'tok';
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await api.loadSession()).toEqual({ kind: 'unavailable', code: 'API_UNREACHABLE' });
  });

  it('loadSessionUser is null for every state but a user', async () => {
    expect(await api.loadSessionUser()).toBeNull();
  });
});

describe('sessionGateFor (R04/R08)', () => {
  const kinds = ['user', 'anonymous', 'expired', 'unavailable'] as const;
  const expected: Record<string, Record<(typeof kinds)[number], string>> = {
    '/': { user: 'screen', anonymous: 'screen', expired: 'screen', unavailable: 'outage-notice' },
    '/guide': { user: 'screen', anonymous: 'screen', expired: 'screen', unavailable: 'screen' },
    '/orders': { user: 'screen', anonymous: 'login-notice', expired: 'expired-notice', unavailable: 'outage-notice' }
  };
  for (const [screen, row] of Object.entries(expected)) {
    for (const kind of kinds) {
      it(`${screen} + ${kind} => ${row[kind]}`, () => {
        expect(sessionGateFor(screen, kind)).toBe(row[kind]);
      });
    }
  }

  it('a query string does not change the screen', () => {
    expect(sessionGateFor('/orders?x=1', 'anonymous')).toBe('login-notice');
    expect(sessionGateFor('/guide#top', 'anonymous')).toBe('screen');
    expect(sessionGateFor('/?next=%2Forders', 'anonymous')).toBe('screen');
  });

  it('only / and /guide are public', () => {
    expect(isPublicScreen('/')).toBe(true);
    expect(isPublicScreen('/guide')).toBe(true);
    for (const screen of ['/orders', '/dashboard', '/maker-po', '/documents', '/status', '/guide/x']) expect(isPublicScreen(screen)).toBe(false);
  });
});

describe('middleware hands the layout the path (R04/R08)', () => {
  it('sets the request path header and overwrites one the browser sent', async () => {
    const { middleware } = await import('../apps/web/src/middleware.js');
    const { NextRequest } = await import('next/server.js');
    const response = middleware(new NextRequest('http://web.test/orders?x=1', { headers: { [REQUEST_PATH_HEADER]: '/spoofed' } }));
    const forwarded = response.headers.get('x-middleware-request-' + REQUEST_PATH_HEADER);
    expect(forwarded).toBe('/orders?x=1');
  });
});

describe('login relay upstream timeout (R04)', () => {
  const requestFor = () =>
    new Request('http://web.test/api/auth/login', {
      method: 'POST',
      headers: { host: 'web.test', origin: 'http://web.test', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'u', password: 'p' })
    });

  it('the relay gives up before the form does', () => {
    expect(LOGIN_RELAY_TIMEOUT_MS).toBeLessThan(LOGIN_TIMEOUT_MS);
  });

  it('an upstream that never answers => 504 {code: API_TIMEOUT} and no address in the body', async () => {
    // The relay asks for LOGIN_RELAY_TIMEOUT_MS; the spy fires that timer at once instead of waiting 12 s.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
    try {
      globalThis.fetch = stalledFetch;
      const { POST } = await import('../apps/web/src/app/api/auth/login/route.js');
      const response = await POST(requestFor());
      expect(timeout).toHaveBeenCalledWith(LOGIN_RELAY_TIMEOUT_MS);
      expect(response.status).toBe(504);
      const body = (await response.json()) as { error: string; code: string };
      expect(body.code).toBe('API_TIMEOUT');
      expect(body.error).toBe(LOGIN_TIMEOUT_MESSAGE);
      expectNoAddress(JSON.stringify(body));
      expect(response.headers.getSetCookie()).toEqual([]);
    } finally {
      timeout.mockRestore();
    }
  });

  it('an unreachable upstream => 502 with no address', async () => {
    globalThis.fetch = (async (url: string) => {
      throw new TypeError(`connect ECONNREFUSED ${url}`);
    }) as unknown as typeof fetch;
    const { POST } = await import('../apps/web/src/app/api/auth/login/route.js');
    const response = await POST(requestFor());
    expect(response.status).toBe(502);
    expectNoAddress(JSON.stringify(await response.json()));
  });

  it('a body that stalls after the headers => 504 API_TIMEOUT', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
      })) as unknown as typeof fetch;
    const { POST } = await import('../apps/web/src/app/api/auth/login/route.js');
    const response = await POST(requestFor());
    expect(response.status).toBe(504);
    expect(((await response.json()) as { code: string }).code).toBe('API_TIMEOUT');
  });

  it('a cross-site post is still refused before the API is asked', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { POST } = await import('../apps/web/src/app/api/auth/login/route.js');
    const response = await POST(
      new Request('http://web.test/api/auth/login', {
        method: 'POST',
        headers: { host: 'web.test', origin: 'http://evil.test', 'content-type': 'application/json' },
        body: '{}'
      })
    );
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('logout relay (R04)', () => {
  const logoutRequest = () =>
    new Request('http://web.test/api/auth/logout', { method: 'POST', headers: { cookie: 'kanei_mvp_session=abc', host: 'web.test', origin: 'http://web.test' } });

  it('a network failure still ends the session and the body names no address', async () => {
    globalThis.fetch = (async (url: string) => {
      throw new TypeError(`connect ECONNREFUSED ${url}`);
    }) as unknown as typeof fetch;
    const { POST } = await import('../apps/web/src/app/api/auth/logout/route.js');
    const response = await POST(logoutRequest());
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('API_UNREACHABLE');
    expectNoAddress(body.error);
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('kanei_mvp_session=; '))).toBe(true);
  });

  it('a stalled API does not hold the logout: the timeout ends it and the cookies are dropped', async () => {
    process.env.KANEI_API_TIMEOUT_MS = '40';
    globalThis.fetch = stalledFetch;
    const { POST } = await import('../apps/web/src/app/api/auth/logout/route.js');
    const response = await POST(logoutRequest());
    expect(response.status).toBe(502);
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('kanei_mvp_session=; '))).toBe(true);
  });
});

describe('SessionNotice markup (R04/R08)', () => {
  const now = new Date('2026-11-20T03:00:00.000Z');

  it('outage: no URL or port, says it is not a logout, and offers a reload link to the same path', () => {
    const html = renderToStaticMarkup(<SessionNotice kind="outage" path="/orders?x=1" code="API_UNREACHABLE" now={now} />);
    expectNoAddress(html);
    expect(html).not.toMatch(/:\d{4}/);
    expect(html).toContain('ログアウトしたわけではありません');
    expect(html).toContain('<a class="session-notice-primary" href="/orders?x=1">もう一度読み込む</a>');
    expect(html).toContain('API_UNREACHABLE');
  });

  it('outage by the database says so', () => {
    const html = renderToStaticMarkup(<SessionNotice kind="outage" path="/orders" code="DB_UNAVAILABLE" now={now} />);
    expect(html).toContain('データベース');
  });

  it('outage never carries a login link (it is not a lost session)', () => {
    const html = renderToStaticMarkup(<SessionNotice kind="outage" path="/orders" code="API_TIMEOUT" now={now} />);
    expect(html).not.toContain('ログインする');
    expect(html).not.toContain('/?next=');
  });

  it('expired: a login link that comes back to the same path', () => {
    const html = renderToStaticMarkup(<SessionNotice kind="expired" path="/orders" />);
    expect(html).toContain('ログインの有効期限が切れました');
    expect(html).toContain('href="/?next=%2Forders"');
  });

  it('login (never logged in): a login link back to the path, with the query kept', () => {
    const html = renderToStaticMarkup(<SessionNotice kind="login" path="/maker-po?tab=1" />);
    expect(html).toContain('ログインしてください');
    expect(html).toContain('href="/?next=%2Fmaker-po%3Ftab%3D1"');
  });

  it('a path that is not a screen to come back to links plain to the login page', () => {
    const html = renderToStaticMarkup(<SessionNotice kind="expired" path="//evil.test" />);
    expect(html).toContain('href="/"');
    expect(html).not.toContain('evil.test');
  });
});
