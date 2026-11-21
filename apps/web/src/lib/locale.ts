/**
 * P1 R29 (REDESIGN §4, policy P-7): the display language, per user.
 * - ja: 日本語 (the default for staff and viewers — their screens do not move).
 * - ja-ko: 日本語＋한국어 — the Japanese text with a small Korean gloss.
 * - ko: 한국어 first, the Japanese business term kept next to it.
 * The default for the representative is ja-ko (the Korean gloss P0 already gave
 * the representative's refusals). The choice is kept in a cookie bound to the
 * user id (a per-user profile column needs a DB migration — reported, §4-2):
 * another person signing in on the same browser gets their own default.
 * Client-safe and pure.
 */
export const LANGUAGE_MODES = ['ja', 'ja-ko', 'ko'] as const;
export type LanguageMode = (typeof LANGUAGE_MODES)[number];

export const LANGUAGE_COOKIE = 'kanei_web_lang';

export const LANGUAGE_LABELS: Readonly<Record<LanguageMode, string>> = {
  ja: '日本語',
  'ja-ko': '日本語＋한국어（併記）',
  ko: '한국어（用語は日本語を併記）'
};

export function isLanguageMode(value: unknown): value is LanguageMode {
  return typeof value === 'string' && (LANGUAGE_MODES as readonly string[]).includes(value);
}

export function defaultLanguageFor(role: string | null | undefined): LanguageMode {
  return role === 'admin' ? 'ja-ko' : 'ja';
}

/** The cookie value: `${userId}.${mode}` (the id keeps one person's choice from another's). */
export function encodeLanguageCookie(userId: string, mode: LanguageMode): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(userId) ? `${userId}.${mode}` : null;
}

/** The mode for this user: their own stored choice, else the role default. */
export function languageFor(cookieValue: string | null | undefined, user: { id: string; role: string } | null): LanguageMode {
  if (!user) return 'ja';
  if (typeof cookieValue === 'string') {
    const dot = cookieValue.lastIndexOf('.');
    const id = cookieValue.slice(0, dot);
    const mode = cookieValue.slice(dot + 1);
    if (dot > 0 && id === user.id && isLanguageMode(mode)) return mode;
  }
  return defaultLanguageFor(user.role);
}

/** Whether the Korean text is shown at all. */
export function showsKorean(mode: LanguageMode): boolean {
  return mode !== 'ja';
}
