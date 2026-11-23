import { cookies } from 'next/headers';
import { decodeDisplayNameCookie, DISPLAY_NAME_COOKIE } from './session-display';
import type { SessionUser } from './api';

/**
 * P4 N1: who is asking for an assignment. /api/me carries no display name, so the name is the one the
 * web remembered at login (cookie, bound to this user id — the same source as the header's name); without it the
 * request simply has no name line text beyond 「名前なし」 and the 利用者ID still identifies the person.
 */
export async function requesterOf(user: Pick<SessionUser, 'id' | 'role' | 'displayName'>): Promise<{ id: string; role: string; displayName?: string }> {
  const remembered = decodeDisplayNameCookie((await cookies()).get(DISPLAY_NAME_COOKIE)?.value, user.id);
  const name = user.displayName ?? remembered;
  return { id: user.id, role: user.role, ...(name ? { displayName: name } : {}) };
}
