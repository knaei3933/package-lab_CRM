import { cookies } from 'next/headers';
import { LANGUAGE_COOKIE, languageFor, languageWithoutSession, showsKorean } from './locale';
import type { LanguageMode } from './locale';

/** P1 R29 / P2: the signed-in operator's display mode (server choice, else their own cookie, else the role default). */
export async function displayLanguage(user: { id: string; role: string; displayLanguage?: string | null | undefined } | null): Promise<{ lang: LanguageMode; showKorean: boolean }> {
  const cookie = (await cookies()).get(LANGUAGE_COOKIE)?.value;
  // p5 R7: without a session the browser's own choice decides (languageWithoutSession), not a hidden default of 'ja'.
  const lang = user ? languageFor(cookie, user) : languageWithoutSession(cookie);
  return { lang, showKorean: showsKorean(lang) };
}
