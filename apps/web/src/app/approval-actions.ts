'use server';

import { refuseIfProjectSwitched, writeProjectOf } from '../lib/project-guard';
import { SNAPSHOT_UNREADABLE_MESSAGE } from '../lib/approval-snapshot';
import { isPlainAmount, normalizeAmountText } from '../lib/amount';
import { approvalEvidenceStamp, cardFromServer, SNAPSHOT_CHANGED_CODE, deliveryTermsStamp, isMissingRoute, TERMS_CHANGED_MESSAGE, TERMS_UNREADABLE_MESSAGE } from '../lib/approval-card';
import type { ApprovalNoticeReason } from '../lib/approval-card';
import { approvalNoticeText } from '../lib/approval-notice';
import { forgetApprovalNotice, rememberApprovalNotice } from '../lib/approval-notice-server';
import { callApi } from '../lib/api';
import { isSettledRefusal, refusalState } from '../lib/action-result';
import { AMOUNT_REQUIRED_CODE, DELIVERY_DATE_REQUIRED_CODE } from '../lib/approval-card';
import { deliveryDatesFromForm } from '../lib/delivery-dates';
import { webErrorText } from '../lib/error-dictionary';
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

/**
 * p4/web3 (b): the approval stopped with 409 MAKER_PO_SNAPSHOT_CHANGED. The server's hash now covers the
 * approval-evidence set too (server2 §9), and its wording 「明細・版」 cannot tell an evidence change apart,
 * so the card is read again and its evidence set compared with the one this card was drawn with
 * (expectedEvidenceStamp). The reason is kept for the redrawn card (lib/approval-notice); nothing is sent
 * again — the representative approves the new card with its own hash (review H1: never a hash read at submit).
 */
