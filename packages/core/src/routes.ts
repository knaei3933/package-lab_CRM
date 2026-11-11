export const SUPPORTED_PROJECT_ROUTES = ['F1'] as const;
export type ProjectRoute = (typeof SUPPORTED_PROJECT_ROUTES)[number];

export type RouteValidation =
  | { ok: true; route: ProjectRoute }
  | { ok: false; code: 'UNSUPPORTED_ROUTE'; message: string };

/**
 * M0 route gate G0. Accepts only F1. Normalization is intentional: the persisted
 * route is always the canonical uppercase value.
 */
export function validateProjectRoute(value: unknown): RouteValidation {
  if (value !== 'F1' && value !== 'f1') {
    return {
      ok: false,
      code: 'UNSUPPORTED_ROUTE',
      message: `route must be F1 in M0; received ${String(value)}`
    };
  }
  return { ok: true, route: 'F1' };
}
