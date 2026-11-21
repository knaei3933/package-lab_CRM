import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { REQUEST_PATH_HEADER } from './lib/request-path';
import { LAST_PROJECT_COOKIE, LAST_PROJECT_COOKIE_OPTIONS, parseProjectPath } from './lib/project-route';

/**
 * P0 R04/R08: hands the root layout the path being drawn (a server layout
 * cannot read it otherwise), so a screen whose session ended or whose API is
 * down is replaced by the right notice — with 「ログインする」 coming back to
 * this very path — before the screen's own data is asked for. Always
 * overwritten here, so a header a browser sends itself is never trusted.
 *
 * P1 R20: a /p/{案件コード}/… address also remembers that code as the last
 * project opened (LAST_PROJECT_COOKIE). The cookie is a shortcut only — the
 * home screen and the old addresses read it; no write ever does.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(REQUEST_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  const response = NextResponse.next({ request: { headers } });
  const scoped = parseProjectPath(request.nextUrl.pathname);
  if (scoped && request.cookies.get(LAST_PROJECT_COOKIE)?.value !== scoped.projectCode) {
    response.cookies.set(LAST_PROJECT_COOKIE, scoped.projectCode, LAST_PROJECT_COOKIE_OPTIONS);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/|api/|favicon\\.ico).*)']
};
