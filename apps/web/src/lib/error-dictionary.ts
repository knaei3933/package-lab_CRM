import { ERROR_DICTIONARY } from './error-dictionary-data';
import type { ErrorDictionaryEntry } from './error-dictionary-data';

/**
 * P0 R09: the one place an API refusal becomes operator text. Client-safe (no
 * Node or Next imports): lib/api.ts uses it for every call, the forms read the
 * result through ActionState.
 *
 * Rules (REDESIGN_PROPOSAL §7-1):
 * - A known `code` answers with the dictionary sentence (what happened + the
 *   one fix) and its Korean auxiliary. The API's own text is never shown for a
 *   coded refusal, so English core messages, enum values and field names
 *   (`paymentTerms: prepaid / on_delivery`) never reach the screen.
 * - An unknown code answers 「予期しないエラーです（コード: X）」 — the code is
 *   the only machine text on screen and goes at the end in brackets.
 * - No code: the HTTP status decides (401 → ログイン切れ, 403 → 権限, 5xx →
 *   システムエラー). An uncoded 4xx keeps the API text only when it passes
 *   isOperatorSafeText (Japanese, no ASCII words, no address).
 * - A network failure or timeout never names the API address (H9).
 *
 * New server codes: add them to error-dictionary-data.ts (a test fails while a
 * code the API source returns is missing there; see the p0-server
 * ERROR_CODES.md when it exists).
 */

export type ApiFailureKind = 'timeout' | 'unreachable';

export interface OperatorErrorText {
  message: string;
  messageKo: string | null;
  /** The code the text was chosen by (API code, or the web code for a failure kind). */
  code: string;
}

export const UNEXPECTED_ERROR_CODE_PREFIX = 'HTTP_';

/** ASCII runs the operator may read (file kinds, units). Everything else ASCII-alphabetic is machine text. */
const ALLOWED_ASCII_WORDS = new Set(['MB', 'KB', 'PDF', 'EML', 'CSV', 'PNG', 'JPEG', 'ID']);

/**
 * True when an API text can be shown as-is: no URL, no host:port, no ASCII word
 * outside the short allow-list (enum values, field names and English core
 * messages all fail this).
 */
export function isOperatorSafeText(text: string): boolean {
  if (text.trim().length === 0) return false;
  if (/:\/\//.test(text) || /\b(?:localhost|127\.0\.0\.1)\b/i.test(text) || /:\d{2,5}\b/.test(text)) return false;
  const words = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return words.every((word) => ALLOWED_ASCII_WORDS.has(word));
}

export function dictionaryEntry(code: string): ErrorDictionaryEntry | null {
  return Object.prototype.hasOwnProperty.call(ERROR_DICTIONARY, code) ? ERROR_DICTIONARY[code] ?? null : null;
}

function fromDictionary(code: string): OperatorErrorText | null {
  const entry = dictionaryEntry(code);
  return entry ? { message: entry.ja, messageKo: entry.ko, code } : null;
}

/** 「予期しないエラーです（コード: X）」 for a code the dictionary does not know. */
export function unexpectedErrorText(code: string): OperatorErrorText {
  const safeCode = code.replace(/[^A-Za-z0-9_]/g, '').slice(0, 80) || 'UNKNOWN';
  return {
    message: `予期しないエラーです（コード: ${safeCode}）。画面を再読み込みしても続く場合は代表者へ連絡してください。`,
    messageKo: `예기치 못한 오류입니다(코드: ${safeCode}). 다시 불러와도 계속되면 대표에게 연락하세요.`,
    code: safeCode
  };
}

function known(code: string): OperatorErrorText {
  return fromDictionary(code) ?? unexpectedErrorText(code);
}

export interface ApiFailureInput {
  status: number;
  code: string | null;
  /** The API's `error` text (shown only for an uncoded 4xx that is operator-safe). */
  apiMessage: string | null;
  failure?: ApiFailureKind | null | undefined;
}

export function describeApiFailure(input: ApiFailureInput): OperatorErrorText {
  if (input.failure === 'timeout') return known('API_TIMEOUT');
  if (input.failure === 'unreachable') return known('API_UNREACHABLE');
  if (input.status === 401) return known('SESSION_EXPIRED');
  if (input.code) return known(input.code);
  if (input.status === 403) return known('ROLE_FORBIDDEN');
  if (input.status === 413) return known('UPLOAD_TOO_LARGE');
  if (input.status >= 500) return known('INTERNAL_ERROR');
  if (input.apiMessage && isOperatorSafeText(input.apiMessage)) {
    return { message: input.apiMessage, messageKo: null, code: `${UNEXPECTED_ERROR_CODE_PREFIX}${input.status}` };
  }
  return unexpectedErrorText(`${UNEXPECTED_ERROR_CODE_PREFIX}${input.status}`);
}

/** The operator text for a web-side code (PROJECT_CONTEXT_MISMATCH, DUPLICATE, UPLOAD_TOO_LARGE…). */
export function webErrorText(code: string): OperatorErrorText {
  return known(code);
}
