import { headers } from 'next/headers';
import { SessionNotice } from './SessionNotice';
import { SessionRefresh } from './SessionRefresh';
import { noticeForSession } from '../lib/route-gate';
import type { RouteProject } from '../lib/project-route-server';
import { REQUEST_PATH_HEADER } from '../lib/request-path';

/**
 * P4 H8: what a page draws when its route is not open. A lost session shows the
 * login notice with a way back to this very screen (never an empty body under a
 * header that still says the operator is signed in); every other refusal stays
 * the project layout's (nothing here).
 */
export async function RouteGate({ route }: { route: RouteProject }) {
  if (route.kind !== 'no-session') return null;
  const notice = noticeForSession(route.session);
  const path = (await headers()).get(REQUEST_PATH_HEADER) ?? '/';
  return (
    <>
      <SessionNotice kind={notice.kind} path={path} code={notice.code} />
      <SessionRefresh />
    </>
  );
}
