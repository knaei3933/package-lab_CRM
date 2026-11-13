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
        '決済条件（G6）が未確定のため承認できません。取引条件（paymentTerms: prepaid / on_delivery）を発注に設定してから代表承認してください'
    };
  }
  return { ok: true, gatedOn: 'payment_terms_recorded', paymentTerms };
}
