import { FILM_ORDER_CANCELLATION_STATE, FILM_SUPPLY_ORDER_TERMINAL_STATE } from '@kanei/core';
import type {
  ApprovalGateView,
  ArtworkRevisionView,
  DeliveryView,
  DocumentView,
  FilmSupplyOrderView,
  SevenPurchaseOrderView
} from './project-data';
import { knownStatus } from './project-data';
import type { MakerPoEventRow, MakerPoViewRow, PaymentGateView } from './maker-po-data';
import { normalizeRole } from './permissions';

/**
 * P1 R21: one film order as the 12 steps the operator sees (REDESIGN §3-2) and
 * the ONE thing to do now (「いま必要な1手」). Pure: built from what the order
 * screen already read; the API still decides every write.
 *
 * - The steps are the user's words for the flow. Several stored states fold into
 *   one step (校正 = ARTWORK_RECEIVED + PROOF_READY), and the exception states
 *   (保留・変更確認・取消確認) are a band above the panel, not a step.
 * - The action is never guessed from a colour or a table: it names who does it,
 *   and when the signed-in role cannot, what it waits for (相手待ち).
 * - A blocked step carries its reason and the one fix, on the spot (§3-3).
 */

export interface OrderStepDefinition {
  no: number;
  key: OrderStepKey;
  title: string;
  /** Korean gloss (shown in the bilingual mode, R29). */
  ko: string;
}

export type OrderStepKey =
  | 'intake' | 'check' | 'content' | 'artwork' | 'proof' | 'approval'
  | 'maker_po' | 'ceo' | 'send' | 'accept' | 'ship' | 'deliver';

export const ORDER_STEPS: readonly OrderStepDefinition[] = [
  { no: 1, key: 'intake', title: '発注書の受付', ko: '발주서 접수' },
  { no: 2, key: 'check', title: '発注書の照合', ko: '발주서 대조' },
  { no: 3, key: 'content', title: '発注内容', ko: '발주 내용' },
  { no: 4, key: 'artwork', title: 'デザイン入稿', ko: '디자인 입고' },
  { no: 5, key: 'proof', title: '校正', ko: '교정본' },
  { no: 6, key: 'approval', title: '校了', ko: '교정 최종 승인' },
  { no: 7, key: 'maker_po', title: 'メーカー発注書', ko: '제조사 발주서' },
  { no: 8, key: 'ceo', title: '代表承認', ko: '대표 승인' },
  { no: 9, key: 'send', title: 'メーカーへ送信', ko: '제조사에 발송' },
  { no: 10, key: 'accept', title: 'メーカー受注確認', ko: '제조사 접수 확인' },
  { no: 11, key: 'ship', title: '製造・出荷', ko: '생산·출하' },
  { no: 12, key: 'deliver', title: '納品', ko: '납품' }
];

export const STEP_COUNT = ORDER_STEPS.length;

/** The live maker paper of an order (not cancelled, not voided). */
const LIVE_MAKER_PO_STATUSES = new Set(['DRAFT', 'APPROVED_FOR_MANUAL_SEND', 'SEND_UNVERIFIED', 'MAKER_PO_SENT_MANUALLY', 'MAKER_PO_ACCEPTED']);

export function liveMakerPo(rows: readonly MakerPoViewRow[]): MakerPoViewRow | null {
  const live = rows.filter((row) => LIVE_MAKER_PO_STATUSES.has(row.status));
  return live[live.length - 1] ?? null;
}

/** The step (1–12) a stored state stands for; 13 = every step done; null = no step (exception, unknown). */
export function stepForStatus(
  status: string,
  context: { poRegistered: boolean; poVerified: boolean; makerPoStatus: string | null }
): number | null {
  switch (status) {
    case 'DRAFT':
      if (!context.poRegistered) return 1;
      return context.poVerified ? 3 : 2;
    case 'SEVEN_PO_VERIFIED':
      return 4;
    case 'ARTWORK_RECEIVED':
    case 'PROOF_READY':
      return 5;
    case 'APPROVAL_PENDING':
      return 6;
    case 'DUAL_APPROVED':
      return 7;
    case 'MAKER_PO_READY':
      return context.makerPoStatus === 'DRAFT' ? 8 : 7;
    case 'APPROVED_FOR_MANUAL_SEND':
      return 9;
    case 'MAKER_PO_SENT_MANUALLY':
      return 10;
    case 'MAKER_PO_ACCEPTED':
    case 'FILM_IN_PRODUCTION':
      return 11;
    case 'FILM_SHIPPED':
    case 'FILM_DELIVERED':
      return 12;
    case FILM_SUPPLY_ORDER_TERMINAL_STATE:
      return STEP_COUNT + 1;
    default:
      return null;
  }
}

