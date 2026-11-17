'use server';

import { callApi } from '../../lib/api';
import { offsetDateTimeField } from '../../lib/datetime';
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

const dateTimeField = offsetDateTimeField;

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

/**
 * Screen 3: register the manual send evidence (staff work). M8-UI2: the
 * evidence itself is the original .eml — either posted inline from the screen
 * (contentBase64, the API files it as the paper's send_evidence document) or
 * cited as a document version already registered on the 文書 screen. Both
 * shapes are the API's own contract; a timestamp without evidence stays out of
 * this form on purpose, because the API parks such a send in SEND_UNVERIFIED.
 */
export async function recordMakerPoSendEvidenceAction(
  _prev: ActionState | null,
  formData: FormData
): Promise<ActionState> {
  const poId = field(formData, 'poId');
  const evidenceDocumentVersionId = field(formData, 'evidenceDocumentVersionId');
  const contentBase64 = field(formData, 'contentBase64');
  const senderAddress = field(formData, 'senderAddress');
  const recipientsRaw = field(formData, 'recipients');
  const sentAt = dateTimeField(formData, 'sentAt');
  if (poId.length === 0) return { ok: false, message: 'メーカー発注書が選択されていません。' };
  if (contentBase64.length === 0 && evidenceDocumentVersionId.length === 0) {
    return {
      ok: false,
      message: '送信証跡がありません。Thunderbirdの送信済みフォルダから書き出した原本のEML（.eml）をこのフォームで選ぶか、文書画面に登録済みの送信証跡（send_evidence）の書類バージョンを選択してください。PDFやスクリーンショット、メモでは送信は「確認済み」になりません。'
    };
  }
  if (senderAddress.length === 0) return { ok: false, message: '送信元アドレスを入力してください。' };
  const recipients = recipientsRaw.split(/[,;、\s]+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (recipients.length === 0) return { ok: false, message: '宛先アドレスを1件以上入力してください。' };
  if (sentAt.length === 0) return { ok: false, message: '送信日時を入力してください。' };
  const body: Record<string, unknown> = { senderAddress, recipients, sentAt };
  if (contentBase64.length > 0) {
    body.contentBase64 = contentBase64;
  } else {
    body.evidenceDocumentVersionId = evidenceDocumentVersionId;
  }
  return post(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/send-evidence`, body);
}

/**
 * M8-UI2: the representative's manual confirmation of a send event the EML
 * check could not settle on its own (PENDING_MANUAL_VERIFICATION). The API
 * requires the verifier's name, the moment of the check, the result and the
 * grounds, and refuses anything but a pending send event — the screen forwards
 * those fields with an explicit timestamp offset and shows the API's own
 * refusal when the target is not pending anymore.
 */
export async function verifyMakerPoSendAction(
  _prev: ActionState | null,
  formData: FormData
): Promise<ActionState> {
  const eventId = field(formData, 'eventId');
  const result = field(formData, 'result');
  const verifierName = field(formData, 'verifierName');
  const verifiedAt = dateTimeField(formData, 'verifiedAt');
  const reasonNote = field(formData, 'reasonNote');
  if (eventId.length === 0) return { ok: false, message: '確認対象の送信イベントが選択されていません。' };
  if (!['confirmed', 'rejected'].includes(result)) {
    return { ok: false, message: '確認結果（confirmed／rejected）を選択してください。' };
  }
  if (verifierName.length === 0) return { ok: false, message: '検証者名（verifierName）を入力してください。' };
  if (verifiedAt.length === 0) return { ok: false, message: '検証日時（verifiedAt）を入力してください。' };
  if (reasonNote.length === 0) {
    return { ok: false, message: '根拠（reasonNote）を入力してください。何を確認して納品を断定したかを記録してください。' };
  }
  return post(`/api/maker-po-events/${encodeURIComponent(eventId)}/send-manual-verification`, {
    result,
    verifierName,
    verifiedAt,
    reasonNote
  });
}

/**
 * M8-UI2: cancel live paper (admin only). The API needs the reason and refuses
 * the states a cancellation cannot leave (already accepted, unproven send).
 */
export async function cancelMakerPoAction(_prev: ActionState | null, formData: FormData): Promise<ActionState> {
  const poId = field(formData, 'poId');
  const note = field(formData, 'note');
  if (poId.length === 0) return { ok: false, message: 'メーカー発注書が選択されていません。' };
  if (note.length === 0) {
    return { ok: false, message: '取消理由（note）は必須です。訂正・再発注の理由を記録してください。' };
  }
  return post(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/cancel`, { note });
}

/**
 * M8-UI2: the representative's acknowledgement of a cancelled paper whose send
 * was proven (取消承認). It is the record that re-opens the ordering step, so
 * the reason is mandatory; the maker-side proof and the moment are optional,
 * exactly as the endpoint accepts them.
 */
export async function acknowledgeMakerPoCancellationAction(
  _prev: ActionState | null,
  formData: FormData
): Promise<ActionState> {
  const poId = field(formData, 'poId');
  const note = field(formData, 'note');
  const acknowledgedAt = dateTimeField(formData, 'acknowledgedAt');
  const evidenceDocumentVersionId = field(formData, 'evidenceDocumentVersionId');
  if (poId.length === 0) return { ok: false, message: 'メーカー発注書が選択されていません。' };
  if (note.length === 0) {
    return { ok: false, message: '承認理由（note）は必須です。取り消しを確認した根拠を記録してください。' };
  }
  const body: Record<string, unknown> = { note };
  if (acknowledgedAt.length > 0) body.acknowledgedAt = acknowledgedAt;
  if (evidenceDocumentVersionId.length > 0) body.evidenceDocumentVersionId = evidenceDocumentVersionId;
  return post(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/cancellation-acknowledgement`, body);
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
  const acceptedAt = dateTimeField(formData, 'acceptedAt');
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
  const acceptedAt = dateTimeField(formData, 'acceptedAt');
  if (acceptedAt.length > 0) body.acceptedAt = acceptedAt;
  return post(`/api/maker-purchase-orders/${encodeURIComponent(poId)}/accept-evidence`, body);
}
