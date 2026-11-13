import { cookies } from 'next/headers';

/**
 * M6 operator UI: the only place apps/web talks to the API. Every call is a
 * server-side fetch to KANEI_API_BASE_URL (default http://127.0.0.1:3081) that
 * forwards the API's own session cookie, so the browser never needs CORS or a
 * second credential: it holds the kanei_mvp_session cookie issued by the API
 * (relayed by the /api/auth/* route handlers) and this module replays it.
 */
export const SESSION_COOKIE = 'kanei_mvp_session';

/** Cookie that remembers which project the operator is working on. */
export const PROJECT_COOKIE = 'kanei_web_project';

export const apiBaseUrl = process.env.KANEI_API_BASE_URL ?? 'http://127.0.0.1:3081';

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function readSelectedProjectId(): Promise<string | null> {
  const store = await cookies();
  return store.get(PROJECT_COOKIE)?.value ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * One API call with the session cookie attached. Upstream Japanese error
 * messages are passed through verbatim so the screens can show the API's own
 * wording instead of inventing a second vocabulary.
 */
export async function callApi<T>(
  path: string,
  options: { method?: string; body?: unknown; sessionToken?: string | null } = {}
): Promise<ApiResult<T>> {
  const token = options.sessionToken !== undefined
    ? options.sessionToken
    : await readSessionToken();
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `${SESSION_COOKIE}=${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store'
    });
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      error: `API（${apiBaseUrl}）に接続できません。APIの起動を確認してください。`
    };
  }

  const raw = await response.text();
  let data: unknown = null;
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  const upstreamError = isRecord(data) && typeof data.error === 'string' ? data.error : null;
  return {
    ok: response.ok,
    status: response.status,
    data: (data as T) ?? null,
    error: response.ok
      ? null
      : upstreamError ?? `APIがステータス ${response.status} を返しました。`
  };
}

export interface SessionUser {
  id: string;
  role: string;
  displayName?: string;
  assignedProjectIds?: string[];
}

export async function loadSessionUser(): Promise<SessionUser | null> {
  const result = await callApi<SessionUser>('/api/me');
  return result.ok && result.data ? result.data : null;
}
