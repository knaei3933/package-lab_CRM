import type { ApiResult } from './api';
import { withExistingBinding } from './binding-conflict';
import type { ActionState } from './types';

/**
 * P0 R09: an API refusal as the form's result line — the operator text the
 * dictionary chose (lib/api → lib/error-dictionary), its Korean auxiliary and
 * the code the form reacts to. Never the API's own English or enum text.
 */
/**
 * P0 review H1: a refusal the API decided and answered (4xx). A timeout or an
 * unreachable API (no answer) and a 5xx (the write may or may not be stored)
 * are not settled — the form keeps its Idempotency-Key so a retry is answered
 * with the first result instead of writing again.
 */
export function isSettledRefusal(result: Pick<ApiResult, 'status' | 'failure'> & { code?: string | null | undefined }): boolean {
  // Review NM1: IDEMPOTENCY_KEY_REUSED means the earlier submit with this key may be
  // stored — the submit is not over, so the key is kept (the form locks instead).
  // P2 (contract v1.2 §1): the other answers that keep the key are listed in KEY_KEEPING_CODES.
  if (keepsSubmitKey(result.code)) return false;
  return !result.failure && result.status >= 400 && result.status < 500;
}

/** Review NM1: the API saw this key with another body — the earlier submit may already be stored. */
export const KEY_REUSED_CODE = 'IDEMPOTENCY_KEY_REUSED';

/**
 * P2 R05 (contract v1.2 §1, review M-2): the first submit with this key is still
 * being processed. Nothing was written twice; the form keeps the key and the
 * operator sends the same input again a little later (answered with the first result).
 */
export const IN_PROGRESS_CODE = 'IDEMPOTENCY_IN_PROGRESS';

/**
 * P2 R05 (contract v1.2 §1, review M-1): the API cannot tell whether the first
 * submit with this key was stored, and answers the same for that key until it
 * expires. The key stays fixed (a resend never writes), the list is refreshed and
 * the operator checks it; only an explicit 「確認しました」 starts a new submit.
 */
export const OUTCOME_UNKNOWN_CODE = 'IDEMPOTENCY_OUTCOME_UNKNOWN';

/** The web's own code for a lost session (lib/api: every 401). */
export const SESSION_EXPIRED_CODE = 'SESSION_EXPIRED';

/**
 * The answers after which the form keeps its Idempotency-Key (the submit is not
 * over). SESSION_EXPIRED: contract §1 「재로그인 뒤에는 같은 키로 재제출」 — a
 * submit that timed out and then met an expired session may already be stored;
 * after logging in again the same key is answered with that first result
 * (P2 keys are per user, not per session) instead of writing twice.
 */
export const KEY_KEEPING_CODES: readonly string[] = [KEY_REUSED_CODE, IN_PROGRESS_CODE, OUTCOME_UNKNOWN_CODE, SESSION_EXPIRED_CODE];

export function keepsSubmitKey(code: string | null | undefined): boolean {
  return typeof code === 'string' && KEY_KEEPING_CODES.includes(code);
}

/**
 * The answers after which the screen's lists are read again at once: the earlier
 * submit may be stored (KEY_REUSED — P0 NM1; OUTCOME_UNKNOWN — P2), so the operator
 * checks the list as it is now.
 */
export function refreshesListOn(code: string | null | undefined): boolean {
  return code === KEY_REUSED_CODE || code === OUTCOME_UNKNOWN_CODE;
}

export function refusalState(result: Pick<ApiResult, 'error' | 'errorKo' | 'code' | 'status' | 'failure'> & { data?: unknown }): ActionState {
  return {
    ok: false,
    // P4 N13: a file refused because it is filed elsewhere says where (existing order code / design).
    message: withExistingBinding(result.error ?? '予期しないエラーです。画面を再読み込みしても続く場合は代表者へ連絡してください。', result.code, result.data),
    messageKo: result.errorKo ?? null,
    code: result.code ?? null,
    // P0 review H1: only an answered 4xx ends the submit (the key is then renewed).
    settled: isSettledRefusal(result)
  };
}

/**
 * The id a create/update answer carries, for the changed-row highlight (R06):
 * `{ id }`, or the record under a wrapper the API uses (`{ document, version }`
 * for an upload, `{ order }`, `{ revision }`…).
 */
export function recordIdOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  for (const candidate of [record, record.document, record.order, record.revision, record.delivery, record.purchaseOrder]) {
    const id = typeof candidate === 'object' && candidate !== null ? (candidate as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && id.length > 0 && id.length <= 64) return id;
  }
  return null;
}
