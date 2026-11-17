/**
 * Explicit-offset timestamps at the web/API boundary.
 *
 * A datetime-local value names wall-clock time and carries no offset. Converting
 * it in the API process would make its meaning depend on the deployment host,
 * so the browser converts its own local value to UTC ISO. The server action
 * still normalizes a defensively accepted naive value as Asia/Tokyo rather than
 * trusting the server's TZ.
 */

const DATETIME_LOCAL_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?$/;
const DATETIME_WITH_EXPLICIT_OFFSET_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATETIME_WITH_SECONDS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/;

/** Converts a browser datetime-local value to an unambiguous UTC ISO string. */
export function datetimeLocalToIso(value: string): string | null {
  if (!DATETIME_LOCAL_PATTERN.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Accepts an already explicit offset unchanged and gives a naive fallback the
 * operator-facing Japanese wall-clock meaning (+09:00), independent of server TZ.
 */
export function normalizeDateTimeForApi(value: string): string | null {
  if (DATETIME_WITH_EXPLICIT_OFFSET_PATTERN.test(value)) return value;
  if (!DATETIME_LOCAL_PATTERN.test(value)) return null;
  const seconds = DATETIME_WITH_SECONDS_PATTERN.test(value) ? '' : ':00';
  return `${value}${seconds}+09:00`;
}