export type StepMark = 'done' | 'current' | 'interrupted' | 'upcoming' | 'unknown';

export type FlowPhase = 'active' | 'exception' | 'complete' | 'cancelled' | 'hidden' | 'unknown';

export type StepActor = 'staff_or_admin' | 'admin';

/** What the 「いま必要な1手」 panel offers. One primary action, or what it waits for. */
export type StepAction =
  | { kind: 'po_check'; poId: string | null; registered: boolean }
  | { kind: 'advance'; to: string; label: string; evidenceNote: 'none' | 'optional' | 'required'; hint: string }
  | { kind: 'proof'; designKeys: string[] }
  | { kind: 'approvals'; designs: ApprovalSlotDesign[] }
  | { kind: 'evidence_check'; count: number }
  | { kind: 'payment_terms'; current: string | null }
  | { kind: 'maker_po_create'; needsReadyTransition: boolean }
  | { kind: 'ceo_approve'; poId: string }
  | { kind: 'send'; poId: string }
  | { kind: 'send_verify'; poId: string; eventId: string }
  | { kind: 'send_stuck'; poId: string }
  | { kind: 'accept'; poId: string; provisionalRecorded: boolean }
  | { kind: 'deliver'; lineIds: string[] }
  | { kind: 'receipt' }
  | { kind: 'done' }
  | { kind: 'hold' }
  | { kind: 'change_review' }
  | { kind: 'cancellation_review' }
  | { kind: 'cancelled' }
  | { kind: 'unreadable'; reason: string };

export interface ApprovalSlotDesign {
  designKey: string;
  revisionId: string;
  revisionNo: number;
  customer: ApprovalSlotState;
  seven: ApprovalSlotState;
  /** P5 R1: who rejected a 'rejected' slot's evidence, when, and why (absent for every other state). */
  rejections?: Partial<Record<'customer' | 'seven', SlotRejection>> | undefined;
}

/**
 * Round 2 (p5-int review H-2): what staff / viewer / auditor read in place of the 却下 reason. The reason is the
 * representative's free text and is never sent to them (the API leaves it out); the screens never draw one for them.
 */
export const REJECTION_REASON_WITHHELD = '却下されました。理由は代表にご確認ください';

/** P5 R1: the representative's 却下 of one slot's evidence, as the gate answers it. */
export interface SlotRejection {
  verifierName: string | null;
  verifiedAt: string | null;
  reasonNote: string | null;
}

/**
 * One organization's 押印 slot: approved (valid), waiting for the representative's check, rejected by the
 * representative (P5 R1: the approval is recorded again on other evidence — the slot takes a new one), or open.
 */
export type ApprovalSlotState = 'approved' | 'pending_check' | 'rejected' | 'open';

export interface StepPanel {
  action: StepAction;
  actor: StepActor | null;
  /** The signed-in role may do it (display only; the API decides). */
  canAct: boolean;
  /** Set when the step cannot move: the reason in one sentence and the fix (§3-3). */
  blocked: { reason: string; fix: 'payment_terms' | 'po_check' | 'ask_admin' | null } | null;
}

export interface OrderFlowView {
  phase: FlowPhase;
  status: string | null;
  /** 1–12 while active; the interrupted step for an exception; null otherwise. */
  current: number | null;
  marks: StepMark[];
  panel: StepPanel;
}

export interface OrderFlowInput {
  order: FilmSupplyOrderView;
  role: string | null | undefined;
  po: SevenPurchaseOrderView | null;
  documents: readonly DocumentView[];
  revisions: readonly ArtworkRevisionView[];
  gate: ApprovalGateView | null;
  makerPos: readonly MakerPoViewRow[];
  /** Events of the live maker paper (oldest first); empty when not read. */
  makerEvents: readonly MakerPoEventRow[];
  /** Send events whose manual decision is already recorded (their ids). */
  settledSendEventIds: ReadonlySet<string>;
  paymentGate: PaymentGateView | null;
  deliveries: readonly DeliveryView[];
}

