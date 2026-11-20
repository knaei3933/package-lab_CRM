import { cookies } from 'next/headers';
import { cache } from 'react';
import { describeApiFailure } from './error-dictionary';
import type { ApiFailureKind } from './error-dictionary';

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

/**
 * P0 R04: every web→API call gives up after this long (AbortSignal.timeout), so
 * a stalled API or database is reported instead of waited on forever (B4).
 * KANEI_API_TIMEOUT_MS overrides it (tests, slow hosts); 10 s is the starting
 * value from REDESIGN_PROPOSAL §7-2.
 */
export const DEFAULT_API_TIMEOUT_MS = 10_000;

export function apiTimeoutMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const configured = Number(env.KANEI_API_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_API_TIMEOUT_MS;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Operator text (lib/error-dictionary): never the API address, an enum or an English core message. */
  error: string | null;
  /** The Korean auxiliary sentence for `error`, when the dictionary has one. */
  errorKo?: string | null;
  /** The API's refusal code, or the web code of a failure (API_TIMEOUT / API_UNREACHABLE). */
  code?: string | null;
  /** Set when no HTTP answer arrived: the call timed out or the API could not be reached. */
  failure?: ApiFailureKind | null;
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
 * One API call with the session cookie attached. P0 R09: a refusal's text
 * comes from lib/error-dictionary by its code (the API's English core
 * messages, enum values and this process's API address never reach a screen).
 */
export async function callApi<T>(
  path: string,
  options: { method?: string; body?: unknown; sessionToken?: string | null; idempotencyKey?: string | undefined } = {}
): Promise<ApiResult<T>> {
  const token = options.sessionToken !== undefined
    ? options.sessionToken
    : await readSessionToken();
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `${SESSION_COOKIE}=${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  // P0 R05: a write's per-submit key (the API replays the first answer to a repeat).
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  let response: Response;
  let raw: string;
  try {
    const init: RequestInit & { headers: Record<string, string> } = {
      method: options.method ?? 'GET',
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(apiTimeoutMs())
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    response = await fetch(`${apiBaseUrl}${path}`, init);
    // The body is read under the same signal: an answer that stalls mid-body times out too.
    raw = await response.text();
  } catch (error) {
    return failureResult(isTimeout(error) ? 'timeout' : 'unreachable');
  }

  let data: unknown = null;
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (response.ok) return { ok: true, status: response.status, data: (data as T) ?? null, error: null, code: null, failure: null };
  const code = isRecord(data) && typeof data.code === 'string' ? data.code : null;
  const upstreamError = isRecord(data) && typeof data.error === 'string' ? data.error : null;
  const text = describeApiFailure({ status: response.status, code, apiMessage: upstreamError });
  return {
    ok: false,
    status: response.status,
    data: (data as T) ?? null,
    error: text.message,
    errorKo: text.messageKo,
    // A lost session reads the same for every API code it comes with (AUTH_REQUIRED…).
    code: response.status === 401 ? 'SESSION_EXPIRED' : code ?? text.code,
    failure: null
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function failureResult<T>(failure: ApiFailureKind): ApiResult<T> {
  const text = describeApiFailure({ status: 0, code: null, apiMessage: null, failure });
  return { ok: false, status: 0, data: null, error: text.message, errorKo: text.messageKo, code: text.code, failure };
}

export interface SessionUser {
  id: string;
  role: string;
  displayName?: string;
  assignedProjectIds?: string[];
}

/**
 * P0 R04/R08: what the session cookie amounts to, told apart — the layout shows
 * a different screen for each (H8, H9):
 * - anonymous: no session cookie at all (never logged in here, or logged out);
 * - expired: the API answered 401 for the cookie (session ended);
 * - unavailable: the API did not answer usably (timeout, unreachable, 5xx) —
 *   this is NOT a logout and must never be shown as one.
 */
export type SessionState =
  | { kind: 'user'; user: SessionUser }
  | { kind: 'anonymous' }
  | { kind: 'expired' }
  | { kind: 'unavailable'; code: string };

/** UI batch B: memoised per server request (React cache) — the layout and the screen share one GET /api/me. */
export const loadSession = cache(async (): Promise<SessionState> => {
  const token = await readSessionToken();
  if (!token) return { kind: 'anonymous' };
  const result = await callApi<SessionUser>('/api/me', { sessionToken: token });
  if (result.ok && result.data) return { kind: 'user', user: result.data };
  if (result.status === 401) return { kind: 'expired' };
  return { kind: 'unavailable', code: result.code ?? 'API_UNREACHABLE' };
});

export const loadSessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await loadSession();
  return session.kind === 'user' ? session.user : null;
});
