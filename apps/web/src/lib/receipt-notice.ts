import { deliveryEvidenceBoundState } from './step-messages';

/**
 * p4/web4: why the last delivery confirmation of this order stopped, kept across the redraw (the same mechanism as the
 * approval card's notice, lib/approval-notice). The single-submit 「納品を記録する」 stores the delivery and the receipt
 * evidence first and is refused at the confirmation (422 DELIVERY_EVIDENCE_MAKER_PO_BOUND); the order then moves to
 * 納品済み, the step panel is mounted again and the form's own result line is dropped. The reason therefore rides in a
 * short-lived, httpOnly cookie bound to the order, and step 12 says it at the top until the deliveries are confirmed.
 *
 * Display only: the cookie holds an order id, a reason code and a time — never a rule, a hash or an amount.
 */
export const RECEIPT_NOTICE_COOKIE = 'kanei_receipt_notice';
export const RECEIPT_NOTICE_MAX_AGE_SECONDS = 600;

export type ReceiptNoticeReason = 'maker_po_bound';

export interface ReceiptNotice {
  orderId: string;
  reason: ReceiptNoticeReason;
  at: string;
}

const REASONS: readonly ReceiptNoticeReason[] = ['maker_po_bound'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function encodeReceiptNotice(notice: ReceiptNotice): string {
  return `${notice.orderId}|${notice.reason}|${notice.at}`;
}

/** Pure: the cookie back to a notice; anything malformed (or another order's) is no notice. */
export function decodeReceiptNotice(value: string | null | undefined, orderId?: string): ReceiptNotice | null {
  if (typeof value !== 'string' || value.length > 120) return null;
  const [id, reason, at, extra] = value.split('|');
  if (extra !== undefined || !id || !UUID.test(id) || !reason || !REASONS.includes(reason as ReceiptNoticeReason) || !at || !ISO.test(at)) return null;
  if (orderId !== undefined && id !== orderId) return null;
  return { orderId: id, reason: reason as ReceiptNoticeReason, at };
}

/** The sentence step 12 says (Japanese, with its Korean line for the bilingual mode): the refusal's own words, the form is below. */
export function receiptNoticeText(reason: ReceiptNoticeReason): { ja: string; ko: string } {
  switch (reason) {
    case 'maker_po_bound': {
      const state = deliveryEvidenceBoundState({ alternativeBelow: true });
      return { ja: state.message, ko: state.messageKo ?? '' };
    }
  }
}
