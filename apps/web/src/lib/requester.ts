import { cookies } from 'next/headers';
import { decodeDisplayNameCookie, DISPLAY_NAME_COOKIE } from './session-display';
import type { SessionUser } from './api';

/**
 * P4 N1: who is asking for an assignment. p4/web3 (d): the name is the session's own (GET /api/me
 * displayName, server2 §1(3) — read on every request, so a renamed user shows the new name); the name the
 * web remembered at login (cookie, bound to this user id) is only the fallback of an older API, and without
 * either the request says 「名前なし」 and the 利用者ID still identifies the person.
 */
export async function requesterOf(user: Pick<SessionUser, 'id' | 'role' | 'displayName'>): Promise<{ id: string; role: string; displayName?: string }> {
  const remembered = decodeDisplayNameCookie((await cookies()).get(DISPLAY_NAME_COOKIE)?.value, user.id);
  // /api/me's own name first (null or blank on an account without one → the remembered name).
  const own = typeof user.displayName === 'string' && user.displayName.trim().length > 0 ? user.displayName.trim() : null;
  const name = own ?? remembered;
  return { id: user.id, role: user.role, ...(name ? { displayName: name } : {}) };
}
