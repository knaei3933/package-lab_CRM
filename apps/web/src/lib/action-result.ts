import type { ApiResult } from './api';
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
export function isSettledRefusal(result: Pick<ApiResult, 'status' | 'failure'>): boolean {
  return !result.failure && result.status >= 400 && result.status < 500;
}

export function refusalState(result: Pick<ApiResult, 'error' | 'errorKo' | 'code' | 'status' | 'failure'>): ActionState {
  return {
    ok: false,
    message: result.error ?? '予期しないエラーです。画面を再読み込みしても続く場合は代表者へ連絡してください。',
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
