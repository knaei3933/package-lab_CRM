import { cookies } from 'next/headers';
import { LANGUAGE_COOKIE, languageFor, showsKorean } from './locale';
import type { LanguageMode } from './locale';

/** P1 R29: the signed-in operator's display mode (their own cookie, else the role default). */
export async function displayLanguage(user: { id: string; role: string } | null): Promise<{ lang: LanguageMode; showKorean: boolean }> {
  const lang = languageFor((await cookies()).get(LANGUAGE_COOKIE)?.value, user);
  return { lang, showKorean: showsKorean(lang) };
}
