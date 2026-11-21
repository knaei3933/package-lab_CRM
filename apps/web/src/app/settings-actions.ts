'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { callApi, loadSessionUser } from '../lib/api';
import { refusalState } from '../lib/action-result';
import { isMissingRoute } from '../lib/approval-card';
import { encodeLanguageCookie, isLanguageMode, LANGUAGE_COOKIE, LANGUAGE_LABELS } from '../lib/locale';
import { idempotencyKeyOf } from '../lib/project-context';
import type { ActionState } from '../lib/types';

/**
 * P1 R29 / P2 R29 (contract §5): the signed-in operator's display language.
 * Saved on the server for this user (PUT /api/me/preferences — only the caller's
 * own row), and in the P1 cookie bound to the user id as the fallback the
 * screens read when the server has no choice. Another person on the same browser
 * keeps their own choice: the server value is theirs, and a cookie written for
 * another user id is ignored. It changes what the screens say, never what is
 * recorded (stored values and the audit history are keys).
 */
export async function setLanguageAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const user = await loadSessionUser();
  if (!user) return { ok: false, message: 'ログインの有効期限が切れました。もう一度ログインしてください。', code: 'SESSION_EXPIRED' };
  const mode = formData.get('language');
  if (!isLanguageMode(mode)) return { ok: false, message: '表示言語を選んでください。' };
  const value = encodeLanguageCookie(user.id, mode);
  if (!value) return { ok: false, message: '表示言語を保存できませんでした。もう一度ログインしてください。' };
  const saved = await callApi<{ id?: string; displayLanguage?: string | null }>('/api/me/preferences', {
    method: 'PUT',
    body: { displayLanguage: mode },
    idempotencyKey: idempotencyKeyOf(formData)
  });
  // An API without the route (before P2) keeps the P1 behaviour: the cookie alone.
  const serverless = !saved.ok && isMissingRoute(saved);
  if (!saved.ok && !serverless) return refusalState(saved);
  (await cookies()).set(LANGUAGE_COOKIE, value, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  revalidatePath('/', 'layout');
  return {
    ok: true,
    message: serverless
      ? `表示言語を「${LANGUAGE_LABELS[mode]}」にしました（このブラウザだけに保存）。`
      : `表示言語を「${LANGUAGE_LABELS[mode]}」にしました（ほかの端末でも同じ表示になります）。`
  };
}
