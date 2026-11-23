/**
 * M5 commission readiness and delivery confirmation (design sections 5.5, 6.4
 * and test T-36).
 *
 * Commission money is computed only from deliveries whose receipt can be
 * proven. A recorded delivery row alone is never enough: until a verified
 * delivery evidence document is bound to it, the delivery stays in the
 * pending-confirmation state and the project's commission readiness stays in
 * MISSING_DATA or PENDING_VERIFICATION. No code path may escalate readiness or
 * calculate a commission as a side effect of recording a delivery — readiness
 * moves only when this module's evaluation is invoked explicitly by the
 * evaluate endpoint, and the evaluation is a pure function over observed
 * facts that writes nothing.
 */

export const COMMISSION_READINESS_STATES = ['MISSING_DATA', 'PENDING_VERIFICATION', 'READY'] as const;

export type CommissionReadinessState = (typeof COMMISSION_READINESS_STATES)[number];

/**
 * A delivery that exists but has no delivery evidence yet. This is the
 * "pending confirmation" state of design section 6.4: the row is recorded, the
 * receipt is not.
 */
export const FILLING_DELIVERY_CONFIRMATION_STATES = ['PENDING_CONFIRMATION', 'CONFIRMED'] as const;

export type FillingDeliveryConfirmationState =
  (typeof FILLING_DELIVERY_CONFIRMATION_STATES)[number];

export function fillingDeliveryConfirmationState(hasEvidence: boolean): FillingDeliveryConfirmationState {
  return hasEvidence ? 'CONFIRMED' : 'PENDING_CONFIRMATION';
}

export interface CommissionReadinessInput {
  /** At least one film delivery is recorded for the project. */
  filmDeliveryRecorded: boolean;
  /** At least one filling delivery is recorded for the project. */
  fillingDeliveryRecorded: boolean;
  /** At least one seven purchase order carries official_registered_at. */
  sevenPoOfficiallyRegistered: boolean;
  /** Every recorded film delivery is backed by verified delivery evidence. */
  filmDeliveryConfirmed: boolean;
  /** Every recorded filling delivery is backed by verified delivery evidence. */
  fillingDeliveryConfirmed: boolean;
  /**
   * P1 policy P-3: false for a film-only project (no filling order exists). The
   * filling requirement is then 対象外 and readiness is judged on the confirmed
   * delivered film quantity alone. Omitted means the filling-linked rule.
   */
  fillingApplicable?: boolean;
  /**
   * P1 review H1 (P-3: the commission is fixed after the delivered quantity is
   * fixed). Read only for a film-only project: how many live film orders the
   * project has, how many of them have no delivery at all, and how many are
   * delivered short (a line confirmed below its ordered quantity while the
   * order was not closed as delivered). Omitted means none of each.
   */
  filmOrders?: { total: number; withoutDelivery: number; quantityIncomplete: number };
}

export interface CommissionReadinessEvaluation {
  state: CommissionReadinessState;
  /** True only in READY; commission calculation may start exactly then. */
  isReady: boolean;
  /** Machine-readable reasons the project is not READY yet (empty in READY). */
  blocking: Array<
    | 'FILM_DELIVERY_NOT_RECORDED'
    | 'FILLING_DELIVERY_NOT_RECORDED'
    | 'SEVEN_PO_NOT_OFFICIALLY_REGISTERED'
    | 'FILM_DELIVERY_PENDING_CONFIRMATION'
    | 'FILLING_DELIVERY_PENDING_CONFIRMATION'
    | 'FILM_ORDER_NOT_DELIVERED'
    | 'FILM_DELIVERY_QUANTITY_INCOMPLETE'
  >;
}

/**
 * The explicit readiness evaluation (T-36). MISSING_DATA is reserved for data
 * that is absent entirely: no delivery recorded at all, or the seven purchase
 * order not officially registered. The moment any delivery exists the project
 * is at least PENDING_VERIFICATION — its evidence is pending, not missing —
 * and readiness must never be escalated to READY, neither by this function nor
 * by any caller that merely recorded a delivery.
 */
export function evaluateCommissionReadiness(input: CommissionReadinessInput): CommissionReadinessEvaluation {
  const fillingApplicable = input.fillingApplicable !== false;
  const blocking: CommissionReadinessEvaluation['blocking'] = [];
  if (!input.filmDeliveryRecorded) blocking.push('FILM_DELIVERY_NOT_RECORDED');
  if (fillingApplicable && !input.fillingDeliveryRecorded) blocking.push('FILLING_DELIVERY_NOT_RECORDED');
  if (!input.sevenPoOfficiallyRegistered) blocking.push('SEVEN_PO_NOT_OFFICIALLY_REGISTERED');

  // P1 P-3: a film-only project has nothing but film to deliver, so "no
  // delivery recorded" means no film delivery.
  const noDeliveryRecorded = fillingApplicable
    ? !input.filmDeliveryRecorded && !input.fillingDeliveryRecorded
    : !input.filmDeliveryRecorded;
  if (noDeliveryRecorded || !input.sevenPoOfficiallyRegistered) {
    return { state: 'MISSING_DATA', isReady: false, blocking };
  }

  if (!input.filmDeliveryConfirmed) blocking.push('FILM_DELIVERY_PENDING_CONFIRMATION');
  if (fillingApplicable && !input.fillingDeliveryConfirmed) blocking.push('FILLING_DELIVERY_PENDING_CONFIRMATION');
  // P1 review H1: a film-only project is ready only when every live film order
  // has its delivered quantity fixed — no order without a delivery, no order
  // delivered short. The filling-linked rule above is unchanged.
  if (!fillingApplicable) {
    const orders = input.filmOrders ?? { total: 0, withoutDelivery: 0, quantityIncomplete: 0 };
    if (orders.withoutDelivery > 0) blocking.push('FILM_ORDER_NOT_DELIVERED');
    if (orders.quantityIncomplete > 0) blocking.push('FILM_DELIVERY_QUANTITY_INCOMPLETE');
  }

  if (blocking.length > 0) return { state: 'PENDING_VERIFICATION', isReady: false, blocking };
  return { state: 'READY', isReady: true, blocking: [] };
}

