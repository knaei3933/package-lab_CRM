/**
 * P4 H4① (conductor decision, 2026-11-23): the representative approves a maker
 * PO only with its 金額 and its 希望納期 on record. Until P4 the approval
 * card let the representative approve with 「金額未入力のまま承認する」 and a
 * 「未記録」 delivery date. The gate sits next to G6 (支払条件) and is decided by
 * this one pure function, so the approval endpoint (before and under its row
 * lock), the approval card's blockers and the representative queue agree.
 *
 * Not one of the four representative-confirmed server rules; the amount stays
 * admin-only (only the representative writes or reads it), and a refusal is a
 * 4xx, so no Idempotency-Key answer is stored and a corrected retry runs.
 */
export type CeoApprovalMissingFact = 'totalAmount' | 'requestedDeliveryDate';

export interface CeoApprovalFactsInput {
  /** The paper's frozen amounts (snapshot.amounts); null when none was entered. */
  amounts: { currency?: unknown; totalAmount?: unknown } | null | undefined;
  /** The order's 希望納期 (YYYY-MM-DD) or null. */
  requestedDeliveryDate: string | null | undefined;
}

export type CeoApprovalFactsGate =
  | { ok: true }
  | {
      ok: false;
      /** The first missing fact decides the code: the amount before the date. */
      code: 'AMOUNT_REQUIRED' | 'DELIVERY_DATE_REQUIRED';
      message: string;
      /** Every missing fact, so one screen can ask for both at once. */
      missing: CeoApprovalMissingFact[];
    };

export const CEO_APPROVAL_FACT_MESSAGES = {
  AMOUNT_REQUIRED: '金額が入力されていないため代表承認できません。承認画面で金額を入力してから承認してください',
  DELIVERY_DATE_REQUIRED: '希望納期が記録されていないため代表承認できません。発注の「希望納期」を入力してから承認してください'
} as const;

export function evaluateCeoApprovalFacts(input: CeoApprovalFactsInput): CeoApprovalFactsGate {
  const missing: CeoApprovalMissingFact[] = [];
  const amount = input.amounts?.totalAmount;
  const currency = input.amounts?.currency;
  const hasAmount = typeof amount === 'string' && amount.trim().length > 0
    && typeof currency === 'string' && currency.trim().length > 0;
  if (!hasAmount) missing.push('totalAmount');
  const date = input.requestedDeliveryDate;
  if (typeof date !== 'string' || date.trim().length === 0) missing.push('requestedDeliveryDate');
  if (missing.length === 0) return { ok: true };
  const code = missing[0] === 'totalAmount' ? 'AMOUNT_REQUIRED' : 'DELIVERY_DATE_REQUIRED';
  return { ok: false, code, message: CEO_APPROVAL_FACT_MESSAGES[code], missing };
}
