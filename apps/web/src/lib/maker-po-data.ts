import { callApi } from './api';
import { FILM_ORDER_CANCELLATION_STATE, isFilmOrderPastMakerAcceptance, isFrozenFilmOrderStatus } from '@kanei/core';
import type { FilmOrderStatus } from '@kanei/core';
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

/**
 * The page's project-wide maker_po_event audit read is capped at this many
 * rows (oldest first). A shorter answer is the complete list, so a send with
 * no decision in it has none — no per-event read is needed (recheck 7 Info-4).
 */
export const MAKER_PO_AUDIT_WINDOW = 200;

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
 * Recheck 7 Medium-3: an order that is cancelled (CANCELLED, terminal) or
 * frozen (ON_HOLD, CHANGE_REVIEW, CANCELLATION_REVIEW) can still carry maker
 * paper: a cancellation review resolved as cancel leaves the paper untouched,
 * and a hold does not retire it. The API keeps the two cleanup operations open
 * there — 発注書の取り消し and 取り消し承認 — and refuses every other maker
 * write (409 FILM_ORDER_CANCELLED_… / ORDER_ON_HOLD_MAKER_PO_ACTION_BLOCKED).
 * Such an order is on the board in cleanup-only mode, and only while there is
 * cleanup left (see makerPaperCleanupWork).
 */
export type MakerPoOrderClosure = 'cancelled' | 'frozen';

export function makerPoOrderClosure(orderStatus: string | null): MakerPoOrderClosure | null {
  if (orderStatus === null) return null;
  if (orderStatus === FILM_ORDER_CANCELLATION_STATE) return 'cancelled';
  return isFrozenFilmOrderStatus(orderStatus as FilmOrderStatus) ? 'frozen' : null;
}

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
  /** Medium-3: set for a cancelled or frozen order — the card offers the cleanup only. */
  closure: MakerPoOrderClosure | null;
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
 * Medium-3: the next action of a paper on a cancelled or frozen order. Only
 * the cleanup is possible there (取り消し, 取り消し承認); the order itself is
 * released or resolved on the /orders screen.
 */
