import type { ApiResult } from './api';
import type { ActionState } from './types';

/**
 * P0 R09: an API refusal as the form's result line — the operator text the
 * dictionary chose (lib/api → lib/error-dictionary), its Korean auxiliary and
 * the code the form reacts to. Never the API's own English or enum text.
 */
export function refusalState(result: Pick<ApiResult, 'error' | 'errorKo' | 'code' | 'status'>): ActionState {
  return {
    ok: false,
    message: result.error ?? '予期しないエラーです。画面を再読み込みしても続く場合は代表者へ連絡してください。',
    messageKo: result.errorKo ?? null,
    code: result.code ?? null
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
