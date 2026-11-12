import { FILM_SUPPLY_ORDER_TERMINAL_STATE, transitionFilmSupplyOrder } from './state-machine.js';
import type { NormalFilmSupplyOrderState } from './state-machine.js';

/**
 * M5 film receipt assumption (design sections 5.5, 6.1 and 13 item 1).
 *
 * FILM_DELIVERED → FILM_RECEIPT_ASSUMED_NO_ISSUE is a MANUAL recording action,
 * never an automatic one: the waiting period after delivery is not decided by
 * the CEO yet (design section 13 item 1), so nothing in the system schedules,
 * times or derives this transition. It happens exactly when an admin or staff
 * member records it — with a required note and an explicit acknowledgment that
 * no evidence document is attached — and the state machine accepts it only
 * from FILM_DELIVERED.
 */

/** The one state the receipt assumption may be recorded from. */
export const FILM_RECEIPT_ASSUMPTION_SOURCE_STATE: NormalFilmSupplyOrderState = 'FILM_DELIVERED';

/**
 * True only for the source state. The generic state machine still owns the
 * transition table; this predicate is the narrower contract the recording
 * action enforces, so a hold or change review can never assume a receipt.
 */
export function canAssumeFilmReceipt(currentStatus: string): boolean {
  return currentStatus === FILM_RECEIPT_ASSUMPTION_SOURCE_STATE;
}

export interface FilmReceiptAssumptionInput {
  currentStatus: string;
  /** The required human note explaining the assumption (blank is refused). */
  note: unknown;
  /** The explicit evidence-free acknowledgment; must be exactly true. */
  acknowledgeNoEvidence: unknown;
  /** Optional recorded receipt_assumed_at; defaults to the recording moment. */
  assumedAt?: Date | string | null;
}

export type FilmReceiptAssumptionEvaluation =
  | { ok: true; to: typeof FILM_SUPPLY_ORDER_TERMINAL_STATE; receiptAssumedAt: Date | string }
  | {
      ok: false;
      code:
        | 'RECEIPT_ASSUMPTION_ONLY_FROM_FILM_DELIVERED'
        | 'RECEIPT_ASSUMPTION_NOTE_REQUIRED'
        | 'RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED'
        | 'INVALID_RECEIPT_ASSUMED_AT';
      message: string;
    };

function isNonBlankNote(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Evaluates the manual receipt-assumption recording request. Request shape
 * first, then the state machine: a well-formed request from any state other
 * than FILM_DELIVERED is refused with
 * RECEIPT_ASSUMPTION_ONLY_FROM_FILM_DELIVERED, and the transition itself is
 * checked against the shared state machine so this gate can never admit a
 * move the machine forbids.
 */
export function evaluateFilmReceiptAssumption(input: FilmReceiptAssumptionInput): FilmReceiptAssumptionEvaluation {
  if (!isNonBlankNote(input.note)) {
    return {
      ok: false,
      code: 'RECEIPT_ASSUMPTION_NOTE_REQUIRED',
      message: 'note is required: assuming a receipt without issue is a business decision that must say why'
    };
  }
  if (input.acknowledgeNoEvidence !== true) {
    return {
      ok: false,
      code: 'RECEIPT_ASSUMPTION_ACKNOWLEDGMENT_REQUIRED',
      message: 'acknowledgeNoEvidence must be true: this action records a receipt assumption without any evidence document'
    };
  }
  if (input.assumedAt !== null && input.assumedAt !== undefined) {
    const parsed = input.assumedAt instanceof Date
      ? input.assumedAt
      : typeof input.assumedAt === 'string'
        ? new Date(input.assumedAt)
        : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      return {
        ok: false,
        code: 'INVALID_RECEIPT_ASSUMED_AT',
        message: 'assumedAt must be an ISO 8601 timestamp when provided'
      };
    }
  }

  if (!canAssumeFilmReceipt(input.currentStatus)) {
    return {
      ok: false,
      code: 'RECEIPT_ASSUMPTION_ONLY_FROM_FILM_DELIVERED',
      message: `a film supply order in ${input.currentStatus} cannot assume a receipt; the assumption is recorded only from FILM_DELIVERED`
    };
  }

  const transition = transitionFilmSupplyOrder(
    FILM_RECEIPT_ASSUMPTION_SOURCE_STATE,
    FILM_SUPPLY_ORDER_TERMINAL_STATE
  );
  if (!transition.ok) {
    return {
      ok: false,
      code: 'RECEIPT_ASSUMPTION_ONLY_FROM_FILM_DELIVERED',
      message: 'the state machine does not allow FILM_DELIVERED to move to FILM_RECEIPT_ASSUMED_NO_ISSUE'
    };
  }

  const assumedAt = input.assumedAt === null || input.assumedAt === undefined
    ? new Date()
    : input.assumedAt instanceof Date
      ? input.assumedAt
      : new Date(input.assumedAt);
  return { ok: true, to: FILM_SUPPLY_ORDER_TERMINAL_STATE, receiptAssumedAt: assumedAt };
}