function marksFor(current: number | null, at: StepMark): StepMark[] {
  return ORDER_STEPS.map((step) => {
    if (current === null) return 'unknown';
    if (step.no < current) return 'done';
    if (step.no === current) return at;
    return 'upcoming';
  });
}

function panel(action: StepAction, actor: StepActor | null, role: string | null | undefined, blocked: StepPanel['blocked'] = null): StepPanel {
  const normalized = normalizeRole(role);
  const canAct = actor === null
    ? false
    : normalized === 'admin' || (actor === 'staff_or_admin' && normalized === 'staff');
  return { action, actor, canAct, blocked };
}

/** The designs this order has proofs for, newest revision each (order of first registration). */
export function designsOf(revisions: readonly ArtworkRevisionView[], orderId: string): string[] {
  const keys: string[] = [];
  for (const revision of revisions) {
    if (revision.filmSupplyOrderId === orderId && !keys.includes(revision.designKey)) keys.push(revision.designKey);
  }
  return keys;
}

type SlotSource = {
  valid: boolean;
  pendingEvidenceIdentifier: boolean;
  rejected?: boolean | undefined;
  manualVerification?: { result: string; verifierName?: string | null; verifiedAt?: string | null; reasonNote?: string | null | undefined } | null | undefined;
};

/** P5 R1: the held approval was REJECTED (the core flag; an older API: the latest manual check's result). */
function isRejected(state: SlotSource): boolean {
  return state.rejected === true || (state.pendingEvidenceIdentifier && state.manualVerification?.result === 'rejected');
}

function slotState(state: SlotSource | undefined): ApprovalSlotState {
  if (!state) return 'open';
  if (state.valid) return 'approved';
  if (isRejected(state)) return 'rejected';
  return state.pendingEvidenceIdentifier ? 'pending_check' : 'open';
}

function rejectionOf(state: SlotSource | undefined): SlotRejection | null {
  if (!state || slotState(state) !== 'rejected') return null;
  const check = state.manualVerification ?? null;
  const textOf = (value: string | null | undefined) => (typeof value === 'string' && value.length > 0 && value !== '—' ? value : null);
  return { verifierName: textOf(check?.verifierName), verifiedAt: textOf(check?.verifiedAt), reasonNote: textOf(check?.reasonNote) };
}

export function approvalSlots(gate: ApprovalGateView | null): ApprovalSlotDesign[] {
  if (!gate) return [];
  return gate.designs.map((design) => {
    const rejections: Partial<Record<'customer' | 'seven', SlotRejection>> = {};
    for (const organization of ['customer', 'seven'] as const) {
      const rejection = rejectionOf(design[organization]);
      if (rejection) rejections[organization] = rejection;
    }
    return {
      designKey: design.designKey,
      revisionId: design.currentRevisionId,
      revisionNo: design.currentRevisionNo,
      customer: slotState(design.customer),
      seven: slotState(design.seven),
      ...(Object.keys(rejections).length > 0 ? { rejections } : {})
    };
  });
}

/** P5 R1: the slots whose evidence the representative rejected (staff 「自分の作業」 and the order screen say so). */
export function rejectedSlots(designs: readonly ApprovalSlotDesign[]): Array<{ designKey: string; organization: 'customer' | 'seven' }> {
  return designs.flatMap((design) => (['customer', 'seven'] as const)
    .filter((organization) => design[organization] === 'rejected')
    .map((organization) => ({ designKey: design.designKey, organization })));
}

/** P5 R1: a manual check still to be made — a rejected one is decided (its form is not offered again). */
export function isOpenManualCheck(entry: { manualVerification: { result: string } | null }): boolean {
  return entry.manualVerification?.result !== 'rejected';
}

const UNDETERMINED = 'undetermined';

/** The 支払条件 the order holds now: the payment gate's answer, else the order's own record. */
export function currentPaymentTerms(input: Pick<OrderFlowInput, 'order' | 'paymentGate'>): string | null {
  return input.paymentGate?.paymentTerms ?? input.order.paymentTerms ?? null;
}

