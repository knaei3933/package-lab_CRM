'use server';

import { callApi } from '../../lib/api';
import type { ActionState } from '../../lib/types';

/**
 * M8-OPERATOR S5 server actions for the maker purchase-order area: thin
 * forms-over-API adapters, like the M6 actions. Each one posts to the existing
 * apps/api endpoint with the operator's session cookie and reports the API's own
 * Japanese message back. Nothing here decides a rule — the API refuses what the
 * role or the state does not allow, and that refusal is what the screen shows.
 */

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

async function post(path: string, body: unknown): Promise<ActionState> {
  const result = await callApi(path, { method: 'POST', body });
  if (result.ok) {
    return { ok: true, message: '記録しました。' };
  }
  return { ok: false, message: result.error ?? `APIがステータス ${result.status} を返しました。` };
}

async function patch(path: string, body: unknown): Promise<ActionState> {
  const result = await callApi(path, { method: 'PATCH', body });
  if (result.ok) {
    return { ok: true, message: '記録しました。' };
  }
  return { ok: false, message: result.error ?? `APIがステータス ${result.status} を返しました。` };
}

/** Screen 1: freeze the maker paper (admin only; the API refuses everyone else). */
export async function createMakerPoAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const orderId = field(formData, 'orderId');
  const recipientAddress = field(formData, 'recipientAddress');
  if (orderId.length === 0) return { ok: false, message: 'フィルム発注を選択してください。' };
  if (recipientAddress.length === 0) return { ok: false, message: '宛先住所（メーカーの送り先）を入力してください。' };
  const body: Record<string, unknown> = { recipientAddress };
  const currency = field(formData, 'currency');
  const totalAmount = field(formData, 'totalAmount');
  if (currency.length > 0 || totalAmount.length > 0) {
    body.amounts = { currency, totalAmount };
  }
  return post(`/api/film-supply-orders/${encodeURIComponent(orderId)}/maker-purchase-orders`, body);
}

/** Screen 2: the CEO approval of the frozen digest (admin only). */
export async function approveMakerPoAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const poId = field(formData, 'poId');
  if (poId.length === 0) return { ok: false, message: 'メーカー発注書が選択されていません。' };
  return post(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/ceo-approval`, {});
}

/** Screen 2 support: record the G6 transaction terms while the order is a draft. */
export async function updatePaymentTermsAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const orderId = field(formData, 'orderId');
  const paymentTerms = field(formData, 'paymentTerms');
  if (orderId.length === 0) return { ok: false, message: 'フィルム発注が選択されていません。' };
  if (!['prepaid', 'on_delivery', 'undetermined'].includes(paymentTerms)) {
    return { ok: false, message: '決済条件（prepaid／on_delivery／undetermined）を選択してください。' };
  }
  // 注意: recording a term is NOT an 入金確認（檢証）. The payment gate only
  // reads the recorded term; the money-arrived confirmation is a separate manual
  // step with no writer yet, so paymentConfirmedAt stays empty.
  return patch(`/api/film-supply-orders/${encodeURIComponent(orderId)}/payment-terms`, { paymentTerms });
}

/** Screen 3: register the manual send evidence (staff work). */
export async function recordMakerPoSendEvidenceAction(
  _prev: ActionState | null,
  formData: FormData
): Promise<ActionState> {
  const poId = field(formData, 'poId');
  const evidenceDocumentVersionId = field(formData, 'evidenceDocumentVersionId');
  const senderAddress = field(formData, 'senderAddress');
  const recipientsRaw = field(formData, 'recipients');
  const sentAt = field(formData, 'sentAt');
  if (poId.length === 0) return { ok: false, message: 'メーカー発注書が選択されていません。' };
  if (evidenceDocumentVersionId.length === 0) {
    return { ok: false, message: '送信証跡（send_evidence）の書類バージョンを選択してください。' };
  }
  if (senderAddress.length === 0) return { ok: false, message: '送信元アドレスを入力してください。' };
  const recipients = recipientsRaw.split(/[,;、\s]+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (recipients.length === 0) return { ok: false, message: '宛先アドレスを1件以上入力してください。' };
  if (sentAt.length === 0) return { ok: false, message: '送信日時を入力してください。' };
  return post(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/send-evidence`, {
    evidenceDocumentVersionId,
    senderAddress,
    recipients,
    sentAt
  });
}

/**
 * Screen 4a: the provisional acceptance a staff member may record. It never
 * finalizes the paper — the API keeps the status and flags the event 仮.
 */
export async function recordProvisionalAcceptanceAction(
  _prev: ActionState | null,
  formData: FormData
): Promise<ActionState> {
  const poId = field(formData, 'poId');
  if (poId.length === 0) return { ok: false, message: 'メーカー発注書が選択されていません。' };
  const body: Record<string, unknown> = {};
  const acceptedAt = field(formData, 'acceptedAt');
  if (acceptedAt.length > 0) body.acceptedAt = acceptedAt;
  return post(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/provisional-acceptance`, body);
}

/** Screen 4b: the final acceptance, admin only. */
export async function recordFinalAcceptanceAction(
  _prev: ActionState | null,
  formData: FormData
): Promise<ActionState> {
  const poId = field(formData, 'poId');
  const evidenceDocumentVersionId = field(formData, 'evidenceDocumentVersionId');
  if (poId.length === 0) return { ok: false, message: 'メーカー発注書が選択されていません。' };
  if (evidenceDocumentVersionId.length === 0) {
    return { ok: false, message: '受領証跡（acceptance_evidence）の書類バージョンを選択してください。' };
  }
  const body: Record<string, unknown> = { evidenceDocumentVersionId };
  const acceptedAt = field(formData, 'acceptedAt');
  if (acceptedAt.length > 0) body.acceptedAt = acceptedAt;
  return post(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/accept-evidence`, body);
}