export function cleanupNextActionForStatus(status: string, role: string, closure: MakerPoOrderClosure): string {
  const admin = role === 'admin';
  const replacement = closure === 'cancelled'
    ? 'この発注は取消で終了しているため、新しい発注書は作成しません'
    : '新しい発注書は保留・見直しの解除後に作成します';
  if (status === 'CANCELLED') {
    return admin
      ? `次のアクション：送信ずみの取り消しの場合は「取り消し承認（メーカー取消確認）」を記録する（${replacement}）`
      : `次のアクション：送信ずみの取り消しの場合、代表者が「取り消し承認」を記録します（${replacement}）`;
  }
  if (isCancellableMakerPoStatus(status)) {
    return admin
      ? '次のアクション：この発注の状態では、発注書の取り消しだけを記録できます（下の「整理」）。代表承認・送信・受入は記録できません'
      : '次のアクション：この発注の状態では、代表者による発注書の取り消しを待ちます（代表承認・送信・受入は記録できません）';
  }
  return `次のアクション：この状態（${MAKER_PO_STATUS_LABELS[status] ?? status}）の発注書はこの画面から取り消せません。メーカーへの連絡と対応は代表者が判断します`;
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
  // The board reads every closed order's paper itself (the page fills
  // workspace.makerPaperCleanup from that read), so the workspace skips it.
  const workspace = await loadWorkspace(projectId, { makerPaperCleanup: false });
  // UI batch B: a withheld status (its 'DRAFT' placeholder) never selects an order.
  const targets = workspace.filmOrders.filter((order) => {
    const status = knownStatus(order);
    return status !== null && (MAKER_PO_ORDER_STATES.includes(status) || makerPoOrderClosure(status) !== null);
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
      closure: makerPoOrderClosure(knownStatus(order)),
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
  manualVerifications: ReadonlyArray<MakerPoSendManualVerification> = [],
  paperStatus: string | null = null
): MakerPoEventRow[] {
  // Recheck 7 Medium-1: the API refuses both decisions on a cancelled paper
  // (409 MAKER_PO_CANCELLED_SEND_CONFIRMATION_BLOCKED), so its sends are never
  // work to settle; they are listed read-only (unsettledSendsOfCancelledPaper).
  if (paperStatus === 'CANCELLED') return [];
  const settledEventIds = new Set(manualVerifications.map((verification) => verification.makerPoEventId));
  return events.filter((event) =>
    event.eventType === 'SEND_EVIDENCE_REGISTERED'
    && event.verificationStatus === 'PENDING_MANUAL_VERIFICATION'
    && !settledEventIds.has(event.id));
}

/**
 * Recheck 7 Medium-1: the sends of a cancelled paper that were never settled.
 * Nobody can settle them any more — the API refuses both 確認 and 却下 on a
 * cancelled paper — so the screen shows them as a read-only note, never as
 * the ③′ form.
 */
export function unsettledSendsOfCancelledPaper(
  events: ReadonlyArray<MakerPoEventRow>,
  manualVerifications: ReadonlyArray<MakerPoSendManualVerification>,
  paperStatus: string,
  /** Sends whose decision exists but cannot be read here (recheck 9 Medium-3): not "pending". */
  undecidable: ReadonlySet<string> = new Set()
): MakerPoEventRow[] {
  if (paperStatus !== 'CANCELLED') return [];
  const settled = new Set(manualVerifications.map((verification) => verification.makerPoEventId));
  return events.filter((event) =>
    event.eventType === 'SEND_EVIDENCE_REGISTERED'
    && event.verificationStatus === 'PENDING_MANUAL_VERIFICATION'
    && !settled.has(event.id)
    && !undecidable.has(event.id));
}

/**
 * The API's own classification of each cancellation, from its MAKER_PO_CANCELLED
 * audit row (entity: the cancel event): true when the cancel told the
 * operator that a replacement needs the 取り消し承認 (the send was proven when
 * the paper was cancelled). Since 20d5f70 no send can be proven after the
 * cancel, so a true flag settles the paper's proof without any further read.
 * A false flag is not taken as proof of "unsent": cancellations recorded
 * before cc9144f ignored confirmed manual verifications.
 */
export function cancellationAcknowledgementFlags(
  auditEvents: ReadonlyArray<AuditEventView>
): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  for (const auditEvent of auditEvents) {
    if (auditEvent.action !== 'MAKER_PO_CANCELLED' || auditEvent.entityType !== 'maker_po_event') continue;
    const flag = auditEvent.afterState?.newMakerPoRequiresCancellationAcknowledgement;
    if (typeof flag === 'boolean') flags.set(auditEvent.entityId, flag);
  }
  return flags;
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

/**
 * Recheck 9 Medium-3: the send events that HAVE a representative decision the
 * viewer cannot read. The API shows staff the audit row of each decision
 * (MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED, entity: the send event) with its
 * afterState narrowed to status-like keys, so `result` is absent. Such a send
 * was settled — confirmed (a proven send) or rejected — and the screen must not
 * read it as "never confirmed" (unproven) nor as 「手動確認待ち」.
 */
export function undisclosedSendDecisionEventIds(
  auditEvents: ReadonlyArray<AuditEventView>
): Set<string> {
  const disclosed = new Set(sendManualVerificationsFromAuditEvents(auditEvents)
    .map((verification) => verification.makerPoEventId));
  const ids = new Set<string>();
  for (const auditEvent of auditEvents) {
    if (
      auditEvent.action === 'MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED'
      && auditEvent.entityType === 'maker_po_event'
      && !disclosed.has(auditEvent.entityId)
    ) {
      ids.add(auditEvent.entityId);
    }
  }
  return ids;
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
  unreadEventIds: ReadonlySet<string> = new Set(),
  cancellationFlags: ReadonlyMap<string, boolean> = new Map()
): MakerPoSendProof {
  if (hasVerifiedSendEvent(events)) return 'proven';
  // Recheck 8 Medium-B: a MAKER_CANCELLATION_ACKNOWLEDGED event no longer
  // proves a send. Since 7bd0bca the API stores the representative decision
  // (a) — a record-only post-delivery confirmation of an internally cancelled
  // paper — under the same event type (cancellationAcknowledgementKind).
  if (events.some((event) => event.eventType === 'MAKER_PO_CANCELLED' && cancellationFlags.get(event.id) === true)) {
    return 'proven';
  }
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
export function cancelSendStateCopy(
  proof: MakerPoSendProof,
  pendingSend: boolean,
  closure: MakerPoOrderClosure | null = null
): CancelSendStateCopy {
  // Medium-3: on a cancelled or frozen order the cancel is cleanup — the order
  // keeps its own state, so nothing "re-opens"; the 取り消し承認 of a proven
  // send records that the maker took the cancellation back.
  const closedOrder = closure === 'cancelled'
    ? 'この発注は取消で終了しているため、取り消しても発注の状態は変わらず、新しい発注書も作成されません。'
    : closure === 'frozen'
      ? 'この発注は保留・見直し中のため、取り消しても発注の状態は変わりません（解除・処理は発注一覧画面で代表者が行います）。'
      : null;
  if (proof === 'proven') {
    if (closedOrder) {
      return {
        tone: 'danger',
        status: `送信ずみ（送信証跡の確認、または代表者による送信の手動確認があります）。取り消したあと、メーカーが取り消しを受け入れたことを「取り消し承認（メーカー取消確認）」として記録してください。${closedOrder}`,
        dialog: `この発注書は送信ずみです（送信証跡の確認、または送信の手動確認の記録があります）。メーカーが生産を始めないよう、取り消したあとメーカーの了承を「取り消し承認（メーカー取消確認）」として記録してください。${closedOrder}${CANCEL_IRREVERSIBLE}`
      };
    }
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
      dialog: `この発注書が送信ずみかどうかを画面で判定できません（この発注書の送信の記録を読み込めませんでした）。送信が確認済みの場合、取り消すと${closedOrder ? '「取り消し承認（メーカー取消確認）」' : '新しい発注書の作成には「取り消し承認（メーカー取消確認）」'}の記録が必要になります。${closedOrder ?? ''}${CANCEL_IRREVERSIBLE}`
    };
  }
  if (pendingSend) {
    if (closedOrder) {
      // The manual check itself is refused on a closed order (409), so it
      // cannot be recorded first; the cancel is internal (no 取り消し承認 follows).
      return {
        tone: 'warning',
        status: `送信は記録されていますが、まだ確認されていません（手動確認待ち）。この発注の状態では送信の手動確認を記録できず、取り消しは内部の訂正として扱われます（取り消し承認の対象ではありません）。メーカーに届いている可能性がある場合は、メーカーへ取り消しを連絡し、その内容を取消理由に書いてください。届いていたと分かったときは、取り消しのあとに「メーカー到達の事後確認（記録のみ）」を残せます。${closedOrder}`,
        dialog: `この発注書の送信は手動確認待ちで、まだ確認されていません。取り消すと内部の訂正として扱われ、あとから送信の確認は記録できません（取り消し承認の対象にもなりません。届いていたと分かったときは「メーカー到達の事後確認（記録のみ）」だけを残せます）。メーカーに届いている可能性がある場合は、メーカーへの連絡内容を取消理由に書いてください。${closedOrder}${CANCEL_IRREVERSIBLE}`
      };
    }
    return {
      tone: 'warning',
      status: '送信は記録されていますが、まだ確認されていません（手動確認待ち）。いま取り消すと内部の訂正として扱われ、すぐに発注書の作成ステップが再度開きます。メーカーに届いている場合は、先に「③′ 送信の手動確認」を記録してください。',
      dialog: `この発注書の送信は手動確認待ちで、まだ確認されていません。取り消すと内部の訂正として扱われ、すぐに発注書の作成ステップが再度開きます。メーカーに届いている場合は、取り消す前に送信の手動確認を記録してください。${CANCEL_IRREVERSIBLE}`
    };
  }
  if (closedOrder) {
    return {
      tone: 'ok',
      status: `未送信（送信証跡の確認も、送信の手動確認もありません）。取り消すとこの発注書は終わります。${closedOrder}`,
      dialog: `この発注書は未送信です。取り消すとこの発注書は終わります。${closedOrder}${CANCEL_IRREVERSIBLE}`
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
export function hasCancellationAcknowledgement(events: ReadonlyArray<MakerPoEventRow>): boolean {
  return events.some((event) => event.eventType === 'MAKER_CANCELLATION_ACKNOWLEDGED');
}

/**
 * Recheck 8 Medium-B: what one MAKER_CANCELLATION_ACKNOWLEDGED record means.
 * The API (API_CONTRACT recheck8-fix, `acknowledgementKind`) records two acts
 * under that event type and decides between them by its proven-send rule:
 * - CANCELLATION_ACKNOWLEDGEMENT: the 取り消し承認 of a proven send — the
 *   maker took the cancellation back; it lifts the create gate.
 * - POST_DELIVERY_CONFIRMATION: representative decision (a) — an internally
 *   cancelled paper (no proven send) is recorded as having reached the maker
 *   after all. Record only: it never re-opens the order or lifts a gate.
 */
export type CancellationAcknowledgementKind = 'CANCELLATION_ACKNOWLEDGEMENT' | 'POST_DELIVERY_CONFIRMATION';

function isAcknowledgementKind(value: unknown): value is CancellationAcknowledgementKind {
  return value === 'CANCELLATION_ACKNOWLEDGEMENT' || value === 'POST_DELIVERY_CONFIRMATION';
}

/**
 * The kind the API stored in each acknowledgement's audit row
 * (MAKER_CANCELLATION_ACKNOWLEDGED, entity: the acknowledgement event,
 * afterState.acknowledgementKind), by acknowledgement event id.
 */
export function acknowledgementKindsFromAuditEvents(
  auditEvents: ReadonlyArray<AuditEventView>
): Map<string, CancellationAcknowledgementKind> {
  const kinds = new Map<string, CancellationAcknowledgementKind>();
  for (const auditEvent of auditEvents) {
    if (auditEvent.action !== 'MAKER_CANCELLATION_ACKNOWLEDGED' || auditEvent.entityType !== 'maker_po_event') continue;
    const kind = auditEvent.afterState?.acknowledgementKind;
    if (isAcknowledgementKind(kind)) kinds.set(auditEvent.entityId, kind);
  }
  return kinds;
}

/**
 * The kind of this paper's recorded acknowledgement, or null when none is
 * recorded. The audit row says it when the screen could read it; otherwise the
 * API's own rule is re-applied: the kind is the send proof at recording time,
 * and since 20d5f70 no send of a cancelled paper can be proven afterwards, so
 * the proof read now is that proof. 'unknown': neither could be read — e.g.
 * on the staff screen, whose audit rows carry neither the kind nor the send
 * decisions (recheck 9 Medium-3: the proof is then 'unknown', never the
 * 'unproven' that turned a proven send's 取り消し承認 into 事後確認).
 */
export function cancellationAcknowledgementKind(
  events: ReadonlyArray<MakerPoEventRow>,
  proof: MakerPoSendProof,
  auditKinds: ReadonlyMap<string, CancellationAcknowledgementKind> = new Map()
): CancellationAcknowledgementKind | 'unknown' | null {
  const acknowledgement = events.find((event) => event.eventType === 'MAKER_CANCELLATION_ACKNOWLEDGED');
  if (!acknowledgement) return null;
  const audited = auditKinds.get(acknowledgement.id);
  if (audited) return audited;
  if (proof === 'proven') return 'CANCELLATION_ACKNOWLEDGEMENT';
  return proof === 'unproven' ? 'POST_DELIVERY_CONFIRMATION' : 'unknown';
}

/** The label of an acknowledgement record, by its kind. */
export function cancellationAcknowledgementLabel(kind: CancellationAcknowledgementKind | 'unknown' | null): string {
  if (kind === 'POST_DELIVERY_CONFIRMATION') return 'メーカー到達の事後確認（記録のみ）';
  if (kind === 'unknown') return '取り消し承認またはメーカー到達の事後確認';
  return MAKER_PO_EVENT_TYPE_LABELS.MAKER_CANCELLATION_ACKNOWLEDGED!;
}

/**
 * Representative decision (a): the screen offers the post-delivery
 * confirmation for a cancelled paper whose send was recorded but never proven
 * (an internal cancel) and that has no acknowledgement yet. A paper with no
 * send record at all is not offered it — nothing says it ever left (recheck 8
 * Low-4).
 */
export function offersPostDeliveryConfirmation(
  status: string,
  proof: MakerPoSendProof,
  events: ReadonlyArray<MakerPoEventRow>
): boolean {
  return status === 'CANCELLED'
    && proof === 'unproven'
    && !hasCancellationAcknowledgement(events)
    && events.some((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED');
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

/** One paper as the cleanup and creation judgements read it. */
export interface MakerPaperJudgement {
  status: string;
  sendProof: MakerPoSendProof;
  acknowledgementRecorded: boolean;
}

/**
 * The 取り消し承認 still owed by a cancelled paper: required (proven send, no
 * acknowledgement), maybe (the proof could not be read), or null.
 */
export function acknowledgementOwed(paper: MakerPaperJudgement): 'required' | 'maybe' | null {
  if (paper.status !== 'CANCELLED' || paper.acknowledgementRecorded) return null;
  if (paper.sendProof === 'proven') return 'required';
  return paper.sendProof === 'unknown' ? 'maybe' : null;
}

export interface MakerPaperCleanupWork {
  /** Paper that is not cancelled (the API's "live paper": status ≠ CANCELLED). */
  livePapers: number;
  /** Live paper the screen can cancel (DRAFT, APPROVED…, SENT_MANUALLY, SNAPSHOT_VOIDED). */
  cancellablePapers: number;
  /** Cancelled paper whose 取り消し承認 is required, or may be (unknown proof). */
  acknowledgementPapers: number;
}

/**
 * Medium-3: the cleanup a cancelled or frozen order still carries. Live paper
 * of a cancelled order may be produced by the maker; a proven send cancelled
 * without the 取り消し承認 was never confirmed taken back. The board shows
 * the order while any of it is left, and 「これ以上の作業はありません」 is
 * said only when none is.
 */
export function makerPaperCleanupWork(papers: ReadonlyArray<MakerPaperJudgement>): MakerPaperCleanupWork {
  return {
    livePapers: papers.filter((paper) => paper.status !== 'CANCELLED').length,
    cancellablePapers: papers.filter((paper) => isCancellableMakerPoStatus(paper.status)).length,
    acknowledgementPapers: papers.filter((paper) => acknowledgementOwed(paper) !== null).length
  };
}

/**
 * Recheck 8 Low-5: the representative decision on the 7th recheck Medium-5 —
 * while an order has live maker paper (any status but CANCELLED, accepted
 * paper included) the API refuses a new artwork revision (409
 * MAKER_PO_ACTIVE_ARTWORK_REVISION_BLOCKED). The only way out is cancelling
 * that paper; 送信未確認 and 受入済み paper cannot be cancelled.
 */
export const ARTWORK_REVISION_LIVE_PAPER_REFUSAL =
  'この発注には取り消されていないメーカー発注書があるため、新しい版は登録できません。'
  + '版を変えるには、先にメーカー発注画面で代表者がその発注書を取り消してください。'
  + '送信未確認・受入済みの発注書は取り消せないため、その発注では版を登録できません（対応は代表者が判断します）。';

/** The maker paper of one order that blocks a new artwork revision. */
export function liveMakerPapers<T extends { status: string }>(rows: ReadonlyArray<T>): T[] {
  return rows.filter((row) => row.status !== 'CANCELLED');
}

export function hasMakerPaperCleanup(work: MakerPaperCleanupWork): boolean {
  return work.livePapers > 0 || work.acknowledgementPapers > 0;
}

/**
 * Low-7 (f): the create gate refuses a replacement while a proven send was
 * cancelled without its 取り消し承認 (422 MAKER_PO_CANCELLATION_ACK_REQUIRED),
 * so such an order is not offered in the create form.
 */
export function acknowledgementBlocksCreation(papers: ReadonlyArray<MakerPaperJudgement>): boolean {
  return papers.some((paper) => acknowledgementOwed(paper) === 'required');
}

/**
 * Medium-3, for the screens outside /maker-po (次にやること, the transition
 * cell): what the maker paper of one cancelled or frozen order still needs.
 * none: nothing (the paper is all cancelled and settled); cleanup: live paper
 * or an owed 取り消し承認; unknown: the paper could not be read, so the screen
 * must not claim there is nothing left.
 */
export type MakerPaperCleanupState = 'none' | 'cleanup' | 'unknown';

export interface MakerPaperCleanupSummary extends MakerPaperCleanupWork {
  state: MakerPaperCleanupState;
}

const UNKNOWN_CLEANUP: MakerPaperCleanupSummary = { state: 'unknown', livePapers: 0, cancellablePapers: 0, acknowledgementPapers: 0 };

/** The summary of one order's judged paper; listFailed: its maker PO list could not be read. */
export function makerPaperCleanupSummary(
  papers: ReadonlyArray<MakerPaperJudgement>,
  listFailed = false
): MakerPaperCleanupSummary {
  if (listFailed) return UNKNOWN_CLEANUP;
  const work = makerPaperCleanupWork(papers);
  const owed = papers.map(acknowledgementOwed);
  return {
    ...work,
    state: work.livePapers > 0 || owed.includes('required') ? 'cleanup' : owed.includes('maybe') ? 'unknown' : 'none'
  };
}

/**
 * Reads the maker paper of the given cancelled or frozen orders: the list per
 * order, the event trail of each cancelled paper not yet acknowledged, and —
 * only when such a paper has a send the trail cannot settle — the project's
 * maker_po_event audit rows (decisions and cancel classifications). A send
 * whose decision lies past that capped read stays unknown here; the /maker-po
 * board itself asks for it.
 */
export async function loadMakerPaperCleanup(
  projectId: string,
  orderIds: readonly string[]
): Promise<Record<string, MakerPaperCleanupSummary>> {
  const out: Record<string, MakerPaperCleanupSummary> = {};
  if (orderIds.length === 0) return out;
  const lists = await Promise.all(orderIds.map((orderId) => callApi<{ makerPurchaseOrders: MakerPoViewRow[] }>(
    `/api/film-supply-orders/${encodeURIComponent(orderId)}/maker-purchase-orders`
  )));
  const cancelledByOrder = new Map<string, MakerPoViewRow[]>();
  const papersByOrder = new Map<string, MakerPoViewRow[]>();
  orderIds.forEach((orderId, index) => {
    const result = lists[index];
    const rows = result?.ok && result.data && Array.isArray(result.data.makerPurchaseOrders)
      ? result.data.makerPurchaseOrders
      : null;
    if (rows === null) {
      out[orderId] = UNKNOWN_CLEANUP;
      return;
    }
    papersByOrder.set(orderId, rows);
    cancelledByOrder.set(orderId, rows.filter((po) => po.status === 'CANCELLED'));
  });
  const cancelled = [...cancelledByOrder.values()].flat();
  const details = new Map<string, Awaited<ReturnType<typeof loadMakerPoDetail>>>();
  await Promise.all(cancelled.map(async (po) => {
    details.set(po.id, await loadMakerPoDetail(po.id));
  }));
  const needsAudit = cancelled.some((po) => {
    const events = details.get(po.id)?.events ?? [];
    return !hasVerifiedSendEvent(events) && !hasCancellationAcknowledgement(events)
      && events.some((event) => event.eventType === 'SEND_EVIDENCE_REGISTERED');
  });
  let audit: AuditEventView[] | null = [];
  let auditComplete = true;
  if (needsAudit) {
    const result = await callApi<{ events: AuditEventView[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/audit-history?entityType=maker_po_event&limit=${MAKER_PO_AUDIT_WINDOW}`
    );
    audit = result.ok && result.data && Array.isArray(result.data.events) ? result.data.events : null;
    auditComplete = audit !== null && audit.length < MAKER_PO_AUDIT_WINDOW;
  }
  const verifications = sendManualVerificationsFromAuditEvents(audit ?? []);
  const flags = cancellationAcknowledgementFlags(audit ?? []);
  // Recheck 9 Medium-3: a decision the role cannot read is no decision read.
  const undisclosed = undisclosedSendDecisionEventIds(audit ?? []);
  for (const [orderId, rows] of papersByOrder) {
    const judgements: MakerPaperJudgement[] = rows.map((po) => {
      if (po.status !== 'CANCELLED') return { status: po.status, sendProof: 'unproven', acknowledgementRecorded: false };
      const detail = details.get(po.id);
      if (!detail || detail.error) return { status: po.status, sendProof: 'unknown', acknowledgementRecorded: false };
      const unread = new Set<string>(auditComplete
        ? []
        : sendEventsWithoutKnownDecision(detail.events, verifications));
      for (const id of undisclosed) unread.add(id);
      return {
        status: po.status,
        sendProof: makerPoSendProof(detail.events, verifications, unread, flags),
        acknowledgementRecorded: hasCancellationAcknowledgement(detail.events)
      };
    });
    out[orderId] = makerPaperCleanupSummary(judgements);
  }
  return out;
}
