import type { ApprovalNotice, ApprovalNoticeReason } from './approval-card';
import { webErrorText } from './error-dictionary';

/**
 * p4/web3 (web review (b), p4-web2b REVIEW L-1): why a 代表承認 from the card stopped, kept across the
 * redraw. A refusal that changes what the card shows (the evidence set or the paper changed: 409
 * MAKER_PO_SNAPSHOT_CHANGED; the API's 422 AMOUNT_REQUIRED / DELIVERY_DATE_REQUIRED) redraws the order
 * screen, and the step panel is mounted again (its key follows the newest record), which drops the
 * form's result line. The reason therefore rides in a short-lived, httpOnly cookie bound to the paper,
 * and the card says it at the top until the paper is approved or the cookie expires.
 *
 * Display only: the cookie holds a paper id, a reason code and a time — never a rule, a hash or an amount.
 */
export const APPROVAL_NOTICE_COOKIE = 'kanei_approval_notice';
export const APPROVAL_NOTICE_MAX_AGE_SECONDS = 600;

const REASONS: readonly ApprovalNoticeReason[] = ['evidence_changed', 'content_changed', 'amount_required', 'delivery_date_required'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function encodeApprovalNotice(notice: ApprovalNotice): string {
  return `${notice.poId}|${notice.reason}|${notice.at}`;
}

/** Pure: the cookie back to a notice; anything malformed (or another paper's) is no notice. */
export function decodeApprovalNotice(value: string | null | undefined, poId?: string): ApprovalNotice | null {
  if (typeof value !== 'string' || value.length > 120) return null;
  const [id, reason, at, extra] = value.split('|');
  if (extra !== undefined || !id || !UUID.test(id) || !reason || !REASONS.includes(reason as ApprovalNoticeReason) || !at || !ISO.test(at)) return null;
  if (poId !== undefined && id !== poId) return null;
  return { poId: id, reason: reason as ApprovalNoticeReason, at };
}

/** The sentence the card says (Japanese, with its Korean line for the bilingual mode). */
export function approvalNoticeText(reason: ApprovalNoticeReason): { ja: string; ko: string } {
  switch (reason) {
    case 'evidence_changed':
      return {
        ja: '承認カードを開いたあとに承認証跡が変わりました（承認の記録し直し、または別の証跡）。承認は記録されていません。押印欄の証跡・差出人・警告を確かめてから、もう一度承認してください。',
        ko: '승인 카드를 연 뒤에 승인 증빙이 바뀌었습니다(승인 재기록 또는 다른 증빙). 승인은 기록되지 않았습니다. 날인란의 증빙·발신자·경고를 확인한 뒤 다시 승인하세요.'
      };
    case 'content_changed':
      return {
        ja: '承認カードを開いたあとに発注書の内容（明細・版）が変わりました。承認は記録されていません。内容を確かめてから、もう一度承認してください。',
        ko: '승인 카드를 연 뒤에 발주서 내용(명세·판)이 바뀌었습니다. 승인은 기록되지 않았습니다. 내용을 확인한 뒤 다시 승인하세요.'
      };
    case 'amount_required': {
      const text = webErrorText('AMOUNT_REQUIRED');
      return { ja: `承認は記録されていません。${text.message}`, ko: `승인은 기록되지 않았습니다. ${text.messageKo ?? ''}`.trim() };
    }
    case 'delivery_date_required': {
      const text = webErrorText('DELIVERY_DATE_REQUIRED');
      return { ja: `承認は記録されていません。${text.message}`, ko: `승인은 기록되지 않았습니다. ${text.messageKo ?? ''}`.trim() };
    }
  }
}
