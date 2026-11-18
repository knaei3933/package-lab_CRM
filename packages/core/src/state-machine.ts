export type ProjectState = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

const PROJECT_TRANSITIONS: Record<ProjectState, readonly ProjectState[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['ARCHIVED'],
  ARCHIVED: []
};

export type TransitionResult<TFrom extends ProjectState, TTo extends ProjectState> =
  | { ok: true; from: TFrom; to: TTo }
  | { ok: false; from: ProjectState; to: ProjectState };

export function transitionProject<TFrom extends ProjectState, TTo extends ProjectState>(
  from: TFrom,
  to: TTo
): TransitionResult<TFrom, TTo> {
  const allowed = PROJECT_TRANSITIONS[from].includes(to);
  return allowed ? { ok: true, from, to } : { ok: false, from, to };
}

/**
 * M1 film supply order lifecycle (design sections 6.1 and 6.5).
 *
 * The normal chain runs from DRAFT to FILM_RECEIPT_ASSUMED_NO_ISSUE. The three
 * exception states are review side-channels: they are reachable from every
 * non-terminal normal state, and leaving them is an explicit business decision
 * that names the state work resumes in.
 */
export const FILM_SUPPLY_ORDER_STATES = [
  'DRAFT',
  'SEVEN_PO_VERIFIED',
  'ARTWORK_RECEIVED',
  'PROOF_READY',
  'APPROVAL_PENDING',
  'DUAL_APPROVED',
  'MAKER_PO_READY',
  'APPROVED_FOR_MANUAL_SEND',
  'MAKER_PO_SENT_MANUALLY',
  'MAKER_PO_ACCEPTED',
  'FILM_IN_PRODUCTION',
  'FILM_SHIPPED',
  'FILM_DELIVERED',
  'FILM_RECEIPT_ASSUMED_NO_ISSUE'
] as const;

export const FILM_SUPPLY_ORDER_EXCEPTION_STATES = ['ON_HOLD', 'CHANGE_REVIEW', 'CANCELLATION_REVIEW'] as const;

export type NormalFilmSupplyOrderState = (typeof FILM_SUPPLY_ORDER_STATES)[number];
export type ExceptionFilmSupplyOrderState = (typeof FILM_SUPPLY_ORDER_EXCEPTION_STATES)[number];
/** Admin-only resolution of CANCELLATION_REVIEW may end the film order here. */
export const FILM_ORDER_CANCELLATION_STATE = 'CANCELLED' as const;
export type CancelledFilmSupplyOrderState = typeof FILM_ORDER_CANCELLATION_STATE;
export type FilmSupplyOrderState = NormalFilmSupplyOrderState | ExceptionFilmSupplyOrderState;
export type FilmOrderStatus = FilmSupplyOrderState | CancelledFilmSupplyOrderState;

export const FILM_SUPPLY_ORDER_TERMINAL_STATE: NormalFilmSupplyOrderState = 'FILM_RECEIPT_ASSUMED_NO_ISSUE';
export const FILM_SUPPLY_ORDER_TERMINAL_STATES = [
  FILM_SUPPLY_ORDER_TERMINAL_STATE,
  FILM_ORDER_CANCELLATION_STATE
] as const;

/**
 * A legacy hold without an audit trail can be released only to a state at or
 * before maker acceptance. Later states additionally require accepted paper and
 * are therefore outside this explicit recovery vocabulary.
 */
export const LEGACY_HOLD_RELEASE_TARGETS = FILM_SUPPLY_ORDER_STATES
  .slice(0, FILM_SUPPLY_ORDER_STATES.indexOf('MAKER_PO_ACCEPTED') + 1) as readonly NormalFilmSupplyOrderState[];

export function isLegacyHoldReleaseTarget(value: unknown): value is NormalFilmSupplyOrderState {
  return typeof value === 'string'
    && (LEGACY_HOLD_RELEASE_TARGETS as readonly string[]).includes(value);
}

export type CancellationReviewOutcome = 'resume' | 'cancel';

export type CancellationReviewResolution<T extends FilmOrderStatus = FilmOrderStatus> =
  | { ok: true; outcome: CancellationReviewOutcome; target: T }
  | {
    ok: false;
    code: 'CANCELLATION_RESUME_REQUIRED' | 'CANCELLATION_RESUME_TARGET_INVALID';
    message: string;
  };

/**
 * A known cancellation-review origin resumes exactly once; a maker-chain origin
 * is deliberately allowed here because the dedicated resolution endpoint—not
 * the generic transition API—is the safe way out of that dead end. Unknown
 * legacy rows must name one of the same conservative targets as legacy holds.
 */
