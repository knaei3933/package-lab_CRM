import { apiBaseUrl, apiTimeoutMs, PROJECT_COOKIE, SESSION_COOKIE } from '../../../../lib/api';
import { webErrorText } from '../../../../lib/error-dictionary';
import { DISPLAY_NAME_COOKIE } from '../../../../lib/session-display';
import { CROSS_SITE_REFUSAL, isSameOriginPost } from '../../../../lib/login-relay';
import { LAST_PROJECT_COOKIE } from '../../../../lib/project-route';

/**
 * Same-origin logout relay: forwards the session cookie to the API's
 * POST /api/auth/logout (which revokes the session row) and relays the cookie
 * deletion back to the browser.
 *
 * UI batch F (review M3): a post another site drives is refused before the
 * session is touched (lib/login-relay isSameOriginPost).
 */
export const dynamic = 'force-dynamic';

const CLEARED_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
const CLEARED_DISPLAY_NAME_COOKIE = `${DISPLAY_NAME_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
// ui/fix-project-select: the next person to sign in on this browser starts without
// the previous operator's project (it may not be one they can open).
const CLEARED_PROJECT_COOKIE = `${PROJECT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
// P1 R20: the last project opened (the home shortcut) is the previous operator's too.
const CLEARED_LAST_PROJECT_COOKIE = `${LAST_PROJECT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginPost(request)) {
    return Response.json(
      { error: CROSS_SITE_REFUSAL, code: 'CSRF_ORIGIN_REJECTED' },
      { status: 403, headers: { 'cache-control': 'no-store' } }
    );
  }
  const cookie = request.headers.get('cookie') ?? '';

  let upstream: Response;
  try {
    const headers: Record<string, string> = {};
    if (cookie.length > 0) headers.cookie = cookie;
    upstream = await fetch(`${apiBaseUrl}/api/auth/logout`, {
      method: 'POST',
      headers,
      cache: 'no-store',
      // P0 R04: the logout never waits on a stalled API (the cookies are dropped regardless).
      signal: AbortSignal.timeout(apiTimeoutMs())
    });
  } catch {
    // The API is unreachable, but the browser session must still end: the
    // 502 answer drops both cookies locally (the body and status are as before).
    const unreachable = Response.json(
      // P0 R04 (H9): no internal address on screen.
      { error: webErrorText('API_UNREACHABLE').message, code: 'API_UNREACHABLE' },
      { status: 502 }
    );
    unreachable.headers.append('set-cookie', CLEARED_SESSION_COOKIE);
    unreachable.headers.append('set-cookie', CLEARED_DISPLAY_NAME_COOKIE);
    unreachable.headers.append('set-cookie', CLEARED_PROJECT_COOKIE);
    unreachable.headers.append('set-cookie', CLEARED_LAST_PROJECT_COOKIE);
    return unreachable;
  }

  const payload = await upstream.text().catch(() => '');
  const response = new Response(payload, {
    status: upstream.status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
  for (const cookieHeader of upstream.headers.getSetCookie()) {
    response.headers.append('set-cookie', cookieHeader);
  }
  // Even if the API answers with an error the browser session must end: drop
  // the cookie locally as well.
  if (!upstream.ok) {
    response.headers.append('set-cookie', CLEARED_SESSION_COOKIE);
  }
  response.headers.append('set-cookie', CLEARED_DISPLAY_NAME_COOKIE);
  response.headers.append('set-cookie', CLEARED_PROJECT_COOKIE);
  response.headers.append('set-cookie', CLEARED_LAST_PROJECT_COOKIE);
  return response;
}
