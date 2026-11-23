/**
 * P1 R29 (REDESIGN §4, policy P-7): the display language, per user.
 * - ja: 日本語 (the default for staff and viewers — their screens do not move).
 * - ja-ko: 日本語＋한국어 — the Japanese text with a small Korean gloss.
 * - ko: 한국어 first, the Japanese business term kept next to it.
 * The default for the representative is ja-ko (the Korean gloss P0 already gave
 * the representative's refusals).
 * P2 R29 (contract §5): the choice is stored on the server per user
 * (GET /api/me displayLanguage, PUT /api/me/preferences). The P1 cookie bound to
 * the user id stays as the fallback: it is read only when the server has no
 * choice for this user (null) or does not answer the field (an older API), and a
 * cookie written for another user id is never read — another person signing in
 * on the same browser gets their own choice or default.
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

/**
 * The mode for this user: the server's stored choice, else their own cookie
 * (bound to their id), else the role default.
 */
export function languageFor(
  cookieValue: string | null | undefined,
  user: { id: string; role: string; displayLanguage?: string | null | undefined } | null
): LanguageMode {
  if (!user) return 'ja';
  if (isLanguageMode(user.displayLanguage)) return user.displayLanguage;
  if (typeof cookieValue === 'string') {
    const dot = cookieValue.lastIndexOf('.');
    const id = cookieValue.slice(0, dot);
    const mode = cookieValue.slice(dot + 1);
    if (dot > 0 && id === user.id && isLanguageMode(mode)) return mode;
  }
  return defaultLanguageFor(user.role);
}

/**
 * p5 R7: with no session there is no user to check the cookie against, so the mode the browser kept is read as it is
 * (`${userId}.${mode}`): the notices of a lost session follow the language their reader chose, and with no cookie they are Japanese only.
 */
export function languageWithoutSession(cookieValue: string | null | undefined): LanguageMode {
  if (typeof cookieValue !== 'string') return 'ja';
  const dot = cookieValue.lastIndexOf('.');
  const mode = cookieValue.slice(dot + 1);
  return dot > 0 && isLanguageMode(mode) ? mode : 'ja';
}

/** Whether the Korean text is shown at all. */
export function showsKorean(mode: LanguageMode): boolean {
  return mode !== 'ja';
}
