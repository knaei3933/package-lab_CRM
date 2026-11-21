'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { loadSessionUser } from '../lib/api';
import { encodeLanguageCookie, isLanguageMode, LANGUAGE_COOKIE, LANGUAGE_LABELS } from '../lib/locale';
import type { ActionState } from '../lib/types';

/**
 * P1 R29: the signed-in operator's display language. Stored for this user only
 * (the cookie carries the user id; another person on the same browser keeps
 * their own default). Nothing is sent to the API — it changes what the screens
 * say, never what is recorded (stored values and the audit history are keys).
 */
export async function setLanguageAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const user = await loadSessionUser();
  if (!user) return { ok: false, message: 'ログインの有効期限が切れました。もう一度ログインしてください。', code: 'SESSION_EXPIRED' };
  const mode = formData.get('language');
  if (!isLanguageMode(mode)) return { ok: false, message: '表示言語を選んでください。' };
  const value = encodeLanguageCookie(user.id, mode);
  if (!value) return { ok: false, message: '表示言語を保存できませんでした。もう一度ログインしてください。' };
  (await cookies()).set(LANGUAGE_COOKIE, value, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  revalidatePath('/', 'layout');
  return { ok: true, message: `表示言語を「${LANGUAGE_LABELS[mode]}」にしました。` };
}
