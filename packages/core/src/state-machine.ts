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
export type FilmSupplyOrderState = NormalFilmSupplyOrderState | ExceptionFilmSupplyOrderState;

export const FILM_SUPPLY_ORDER_TERMINAL_STATE: NormalFilmSupplyOrderState = 'FILM_RECEIPT_ASSUMED_NO_ISSUE';

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

function withExceptions(next: readonly NormalFilmSupplyOrderState[]): readonly FilmSupplyOrderState[] {
  return [...next, ...EXCEPTION_STATES];
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
  // Releasing a hold or closing a cancellation review names the resume state.
  ON_HOLD: FILM_SUPPLY_ORDER_STATES,
  CHANGE_REVIEW: CHANGE_REVIEW_TARGETS,
  CANCELLATION_REVIEW: FILM_SUPPLY_ORDER_STATES
};

export function isExceptionFilmSupplyOrderState(
  state: FilmSupplyOrderState
): state is ExceptionFilmSupplyOrderState {
  return (EXCEPTION_STATES as readonly string[]).includes(state);
}

export function isTerminalFilmSupplyOrderState(state: FilmSupplyOrderState): boolean {
  return state === FILM_SUPPLY_ORDER_TERMINAL_STATE;
}

export function filmSupplyOrderTransitions(state: FilmSupplyOrderState): readonly FilmSupplyOrderState[] {
  return FILM_SUPPLY_ORDER_TRANSITIONS[state];
}

export type FilmSupplyOrderTransitionResult<TFrom extends FilmSupplyOrderState, TTo extends FilmSupplyOrderState> =
  | { ok: true; from: TFrom; to: TTo }
  | { ok: false; from: FilmSupplyOrderState; to: FilmSupplyOrderState };

export function transitionFilmSupplyOrder<TFrom extends FilmSupplyOrderState, TTo extends FilmSupplyOrderState>(
  from: TFrom,
  to: TTo
): FilmSupplyOrderTransitionResult<TFrom, TTo> {
  const allowed = FILM_SUPPLY_ORDER_TRANSITIONS[from].includes(to);
  return allowed ? { ok: true, from, to } : { ok: false, from, to };
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
