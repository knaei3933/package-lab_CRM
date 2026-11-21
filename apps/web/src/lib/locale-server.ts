import { cookies } from 'next/headers';
import { LANGUAGE_COOKIE, languageFor, showsKorean } from './locale';
import type { LanguageMode } from './locale';

/** P1 R29 / P2: the signed-in operator's display mode (server choice, else their own cookie, else the role default). */
export async function displayLanguage(user: { id: string; role: string; displayLanguage?: string | null | undefined } | null): Promise<{ lang: LanguageMode; showKorean: boolean }> {
  const lang = languageFor((await cookies()).get(LANGUAGE_COOKIE)?.value, user);
  return { lang, showKorean: showsKorean(lang) };
}
