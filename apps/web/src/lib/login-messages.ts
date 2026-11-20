/**
 * UI batch F: the login answers the relay writes and the login form reads.
 * Client-safe (no Node imports): app/api/auth/login/route.ts builds the
 * refusal, components/LoginForm.tsx counts the lockout down with waitText.
 */

export const CROSS_SITE_REFUSAL = '別のサイトからの送信は受け付けられません。この画面からもう一度操作してください。';

export const LOGIN_LOCKED_CODE = 'LOGIN_TEMPORARILY_LOCKED';
export const LOGIN_INVALID_MESSAGE = 'ユーザー名またはパスワードが正しくありません。';
export const LOGIN_EMPTY_MESSAGE = 'ユーザー名とパスワードを入力してください。';
export const LOGIN_UNAVAILABLE_MESSAGE = 'ログインできませんでした。時間をおいてもう一度お試しください。';

/**
 * P0 R04 (B4): the login form gives up after 15 s; the relay asks the API for
 * at most LOGIN_RELAY_TIMEOUT_MS so it can still answer in Japanese first.
 */
export const LOGIN_TIMEOUT_MS = 15_000;
export const LOGIN_RELAY_TIMEOUT_MS = 12_000;
export const LOGIN_TIMEOUT_MESSAGE = 'システムが応答していないため、ログインできませんでした。数分後にもう一度お試しください。急ぎの場合は代表者へ連絡してください。';

/** 「約3分20秒」-style wait, rounded up to whole seconds; 1 hour is the API's cap. */
export function waitText(seconds: number): string {
  const total = Math.max(1, Math.ceil(seconds));
  if (total < 60) return `${total}秒`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}時間${minutes}分` : `${hours}時間`;
  return rest > 0 ? `${minutes}分${rest}秒` : `${minutes}分`;
}

/**
 * The lockout sentence. It names neither the account nor whether it exists —
 * the same words for every username (the API locks unknown names alike).
 */
export function lockedMessage(retryAfterSeconds: number | null): string {
  const wait = retryAfterSeconds !== null ? `約${waitText(retryAfterSeconds)}後に` : 'しばらくしてから';
  return `ログインの失敗が続いたため、一時的にログインを受け付けていません。${wait}もう一度お試しください。`;
}

export interface LoginRefusal {
  error: string;
  code?: string;
  retryAfterSeconds?: number;
}

function retryAfterFrom(payload: unknown, header: string | null): number | null {
  const fromBody = typeof payload === 'object' && payload !== null
    ? (payload as { retryAfterSeconds?: unknown }).retryAfterSeconds
    : undefined;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const fromHeader = header === null ? NaN : Number(header);
  return Number.isFinite(fromHeader) && fromHeader > 0 ? Math.ceil(fromHeader) : null;
}

/** The fixed refusal for an upstream non-2xx answer (never the upstream text). */
export function loginRefusal(status: number, payload: unknown, retryAfterHeader: string | null = null): LoginRefusal {
  const code = typeof payload === 'object' && payload !== null && typeof (payload as { code?: unknown }).code === 'string'
    ? (payload as { code: string }).code
    : null;
  if (status === 429 || code === LOGIN_LOCKED_CODE) {
    const retryAfterSeconds = retryAfterFrom(payload, retryAfterHeader);
    return {
      error: lockedMessage(retryAfterSeconds),
      code: LOGIN_LOCKED_CODE,
      ...(retryAfterSeconds !== null ? { retryAfterSeconds } : {})
    };
  }
  if (status === 401) return { error: LOGIN_INVALID_MESSAGE };
  if (status === 400) return { error: LOGIN_EMPTY_MESSAGE };
  if (status === 403 && code === 'CSRF_ORIGIN_REJECTED') return { error: CROSS_SITE_REFUSAL, code };
  return { error: LOGIN_UNAVAILABLE_MESSAGE };
}
