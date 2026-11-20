import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { REQUEST_PATH_HEADER } from './lib/request-path';

/**
 * P0 R04/R08: hands the root layout the path being drawn (a server layout
 * cannot read it otherwise), so a screen whose session ended or whose API is
 * down is replaced by the right notice — with 「ログインする」 coming back to
 * this very path — before the screen's own data is asked for. Always
 * overwritten here, so a header a browser sends itself is never trusted.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(REQUEST_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/|api/|favicon\\.ico).*)']
};
