import { apiBaseUrl, SESSION_COOKIE } from '../../../../lib/api.js';

/**
 * Same-origin logout relay: forwards the session cookie to the API's
 * POST /api/auth/logout (which revokes the session row) and relays the cookie
 * deletion back to the browser.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const cookie = request.headers.get('cookie') ?? '';

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: cookie.length > 0 ? { cookie } : undefined,
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
  for (const cookieHeader of upstream.headers.getSetCookie()) {
    response.headers.append('set-cookie', cookieHeader);
  }
  // Even if the API is unreachable the browser session must end: drop the
  // cookie locally as well.
  if (!upstream.ok) {
    response.headers.append(
      'set-cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
  }
  return response;
}
