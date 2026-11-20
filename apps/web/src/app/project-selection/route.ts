import { callApi, PROJECT_COOKIE, SESSION_COOKIE } from '../../lib/api';
import type { ProjectSummary } from '../../lib/project-data';
import { decideProjectSelection, safeReturnPath } from '../../lib/project-selection';

/**
 * ui/fix-project-select: writes the screen's project decision into the
 * kanei_web_project cookie and sends the operator back (303). The decision is
 * made again here from the API's own answers — nothing in the address names a
 * project — so a link from elsewhere can at most forget a project this
 * operator cannot open or open the only one they can. `reset=1`
 * (「案件を選び直す」) forgets the remembered project first. `next` is one of
 * the screens (lib/project-selection), never an outside address.
 */
export const dynamic = 'force-dynamic';

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

const ATTRIBUTES = 'Path=/; HttpOnly; SameSite=Lax';

function goTo(location: string, setCookie: string | null): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  if (setCookie) headers.append('set-cookie', setCookie);
  return new Response(null, { status: 303, headers });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeReturnPath(url.searchParams.get('next'));
  const cookieHeader = request.headers.get('cookie');
  const sessionToken = cookieValue(cookieHeader, SESSION_COOKIE);
  if (!sessionToken) return goTo('/', null);

  const me = await callApi('/api/me', { sessionToken });
  if (!me.ok) return goTo(me.status === 401 ? '/' : next, null);

  const stored = cookieValue(cookieHeader, PROJECT_COOKIE);
  const reset = url.searchParams.get('reset') === '1';
  const result = await callApi<{ projects: ProjectSummary[] }>('/api/projects', { sessionToken });
  const list = result.ok && result.data && Array.isArray(result.data.projects)
    ? { projects: result.data.projects, error: null }
    : { projects: [], error: result.error ?? `案件の一覧を取得できませんでした（${result.status}）。` };

  const decision = decideProjectSelection(reset ? null : stored, list);
  let cookie = decision.cookie;
  if (reset && stored && cookie === undefined) cookie = null;
  if (cookie === undefined) return goTo(next, null);
  return goTo(
    next,
    cookie === null
      ? `${PROJECT_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`
      : `${PROJECT_COOKIE}=${encodeURIComponent(cookie)}; ${ATTRIBUTES}`
  );
}
