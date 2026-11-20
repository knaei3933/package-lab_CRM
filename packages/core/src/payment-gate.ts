/**
 * M7-SEC3 FIX 3: the G6 payment gate (design "G6 결제 조건").
 *
 * The design conditions the maker purchase order on the transaction terms of
 * the film supply order being settled before the paper is approved: the order
 * must carry a confirmed payment term (선입금/ prepaid, or a confirmed
 * on-delivery term), and approval work is only ever "발주 초안까지만" — the
 * terms are set while the order is still a draft and are never renegotiated
 * after the chain has started moving.
 *
 * The rules this module owns, all pure so the gate stays unit-testable:
 * - the vocabulary of payment terms: 'prepaid' | 'on_delivery' |
 *   'undetermined'. Absence of data normalizes to 'undetermined', never to a
 *   confirmed term — an unrecorded term is an undetermined one;
 * - the gate itself: 'undetermined' closes G6, so the CEO approval of the maker
 *   purchase order is refused with PAYMENT_GATE_UNSATISFIED until the term is
 *   recorded. A closed gate is a recorded decision, not a default.
 */

export const PAYMENT_TERMS_VALUES = ['prepaid', 'on_delivery', 'undetermined'] as const;

export type PaymentTerms = (typeof PAYMENT_TERMS_VALUES)[number];

/** The term every order starts with: nothing confirmed yet. */
export const DEFAULT_PAYMENT_TERMS: PaymentTerms = 'undetermined';

export type PaymentTermsValidation<T extends PaymentTerms> =
  | { ok: true; value: T }
  | { ok: false; code: 'UNKNOWN_PAYMENT_TERMS'; message: string };

/**
 * Validates a client-supplied payment term. `null` and `undefined` are not
 * accepted as input: a client that omits the field gets the default through
 * normalization, not through this validator, so an explicitly wrong value can
 * never slip through as "unset".
 */
export function validatePaymentTermsInput(value: unknown): PaymentTermsValidation<PaymentTerms> {
  if (typeof value !== 'string' || !(PAYMENT_TERMS_VALUES as readonly string[]).includes(value)) {
    return {
      ok: false,
      code: 'UNKNOWN_PAYMENT_TERMS',
      message: `paymentTerms must be one of ${PAYMENT_TERMS_VALUES.join(', ')}; received ${String(value)}`
    };
  }
  return { ok: true, value: value as PaymentTerms };
}

/** Absence of a stored term reads as 'undetermined', never as a confirmed one. */
export function normalizePaymentTerms(value: string | null | undefined): PaymentTerms {
  if (typeof value !== 'string' || !(PAYMENT_TERMS_VALUES as readonly string[]).includes(value)) {
    return DEFAULT_PAYMENT_TERMS;
  }
  return value as PaymentTerms;
}

export interface PaymentGateInput {
  /** The stored term of the order; null/undefined reads as 'undetermined'. */
  paymentTerms: string | null | undefined;
}

export type PaymentGate =
  | { ok: true; gatedOn: 'payment_terms_recorded'; paymentTerms: PaymentTerms }
  | {
      ok: false;
      code: 'PAYMENT_GATE_UNSATISFIED';
      paymentTerms: PaymentTerms;
      message: string;
    };

/**
 * G6: the maker purchase order approval requires a confirmed transaction term.
 * Only 'undetermined' closes the gate — 'prepaid' and 'on_delivery' are both
 * confirmed terms per the design, so either one opens it.
 */
export function evaluatePaymentGate(input: PaymentGateInput): PaymentGate {
  const paymentTerms = normalizePaymentTerms(input.paymentTerms);
  if (paymentTerms === DEFAULT_PAYMENT_TERMS) {
    return {
      ok: false,
      code: 'PAYMENT_GATE_UNSATISFIED',
      paymentTerms,
      message:
        '支払条件が「未定」のため代表承認できません。フィルム発注の支払条件を「前払い」または「納品後払い」に変更してから承認してください'
    };
  }
  return { ok: true, gatedOn: 'payment_terms_recorded', paymentTerms };
}

/** P0 R01: Japanese labels for the payment terms (never shown as raw enum values). */
export const PAYMENT_TERMS_LABELS_JA: Readonly<Record<PaymentTerms, string>> = {
  prepaid: '前払い',
  on_delivery: '納品後払い',
  undetermined: '未定'
};

/**
 * P0 R01 (policy P-5): the payment terms stay editable by the assigned staff and
 * the representative until the representative approves a maker purchase order
 * for the film order. After that approval the terms are the ones the paper was
 * approved against, and correcting them means cancelling the paper and
 * approving a new one. Exception states (hold / change review / cancellation
 * review) and the cancelled end state freeze the order, so the terms freeze too.
 */
export const PAYMENT_TERMS_EDITABLE_ORDER_STATES = [
  'DRAFT',
  'SEVEN_PO_VERIFIED',
  'ARTWORK_RECEIVED',
  'PROOF_READY',
  'APPROVAL_PENDING',
  'DUAL_APPROVED',
  'MAKER_PO_READY'
] as const;

export type PaymentTermsChangeGate =
  | { ok: true }
  | {
      ok: false;
      code: 'PAYMENT_TERMS_LOCKED';
      reason: 'order_frozen' | 'ceo_approved';
      message: string;
    };

export function evaluatePaymentTermsChange(input: {
  orderStatus: string;
  /** True when a non-cancelled maker PO of the order carries a CEO approval. */
  approvedPaperExists: boolean;
}): PaymentTermsChangeGate {
  if (input.approvedPaperExists
    || !(PAYMENT_TERMS_EDITABLE_ORDER_STATES as readonly string[]).includes(input.orderStatus)) {
    const frozen = ['ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW', 'CANCELLED'].includes(input.orderStatus);
    return frozen && !input.approvedPaperExists
      ? {
          ok: false,
          code: 'PAYMENT_TERMS_LOCKED',
          reason: 'order_frozen',
          message: '保留・見直し中または取消終了の発注は支払条件を変更できません。状態を解決してから変更してください'
        }
      : {
          ok: false,
          code: 'PAYMENT_TERMS_LOCKED',
          reason: 'ceo_approved',
          message: '代表承認済みのメーカー発注書があるため、支払条件は変更できません。変更する場合はメーカー発注書を取り消して作り直してください'
        };
  }
  return { ok: true };
}
