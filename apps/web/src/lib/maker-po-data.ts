import { callApi } from './api';
import { isFilmOrderPastMakerAcceptance } from '@kanei/core';
import { knownStatus, loadWorkspace } from './project-data';
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

/** UI batch B (⑤): Japanese only; the stored values stay prepaid / on_delivery / undetermined. */
export const PAYMENT_TERMS_LABELS: Readonly<Record<string, string>> = {
  prepaid: '前払い',
  on_delivery: '搬入時払い',
  undetermined: '未確定'
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
  // UI batch B: a withheld status (its 'DRAFT' placeholder) never selects an order.
  const targets = workspace.filmOrders.filter((order) => {
    const status = knownStatus(order);
    return status !== null && MAKER_PO_ORDER_STATES.includes(status);
  });
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
 * True when a send event of this paper was VERIFIED by the EML check. Only one
 * half of the API's proven-send rule: a confirmed manual verification proves a
 * send too, so screens decide with makerPoSendProof, never with this alone.
 */
export function hasVerifiedSendEvent(events: ReadonlyArray<MakerPoEventRow>): boolean {
  return events.some((event) =>
    event.eventType === 'SEND_EVIDENCE_REGISTERED'
    && event.verificationStatus === 'VERIFIED');
}

/**
 * Whether this paper's send is proven, by the API's own rule (cancel
 * classification, 取り消し承認 gate and the create gate since cc9144f): a
 * VERIFIED send event, OR a representative's confirmed manual verification
 * (FIX 3) of a send of this paper.
 *
 * - proven: cancelling keeps the ordering step closed until the 取り消し承認;
 * - unproven: nothing proves a send (cancelling is an internal correction);
 * - unknown: a send still in PENDING_MANUAL_VERIFICATION whose manual
 *   verification records could not be read, so the screen cannot tell — it
 *   must never fall back to 「未送信」 (recheck 6 High-A).
 */
export type MakerPoSendProof = 'proven' | 'unproven' | 'unknown';

export function makerPoSendProof(
  events: ReadonlyArray<MakerPoEventRow>,
  manualVerifications: ReadonlyArray<MakerPoSendManualVerification>,
  unreadEventIds: ReadonlySet<string> = new Set()
): MakerPoSendProof {
  if (hasVerifiedSendEvent(events)) return 'proven';
  const eventIds = new Set(events.map((event) => event.id));
  if (manualVerifications.some((verification) =>
    verification.result === 'confirmed' && eventIds.has(verification.makerPoEventId))) {
    return 'proven';
  }
  const unread = events.some((event) =>
    event.eventType === 'SEND_EVIDENCE_REGISTERED'
    && event.verificationStatus === 'PENDING_MANUAL_VERIFICATION'
    && unreadEventIds.has(event.id));
  return unread ? 'unknown' : 'unproven';
}

export interface CancelSendStateCopy {
  /** danger: the step stays closed; ok: it re-opens; warning: cannot be judged here. */
  tone: 'danger' | 'ok' | 'warning';
  /** The 「この発注書の送信状態」 line. */
  status: string;
  /** The confirmation dialog body. */
  dialog: string;
}

const CANCEL_IRREVERSIBLE = '取り消しは元に戻せません（取消イベントと履歴は残ります）。';

/**
 * The cancel block's wording, from the same judgement the API makes when it
 * classifies the cancellation (recheck 6 High-A: the box and the dialog said
 * 「未送信…すぐに再度開きます」 for a send the representative had confirmed).
 * pendingSend: a send of this paper is recorded but still waits for the
 * manual check — it is not proven, so the API treats the cancel as internal.
 */
export function cancelSendStateCopy(proof: MakerPoSendProof, pendingSend: boolean): CancelSendStateCopy {
  if (proof === 'proven') {
    return {
      tone: 'danger',
      status: '送信ずみ（送信証跡の確認、または代表者による送信の手動確認があります）。取り消すと、発注書の作成ステップの再開には「取り消し承認（メーカー取消確認）」が必要です。',
      dialog: `この発注書は送信ずみです（送信証跡の確認、または送信の手動確認の記録があります）。取り消すと、新しい発注書の作成には「取り消し承認（メーカー取消確認）」の記録が必要になります。${CANCEL_IRREVERSIBLE}`
    };
  }
  if (proof === 'unknown') {
    return {
      tone: 'warning',
      status: '判定できません（この発注書の送信の記録を読み込めませんでした）。送信が確認済みの場合、取り消すと「取り消し承認（メーカー取消確認）」が必要になります。画面を再読み込みしてから取り消してください。',
      dialog: `この発注書が送信ずみかどうかを画面で判定できません（この発注書の送信の記録を読み込めませんでした）。送信が確認済みの場合、取り消すと新しい発注書の作成には「取り消し承認（メーカー取消確認）」の記録が必要になります。${CANCEL_IRREVERSIBLE}`
    };
  }
  if (pendingSend) {
    return {
      tone: 'warning',
      status: '送信は記録されていますが、まだ確認されていません（手動確認待ち）。いま取り消すと内部の訂正として扱われ、すぐに発注書の作成ステップが再度開きます。メーカーに届いている場合は、先に「③′ 送信の手動確認」を記録してください。',
      dialog: `この発注書の送信は手動確認待ちで、まだ確認されていません。取り消すと内部の訂正として扱われ、すぐに発注書の作成ステップが再度開きます。メーカーに届いている場合は、取り消す前に送信の手動確認を記録してください。${CANCEL_IRREVERSIBLE}`
    };
  }
  return {
    tone: 'ok',
    status: '未送信（送信証跡の確認も、送信の手動確認もありません）。取り消すとすぐに発注書の作成ステップが再度開きます。',
    dialog: `この発注書は未送信です。取り消すと、すぐに発注書の作成ステップが再度開きます。${CANCEL_IRREVERSIBLE}`
  };
}

/** A cancelled paper whose 取り消し承認 the API will (or may) ask for. */
export function cancellationAcknowledgementMayBeRequired(status: string, proof: MakerPoSendProof): boolean {
  return status === 'CANCELLED' && proof !== 'unproven';
}

export interface EventManualVerificationRead {
  verifications: MakerPoSendManualVerification[];
  /** Events whose manual verification records could not be read (API error or a trimmed answer). */
  unreadEventIds: Set<string>;
}

/**
 * The project-wide audit read is capped (limit 200, oldest first), so a
 * busy project can lose the newest manual verifications from it. For each
 * send that still shows PENDING_MANUAL_VERIFICATION and has no decision in
 * that list, this asks the audit history for that one event (entityId), so a
 * confirmed send is never mistaken for an unsent one. A failed read, or an
 * answer whose decision row came back without its result (a role-trimmed
 * view), marks the event unread instead of "no decision".
 */
export async function loadManualVerificationsForEvents(
  projectId: string,
  eventIds: readonly string[]
): Promise<EventManualVerificationRead> {
  const unreadEventIds = new Set<string>();
  const verifications: MakerPoSendManualVerification[] = [];
  await Promise.all([...new Set(eventIds)].map(async (eventId) => {
    const result = await callApi<{ events: AuditEventView[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/audit-history?entityType=maker_po_event&entityId=${encodeURIComponent(eventId)}&limit=500`
    );
    const rows = result.ok && result.data && Array.isArray(result.data.events) ? result.data.events : null;
    if (rows === null) {
      unreadEventIds.add(eventId);
      return;
    }
    const decisions = rows.filter((row) =>
      row.action === 'MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED' && row.entityId === eventId);
    const parsed = sendManualVerificationsFromAuditEvents(decisions);
    if (parsed.length < decisions.length) unreadEventIds.add(eventId);
    verifications.push(...parsed);
  }));
  return { verifications, unreadEventIds };
}

/**
 * Send events still in PENDING_MANUAL_VERIFICATION with no confirmation in
 * `known`. A rejection does not settle the question: the API lets a rejected
 * send be confirmed later, and that confirmation may lie past the window.
 */
export function sendEventsWithoutKnownDecision(
  events: ReadonlyArray<MakerPoEventRow>,
  known: ReadonlyArray<MakerPoSendManualVerification>
): string[] {
  const decided = new Set(known
    .filter((verification) => verification.result === 'confirmed')
    .map((verification) => verification.makerPoEventId));
  return events
    .filter((event) =>
      event.eventType === 'SEND_EVIDENCE_REGISTERED'
      && event.verificationStatus === 'PENDING_MANUAL_VERIFICATION'
      && !decided.has(event.id))
    .map((event) => event.id);
}

/**
 * Low-6 (recheck 6): the 取り消し承認 may cite only a document bound to the
 * same order AND the same maker PO (422 MAKER_CANCELLATION_ACK_EVIDENCE_MISMATCH),
 * and since 20d5f70 only an acceptance_evidence document a human marked
 * verified (422 …_EVIDENCE_TYPE_INVALID / …_EVIDENCE_NOT_VERIFIED). The select
 * offers exactly those versions.
 */
export const ACKNOWLEDGEMENT_EVIDENCE_DOCUMENT_TYPE = 'acceptance_evidence';

export function acknowledgementEvidenceDocuments<
  T extends {
    documentType: string;
    verificationStatus: string;
    filmSupplyOrderId: string | null;
    makerPurchaseOrderId: string | null;
  }
>(documents: ReadonlyArray<T>, orderId: string, poId: string): T[] {
  return documents.filter((document) =>
    document.filmSupplyOrderId === orderId
    && document.makerPurchaseOrderId === poId
    && document.documentType === ACKNOWLEDGEMENT_EVIDENCE_DOCUMENT_TYPE
    && document.verificationStatus === 'verified');
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
