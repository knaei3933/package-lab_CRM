import { apiBaseUrl, SESSION_COOKIE } from '../../../../lib/api';
import { DISPLAY_NAME_COOKIE, encodeDisplayNameCookie, sessionCookieAttributes } from '../../../../lib/session-display';

/**
 * Same-origin login relay (criterion 1). The browser posts its credentials to
 * POST /api/auth/login here; this handler posts them to the API's own
 * POST /api/auth/login at KANEI_API_BASE_URL and relays the response together
 * with the API's Set-Cookie, so the kanei_mvp_session cookie the API issued
 * keeps working for every later server-side call (apps/web runs on another
 * port, and the API serves no CORS headers by design).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { username?: unknown; password?: unknown }
    | null;

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: body?.username, password: body?.password }),
      cache: 'no-store'
    });
  } catch {
    return Response.json(
      { error: `API（${apiBaseUrl}）に接続できません。APIの起動を確認してください。` },
      { status: 502 }
    );
  }

  const payload = await upstream.text();
  const response = new Response(payload, {
    status: upstream.status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
  for (const cookie of upstream.headers.getSetCookie()) {
    response.headers.append('set-cookie', cookie);
  }
  // UI batch A: remember the operator's name for the header (display only —
  // GET /api/me answers no name). Bound to the user id the API returned.
  if (upstream.ok) {
    let answer: { id?: unknown; displayName?: unknown } | null = null;
    try {
      answer = JSON.parse(payload) as { id?: unknown; displayName?: unknown };
    } catch {
      answer = null;
    }
    const remembered = encodeDisplayNameCookie(answer?.id, answer?.displayName || body?.username);
    const sessionCookie = upstream.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
    if (remembered && sessionCookie) {
      response.headers.append(
        'set-cookie',
        `${DISPLAY_NAME_COOKIE}=${remembered}; Path=/; HttpOnly; SameSite=Lax${sessionCookieAttributes(sessionCookie)}`
      );
    }
  }
  return response;
}
