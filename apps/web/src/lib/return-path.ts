/**
 * P0 R08: the screen to come back to after a new login (`/?next=/orders`).
 * Only a same-site path is ever followed — never another origin, a
 * protocol-relative `//host`, a backslash trick or a control character — so
 * the login page cannot be turned into an open redirect. Client-safe.
 */
export const RETURN_PARAM = 'next';
/** P1 R26: after login, the role's home (承認箱 / 自分の作業 / 履歴). */
export const DEFAULT_AFTER_LOGIN = '/home';

export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 512) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  // The login page itself and the API relays are never a destination.
  if (value === '/' || value.startsWith('/?') || value.startsWith('/api/')) return null;
  return value;
}

/** `/?next=<path>` for a screen, or `/` when the path is not one to come back to. */
export function loginHrefFor(path: string): string {
  const safe = safeReturnPath(path);
  return safe ? `/?${RETURN_PARAM}=${encodeURIComponent(safe)}` : '/';
}
