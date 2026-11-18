import { callApi } from './api';
import { isFilmOrderPastMakerAcceptance } from '@kanei/core';
import { loadWorkspace } from './project-data';
import type { AuditEventView, FilmSupplyOrderView, Workspace } from './project-data';

/**
 * M8-OPERATOR S5 data assembly for the /maker-po area.
 *
 * Every screen reads what the API answers for the signed-in operator, and the
 * API already narrows the maker purchase-order answers by role (FIX 1) — this
 * module never re-filters or re-derives amounts it was not shown. The two
 * dedicated reads it adds are the maker-PO list per order and the G6 payment
 * gate, both of which carry the block reason the screen must show.
 */

/** The maker-PO view shape, exactly as the API answers it per role. */
export interface MakerPoViewRow {
  id: string;
  filmSupplyOrderId?: string;
  status: string;
  // admin view only:
  snapshot?: {
    order?: { code?: string | null };
    amounts?: { currency: string; totalAmount: string } | null;
    recipient?: { address: string };
    items?: Array<{ lineNumber: number; description: string; orderedQuantity: string; unit: string }>;
    specs?: { artworkFiles: Array<{ designKey: string; revisionNo: number; fileSha256: string }> };
  };
  snapshotSha256?: string;
  // staff view only:
  orderCode?: string | null;
  recipientAddress?: string | null;
  ceoApprovedAt?: string | null;
  createdByUserId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MakerPoEventRow {
  id: string;
  eventType: string;
  verificationStatus?: string;
  /** Why the evidence needs a human (PENDING_MANUAL_VERIFICATION の理由). */
  verificationNote?: string | null;
  /** How the evidence was checked (`eml_header_check` など)。 */
  verificationMethod?: string | null;
  verificationChecks?: Array<Record<string, unknown>> | null;
  provisional?: boolean;
  sentAt?: string | null;
  recordedAt?: string;
  senderAddress?: string | null;
  recipients?: Array<string> | null;
  attachmentHashes?: Array<string> | null;
}

/** A manual verification of one send event, shaped from its audit record. */
export type MakerPoSendManualVerificationResult = 'confirmed' | 'rejected';

export interface MakerPoSendManualVerification {
  makerPoEventId: string;
  result: MakerPoSendManualVerificationResult;
  verifierName: string | null;
  verifiedAt: string | null;
  reasonNote: string | null;
  recordedAt: string | null;
}

export interface PaymentGateView {
  orderId: string;
  orderStatus: string;
  paymentTerms: string;
  gate: { satisfied: boolean; code: string | null; reason: string | null; gatedOn?: string | null };
  paymentConfirmedAt: string | null;
}

/**
 * M8-OPER2 FIX 3: the production/shipping/delivery states an order reaches
 * after its maker paper was accepted. These orders keep their place on the
 * board — the 発注書・代表承認・送信・受入 history stays readable — but the
 * recording forms are replaced by that read-only history.
 */
const PAST_MAKER_ACCEPTANCE_ORDER_STATES: readonly string[] = [
  'FILM_IN_PRODUCTION',
  'FILM_SHIPPED',
  'FILM_DELIVERED',
  'FILM_RECEIPT_ASSUMED_NO_ISSUE'
];

/** Which orders carry maker-PO work: the freeze gate, the chain below it, and the completed orders behind it. */
const MAKER_PO_ORDER_STATES: readonly string[] = [
  'MAKER_PO_READY',
  'APPROVED_FOR_MANUAL_SEND',
  'MAKER_PO_SENT_MANUALLY',
  'MAKER_PO_ACCEPTED',
  'SNAPSHOT_VOIDED',
  ...PAST_MAKER_ACCEPTANCE_ORDER_STATES
];

/**
 * True for an order whose maker paper is closed: it has moved past
 * MAKER_PO_ACCEPTED into production/shipping/delivery. The screens answer with
 * read-only history and never render the 승인/발송/수락 forms again.
 */
export function isOrderPastMakerAcceptance(orderStatus: string): boolean {
  return isFilmOrderPastMakerAcceptance(orderStatus);
}

/**
 * Shows every machine-readable check, including the aggregated pending_codes
 * row used when a PDF has several blocking reasons.
 */
export function formatMakerPoVerificationChecks(
  checks: Array<Record<string, unknown>> | null | undefined
): string[] {
  if (!Array.isArray(checks)) return [];
  return checks.map((check) => {
    const key = typeof check?.key === 'string' ? check.key : '';
    const detail = typeof check?.detail === 'string' ? check.detail : '';
    return detail.length > 0 ? `${key}:${detail}` : key;
  }).filter((entry) => entry.length > 0);
}

export interface OrderMakerPoBoard {
  order: FilmSupplyOrderView;
  makerPurchaseOrders: MakerPoViewRow[];
  /** Rows of orders whose maker PO list could not be read (role or API error). */
  makerPoError: string | null;
  paymentGate: PaymentGateView | null;
  paymentGateError: string | null;
}

export interface MakerPoBoard {
  workspace: Workspace;
  boards: OrderMakerPoBoard[];
}

/** The Japanese wording of every maker PO status the screens may show. */
export const MAKER_PO_STATUS_LABELS: Readonly<Record<string, string>> = {
  DRAFT: '下書き（代表承認待ち）',
  APPROVED_FOR_MANUAL_SEND: '代表承認ずみ（手動送信待ち）',
  SEND_UNVERIFIED: '送信未確認（要対応）',
  MAKER_PO_SENT_MANUALLY: '手動送信ずみ（受入確認待ち）',
  MAKER_PO_ACCEPTED: '受入確認済み（最終）',
  SNAPSHOT_VOIDED: 'スナップショット失効（再承認が必要）',
  // M8-HARDEN FIX B2: the replacement exit — history stays, a new maker PO follows.
  CANCELLED: '取消（再発注待ち）'
};

export const MAKER_PO_EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  CEO_APPROVED: '代表承認',
  SNAPSHOT_VOIDED: 'スナップショット失効',
  SEND_EVIDENCE_REGISTERED: '送信証跡の記録',
  ACCEPT_EVIDENCE_REGISTERED: '受入証跡の記録（最終）',
  MAKER_PO_ACCEPT_RECORDED_PROVISIONAL: '受入記録（仮）',
  SEND_REJECTED: '送信却下',
  MAKER_PO_CANCELLED: '発注取消（履歴保持・再発注へ）',
  MAKER_CANCELLATION_ACKNOWLEDGED: '取り消し承認（メーカー取消確認）'
};