export function buildOrderFlow(input: OrderFlowInput): OrderFlowView {
  const { order, role } = input;
  const status = knownStatus(order);
  if (status === null) {
    return {
      phase: 'hidden',
      status: null,
      current: null,
      marks: marksFor(null, 'current'),
      panel: panel({ kind: 'unreadable', reason: 'この役割では発注の状態が表示されません（閲覧権限なし）。' }, null, role)
    };
  }
  const maker = liveMakerPo(input.makerPos);
  const context = {
    poRegistered: Boolean(input.po?.officiallyRegistered),
    poVerified: input.po?.verificationStatus === 'verified',
    makerPoStatus: maker?.status ?? null
  };

  if (status === FILM_ORDER_CANCELLATION_STATE) {
    return { phase: 'cancelled', status, current: null, marks: marksFor(null, 'current'), panel: panel({ kind: 'cancelled' }, null, role) };
  }
  if (status === 'ON_HOLD' || status === 'CHANGE_REVIEW' || status === 'CANCELLATION_REVIEW') {
    const left = order.lastNormalStatus ? stepForStatus(order.lastNormalStatus, context) : null;
    const interrupted = typeof left === 'number' && left <= STEP_COUNT ? left : null;
    const action: StepAction = status === 'ON_HOLD'
      ? { kind: 'hold' }
      : status === 'CHANGE_REVIEW'
        ? { kind: 'change_review' }
        : { kind: 'cancellation_review' };
    // Approved server rule: the hold and the cancellation review are released by the
    // representative only (CANCELLED ends the order); the change review is resumed by both.
    const actor: StepActor = status === 'CHANGE_REVIEW' ? 'staff_or_admin' : 'admin';
    return {
      phase: 'exception',
      status,
      current: interrupted,
      marks: interrupted === null ? marksFor(null, 'current') : marksFor(interrupted, 'interrupted'),
      panel: panel(action, actor, role)
    };
  }

  const step = stepForStatus(status, context);
  if (step === null) {
    return {
      phase: 'unknown',
      status,
      current: null,
      marks: marksFor(null, 'current'),
      panel: panel({ kind: 'unreadable', reason: 'この状態は段階として表示できません。発注一覧で確認してください。' }, null, role)
    };
  }
  if (step > STEP_COUNT) {
    return { phase: 'complete', status, current: null, marks: ORDER_STEPS.map((): StepMark => 'done'), panel: panel({ kind: 'done' }, null, role) };
  }
  return { phase: 'active', status, current: step, marks: marksFor(step, 'current'), panel: activePanel(input, status, step, maker) };
}

