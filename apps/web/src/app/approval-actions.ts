'use server';

import { refuseIfProjectSwitched, writeProjectOf } from '../lib/project-guard';
import { isMissingRoute } from '../lib/approval-card';
import { callApi } from '../lib/api';
import { isSettledRefusal, refusalState } from '../lib/action-result';
import { idempotencyKeyOf } from '../lib/project-context';
import { revalidatePath } from 'next/cache';
import type { ActionState } from '../lib/types';

/**
 * P1 R24: the approval card's two decisions. Both are the representative's
 * (the API refuses everyone else: CEO_ONLY / FORBIDDEN).
 *
 * - 代表承認: the existing ceo-approval write with the 支払条件 the card showed
 *   (P0) and, when the server card gave one, the snapshot hash it showed
 *   (contract §2-2: a paper changed meanwhile is refused, never approved unseen).
 * - 差し戻す: contract §2-3 POST …/return with the reason. Until the API has
 *   that route (404 without a code), the same outcome is recorded with the
 *   existing cancel of a DRAFT paper, its note naming it a 差し戻し — the paper
 *   is withdrawn, the order stays at メーカー発注準備完了 for a corrected paper.
 */
function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

const TERMS = ['prepaid', 'on_delivery', 'undetermined'];

export async function approveFromCardAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await refuseIfProjectSwitched(formData);
  if (switched) return switched;
  const poId = field(formData, 'poId');
  const expectedPaymentTerms = field(formData, 'expectedPaymentTerms');
  const expectedSnapshotSha256 = field(formData, 'expectedSnapshotSha256');
  if (poId.length === 0) return { ok: false, message: 'メーカー発注書が見つかりません。画面を再読み込みしてください。' };
  if (!TERMS.includes(expectedPaymentTerms)) {
    return { ok: false, message: '支払条件を読み取れなかったため、承認を止めました。画面を再読み込みしてください。' };
  }
  const body: Record<string, unknown> = { expectedPaymentTerms };
  if (/^[0-9a-f]{64}$/.test(expectedSnapshotSha256)) body.expectedSnapshotSha256 = expectedSnapshotSha256;
  const result = await callApi(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/ceo-approval`, {
    method: 'POST',
    body,
    idempotencyKey: idempotencyKeyOf(formData)
  });
  if (!result.ok) return refusalState(result);
  revalidatePath('/', 'layout');
  return { ok: true, message: '代表承認を記録しました。担当者がメーカーへ送信します。', changedId: poId };
}

export async function returnMakerPoAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await refuseIfProjectSwitched(formData);
  if (switched) return switched;
  const poId = field(formData, 'poId');
  const reason = field(formData, 'reason');
  if (poId.length === 0) return { ok: false, message: 'メーカー発注書が見つかりません。画面を再読み込みしてください。' };
  if (reason.length === 0) return { ok: false, message: '差し戻しの理由を入力してください。' };
  const key = idempotencyKeyOf(formData);
  const projectId = writeProjectOf(formData);
  const returned = await callApi(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/return`, {
    method: 'POST',
    body: projectId ? { reason, expectedProjectId: projectId } : { reason },
    idempotencyKey: key
  });
  if (returned.ok) {
    revalidatePath('/', 'layout');
    return { ok: true, message: '差し戻しました。内容を直して、新しいメーカー発注書を作り直します。', changedId: poId };
  }
  if (!isMissingRoute(returned)) return refusalState(returned);
  // Contract adapter: the return route is not on this API yet — the same outcome, by the existing cancel.
  const cancelled = await callApi(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/cancel`, {
    method: 'POST',
    body: { note: `差し戻し: ${reason}` },
    idempotencyKey: key ? `${key}.cancel` : undefined
  });
  if (!cancelled.ok) return { ...refusalState(cancelled), settled: isSettledRefusal(cancelled) };
  revalidatePath('/', 'layout');
  return { ok: true, message: '差し戻しました（発注書を取り消し、理由を履歴に残しました）。内容を直して作り直します。', changedId: poId };
}
