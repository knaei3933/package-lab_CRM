/**
 * Explicit-offset timestamps at the web/API boundary.
 *
 * A datetime-local value names wall-clock time and carries no offset. Converting
 * it in the API process would make its meaning depend on the deployment host,
 * so the browser converts its own local value to UTC ISO. The server action
 * still normalizes a defensively accepted naive value as Asia/Tokyo rather than
 * trusting the server's TZ.
 */

export const DATETIME_LOCAL_PATTERN =
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

/**
 * Reads the hidden explicit-offset field. Before hydration it is empty, and a
 * malformed hidden value can also occur from stale markup; in both cases the
 * visible Local value gets explicit Asia/Tokyo semantics. Returning empty for
 * two invalid values lets existing required-field validation run.
 */
export function offsetDateTimeField(formData: FormData, key: string): string {
  const read = (name: string): string => {
    const value = formData.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  const explicit = read(key);
  if (explicit.length > 0) {
    const normalizedExplicit = normalizeDateTimeForApi(explicit);
    if (normalizedExplicit !== null) return normalizedExplicit;
  }
  const local = read(`${key}Local`);
  return local.length === 0 ? '' : normalizeDateTimeForApi(local) ?? '';
}

/** The current wall clock in Japan, regardless of the server process timezone. */
export function asiaTokyoDatetimeLocalNow(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const value = (partType: string): string => parts.find((part) => part.type === partType)?.value ?? '';
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const hour = value('hour');
  const minute = value('minute');
  return year.length > 0 && month.length > 0 && day.length > 0 && hour.length > 0 && minute.length > 0
    ? `${year}-${month}-${day}T${hour}:${minute}`
    : '';
}