export const PAYMENT_TERMS_LABELS: Readonly<Record<string, string>> = {
  prepaid: '前払い（prepaid）',
  on_delivery: '搬入時払い（on_delivery）',
  undetermined: '未確定（undetermined）'
};

/**
 * The next action per maker PO status. The screens always show it, so the
 * operator never has to guess what unblocks the paper.
 */
export function nextActionForStatus(status: string, role: string): string {
  const admin = role === 'admin';
  switch (status) {
    case 'DRAFT':
    case 'SNAPSHOT_VOIDED':
      return admin
        ? '次のアクション：代表承認（G6の決済条件が確定している場合のみ記録できます）'
        : '次のアクション：代表者による代表承認を待ちます（担当者は承認できません）';
    case 'APPROVED_FOR_MANUAL_SEND':
      return '次のアクション：送信済みメールの原本（.eml）を送信証跡として手動送信を記録する';
    case 'SEND_UNVERIFIED':
      return '次のアクション：なし（送信未確認のまま停止中。証跡を揃えたうえで代表者へ相談してください）';
    case 'MAKER_PO_SENT_MANUALLY':
      return role === 'admin'
        ? '次のアクション：受入記録（仮）を確認し、受領証跡を検証して最終受入確認を記録する'
        : '次のアクション：受入記録（仮）を記録し、代表者の最終受入確認を待ちます';
    case 'MAKER_PO_ACCEPTED':
      return '次のアクション：なし（受入確認済み。この発注の紙は完了です）';
    case 'CANCELLED':
      return admin
        ? '次のアクション：送信ずみの取り消しの場合は「取り消し承認（メーカー取消確認）」を記録し、訂正後の発注書を新しく作成する'
        : '次のアクション：訂正後の発注書の作成は代表者により行われます（取り消された発注書は履歴として残ります）';
    default:
      return `次のアクション：状態 ${status} の取り扱いを確認してください`;
  }
}

/**
 * The G6 read for one order: the recorded terms, the gate state and the 入金確認
 * that never self-fills. The /orders screen uses it to show the current terms
 * next to the recording form; the API already answers it per role.
 */
export async function loadPaymentGate(orderId: string): Promise<PaymentGateView | null> {
  const result = await callApi<PaymentGateView>(
    `/api/film-supply-orders/${encodeURIComponent(orderId)}/payment-gate`
  );
  return result.ok && result.data ? result.data : null;
}

/** Loads the maker-PO board for one project, order by order. */
export async function loadMakerPoBoard(projectId: string): Promise<MakerPoBoard> {
  const workspace = await loadWorkspace(projectId);
  const targets = workspace.filmOrders.filter((order) => MAKER_PO_ORDER_STATES.includes(order.status));
  const boards = await Promise.all(targets.map(async (order) => {
    const [listResult, gateResult] = await Promise.all([
      callApi<{ makerPurchaseOrders: MakerPoViewRow[] }>(
        `/api/film-supply-orders/${encodeURIComponent(order.id)}/maker-purchase-orders`
      ),
      callApi<PaymentGateView>(`/api/film-supply-orders/${encodeURIComponent(order.id)}/payment-gate`)
    ]);
    return {
      order,
      makerPurchaseOrders: listResult.ok && listResult.data
        ? listResult.data.makerPurchaseOrders
        : [],
      makerPoError: listResult.ok ? null : listResult.error,
      paymentGate: gateResult.ok && gateResult.data ? gateResult.data : null,
      paymentGateError: gateResult.ok ? null : gateResult.error
    } satisfies OrderMakerPoBoard;
  }));
  return { workspace, boards };
}