async function snapshotChanged(poId: string, formData: FormData, refusal: ActionState): Promise<ActionState> {
  const drawn = field(formData, 'expectedEvidenceStamp');
  let reason: ApprovalNoticeReason = 'content_changed';
  if (drawn.length > 0) {
    const current = await callApi<unknown>(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/approval-card`);
    const card = current.ok ? cardFromServer(poId, current.data) : null;
    const now = card ? approvalEvidenceStamp(card) : null;
    if (now !== null && now !== drawn) reason = 'evidence_changed';
  }
  await rememberApprovalNotice(poId, reason);
  revalidatePath('/', 'layout');
  const text = approvalNoticeText(reason);
  // An answered 409: the submit is over (a new key for the next one, which carries the new card's hash).
  return { ...refusal, ok: false, message: text.ja, messageKo: text.ko, code: SNAPSHOT_CHANGED_CODE, settled: true };
}

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
  // Review H1: only the hash the card was drawn with — never read again at submit.
  if (!/^[0-9a-f]{64}$/.test(expectedSnapshotSha256)) return { ok: false, message: SNAPSHOT_UNREADABLE_MESSAGE };
  // P2 verifier M1 (contract §3-2, L1): 納期・数量 are fixed by this approval but are not in
  // the hash — read the card again and stop when they changed since it was drawn. Only a
  // comparison: the hash sent below is still the one the card was drawn with (review H1).
  const expectedTermsStamp = field(formData, 'expectedTermsStamp');
  if (expectedTermsStamp.length > 0) {
    const current = await callApi<unknown>(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/approval-card`);
    if (!current.ok) return { ok: false, message: TERMS_UNREADABLE_MESSAGE };
    if (deliveryTermsStamp(current.data) !== expectedTermsStamp) {
      revalidatePath('/', 'layout');
      return { ok: false, message: TERMS_CHANGED_MESSAGE, settled: true };
    }
  }
  let hash = expectedSnapshotSha256;
  // Review M2: the representative may enter / correct the amount here (a staff draft has none). It is
  // saved into the paper pinned to the same rendered hash, and the approval then carries the hash the
  // API answers for that content (the lines the representative saw + the amount they typed).
  const totalAmount = normalizeAmountText(field(formData, 'totalAmount'));
  if (totalAmount.length > 0) {
    if (!isPlainAmount(totalAmount)) return { ok: false, message: '金額は数字で入力してください（例 480000）。' };
    const currency = /^[A-Z]{3}$/.test(field(formData, 'currency')) ? field(formData, 'currency') : 'JPY';
    const saved = await callApi<{ approvalSnapshotSha256?: unknown }>(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/amounts`, {
      method: 'PATCH',
      body: { amounts: { currency, totalAmount }, expectedSnapshotSha256: hash },
      idempotencyKey: idempotencyKeyOf(formData) ? `${idempotencyKeyOf(formData)}.amounts` : undefined,
      expectedProjectId: writeProjectOf(formData)
    });
    if (!saved.ok) return saved.code === SNAPSHOT_CHANGED_CODE ? snapshotChanged(poId, formData, refusalState(saved)) : refusalState(saved);
    const next = saved.data?.approvalSnapshotSha256;
    if (typeof next !== 'string' || !/^[0-9a-f]{64}$/.test(next)) return { ok: false, message: SNAPSHOT_UNREADABLE_MESSAGE };
    hash = next;
  } else if (field(formData, 'amountRequired') === 'true') {
    // P4 H4①: a paper without an amount is not approved (the API refuses it too: 422 AMOUNT_REQUIRED).
    // The old 「金額未入力のまま承認する」 check is gone: the amount is entered here.
    const text = webErrorText(AMOUNT_REQUIRED_CODE);
    return { ok: false, message: text.message, messageKo: text.messageKo, code: AMOUNT_REQUIRED_CODE };
  }
  const body: Record<string, unknown> = { expectedPaymentTerms, expectedSnapshotSha256: hash };
  const result = await callApi(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/ceo-approval`, {
    method: 'POST',
    body,
    idempotencyKey: idempotencyKeyOf(formData), expectedProjectId: writeProjectOf(formData)
  });
  if (!result.ok) {
    if (result.code === SNAPSHOT_CHANGED_CODE) return snapshotChanged(poId, formData, refusalState(result));
    // P4 H4①: the API says what is still missing (AMOUNT_REQUIRED / DELIVERY_DATE_REQUIRED): the card is drawn again with that input.
    // p4/web3 (web2b review L-1): the redraw mounts the step panel again — the reason rides on the notice.
    if (result.code === AMOUNT_REQUIRED_CODE || result.code === DELIVERY_DATE_REQUIRED_CODE) {
      await rememberApprovalNotice(poId, result.code === AMOUNT_REQUIRED_CODE ? 'amount_required' : 'delivery_date_required');
      revalidatePath('/', 'layout');
    }
    return refusalState(result);
  }
  await forgetApprovalNotice();
  revalidatePath('/', 'layout');
  return { ok: true, message: '代表承認を記録しました。担当者がメーカーへ送信します。', changedId: poId };
}

/**
 * P4 H4①: the 希望納期 of the order, recorded from the approval card (PATCH …/delivery-dates, the same
 * write as the order screen's 「発注の条件」). It is part of the frozen paper, so the card is drawn
 * again afterwards (revalidate) — the approval never sends a hash read at submit (review H1).
 */
export async function recordRequestedDeliveryDateAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const switched = await refuseIfProjectSwitched(formData);
  if (switched) return switched;
  const orderId = field(formData, 'orderId');
  if (orderId.length === 0) return { ok: false, message: 'フィルム発注が見つかりません。画面を再読み込みしてください。' };
  const dates = deliveryDatesFromForm(formData);
  if ('error' in dates) return { ok: false, message: dates.error };
  if (typeof dates.body.requestedDeliveryDate !== 'string') {
    const text = webErrorText(DELIVERY_DATE_REQUIRED_CODE);
    return { ok: false, message: text.message, messageKo: text.messageKo, code: DELIVERY_DATE_REQUIRED_CODE };
  }
  const result = await callApi(`/api/film-supply-orders/${encodeURIComponent(orderId)}/delivery-dates`, {
    method: 'PATCH',
    body: { requestedDeliveryDate: dates.body.requestedDeliveryDate },
    idempotencyKey: idempotencyKeyOf(formData),
    expectedProjectId: writeProjectOf(formData)
  });
  if (!result.ok) return refusalState(result);
  revalidatePath('/', 'layout');
  return { ok: true, message: '希望納期を記録しました。承認カードを読み込み直しています。', changedId: orderId };
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
    idempotencyKey: key,
    expectedProjectId: projectId
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
    idempotencyKey: key ? `${key}.cancel` : undefined,
    expectedProjectId: projectId
  });
  if (!cancelled.ok) return { ...refusalState(cancelled), settled: isSettledRefusal(cancelled) };
  revalidatePath('/', 'layout');
  return { ok: true, message: '差し戻しました（発注書を取り消し、理由を履歴に残しました）。内容を直して作り直します。', changedId: poId };
}