function activePanel(input: OrderFlowInput, status: string, step: number, maker: MakerPoViewRow | null): StepPanel {
  const { order, role } = input;
  const both: StepActor = 'staff_or_admin';
  switch (status) {
    case 'DRAFT': {
      if (step < 3) {
        return panel(
          { kind: 'po_check', poId: order.sevenPurchaseOrderId, registered: Boolean(input.po?.officiallyRegistered) },
          both,
          role
        );
      }
      return panel({
        kind: 'advance',
        to: 'SEVEN_PO_VERIFIED',
        label: '発注内容を確定する',
        evidenceNote: 'none',
        hint: '照合済みのセブン化学発注書と明細で、この発注を確定します。'
      }, both, role);
    }
    case 'SEVEN_PO_VERIFIED':
      // No document type holds the design data yet (needs a DB enum value — reported):
      // the receipt is recorded with a note kept in the audit history.
      return panel({
        kind: 'advance',
        to: 'ARTWORK_RECEIVED',
        label: 'デザインを受け取ったことを記録する',
        evidenceNote: input.documents.some((document) => document.filmSupplyOrderId === order.id) ? 'optional' : 'required',
        hint: '受け取ったデザインデータ（ファイル名・受領日・送り主）をメモに書きます。メモは履歴に残ります。'
      }, both, role);
    case 'ARTWORK_RECEIVED':
      return panel({ kind: 'proof', designKeys: designsOf(input.revisions, order.id) }, both, role);
    case 'PROOF_READY':
      return panel({
        kind: 'advance',
        to: 'APPROVAL_PENDING',
        label: '校了の確認へ進める',
        evidenceNote: 'none',
        hint: '登録した校正を、顧客とセブン化学の承認待ちにします。'
      }, both, role);
    case 'APPROVAL_PENDING': {
      const designs = approvalSlots(input.gate);
      // P5 R1: a rejected check is decided — it never makes the panel a check list; its slot takes a new approval.
      const pending = input.gate?.pendingManualVerifications.filter(isOpenManualCheck).length ?? 0;
      const openSlots = designs.some((design) => design.customer === 'open' || design.seven === 'open'
        || design.customer === 'rejected' || design.seven === 'rejected');
      if (!openSlots && pending > 0) return panel({ kind: 'evidence_check', count: pending }, 'admin', role);
      return panel({ kind: 'approvals', designs }, both, role);
    }
    case 'DUAL_APPROVED':
    case 'MAKER_PO_READY': {
      const terms = currentPaymentTerms(input);
      if (terms === null || terms === UNDETERMINED) {
        return panel(
          { kind: 'payment_terms', current: terms },
          both,
          role,
          {
            reason: '支払条件が「未定」です。メーカー発注書の代表承認には、前払いか納品後払いの選択が必要です。',
            fix: 'payment_terms'
          }
        );
      }
      if (maker?.status === 'DRAFT') return panel({ kind: 'ceo_approve', poId: maker.id }, 'admin', role);
      // P-6 (decided): the draft paper is drawn up by staff (or the representative); approval stays the representative's.
      return panel({ kind: 'maker_po_create', needsReadyTransition: status === 'DUAL_APPROVED' }, 'staff_or_admin', role);
    }
    case 'APPROVED_FOR_MANUAL_SEND': {
      if (!maker) return panel({ kind: 'unreadable', reason: 'メーカー発注書を読み込めませんでした。' }, null, role);
      if (maker.status === 'SEND_UNVERIFIED') return panel({ kind: 'send_stuck', poId: maker.id }, 'admin', role);
      const pending = pendingSend(input.makerEvents, input.settledSendEventIds);
      if (pending) return panel({ kind: 'send_verify', poId: maker.id, eventId: pending.id }, 'admin', role);
      return panel({ kind: 'send', poId: maker.id }, both, role);
    }
    case 'MAKER_PO_SENT_MANUALLY': {
      if (!maker) return panel({ kind: 'unreadable', reason: 'メーカー発注書を読み込めませんでした。' }, null, role);
      const pending = pendingSend(input.makerEvents, input.settledSendEventIds);
      if (pending) return panel({ kind: 'send_verify', poId: maker.id, eventId: pending.id }, 'admin', role);
      const provisionalRecorded = input.makerEvents.some((event) => event.eventType === 'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL');
      // Staff records the provisional acceptance; the final one is the representative's.
      return panel({ kind: 'accept', poId: maker.id, provisionalRecorded }, provisionalRecorded ? 'admin' : both, role);
    }
    case 'MAKER_PO_ACCEPTED':
      return panel({
        kind: 'advance',
        to: 'FILM_IN_PRODUCTION',
        label: '製造開始を記録する',
        evidenceNote: 'none',
        hint: 'メーカーが製造を始めたら記録します（外部の事実の記録）。'
      }, both, role);
    case 'FILM_IN_PRODUCTION':
      return panel({
        kind: 'advance',
        to: 'FILM_SHIPPED',
        label: '出荷を記録する',
        evidenceNote: 'none',
        hint: 'メーカーが出荷したら記録します（外部の事実の記録）。'
      }, both, role);
    case 'FILM_SHIPPED':
      return panel({ kind: 'deliver', lineIds: order.lines.map((line) => line.id) }, both, role);
    case 'FILM_DELIVERED':
      return panel({ kind: 'receipt' }, both, role);
    default:
      return panel({ kind: 'unreadable', reason: 'この状態は段階として表示できません。' }, null, role);
  }
}

function pendingSend(events: readonly MakerPoEventRow[], settled: ReadonlySet<string>): MakerPoEventRow | null {
  const pending = events.filter((event) =>
    event.eventType === 'SEND_EVIDENCE_REGISTERED'
    && event.verificationStatus === 'PENDING_MANUAL_VERIFICATION'
    && !settled.has(event.id));
  return pending[pending.length - 1] ?? null;
}

/** The 「次:」 line under the panel — the step after the current one and who does it. */
export function nextStepText(view: Pick<OrderFlowView, 'phase' | 'current'>): string | null {
  if (view.phase !== 'active' || view.current === null) return null;
  const next = ORDER_STEPS[view.current];
  if (!next) return '次: 完了・手数料計算の準備';
  const owner = next.key === 'ceo' ? '代表' : '担当者';
  return `次: ${next.no} ${next.title}（${owner}）`;
}

/** The wait line for a role that cannot do the step (相手待ち). */
export function waitingText(actor: StepActor | null): string {
  return actor === 'admin' ? '代表の確認・承認を待っています。' : '担当者の記録を待っています。';
}
