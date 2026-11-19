import { PAYMENT_TERMS_LABELS } from './maker-po-data';
import type { MakerPoViewRow } from './maker-po-data';
import type { FilmOrderHoldView, FilmSupplyOrderView } from './project-data';
import { HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT } from './redaction';
import { formatMoney, formatTimestamp } from './vocabulary';

/**
 * UI batch E (F-08, F-11, F-23): the facts a representative decision rests on,
 * listed in the confirm dialog (ConfirmOptions.facts) before the record is
 * filed. Pure functions over what the API already showed this role.
 */

export interface DecisionFact {
  label: string;
  value: string;
}

/**
 * UI batch E (F-08): the facts the representative approves — the dialog lists
 * them before 「代表承認を記録する」, because the approval is a money decision
 * that cannot be undone. Only what the API showed this role is listed (the
 * amount is in the admin answer only); a missing value reads 「（記録なし）」.
 */
export function ceoApprovalFacts(
  po: Pick<MakerPoViewRow, 'orderCode' | 'recipientAddress' | 'snapshot'>,
  orderCode: string,
  paymentTerms: string | null
): DecisionFact[] {
  const amounts = po.snapshot?.amounts ?? null;
  return [
    { label: '発注コード', value: po.snapshot?.order?.code ?? po.orderCode ?? orderCode },
    { label: '宛先（メーカーの送り先）', value: po.snapshot?.recipient?.address ?? po.recipientAddress ?? '（記録なし）' },
    { label: '金額', value: amounts ? formatMoney(amounts.currency, amounts.totalAmount) : '（記録なし）' },
    { label: '決済条件', value: paymentTerms ? PAYMENT_TERMS_LABELS[paymentTerms] ?? paymentTerms : '（確認できません）' }
  ];
}


/**
 * UI batch E3: the 決済条件 of one film order as the audit history showed this
 * role — 「前払い」, 「（閲覧権限なし）」 when withheld, 「（未記録）」 otherwise.
 * A recorded term is never a 入金確認.
 */
export function paymentTermsText(order: Pick<FilmSupplyOrderView, 'paymentTerms' | 'paymentTermsHidden'>): string {
  if (order.paymentTerms) return PAYMENT_TERMS_LABELS[order.paymentTerms] ?? order.paymentTerms;
  return order.paymentTermsHidden ? HIDDEN_BY_ROLE_LABEL : '（未記録）';
}

/** UI batch E (F-11): the hold reason as the role may read it. */
function holdReasonText(hold: FilmOrderHoldView): string {
  if (hold.reason) return hold.reason;
  return hold.reasonHidden ? `（${HIDDEN_BY_ROLE_SHORT}）` : '（記録なし）';
}

/**
 * UI batch E (F-11): one line under the 保留中 badge —
 * 「保留の理由: 色見本の再確認待ち（山田 が 2026/11/19 10:00 JST に保留）」.
 */
export function holdSummaryText(hold: FilmOrderHoldView): string {
  const who = hold.actorName ? `${hold.actorName} が ` : '';
  return `保留の理由: ${holdReasonText(hold)}（${who}${formatTimestamp(hold.at)} に保留）`;
}

/** UI batch E (F-11): the rows the 保留解除 dialog lists before the typed reason. */
export function holdReleaseFacts(order: Pick<FilmSupplyOrderView, 'code' | 'hold'>): DecisionFact[] {
  const hold = order.hold ?? null;
  return [
    { label: '発注コード', value: order.code },
    { label: '保留の理由', value: hold ? holdReasonText(hold) : '（確認できません）' },
    { label: '保留した人・日時', value: hold ? `${hold.actorName ?? '（不明）'}／${formatTimestamp(hold.at)}` : '（確認できません）' }
  ];
}
