/** P0 R04/R08: the request header middleware.ts sets to the path being drawn. Client-safe. */
export const REQUEST_PATH_HEADER = 'x-kanei-request-path';

/**
 * Screens that are drawn without a session: the login screen and the guide.
 * Every other screen shows the session / outage notice instead of its body
 * when there is no usable session (never a false 「まだありません」, H8).
 */
export function isPublicScreen(path: string): boolean {
  const pathname = pathnameOf(path);
  return pathname === '/' || pathname === '/guide';
}

function pathnameOf(path: string): string {
  return path.split(/[?#]/)[0] || '/';
}

export type SessionGate = 'screen' | 'login-notice' | 'expired-notice' | 'outage-notice';

/** What the layout draws for a path and a session state. Pure. */
export function sessionGateFor(path: string, kind: 'user' | 'anonymous' | 'expired' | 'unavailable'): SessionGate {
  if (kind === 'user') return 'screen';
  // An outage is never shown as a logout (H9): even the login screen says the system is down
  // (the guide stays readable — it needs no data).
  if (kind === 'unavailable') return pathnameOf(path) === '/guide' ? 'screen' : 'outage-notice';
  if (isPublicScreen(path)) return 'screen';
  return kind === 'expired' ? 'expired-notice' : 'login-notice';
}