export function resolveCancellationReview(
  outcome: CancellationReviewOutcome,
  origin: NormalFilmSupplyOrderState | null | undefined,
  requestedResume?: unknown
): CancellationReviewResolution {
  if (outcome === 'cancel') {
    return { ok: true, outcome, target: FILM_ORDER_CANCELLATION_STATE };
  }

  if (origin) {
    if (requestedResume !== undefined && requestedResume !== origin) {
      return {
        ok: false,
        code: 'CANCELLATION_RESUME_TARGET_INVALID',
        message: 'cancellation review can resume only to its exact entry origin'
      };
    }
    return { ok: true, outcome, target: origin };
  }

  if (requestedResume === undefined || requestedResume === null) {
    return {
      ok: false,
      code: 'CANCELLATION_RESUME_REQUIRED',
      message: 'a legacy cancellation review requires an explicit resumeStatus'
    };
  }
  if (!isLegacyHoldReleaseTarget(requestedResume)) {
    return {
      ok: false,
      code: 'CANCELLATION_RESUME_TARGET_INVALID',
      message: 'legacy cancellation recovery may resume only to DRAFT through MAKER_PO_ACCEPTED'
    };
  }
  return { ok: true, outcome, target: requestedResume };
}

const NEXT_NORMAL_STATE: Record<NormalFilmSupplyOrderState, NormalFilmSupplyOrderState | null> = {
  DRAFT: 'SEVEN_PO_VERIFIED',
  SEVEN_PO_VERIFIED: 'ARTWORK_RECEIVED',
  ARTWORK_RECEIVED: 'PROOF_READY',
  PROOF_READY: 'APPROVAL_PENDING',
  APPROVAL_PENDING: 'DUAL_APPROVED',
  DUAL_APPROVED: 'MAKER_PO_READY',
  MAKER_PO_READY: 'APPROVED_FOR_MANUAL_SEND',
  APPROVED_FOR_MANUAL_SEND: 'MAKER_PO_SENT_MANUALLY',
  MAKER_PO_SENT_MANUALLY: 'MAKER_PO_ACCEPTED',
  MAKER_PO_ACCEPTED: 'FILM_IN_PRODUCTION',
  FILM_IN_PRODUCTION: 'FILM_SHIPPED',
  FILM_SHIPPED: 'FILM_DELIVERED',
  FILM_DELIVERED: 'FILM_RECEIPT_ASSUMED_NO_ISSUE',
  FILM_RECEIPT_ASSUMED_NO_ISSUE: null
};

const EXCEPTION_STATES = FILM_SUPPLY_ORDER_EXCEPTION_STATES;

/**
 * M5: FILM_RECEIPT_ASSUMED_NO_ISSUE is reachable from FILM_DELIVERED and from
 * nothing else. Releasing a hold or closing a review resumes the chain it came
 * from, but assuming a receipt without issue is the manual recording action of
 * design section 5.5 — never a side effect of leaving an exception state, and
 * never scheduled (design section 13 item 1). The terminal state is therefore
 * removed from the exception release targets.
 */
const EXCEPTION_RELEASE_TARGETS: readonly NormalFilmSupplyOrderState[] = FILM_SUPPLY_ORDER_STATES
  .filter((state) => state !== FILM_SUPPLY_ORDER_TERMINAL_STATE);

function withExceptions(next: readonly (NormalFilmSupplyOrderState | null)[]): readonly FilmSupplyOrderState[] {
  const normalNexts = next.filter((state): state is NormalFilmSupplyOrderState => state !== null);
  return [...normalNexts, ...EXCEPTION_STATES];
}

/** CHANGE_REVIEW resolves into the artwork/approval states a change restarts. */
const CHANGE_REVIEW_TARGETS: readonly NormalFilmSupplyOrderState[] = [
  'ARTWORK_RECEIVED',
  'PROOF_READY',
  'APPROVAL_PENDING'
];

const FILM_SUPPLY_ORDER_TRANSITIONS: Record<FilmSupplyOrderState, readonly FilmSupplyOrderState[]> = {
  DRAFT: withExceptions([NEXT_NORMAL_STATE.DRAFT]),
  SEVEN_PO_VERIFIED: withExceptions([NEXT_NORMAL_STATE.SEVEN_PO_VERIFIED]),
  ARTWORK_RECEIVED: withExceptions([NEXT_NORMAL_STATE.ARTWORK_RECEIVED]),
  PROOF_READY: withExceptions([NEXT_NORMAL_STATE.PROOF_READY]),
  APPROVAL_PENDING: withExceptions([NEXT_NORMAL_STATE.APPROVAL_PENDING]),
  DUAL_APPROVED: withExceptions([NEXT_NORMAL_STATE.DUAL_APPROVED]),
  MAKER_PO_READY: withExceptions([NEXT_NORMAL_STATE.MAKER_PO_READY]),
  APPROVED_FOR_MANUAL_SEND: withExceptions([NEXT_NORMAL_STATE.APPROVED_FOR_MANUAL_SEND]),
  MAKER_PO_SENT_MANUALLY: withExceptions([NEXT_NORMAL_STATE.MAKER_PO_SENT_MANUALLY]),
  MAKER_PO_ACCEPTED: withExceptions([NEXT_NORMAL_STATE.MAKER_PO_ACCEPTED]),
  FILM_IN_PRODUCTION: withExceptions([NEXT_NORMAL_STATE.FILM_IN_PRODUCTION]),
  FILM_SHIPPED: withExceptions([NEXT_NORMAL_STATE.FILM_SHIPPED]),
  FILM_DELIVERED: withExceptions([NEXT_NORMAL_STATE.FILM_DELIVERED]),
  // Assumed receipt without issue closes the film chain.
  FILM_RECEIPT_ASSUMED_NO_ISSUE: [],
  // Releasing a hold or closing a cancellation review names the resume state;
  // the assumed-receipt terminal state is never one of them.
  ON_HOLD: EXCEPTION_RELEASE_TARGETS,
  CHANGE_REVIEW: CHANGE_REVIEW_TARGETS,
  CANCELLATION_REVIEW: EXCEPTION_RELEASE_TARGETS
};

