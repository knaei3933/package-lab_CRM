/**
 * UI batch C (1-②): locale-independent date and time text entry.
 *
 * The browser's own date / datetime-local pickers follow the OS locale (a
 * US-English Windows shows mm/dd/yyyy and AM/PM). The operator screens instead
 * take plain text — 2026/11/18 and 14:30 — and these pure helpers turn it into
 * the same datetime-local value (YYYY-MM-DDTHH:MM) the forms always produced,
 * so the submitted fields do not change. No DOM, no server imports: the client
 * components and the tests share them.
 */

/** Same zone as lib/vocabulary DISPLAY_TIME_ZONE (kept literal: client bundles must not pull @kanei/core). */
const JST = 'Asia/Tokyo';

const FULL_WIDTH_DIGITS = /[０-９]/g;

/** IME input often arrives full-width (２０２６／１１／１８, １４：３０). */
function toHalfWidth(text: string): string {
  return text
    .replace(FULL_WIDTH_DIGITS, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/[／]/g, '/')
    .replace(/[－ー−]/g, '-')
    .replace(/[：]/g, ':')
    .replace(/[\s　]+/g, '');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * Accepts 2026/11/18, 2026-11-18, 2026/1/5 and 20261118 (surrounding spaces and
 * full-width digits allowed). Returns YYYY-MM-DD, or null for anything else,
 * including dates the calendar does not have (2026/02/30, 2025/02/29).
 */
export function parseDateText(text: string): string | null {
  const compact = toHalfWidth(text);
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(compact) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(compact);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || !isCalendarDate(year, month, day)) return null;
  return `${match[1]}-${pad2(month)}-${pad2(day)}`;
}

/** Accepts 14:30, 9:05, 1430 and 905 on a 24-hour clock. Returns HH:MM or null (24:00, 25:61 refused). */
export function parseTimeText(text: string): string | null {
  const compact = toHalfWidth(text);
  const match = /^(\d{1,2}):(\d{2})$/.exec(compact) ?? /^(\d{1,2})(\d{2})$/.exec(compact);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${pad2(hour)}:${match[2]}`;
}

/** Date + time text → datetime-local value, or null when either part is not a valid entry. */
export function composeDatetimeLocal(dateText: string, timeText: string): string | null {
  const date = parseDateText(dateText);
  const time = parseTimeText(timeText);
  return date !== null && time !== null ? `${date}T${time}` : null;
}

/** datetime-local value → its date (YYYY-MM-DD) and time (HH:MM); seconds are dropped. Empty parts for anything else. */
export function splitDatetimeLocal(value: string): { date: string; time: string } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d{1,6})?)?$/.exec(value);
  return match ? { date: match[1] ?? '', time: match[2] ?? '' } : { date: '', time: '' };
}

/** YYYY-MM-DD → the display spelling 2026/11/18 (other text unchanged). */
export function dateTextForDisplay(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replaceAll('-', '/') : date;
}

const JST_WITH_WEEKDAY = new Intl.DateTimeFormat('ja-JP', {
  timeZone: JST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

/**
 * An instant (ISO with offset) as Japan wall clock with the weekday:
 * 2026/11/18（水）14:30. Independent of the browser and server TZ, so the
 * confirmation under a date field shows the moment that will actually be
 * recorded. null for an unparseable value.
 */
export function formatJstWithWeekday(iso: string): string | null {
  const date = new Date(iso);
  if (iso.length === 0 || Number.isNaN(date.getTime())) return null;
  const parts = JST_WITH_WEEKDAY.formatToParts(date);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}/${part('month')}/${part('day')}（${part('weekday')}）${part('hour')}:${part('minute')}`;
}

/** p5 N2: 「2026/11/18（水）14:30:05」 — the same instant to the second (null for an unreadable value). */
export function formatJstWithSeconds(iso: string): string | null {
  const minute = formatJstWithWeekday(iso);
  if (minute === null) return null;
  const date = new Date(iso);
  const seconds = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', second: '2-digit' }).format(date);
  return `${minute}:${seconds.padStart(2, '0')}`;
}

export type DateTimeIssue = { part: 'date' | 'time'; message: string };

/**
 * Why a date + time pair cannot be recorded yet, or null when it can (or when
 * an optional pair is left empty). The part says which input gets the error.
 */
export function dateTimeIssue(dateText: string, timeText: string, required: boolean, label: string): DateTimeIssue | null {
  const hasDate = dateText.trim().length > 0;
  const hasTime = timeText.trim().length > 0;
  if (!hasDate && !hasTime) return required ? { part: 'date', message: `${label}を入力してください。` } : null;
  if (hasDate && parseDateText(dateText) === null) {
    return { part: 'date', message: '日付は 2026/11/18 の形で、実在する日付を入力してください。' };
  }
  if (hasTime && parseTimeText(timeText) === null) {
    return { part: 'time', message: '時刻は 14:30 の形（24時間表記、00:00〜23:59）で入力してください。' };
  }
  if (!hasDate) return { part: 'date', message: '日付も入力してください（時刻だけでは記録できません）。' };
  if (!hasTime) return { part: 'time', message: '時刻も入力してください（日付だけでは記録できません）。' };
  return null;
}

/** The DateTextField message for text that is not a calendar date. */
export const DATE_TEXT_INVALID_MESSAGE = '日付は 2026/11/18 の形で、実在する日付を入力してください。';

/** datetime-local value → the two texts the inputs show (2026/11/18, 14:30); empty texts for ''. */
export function datetimeTextsFor(value: string): { date: string; time: string } {
  const { date, time } = splitDatetimeLocal(value);
  return { date: dateTextForDisplay(date), time };
}

/**
 * A date typed out in full (2026/11/18, 2026-11-18, 20261118) that the
 * calendar has. While typing, 2026/11/1 is on its way to 2026/11/18, so the
 * short spellings only count once the input is left (blur).
 */
export function isCompleteDateText(text: string): boolean {
  const compact = toHalfWidth(text);
  return (/^\d{4}[/-]\d{2}[/-]\d{2}$/.test(compact) || /^\d{8}$/.test(compact)) && parseDateText(compact) !== null;
}

/** A time typed out in full (14:30, 9:05, 1430). 143 is on its way to 1430, not 01:43. */
export function isCompleteTimeText(text: string): boolean {
  const compact = toHalfWidth(text);
  return (/^\d{1,2}:\d{2}$/.test(compact) || /^\d{4}$/.test(compact)) && parseTimeText(compact) !== null;
}

/**
 * The datetime-local value the 「日本時間 … として記録します」 line (a polite
 * live region) may show, or null to show nothing. 'input' (each keystroke)
 * only accepts both parts typed out in full, so a transient parse such as 143
 * → 01:43 is never announced; 'commit' (blur, a value set from outside) takes
 * any valid entry.
 */
export function previewLocalValue(texts: { date: string; time: string }, trigger: 'input' | 'commit'): string | null {
  if (trigger === 'input' && !(isCompleteDateText(texts.date) && isCompleteTimeText(texts.time))) return null;
  return composeDatetimeLocal(texts.date, texts.time);
}
