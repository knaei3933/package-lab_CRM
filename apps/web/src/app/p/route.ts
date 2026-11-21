import { decodeRouteCode, projectPath } from '../../lib/project-route';

export const dynamic = 'force-dynamic';

/**
 * P1 R20: /p?code={案件コード} — the header's project picker without a script
 * (a plain GET form). Only a route code is followed, always to /p/{code}; the
 * project layout then decides whether this operator may open it.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = decodeRouteCode(url.searchParams.get('code') ?? '');
  const location = code ? projectPath(code) : '/dashboard';
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}
