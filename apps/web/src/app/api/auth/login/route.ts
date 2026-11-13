import { apiBaseUrl } from '../../../../lib/api';

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
  return response;
}
