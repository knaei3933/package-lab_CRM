import { cookies } from 'next/headers';
import { decodeReceiptNotice, encodeReceiptNotice, RECEIPT_NOTICE_COOKIE, RECEIPT_NOTICE_MAX_AGE_SECONDS } from './receipt-notice';
import type { ReceiptNotice, ReceiptNoticeReason } from './receipt-notice';

/** p4/web4: the notice of THIS order (the order screen reads it for the step it draws). */
export async function readReceiptNotice(orderId: string): Promise<ReceiptNotice | null> {
  try {
    return decodeReceiptNotice((await cookies()).get(RECEIPT_NOTICE_COOKIE)?.value, orderId);
  } catch {
    return null;
  }
}

/** p4/web4: set from a server action only (the confirmation stopped and the step is drawn again). */
export async function rememberReceiptNotice(orderId: string, reason: ReceiptNoticeReason, now: Date = new Date()): Promise<void> {
  try {
    (await cookies()).set(RECEIPT_NOTICE_COOKIE, encodeReceiptNotice({ orderId, reason, at: now.toISOString() }), {
      path: '/', httpOnly: true, sameSite: 'lax', maxAge: RECEIPT_NOTICE_MAX_AGE_SECONDS
    });
  } catch {
    // Display only: a notice that cannot be kept never changes the action's own answer.
  }
}

/** p4/web4: this order's deliveries were confirmed — its notice is over (another order's notice is left alone). */
export async function forgetReceiptNotice(orderId: string): Promise<void> {
  try {
    const store = await cookies();
    if (decodeReceiptNotice(store.get(RECEIPT_NOTICE_COOKIE)?.value, orderId)) store.delete(RECEIPT_NOTICE_COOKIE);
  } catch {
    // Display only (as above).
  }
}
