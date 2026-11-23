/**
 * P1 R20: the project and the film order live in the address, not in a cookie.
 *
 *   /p/{案件コード}                     the project's overview
 *   /p/{案件コード}/o/{発注コード}         one film order (timeline + current step)
 *   /p/{案件コード}/new                 the new-order wizard
 *   /p/{案件コード}/orders|documents|…   the project's lists (the former screens)
 *
 * A write is sent to the project the screen was drawn for (the URL's project,
 * carried by the form's hidden field) — a tab switched elsewhere can no longer
 * redirect it (B3, root fix). The cookie only remembers the last project opened
 * (LAST_PROJECT_COOKIE), for the home shortcut and for the old addresses
 * (/orders …), which are redirected into the URL of that project.
 *
 * Client-safe: no server imports here (see project-route-server.ts).
 */

export const PROJECT_ROUTE_PREFIX = '/p';

/** The last project code opened in this browser (set by middleware on every /p/{code} request). */
export const LAST_PROJECT_COOKIE = 'kanei_web_last_project';

/** The former screens, now project-scoped lists under /p/{code}/… */
export const PROJECT_SCREENS = ['orders', 'documents', 'approvals', 'maker-po', 'deliveries', 'evidence'] as const;
export type ProjectScreen = (typeof PROJECT_SCREENS)[number];

/** The legacy (cookie-scoped) address of each screen. */
export const LEGACY_SCREEN_PATHS = PROJECT_SCREENS.map((screen) => `/${screen}`);

/**
 * A code that may stand in a URL segment: letters (any script), digits and
 * `.` `_` `-`, 1–64 characters. Anything else (a slash, a space, `..`, a
 * control character) never names a project or order here.
 */
export function isRouteCode(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && value !== '.'
    && value !== '..'
    && /^[\p{L}\p{N}._-]+$/u.test(value);
}

/** A URL segment decoded once; null when it does not decode or is not a route code. */
export function decodeRouteCode(segment: unknown): string | null {
  if (typeof segment !== 'string') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return isRouteCode(decoded) ? decoded : null;
}

function segment(code: string): string {
  return encodeURIComponent(code);
}

/** `/p/{code}` or `/p/{code}/{rest}`. */
export function projectPath(projectCode: string, rest?: string): string {
  const base = `${PROJECT_ROUTE_PREFIX}/${segment(projectCode)}`;
  if (!rest) return base;
  return `${base}/${rest.replace(/^\/+/, '')}`;
}

/** `/p/{project}/o/{order}`, optionally `?step=N` (a step deep link, REDESIGN §2-2). */
export function orderPath(projectCode: string, orderCode: string, step?: number | null): string {
  const base = projectPath(projectCode, `o/${segment(orderCode)}`);
  return typeof step === 'number' && Number.isInteger(step) ? `${base}?step=${step}` : base;
}

/** p4/web3 (c): the anchor of 「支払条件を変更する」 on the order screen (OrderTermsSection). */
export const PAYMENT_TERMS_ANCHOR = 'payment-terms';

/** `/p/{project}/new` — the new film order wizard (発注書の受付 → 照合 → 発注内容). */
export function newOrderPath(projectCode: string): string {
  return projectPath(projectCode, 'new');
}

export interface ProjectPathParts {
  projectCode: string;
  /** What follows /p/{code}, without the leading slash ('' for the overview). */
  rest: string;
  /** The order code when the path is /p/{code}/o/{order}… */
  orderCode: string | null;
}

/** Reads /p/{code}/… from a pathname (no query, no hash). Null for any other path. */
export function parseProjectPath(pathname: string | null | undefined): ProjectPathParts | null {
  if (typeof pathname !== 'string') return null;
  const clean = pathname.split(/[?#]/)[0] ?? '';
  const match = /^\/p\/([^/]+)(?:\/(.*))?$/.exec(clean);
  if (!match) return null;
  const projectCode = decodeRouteCode(match[1]);
  if (!projectCode) return null;
  const rest = (match[2] ?? '').replace(/\/+$/, '');
  const orderMatch = /^o\/([^/]+)/.exec(rest);
  const orderCode = orderMatch ? decodeRouteCode(orderMatch[1]) : null;
  return { projectCode, rest, orderCode };
}

const LEGACY_SCREEN_PATTERN = /^\/(orders|documents|approvals|maker-po|deliveries|evidence)(?=$|[?#])/;

/**
 * A screen link written for the old cookie-scoped addresses (`/orders#order-…`,
 * `/maker-po`, `/documents?download=…`) placed under the project the screen
 * shows. Other links (the guide, outside addresses, already scoped ones) are
 * returned as they are. `/dashboard` becomes the project's overview.
 */
export function scopeHref(projectCode: string | null | undefined, href: string): string {
  if (!projectCode || !isRouteCode(projectCode)) return href;
  if (href === '/dashboard') return projectPath(projectCode);
  const match = LEGACY_SCREEN_PATTERN.exec(href);
  if (!match) return href;
  return `${projectPath(projectCode, match[1])}${href.slice(match[0].length)}`;
}

/** The legacy screen an old address names ('/orders' → 'orders'), or null. */
export function legacyScreenOf(pathname: string): ProjectScreen | null {
  const match = LEGACY_SCREEN_PATTERN.exec(pathname);
  return match ? (match[1] as ProjectScreen) : null;
}

/** Cookie attributes for LAST_PROJECT_COOKIE (host-wide, script-free, 180 days). */
export const LAST_PROJECT_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  maxAge: 60 * 60 * 24 * 180
};

/**
 * The legacy screen path a project-scoped pathname stands for (for the static
 * guide line and the menu's current mark): /p/{code}/orders → /orders, the
 * overview /p/{code} → /dashboard. The order screen and the wizard have none
 * (they explain themselves, REDESIGN §6-2). Other paths are returned as they are.
 */
export function unscopedPath(pathname: string | null): string | null {
  if (pathname === null) return null;
  const scoped = parseProjectPath(pathname);
  if (!scoped) return pathname;
  if (scoped.rest === '') return '/dashboard';
  const screen = (PROJECT_SCREENS as readonly string[]).find((name) => scoped.rest === name || scoped.rest.startsWith(`${name}/`));
  return screen ? `/${screen}` : null;
}
