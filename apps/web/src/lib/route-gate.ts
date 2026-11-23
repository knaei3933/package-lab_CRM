import type { SessionState } from './api';

/**
 * P4 H8: what a project screen shows when its route cannot open. Moving to a
 * screen from the sidebar (a client-side navigation) does not draw the root
 * layout again, so the gate that replaces the screen with a notice cannot be the
 * layout's alone: every page asks it too. Pure.
 *
 * Only a missing session has a body of its own here; 「案件が見つかりません」 and a
 * failed project list are the project layout's, which wraps every page.
 */
/** The three notices of components/SessionNotice (kept here so lib/ does not import a .tsx file). */
export type RouteGateNoticeKind = 'login' | 'expired' | 'outage';

export interface RouteGateNotice {
  kind: RouteGateNoticeKind;
  /** The outage's reference code (only for kind 'outage'). */
  code: string | null;
}

type NoSession = Exclude<SessionState, { kind: 'user' }>;

export function noticeForSession(session: NoSession): RouteGateNotice {
  if (session.kind === 'expired') return { kind: 'expired', code: null };
  if (session.kind === 'unavailable') return { kind: 'outage', code: session.code };
  return { kind: 'login', code: null };
}