/** Role-shaped event trail of one maker PO. */
export async function loadMakerPoDetail(
  poId: string
): Promise<{ purchaseOrder: MakerPoViewRow | null; events: MakerPoEventRow[]; error: string | null }> {
  const result = await callApi<{ purchaseOrder: MakerPoViewRow; events: MakerPoEventRow[] }>(
    `/api/maker-purchase-orders/${encodeURIComponent(poId)}`
  );
  if (!result.ok || !result.data) {
    return { purchaseOrder: null, events: [], error: result.error ?? 'メーカー発注書が取得できませんでした。' };
  }
  return { purchaseOrder: result.data.purchaseOrder, events: result.data.events, error: null };
}

/**
 * M8-UI2: the send events a human still has to settle. The EML check records
 * what it could not prove (PENDING_MANUAL_VERIFICATION) and the paper stays
 * where it is; the representative's confirmation is a separate append-only
 * record, so a settled event is excluded even though its original status is
 * unchanged.
 */
export function pendingManualVerificationEvents(
  events: MakerPoEventRow[],
  manualVerifications: ReadonlyArray<MakerPoSendManualVerification> = []
): MakerPoEventRow[] {
  const settledEventIds = new Set(manualVerifications.map((verification) => verification.makerPoEventId));
  return events.filter((event) =>
    event.eventType === 'SEND_EVIDENCE_REGISTERED'
    && event.verificationStatus === 'PENDING_MANUAL_VERIFICATION'
    && !settledEventIds.has(event.id));
}

/**
 * Reads the representative's append-only send decisions from the audit rows the
 * page already loads. The original send event keeps its pending content-check
 * status forever, so the separate audit record — not that status — says whether
 * a human has settled it.
 */
export function sendManualVerificationsFromAuditEvents(
  auditEvents: ReadonlyArray<AuditEventView>
): MakerPoSendManualVerification[] {
  return auditEvents.flatMap((auditEvent) => {
    if (
      auditEvent.action !== 'MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED'
      || auditEvent.entityType !== 'maker_po_event'
    ) {
      return [];
    }

    const afterState = auditEvent.afterState;
    const makerPoEventId = afterState?.makerPoEventId;
    const result = afterState?.result;
    if (
      typeof makerPoEventId !== 'string'
      || makerPoEventId !== auditEvent.entityId
      || (result !== 'confirmed' && result !== 'rejected')
    ) {
      return [];
    }

    const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
    return [{
      makerPoEventId,
      result,
      verifierName: text(afterState?.verifierName),
      verifiedAt: text(afterState?.verifiedAt),
      reasonNote: text(afterState?.reasonNote),
      recordedAt: auditEvent.occurredAt
    }];
  });
}

/** The rejected decisions shown as history rather than as actionable rows. */
export function rejectedSendManualVerifications(
  manualVerifications: ReadonlyArray<MakerPoSendManualVerification>
): MakerPoSendManualVerification[] {
  return manualVerifications.filter((verification) => verification.result === 'rejected');
}

/**
 * True when this paper's send is proven by a verified send event — the
 * classification the API's own cancel and acknowledgement gates re-derive. A
 * paper whose send was already proven cannot be quietly replaced: cancelling
 * it keeps the ordering step closed until the 取り消し承認 is recorded.
 */
export function hasVerifiedSendEvent(events: MakerPoEventRow[]): boolean {
  return events.some((event) =>
    event.eventType === 'SEND_EVIDENCE_REGISTERED'
    && event.verificationStatus === 'VERIFIED');
}

/** True when the 取り消し承認 (MAKER_CANCELLATION_ACKNOWLEDGED) is already recorded. */
export function hasCancellationAcknowledgement(events: MakerPoEventRow[]): boolean {
  return events.some((event) => event.eventType === 'MAKER_CANCELLATION_ACKNOWLEDGED');
}

/**
 * The statuses a cancellation may leave (transitionMakerPurchaseOrder →
 * CANCELLED in @kanei/core): live paper only. SEND_UNVERIFIED refuses on
 * purpose — the unproven send blocks the paper until a human resolves it —
 * and accepted or already-cancelled paper has no exit to offer.
 */
const CANCELLABLE_MAKER_PO_STATUSES: readonly string[] = [
  'DRAFT',
  'APPROVED_FOR_MANUAL_SEND',
  'MAKER_PO_SENT_MANUALLY',
  'SNAPSHOT_VOIDED'
];

export function isCancellableMakerPoStatus(status: string): boolean {
  return CANCELLABLE_MAKER_PO_STATUSES.includes(status);
}
