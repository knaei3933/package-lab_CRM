import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1 R29: the per-user display language — cookie rules, the action, Bilingual / KoGloss. */
const state = vi.hoisted(() => ({ user: { id: 'user-1', role: 'admin' } as { id: string; role: string } | null }));
const cookieSet = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/lib/api.js', () => ({
  SESSION_COOKIE: 'kanei_mvp_session', PROJECT_COOKIE: 'kanei_web_project', apiBaseUrl: 'http://api.test',
  readSessionToken: async () => 'token', readSelectedProjectId: async () => null, loadSessionUser: async () => state.user,
  callApi: async () => ({ ok: false, status: 0, data: null, error: 'x' })
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: cookieSet }) }));
vi.mock('next/cache', () => ({ revalidatePath }));

const locale = await import('../apps/web/src/lib/locale.js');
const { setLanguageAction } = await import('../apps/web/src/app/settings-actions.js');
const { Bilingual } = await import('../apps/web/src/components/Bilingual.js');
const { RenderedContextProvider, KoGloss } = await import('../apps/web/src/components/RenderedContext.js');
const { languageFor, encodeLanguageCookie, defaultLanguageFor, showsKorean, LANGUAGE_COOKIE } = locale;

const ADMIN = { id: 'user-1', role: 'admin' };
const STAFF = { id: 'user-2', role: 'staff' };

describe('languageFor', () => {
  it('defaults to ja-ko for the representative and ja for everyone else', () => {
    expect(languageFor(undefined, ADMIN)).toBe('ja-ko');
    expect(languageFor(undefined, STAFF)).toBe('ja');
    expect(languageFor(null, { id: 'v', role: 'viewer' })).toBe('ja');
    expect(languageFor(undefined, { id: 'x', role: 'weird' })).toBe('ja');
  });

  it('is ja without a user', () => {
    expect(languageFor('user-1.ko', null)).toBe('ja');
  });

  it('uses the user\'s own stored choice', () => {
    expect(languageFor('user-1.ko', ADMIN)).toBe('ko');
    expect(languageFor('user-2.ja-ko', STAFF)).toBe('ja-ko');
    expect(languageFor('user-1.ja', ADMIN)).toBe('ja');
  });

  it('ignores another user\'s cookie (the id must match)', () => {
    expect(languageFor('user-1.ko', STAFF)).toBe('ja');
    expect(languageFor('user-2.ja', ADMIN)).toBe('ja-ko');
  });

  it.each(['user-1.fr', 'user-1.', 'user-1', '.ko', 'ko', '', 'user-1.JA', 'user-1.ko.ko'])('falls back to the default for the bad value %j', (value) => {
    expect(languageFor(value, ADMIN)).toBe('ja-ko');
  });

  it('showsKorean is false only for ja', () => {
    expect([showsKorean('ja'), showsKorean('ja-ko'), showsKorean('ko')]).toEqual([false, true, true]);
    expect(defaultLanguageFor('admin')).toBe('ja-ko');
  });
});

describe('encodeLanguageCookie', () => {
  it('joins the user id and the mode', () => {
    expect(encodeLanguageCookie('user-1', 'ko')).toBe('user-1.ko');
  });
  it.each(['', 'a.b', 'a b', 'a/b', 'a;b', 'x'.repeat(65), 'ユーザー'])('rejects the user id %j', (id) => {
    expect(encodeLanguageCookie(id, 'ja')).toBeNull();
  });
  it('round-trips through languageFor', () => {
    expect(languageFor(encodeLanguageCookie('user-1', 'ko'), ADMIN)).toBe('ko');
  });
});

describe('setLanguageAction', () => {
  const form = (mode?: string) => { const data = new FormData(); if (mode !== undefined) data.set('language', mode); return data; };
  beforeEach(() => { state.user = { ...ADMIN }; cookieSet.mockReset(); revalidatePath.mockReset(); });

  it('refuses without a session (SESSION_EXPIRED) and sets no cookie', async () => {
    state.user = null;
    const result = await setLanguageAction(null, form('ko'));
    expect(result).toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'fr', 'JA', 'ko; Path=/x'])('refuses the mode %j and sets no cookie', async (mode) => {
    const result = await setLanguageAction(null, form(mode));
    expect(result.ok).toBe(false);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it('sets the cookie bound to the user id and refreshes the layout', async () => {
    const result = await setLanguageAction(null, form('ko'));
    expect(result.ok).toBe(true);
    expect(cookieSet).toHaveBeenCalledTimes(1);
    const [name, value, options] = cookieSet.mock.calls[0]!;
    expect(name).toBe(LANGUAGE_COOKIE);
    expect(name).toBe('kanei_web_lang');
    expect(value).toBe('user-1.ko');
    expect(options).toMatchObject({ path: '/', httpOnly: true, sameSite: 'lax' });
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('refuses a user whose id cannot be stored in the cookie', async () => {
    state.user = { id: 'bad id', role: 'staff' };
    expect((await setLanguageAction(null, form('ja'))).ok).toBe(false);
    expect(cookieSet).not.toHaveBeenCalled();
  });
});

describe('Bilingual and KoGloss per mode', () => {
  const ctx = (lang: 'ja' | 'ja-ko' | 'ko') => ({ projectId: 'p', showKorean: lang !== 'ja', lang });
  const bilingual = (lang: 'ja' | 'ja-ko' | 'ko') => renderToStaticMarkup(<RenderedContextProvider value={ctx(lang)}><Bilingual ja="金額" ko="금액" /></RenderedContextProvider>);
  const gloss = (value: ReturnType<typeof ctx> | null, ko: string | null) => renderToStaticMarkup(
    value ? <RenderedContextProvider value={value}><KoGloss ko={ko} /></RenderedContextProvider> : <KoGloss ko={ko} />
  );

  it('ja: Japanese only', () => { expect(bilingual('ja')).toBe('金額'); });
  it('ja-ko: Japanese with a lang="ko" gloss after it', () => {
    expect(bilingual('ja-ko')).toBe('金額<span class="p1-ko" lang="ko">금액</span>');
  });
  it('ko: Korean first, the Japanese business term kept next to it', () => {
    const html = bilingual('ko');
    expect(html).toBe('<span lang="ko">금액</span><span class="p1-ja">金額</span>');
    expect(html.indexOf('금액')).toBeLessThan(html.indexOf('金額'));
  });
  it('KoGloss shows the gloss in ja-ko and ko, never in ja', () => {
    expect(gloss(ctx('ja'), '초안')).toBe('');
    expect(gloss(ctx('ja-ko'), '초안')).toBe('<span class="p1-ko" lang="ko">초안</span>');
    expect(gloss(ctx('ko'), '초안')).toContain('초안');
  });
  it('KoGloss shows nothing for an empty gloss or without a context', () => {
    expect(gloss(ctx('ko'), null)).toBe('');
    expect(gloss(ctx('ko'), '')).toBe('');
    expect(gloss(null, '초안')).toBe('');
  });
});

describe('the layout wires the mode', () => {
  const layout = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src/app/layout.tsx'), 'utf8');
  it('sets <html lang> to ko only in the Korean mode', () => {
    expect(layout).toContain("<html lang={display.lang === 'ko' ? 'ko' : 'ja'}");
  });
  it('links 表示言語 to /settings', () => {
    expect(layout).toContain('href="/settings"');
    expect(layout).toContain('表示言語');
  });
});