export function isExceptionFilmSupplyOrderState(
  state: FilmOrderStatus
): state is ExceptionFilmSupplyOrderState {
  return (EXCEPTION_STATES as readonly string[]).includes(state);
}

export function isTerminalFilmSupplyOrderState(state: FilmOrderStatus): boolean {
  return (FILM_SUPPLY_ORDER_TERMINAL_STATES as readonly string[]).includes(state);
}

export function isFrozenFilmOrderStatus(state: FilmOrderStatus): boolean {
  return isExceptionFilmSupplyOrderState(state) || state === FILM_ORDER_CANCELLATION_STATE;
}

export function isClosedFilmOrderStatus(state: FilmOrderStatus): boolean {
  return (FILM_SUPPLY_ORDER_TERMINAL_STATES as readonly string[]).includes(state);
}

export function filmSupplyOrderTransitions(state: FilmSupplyOrderState): readonly FilmSupplyOrderState[] {
  return FILM_SUPPLY_ORDER_TRANSITIONS[state];
}

export type FilmSupplyOrderTransitionResult<TFrom extends FilmSupplyOrderState, TTo extends FilmSupplyOrderState> =
  | { ok: true; from: TFrom; to: TTo }
  | { ok: false; from: FilmSupplyOrderState; to: FilmSupplyOrderState };

/**
 * `exceptionOrigin` is the normal status immediately before the order entered
 * its current hold or cancellation review. Omitting it (unknown legacy data) or
 * naming any other state rejects every release, so neither exception can turn a
 * pre-acceptance interruption into a shortcut to FILM_IN_PRODUCTION. An order
 * interrupted while already in production resumes exactly that production
 * state. CHANGE_REVIEW keeps its designed restart targets.
 */
export function transitionFilmSupplyOrder<TFrom extends FilmOrderStatus, TTo extends FilmOrderStatus>(
  from: TFrom,
  to: TTo,
  exceptionOrigin?: NormalFilmSupplyOrderState | null
): FilmSupplyOrderTransitionResult<FilmSupplyOrderState, FilmSupplyOrderState> {
  const allowedTargets = FILM_SUPPLY_ORDER_TRANSITIONS[from as FilmSupplyOrderState];
  if (!Array.isArray(allowedTargets)) {
    return {
      ok: false,
      from: from as FilmSupplyOrderState,
      to: to as FilmSupplyOrderState
    };
  }
  let allowed = allowedTargets.includes(to as FilmSupplyOrderState);
  if (from === 'ON_HOLD' || from === 'CANCELLATION_REVIEW') {
    allowed = allowed && exceptionOrigin === to;
  }
  const fromState = from as FilmSupplyOrderState;
  const toState = to as FilmSupplyOrderState;
  return allowed ? { ok: true, from: fromState, to: toState } : { ok: false, from: fromState, to: toState };
}

/**
 * M1 date separation rule (design section 5.6): gate checks read
 * official_registered_at ONLY. original_received_at is reference data; it is
 * accepted here so callers can pass a whole purchase order record, and it is
 * deliberately never read when deciding the gate.
 */
export interface SevenPurchaseOrderGateInput {
  officialRegisteredAt: Date | string | null;
  originalReceivedAt?: Date | string | null;
}

export type SevenPoVerificationGate =
  | { ok: true; gatedOn: 'official_registered_at' }
  | { ok: false; code: 'OFFICIAL_REGISTRATION_REQUIRED'; message: string };

export function evaluateSevenPoVerificationGate(po: SevenPurchaseOrderGateInput): SevenPoVerificationGate {
  const registered = po.officialRegisteredAt;
  const hasOfficialRegistration = registered !== null && registered !== undefined;
  if (!hasOfficialRegistration) {
    return {
      ok: false,
      code: 'OFFICIAL_REGISTRATION_REQUIRED',
      message: 'official_registered_at is required to verify the seven purchase order; original_received_at is reference-only'
    };
  }
  return { ok: true, gatedOn: 'official_registered_at' };
}
