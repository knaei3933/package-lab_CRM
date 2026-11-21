import { normalizePaymentTerms } from './payment-gate.js';
import {
  isExceptionFilmSupplyOrderState,
  isTerminalFilmSupplyOrderState,
  transitionFilmSupplyOrder
} from './state-machine.js';
import type { FilmOrderStatus, NormalFilmSupplyOrderState } from './state-machine.js';

/**
 * P1 R23 (policy P-9): the steps the system takes by itself.
 *
 * A person never presses 校正ゲラ準備完了, 校了確認待ち or 製造先発注準備完了
 * again; the states stay, and the server moves the order through them the
 * moment the facts that define them exist. Every automatic move is still one
 * normal step of the state machine (no state is skipped, each step gets its own
 * audit row) and is decided only from facts read under the order row lock.
 *
 * The manual, external-fact steps (デザインデータ受領, 製造・出荷・納品) and
 * every exception exit (hold release, change/cancellation review) are not here:
 * they stay human records with their existing rules.
 */
export interface AutoAdvanceFacts {
  /** The linked seven PO passes the precedence gate (official date + checklist). */
  sevenPoGateOpen: boolean;
  /** The gate's refusal when it is closed (shown as the blocker). */
  sevenPoGateRefusal?: { code: string; message: string } | null;
  /** At least one artwork revision (校正ゲラ) is registered on the order. */
  hasArtworkRevision: boolean;
  /** The derived dual approval gate is open right now. */
  dualApproved: boolean;
  /** The order's payment term as stored. */
  paymentTerms: unknown;
}

export type AutoAdvanceRule =
  | 'seven_po_gate_open'
  | 'proof_registered'
  | 'dual_approval_reached'
  | 'dual_approved_and_payment_terms_decided';

export interface AutoAdvanceStep {
  from: NormalFilmSupplyOrderState;
  to: NormalFilmSupplyOrderState;
  rule: AutoAdvanceRule;
}

export interface AutoAdvanceBlocker {
  code: string;
  message: string;
}

/** The targets the generic transition endpoint no longer accepts from a normal state. */
export const AUTO_ONLY_TRANSITION_TARGETS = ['PROOF_READY', 'APPROVAL_PENDING', 'MAKER_PO_READY'] as const;

/**
 * True when a manual request names a step the system now owns. CHANGE_REVIEW
 * resolution (restart into PROOF_READY / APPROVAL_PENDING) is an exception exit,
 * not a step, and stays manual.
 */
export function isAutoOnlyManualTarget(from: FilmOrderStatus, to: string): boolean {
  if (!(AUTO_ONLY_TRANSITION_TARGETS as readonly string[]).includes(to)) return false;
  if (isExceptionFilmSupplyOrderState(from)) return false;
  return true;
}

export function isPaymentTermsDecided(value: unknown): boolean {
  const terms = normalizePaymentTerms(typeof value === 'string' ? value : null);
  return terms === 'prepaid' || terms === 'on_delivery';
}

interface RuleOutcome {
  step: AutoAdvanceStep | null;
  /** The next automatic target from this state, when one exists. */
  target: NormalFilmSupplyOrderState | null;
  blockers: AutoAdvanceBlocker[];
}

const ARTWORK_REVISION_REQUIRED: AutoAdvanceBlocker = {
  code: 'ARTWORK_REVISION_REQUIRED',
  message: '校正ゲラ（版）がまだ登録されていません。版を登録すると自動で進みます'
};

const DUAL_APPROVAL_REQUIRED: AutoAdvanceBlocker = {
  code: 'DUAL_APPROVAL_REQUIRED',
  message: '全デザインの両組織承認が必要です'
};

const PAYMENT_TERMS_UNDETERMINED: AutoAdvanceBlocker = {
  code: 'PAYMENT_TERMS_UNDETERMINED',
  message: '支払条件が「未定」です。代表承認の前に「前払い」または「納品後払い」を選んでください'
};

