import { apiBaseUrl, SESSION_COOKIE } from '../../../../lib/api';
import { DISPLAY_NAME_COOKIE, encodeDisplayNameCookie, sessionCookieAttributes } from '../../../../lib/session-display';
import {
  CROSS_SITE_REFUSAL,
  isJsonRequest,
  isSameOriginPost,
  LOGIN_UNAVAILABLE_MESSAGE,
  loginRefusal,
  loginRelayHeaders,
  trustedClientAddress
} from '../../../../lib/login-relay';

/**
 * Same-origin login relay (criterion 1). The browser posts its credentials to
 * POST /api/auth/login here; this handler posts them to the API's own
 * POST /api/auth/login at KANEI_API_BASE_URL and relays the response together
 * with the API's Set-Cookie, so the kanei_mvp_session cookie the API issued
 * keeps working for every later server-side call (apps/web runs on another
 * port, and the API serves no CORS headers by design).
 *
 * UI batch F (lib/login-relay): a cross-site or non-JSON post is refused
 * before the API is asked; the browser address recorded by the trusted reverse
 * proxy — and only that — is sent as the API's X-Forwarded-For; a refusal is
 * answered with one fixed Japanese sentence per status (the lockout keeps its
 * code, the remaining wait and Retry-After).
 */
export const dynamic = 'force-dynamic';

function refusal(status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...extraHeaders } });
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginPost(request) || !isJsonRequest(request)) {
    return refusal(403, { error: CROSS_SITE_REFUSAL, code: 'CSRF_ORIGIN_REJECTED' });
  }
  const body = (await request.json().catch(() => null)) as
    | { username?: unknown; password?: unknown }
    | null;

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: loginRelayHeaders(trustedClientAddress(request.headers)),
      body: JSON.stringify({ username: body?.username, password: body?.password }),
      cache: 'no-store'
    });
  } catch {
    // The API address is configuration, not something an anonymous visitor needs.
    return refusal(502, { error: LOGIN_UNAVAILABLE_MESSAGE });
  }

  const payload = await upstream.text();
  if (!upstream.ok) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(payload);
    } catch {
      parsed = null;
    }
    const answer = loginRefusal(upstream.status, parsed, upstream.headers.get('retry-after'));
    return refusal(
      upstream.status >= 500 ? 502 : upstream.status,
      { ...answer },
      answer.retryAfterSeconds !== undefined ? { 'retry-after': String(answer.retryAfterSeconds) } : {}
    );
  }
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