/**
 * The only state in which a commission may be calculated. Everywhere else this
 * gate stays closed, so a pending-confirmation delivery can never turn into
 * commission money (T-36).
 */
export function isCommissionCalculationAllowed(state: CommissionReadinessState): boolean {
  return state === 'READY';
}

// ---------------------------------------------------------------------------
// Delivery evidence binding
// ---------------------------------------------------------------------------

/** The read model of the evidence document version a delivery confirmation cites. */
export interface DeliveryEvidenceDocument {
  projectId: string;
  documentType: string;
  /** Human verification recorded on the documents row; separate from the hash. */
  verificationStatus: string;
  /** The film supply order the document is bound to, when it carries one. */
  filmSupplyOrderId: string | null;
  /**
   * P4 server2 (review3 M-1, conductor decision): the maker PO the document is
   * bound to. An acceptance_evidence bound to a maker PO is the maker's 受入 of
   * the paper (step 10), never the customer's 受領 of the delivered film.
   */
  makerPurchaseOrderId?: string | null;
  /**
   * P4 server2 (review4 M-1, conductor decision): the cited bytes (SHA-256) are
   * the same as a version of a maker-PO-bound document of the same project —
   * the maker's acceptance re-uploaded without its binding (another file name).
   */
  contentMatchesMakerPoDocument?: boolean;
}

export interface DeliveryEvidenceContext {
  /** The project the delivered goods belong to. */
  order: { projectId: string; filmSupplyOrderId: string | null };
  /** The cited evidence document version, or null when the id does not resolve. */
  evidenceDocument: DeliveryEvidenceDocument | null;
}

export type DeliveryEvidenceEvaluation =
  | { ok: true; confirmedOn: 'verified_delivery_evidence' }
  | {
      ok: false;
      code:
        | 'DELIVERY_EVIDENCE_REQUIRED'
        | 'DELIVERY_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND'
        | 'DELIVERY_EVIDENCE_DOCUMENT_TYPE_INVALID'
        | 'DELIVERY_EVIDENCE_PROJECT_MISMATCH'
        | 'DELIVERY_EVIDENCE_ORDER_MISMATCH'
        | 'DELIVERY_EVIDENCE_MAKER_PO_BOUND'
        | 'DELIVERY_EVIDENCE_NOT_VERIFIED';
      message: string;
    };

/**
 * Evaluates the evidence a delivery confirmation cites. Delivery evidence is an
 * acceptance evidence document (受領証跡) of the same company, carrying a human
 * verification; a film delivery additionally requires the document to be bound
 * to exactly its film supply order. Anything else leaves the delivery in the
 * pending-confirmation state (T-36).
 */
export function evaluateDeliveryEvidence(
  evidenceDocumentVersionId: unknown,
  context: DeliveryEvidenceContext
): DeliveryEvidenceEvaluation {
  if (typeof evidenceDocumentVersionId !== 'string' || evidenceDocumentVersionId.length === 0) {
    return {
      ok: false,
      code: 'DELIVERY_EVIDENCE_REQUIRED',
      message: 'evidenceDocumentVersionId is required: a delivery is confirmed only from delivery evidence'
    };
  }

  const evidence = context.evidenceDocument;
  if (!evidence) {
    return {
      ok: false,
      code: 'DELIVERY_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND',
      message: 'the cited delivery evidence document version does not exist'
    };
  }
  if (evidence.documentType !== 'acceptance_evidence') {
    return {
      ok: false,
      code: 'DELIVERY_EVIDENCE_DOCUMENT_TYPE_INVALID',
      message: 'delivery evidence must be a document of type acceptance_evidence'
    };
  }
  if (evidence.projectId !== context.order.projectId) {
    return {
      ok: false,
      code: 'DELIVERY_EVIDENCE_PROJECT_MISMATCH',
      message: 'delivery evidence belongs to a different project (company)'
    };
  }
  if (
    context.order.filmSupplyOrderId !== null
    && evidence.filmSupplyOrderId !== context.order.filmSupplyOrderId
  ) {
    return {
      ok: false,
      code: 'DELIVERY_EVIDENCE_ORDER_MISMATCH',
      message: 'delivery evidence is bound to a different film supply order'
    };
  }
  // P4 server2 (review3 M-1, conductor decision): only the customer's receipt
  // evidence confirms a delivery. Checked before the verification so the
  // reason is the specific one even for a maker document nobody verified.
  if ((evidence.makerPurchaseOrderId !== undefined && evidence.makerPurchaseOrderId !== null)
    || evidence.contentMatchesMakerPoDocument === true) {
    return {
      ok: false,
      code: 'DELIVERY_EVIDENCE_MAKER_PO_BOUND',
      message: 'evidence bound to a maker purchase order is the maker\'s acceptance of the paper, not the customer\'s receipt of the delivery'
    };
  }
  if (evidence.verificationStatus !== 'verified') {
    return {
      ok: false,
      code: 'DELIVERY_EVIDENCE_NOT_VERIFIED',
      message: 'delivery evidence must carry a human verification (verificationStatus verified) before the delivery can be confirmed'
    };
  }
  return { ok: true, confirmedOn: 'verified_delivery_evidence' };
}