function ruleFor(status: NormalFilmSupplyOrderState, facts: AutoAdvanceFacts): RuleOutcome {
  switch (status) {
    case 'DRAFT':
      return facts.sevenPoGateOpen
        ? { step: { from: 'DRAFT', to: 'SEVEN_PO_VERIFIED', rule: 'seven_po_gate_open' }, target: 'SEVEN_PO_VERIFIED', blockers: [] }
        : {
            step: null,
            target: 'SEVEN_PO_VERIFIED',
            blockers: [facts.sevenPoGateRefusal ?? {
              code: 'SEVEN_PO_REQUIRED',
              message: 'セブン発注書の紐付けが必要です'
            }]
          };
    case 'ARTWORK_RECEIVED':
      return facts.hasArtworkRevision
        ? { step: { from: 'ARTWORK_RECEIVED', to: 'PROOF_READY', rule: 'proof_registered' }, target: 'PROOF_READY', blockers: [] }
        : { step: null, target: 'PROOF_READY', blockers: [ARTWORK_REVISION_REQUIRED] };
    case 'PROOF_READY':
      return facts.hasArtworkRevision
        ? { step: { from: 'PROOF_READY', to: 'APPROVAL_PENDING', rule: 'proof_registered' }, target: 'APPROVAL_PENDING', blockers: [] }
        : { step: null, target: 'APPROVAL_PENDING', blockers: [ARTWORK_REVISION_REQUIRED] };
    case 'APPROVAL_PENDING':
      return facts.dualApproved
        ? { step: { from: 'APPROVAL_PENDING', to: 'DUAL_APPROVED', rule: 'dual_approval_reached' }, target: 'DUAL_APPROVED', blockers: [] }
        : { step: null, target: 'DUAL_APPROVED', blockers: [DUAL_APPROVAL_REQUIRED] };
    case 'DUAL_APPROVED': {
      const blockers: AutoAdvanceBlocker[] = [];
      if (!facts.dualApproved) blockers.push(DUAL_APPROVAL_REQUIRED);
      if (!isPaymentTermsDecided(facts.paymentTerms)) blockers.push(PAYMENT_TERMS_UNDETERMINED);
      return blockers.length === 0
        ? {
            step: { from: 'DUAL_APPROVED', to: 'MAKER_PO_READY', rule: 'dual_approved_and_payment_terms_decided' },
            target: 'MAKER_PO_READY',
            blockers
          }
        : { step: null, target: 'MAKER_PO_READY', blockers };
    }
    default:
      return { step: null, target: null, blockers: [] };
  }
}

export interface AutoAdvancePlan {
  steps: AutoAdvanceStep[];
  /** The state the order would be in after the steps. */
  finalStatus: FilmOrderStatus;
  /** The next automatic target after the steps, and why it does not happen yet. */
  nextAutomatic: { target: NormalFilmSupplyOrderState; blockers: AutoAdvanceBlocker[] } | null;
}

/**
 * The pure plan: from `status`, apply the rules one normal step at a time while
 * they hold. Each planned step is re-checked against the shared state machine,
 * so this function can never plan a move the machine forbids. Exception,
 * cancelled and terminal states plan nothing.
 */
export function planAutoAdvance(status: FilmOrderStatus, facts: AutoAdvanceFacts): AutoAdvancePlan {
  const steps: AutoAdvanceStep[] = [];
  let current: FilmOrderStatus = status;
  if (isExceptionFilmSupplyOrderState(current) || isTerminalFilmSupplyOrderState(current)) {
    return { steps, finalStatus: current, nextAutomatic: null };
  }
  // Bounded: the chain has fewer automatic steps than this limit.
  for (let guard = 0; guard < 8; guard += 1) {
    const outcome = ruleFor(current as NormalFilmSupplyOrderState, facts);
    if (!outcome.step) {
      return {
        steps,
        finalStatus: current,
        nextAutomatic: outcome.target ? { target: outcome.target, blockers: outcome.blockers } : null
      };
    }
    if (!transitionFilmSupplyOrder(outcome.step.from, outcome.step.to).ok) {
      return { steps, finalStatus: current, nextAutomatic: null };
    }
    steps.push(outcome.step);
    current = outcome.step.to;
  }
  return { steps, finalStatus: current, nextAutomatic: null };
}

/** The human-recorded next step for the states where the system waits for an outside fact. */
export const MANUAL_NEXT_STEP: Readonly<Partial<Record<FilmOrderStatus, NormalFilmSupplyOrderState>>> = {
  SEVEN_PO_VERIFIED: 'ARTWORK_RECEIVED',
  MAKER_PO_ACCEPTED: 'FILM_IN_PRODUCTION',
  FILM_IN_PRODUCTION: 'FILM_SHIPPED',
  FILM_SHIPPED: 'FILM_DELIVERED'
};
