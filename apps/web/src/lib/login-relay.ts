import { isIP } from 'node:net';
export { CROSS_SITE_REFUSAL, LOGIN_EMPTY_MESSAGE, LOGIN_INVALID_MESSAGE, LOGIN_LOCKED_CODE, LOGIN_RELAY_TIMEOUT_MS, LOGIN_TIMEOUT_MESSAGE, LOGIN_UNAVAILABLE_MESSAGE, lockedMessage, loginRefusal, waitText } from './login-messages';
export type { LoginRefusal } from './login-messages';

/**
 * UI batch F (server F2 contract, review H2/M3): what the same-origin login
 * relay adds to and removes from the API exchange.
 *
 * 1. Client address. The API keys its lockout on account + client address and
 *    takes the FIRST X-Forwarded-For value, but only when the socket peer (this
 *    web process) is in TRUSTED_PROXY_CIDRS. The web therefore sends exactly one
 *    value — the browser address — and never the incoming chain, whose left
 *    entries a browser could write itself.
 *
 *    A Next route handler cannot see its socket peer, and Next only fills
 *    X-Forwarded-For from the socket when the header is absent: a browser that
 *    reaches this process directly can put any value there. The address is
 *    therefore used only when the operator declares that every connection comes
 *    through the reverse proxy (KANEI_WEB_BEHIND_TRUSTED_PROXY=1, production
 *    compose behind Caddy, web port not published). Caddy without
 *    trusted_proxies replaces X-Forwarded-For with its own peer address
 *    ($remote_addr); the right-most value is the one the proxy wrote, and only a
 *    syntactically valid IP is forwarded. Otherwise nothing is added and the API
 *    attributes the attempt to this process (safe, but browsers are not told
 *    apart).
 *
 * 2. Origin. The relay is a cookie-issuing POST, so a cross-site page must not
 *    be able to drive it (login CSRF). A browser always sends Origin on POST; a
 *    present Origin must name this host (or WEB_ALLOWED_ORIGINS), and
 *    Sec-Fetch-Site must not be cross-site. The login body must be JSON, which a
 *    cross-site HTML form cannot send.
 *
 * 3. Answer. Refusals are rewritten to one fixed Japanese sentence per status so
 *    the form never tells an existing account from a missing one (the API
 *    already answers both with the same 401/429); the lockout keeps its code and
 *    the remaining wait.
 */

export const TRUSTED_PROXY_ENV = 'KANEI_WEB_BEHIND_TRUSTED_PROXY';
export const ALLOWED_ORIGINS_ENV = 'WEB_ALLOWED_ORIGINS';

type Env = Readonly<Record<string, string | undefined>>;

/** A canonical IP literal (brackets, IPv6 zone and IPv4-mapped prefix removed), or null. */
export function canonicalIp(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(value)) value = value.slice(7);
  return isIP(value) === 0 ? null : value.toLowerCase();
}

/**
 * The browser address the reverse proxy recorded, or null when this process is
 * not declared to sit behind it or the value is not an IP.
 */
export function trustedClientAddress(headers: Headers, env: Env = process.env): string | null {
  if (env[TRUSTED_PROXY_ENV] !== '1') return null;
  const chain = headers.get('x-forwarded-for');
  if (!chain) return null;
  const hops = chain.split(',').map((hop) => hop.trim()).filter((hop) => hop.length > 0);
  const nearest = hops.at(-1);
  return nearest ? canonicalIp(nearest) : null;
}

/** Headers for the relay's fetch to the API: JSON, plus the single trusted client address. */
export function loginRelayHeaders(clientAddress: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (clientAddress) headers['x-forwarded-for'] = clientAddress;
  return headers;
}

function allowedOrigins(env: Env): string[] {
  return (env[ALLOWED_ORIGINS_ENV] ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** False when a browser says this POST comes from another site. */
export function isSameOriginPost(request: Request, env: Env = process.env): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  if (allowedOrigins(env).includes(origin)) return true;
  let originHost: string;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    originHost = parsed.host.toLowerCase();
  } catch {
    // "null" (sandboxed/opaque origins) and garbage are never this site.
    return false;
  }
  const host = request.headers.get('host')?.trim().toLowerCase();
  return Boolean(host) && originHost === host;
}

export function isJsonRequest(request: Request): boolean {
  const type = request.headers.get('content-type') ?? '';
  return /^application\/json(\s*;|$)/i.test(type.trim());
}
