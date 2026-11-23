import { cookies } from 'next/headers';
import type { ApprovalNotice, ApprovalNoticeReason } from './approval-card';
import { APPROVAL_NOTICE_COOKIE, APPROVAL_NOTICE_MAX_AGE_SECONDS, decodeApprovalNotice, encodeApprovalNotice } from './approval-notice';

/** p4/web3: the notice of THIS paper (the order screen reads it for the card it draws). */
export async function readApprovalNotice(poId: string): Promise<ApprovalNotice | null> {
  try {
    return decodeApprovalNotice((await cookies()).get(APPROVAL_NOTICE_COOKIE)?.value, poId);
  } catch {
    return null;
  }
}

/** p4/web3: set from a server action only (the approval stopped and the card is drawn again). */
export async function rememberApprovalNotice(poId: string, reason: ApprovalNoticeReason, now: Date = new Date()): Promise<void> {
  try {
    (await cookies()).set(APPROVAL_NOTICE_COOKIE, encodeApprovalNotice({ poId, reason, at: now.toISOString() }), {
      path: '/', httpOnly: true, sameSite: 'lax', maxAge: APPROVAL_NOTICE_MAX_AGE_SECONDS
    });
  } catch {
    // Display only: a notice that cannot be kept never changes the action's own answer.
  }
}

/** p4/web3: the paper was approved — the notice is over. */
export async function forgetApprovalNotice(): Promise<void> {
  try {
    const store = await cookies();
    if (store.get(APPROVAL_NOTICE_COOKIE)) store.delete(APPROVAL_NOTICE_COOKIE);
  } catch {
    // Display only (as above).
  }
}
