import { createHash } from 'node:crypto';
import type { DocumentType } from './documents.js';
import {
  evaluateMakerPoEmlEvidence,
  MAKER_PO_SEND_VERIFICATION_METHOD_EML_HEADER_CHECK,
  MAKER_PO_SENT_AT_MAX_FUTURE_SKEW_MS,
  type MakerPoEmlCheck,
  type MakerPoEmlPendingCode
} from './eml.js';

/**
 * M4 maker purchase orders with manual-send evidence (design section 5.8 and
 * gates G8 to G10).
 *
 * The maker PO is a snapshot-first record: the paper the maker receives is
 * frozen as JSON plus a server-computed sha256, the CEO approves exactly that
 * digest, and sending happens outside the system (manual mail) so the send and
 * the acceptance can only ever be recorded as evidence-backed events.
 *
 * The rules this module owns, all pure so the state machine stays unit-testable:
 * - snapshot identity (G10): the digest is recomputed from current order data
 *   at every transition that matters. A transition that finds the current
 *   digest different from the approved one voids the snapshot — the frozen
 *   paper no longer describes the real order, the send is refused, and a fresh
 *   CEO approval of the new snapshot is required (T-23, T-24);
 * - evidence verification (G9): registering send evidence with a proof
 *   document (the sent mail file or a header proof carrying sender address,
 *   recipients, sent time and attachment hashes) is VERIFIED and moves the PO
 *   to MAKER_PO_SENT_MANUALLY; registering only a sent_at timestamp is
 *   UNVERIFIED, moves the PO to SEND_UNVERIFIED and blocks every further
 *   transition until a human resolves it (T-21). Acceptance is only reachable
 *   behind a verified acceptance evidence document (T-22);
 * - allowed transitions (G8): the CEO approval is the only exit from DRAFT,
 *   SEND_UNVERIFIED has no exits, and SNAPSHOT_VOIDED only re-opens through a
 *   fresh CEO approval;
 * - one active maker PO per film order (M8-HARDEN FIX B2): replacement is the
 *   explicit CANCELLED status — the old paper is cancelled with an append-only
 *   event, its rows are never deleted, and only then can a new maker PO freeze
 *   for the same order.
 */

export const MAKER_PURCHASE_ORDER_STATUSES = [
  'DRAFT',
  'APPROVED_FOR_MANUAL_SEND',
  'SEND_UNVERIFIED',
  'MAKER_PO_SENT_MANUALLY',
  'MAKER_PO_ACCEPTED',
  'SNAPSHOT_VOIDED',
  'CANCELLED'
] as const;

export type MakerPurchaseOrderStatus = (typeof MAKER_PURCHASE_ORDER_STATUSES)[number];

/** M8-HARDEN FIX B2: the one status that frees an order for replacement paper. */
export const MAKER_PO_CANCELLED_STATUS = 'CANCELLED';

export const MAKER_PO_EVENT_TYPES = [
  'CEO_APPROVED',
  'SNAPSHOT_VOIDED',
  'SEND_EVIDENCE_REGISTERED',
  'ACCEPT_EVIDENCE_REGISTERED',
  'SEND_REJECTED',
  'MAKER_PO_CANCELLED',
  // M8-HARDEN2 FIX 2: the representative's acknowledgement that a cancelled
  // paper had really been sent. It is the only record that re-opens the
  // ordering step after paper whose send was proven has been cancelled.
  'MAKER_CANCELLATION_ACKNOWLEDGED'
] as const;

export type MakerPoEventType = (typeof MAKER_PO_EVENT_TYPES)[number];

export const MAKER_PO_EVENT_VERIFICATION_STATUSES = [
  'VERIFIED',
  'UNVERIFIED',
  'PENDING_MANUAL_VERIFICATION'
] as const;

export type MakerPoEventVerificationStatus = (typeof MAKER_PO_EVENT_VERIFICATION_STATUSES)[number];

export type MakerPoVocabularyValidation<T extends string> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

/**
 * The film supply order states of the maker purchase-order chain (M4).
 *
 * These are the order-level mirrors of the maker PO statuses: the CEO approval,
 * the send evidence and the acceptance evidence of a maker purchase order are
 * the only writers of APPROVED_FOR_MANUAL_SEND, MAKER_PO_SENT_MANUALLY and
 * MAKER_PO_ACCEPTED on the order. They are exported from this module — the same
 * module that owns the maker PO transition rules — so the generic film order
 * transition endpoint and the dedicated maker purchase-order endpoints share
 * one vocabulary and can never drift apart.
 */
export const FILM_ORDER_MAKER_CHAIN_STATES = [
  'APPROVED_FOR_MANUAL_SEND',
  'MAKER_PO_SENT_MANUALLY',
  'MAKER_PO_ACCEPTED'
] as const;

export type FilmOrderMakerChainState = (typeof FILM_ORDER_MAKER_CHAIN_STATES)[number];

export function isFilmOrderMakerChainState(state: string): state is FilmOrderMakerChainState {
  return (FILM_ORDER_MAKER_CHAIN_STATES as readonly string[]).includes(state);
}

/**
 * M8-OPER2 FIX 3: the production/shipping/delivery states an order reaches
 * AFTER its maker purchase order was accepted (製造中／出荷済み／納品済み). The
 * maker-PO screens keep listing these orders — their paper history (発注書・
 * 代表承認・送信・受入) must stay readable after the chain moved on — but the
 * screens stop offering the recording forms, because the paper is closed:
 * re-approving, re-sending or re-accepting it is no longer an action anyone
 * should reach for.
 */
export const FILM_ORDER_PAST_MAKER_ACCEPTANCE_STATES = [
  'FILM_IN_PRODUCTION',
  'FILM_SHIPPED',
  'FILM_DELIVERED',
  'FILM_RECEIPT_ASSUMED_NO_ISSUE'
] as const;

export type FilmOrderPastMakerAcceptanceState =
  (typeof FILM_ORDER_PAST_MAKER_ACCEPTANCE_STATES)[number];

export function isFilmOrderPastMakerAcceptance(state: string): boolean {
  return (FILM_ORDER_PAST_MAKER_ACCEPTANCE_STATES as readonly string[]).includes(state);
}

export type MakerChainTransitionCheck =
  | { ok: true }
  | { ok: false; code: 'MAKER_CHAIN_TRANSITION_FORBIDDEN'; message: string };

/**
 * A generic film order transition may never target the maker chain: each of
 * these states is reached by recording evidence on the maker purchase order
 * (CEO approval, send evidence, acceptance evidence), not by naming a state.
 */
export function makerChainTransitionRefusal(target: string): MakerChainTransitionCheck {
  if (!isFilmOrderMakerChainState(target)) return { ok: true };
  return {
    ok: false,
    code: 'MAKER_CHAIN_TRANSITION_FORBIDDEN',
    message: `メーカー発注の状態（${target}）は総合的な状態遷移APIからは遷移できません。メーカー発注書の専用操作（CEO承認・送信証跡・受領証跡）から記録してください。`
  };
}

export function validateMakerPoStatus(value: unknown): MakerPoVocabularyValidation<MakerPurchaseOrderStatus> {
  if (typeof value !== 'string' || !(MAKER_PURCHASE_ORDER_STATUSES as readonly string[]).includes(value)) {
    return {
      ok: false,
      code: 'UNKNOWN_MAKER_PO_STATUS',
      message: `maker purchase order status must be one of ${MAKER_PURCHASE_ORDER_STATUSES.join(', ')}; received ${String(value)}`
    };
  }
  return { ok: true, value: value as MakerPurchaseOrderStatus };
}

export function validateMakerPoEventType(value: unknown): MakerPoVocabularyValidation<MakerPoEventType> {
  if (typeof value !== 'string' || !(MAKER_PO_EVENT_TYPES as readonly string[]).includes(value)) {
    return {
      ok: false,
      code: 'UNKNOWN_MAKER_PO_EVENT_TYPE',
      message: `maker PO event type must be one of ${MAKER_PO_EVENT_TYPES.join(', ')}; received ${String(value)}`
    };
  }
  return { ok: true, value: value as MakerPoEventType };
}

export function validateMakerPoVerificationStatus(
  value: unknown
): MakerPoVocabularyValidation<MakerPoEventVerificationStatus> {
  if (
    typeof value !== 'string'
    || !(MAKER_PO_EVENT_VERIFICATION_STATUSES as readonly string[]).includes(value)
  ) {
    return {
      ok: false,
      code: 'UNKNOWN_MAKER_PO_VERIFICATION_STATUS',
      message: `maker PO event verification status must be one of ${MAKER_PO_EVENT_VERIFICATION_STATUSES.join(', ')}; received ${String(value)}`
    };
  }
  return { ok: true, value: value as MakerPoEventVerificationStatus };
}

// ---------------------------------------------------------------------------
// Snapshot identity (G10)
// ---------------------------------------------------------------------------

/** One line of the frozen maker paper. */
export interface MakerPoSnapshotItem {
  lineNumber: number;
  description: string;
  orderedQuantity: string;
  unit: string;
}

/** The artwork a design's approval is bound to, frozen into the paper. */
export interface MakerPoSnapshotArtworkFile {
  designKey: string;
  revisionNo: number;
  fileSha256: string;
}

/**
 * The immutable maker PO snapshot (design section 5.8): order identity, items,
 * quantities, specs (the approved artwork files), amounts and the recipient
 * address. Anything that changes in the order data after the snapshot was
 * approved changes the recomputed digest and voids the paper.
 */
export interface MakerPoSnapshot {
  order: { id: string; code: string; sevenPoNumber: string | null };
  items: MakerPoSnapshotItem[];
  quantities: Array<{ lineNumber: number; orderedQuantity: string; unit: string }>;
  specs: { artworkFiles: MakerPoSnapshotArtworkFile[] };
  amounts: { currency: string; totalAmount: string } | null;
  recipient: { address: string };
}

export interface MakerPoSnapshotInput {
  order: { id: string; code: string; sevenPoNumber: string | null };
  items: Array<{
    lineNumber: number;
    description: string;
    orderedQuantity: string;
    unit: string;
  }>;
  artworkFiles: MakerPoSnapshotArtworkFile[];
  amounts?: { currency?: unknown; totalAmount?: unknown } | null;
  recipientAddress: string;
}

/**
 * Builds the snapshot from current order data. Inputs are normalized here
 * (sorted, trimmed) so the digest only moves when the underlying business data
 * moves, never because of row or key order.
 */
export function buildMakerPoSnapshot(input: MakerPoSnapshotInput): MakerPoSnapshot {
  const items = [...input.items].sort((a, b) => a.lineNumber - b.lineNumber);
  const artworkFiles = [...input.artworkFiles].sort(
    (a, b) => (a.designKey < b.designKey ? -1 : a.designKey > b.designKey ? 1 : a.revisionNo - b.revisionNo)
  );
  const currency = typeof input.amounts?.currency === 'string' && input.amounts.currency.length > 0
    ? input.amounts.currency
    : null;
  const totalAmount = typeof input.amounts?.totalAmount === 'string' && input.amounts.totalAmount.length > 0
    ? input.amounts.totalAmount
    : null;

  return {
    order: {
      id: input.order.id,
      code: input.order.code,
      sevenPoNumber: input.order.sevenPoNumber
    },
    items,
    quantities: items.map((item) => ({
      lineNumber: item.lineNumber,
      orderedQuantity: item.orderedQuantity,
      unit: item.unit
    })),
    specs: { artworkFiles },
    amounts: currency !== null && totalAmount !== null ? { currency, totalAmount } : null,
    recipient: { address: input.recipientAddress.trim() }
  };
}

/**
 * Deterministic JSON: object keys are recursively sorted and whitespace is
 * fixed, so two snapshots with equal content always serialize identically —
 * including after a round trip through Postgres jsonb, which does not preserve
 * key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

/** The server-side snapshot digest (design section 5.8): never a client value. */
export function computeMakerPoSnapshotSha256(snapshot: MakerPoSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
}

/** Approved snapshot hash equality (G10): the pure half of the void check. */
export function approvedSnapshotMatchesCurrent(approvedSnapshotSha256: string, currentSnapshotSha256: string): boolean {
  return approvedSnapshotSha256 === currentSnapshotSha256;
}

// ---------------------------------------------------------------------------
// Allowed transitions (G8)
// ---------------------------------------------------------------------------

/**
 * The maker PO state machine. SEND_UNVERIFIED is a deliberate dead end: a send
 * nobody can prove blocks the paper until a human resolves it outside this
 * machine (T-21). SNAPSHOT_VOIDED only re-opens through a fresh CEO approval
 * that re-freezes the drifted order data (T-23, T-24).
 *
 * M8-HARDEN FIX B2: CANCELLED is the replacement exit (정정·재발주). It is
 * reachable from every status an operator can still act on except the two
 * closed ones — SEND_UNVERIFIED keeps its T-21 dead end and MAKER_PO_ACCEPTED
 * is finished paper — and it has no exits itself: cancelling never deletes or
 * re-opens a row, the history stays and a new maker PO is frozen instead.
 */
const MAKER_PO_TRANSITIONS: Record<MakerPurchaseOrderStatus, readonly MakerPurchaseOrderStatus[]> = {
  DRAFT: ['APPROVED_FOR_MANUAL_SEND', 'CANCELLED'],
  APPROVED_FOR_MANUAL_SEND: ['MAKER_PO_SENT_MANUALLY', 'SEND_UNVERIFIED', 'SNAPSHOT_VOIDED', 'CANCELLED'],
  SEND_UNVERIFIED: [],
  MAKER_PO_SENT_MANUALLY: ['MAKER_PO_ACCEPTED', 'CANCELLED'],
  MAKER_PO_ACCEPTED: [],
  SNAPSHOT_VOIDED: ['APPROVED_FOR_MANUAL_SEND', 'CANCELLED'],
  CANCELLED: []
};

export type MakerPoTransitionResult<TFrom extends MakerPurchaseOrderStatus, TTo extends MakerPurchaseOrderStatus> =
  | { ok: true; from: TFrom; to: TTo }
  | { ok: false; from: MakerPurchaseOrderStatus; to: MakerPurchaseOrderStatus };

export function transitionMakerPurchaseOrder<
  TFrom extends MakerPurchaseOrderStatus,
  TTo extends MakerPurchaseOrderStatus
>(from: TFrom, to: TTo): MakerPoTransitionResult<TFrom, TTo> {
  const allowed = MAKER_PO_TRANSITIONS[from].includes(to);
  return allowed ? { ok: true, from, to } : { ok: false, from, to };
}

export function makerPurchaseOrderTransitions(
  state: MakerPurchaseOrderStatus
): readonly MakerPurchaseOrderStatus[] {
  return MAKER_PO_TRANSITIONS[state];
}

export interface MakerPoCreationGateInput {
  orderStatus: string;
}

export type MakerPoCreationGate =
  | { ok: true; gatedOn: 'order_at_maker_po_ready' }
  | { ok: false; code: 'MAKER_PO_NOT_READY'; message: string };

/**
 * The maker paper is frozen only once the artwork gate has fully passed: the
 * order must sit exactly at MAKER_PO_READY (dual approval reached, ordering
 * step current). Earlier states would freeze an unapproved artwork; later
 * states mean a maker PO already exists for this step.
 */
export function evaluateMakerPoCreationGate(input: MakerPoCreationGateInput): MakerPoCreationGate {
  if (input.orderStatus !== 'MAKER_PO_READY') {
    return {
      ok: false,
      code: 'MAKER_PO_NOT_READY',
      message: 'a maker purchase order can only be created for an order at MAKER_PO_READY'
    };
  }
  return { ok: true, gatedOn: 'order_at_maker_po_ready' };
}

export type MakerPoApprovalGate =
  | { ok: true; from: MakerPurchaseOrderStatus; to: 'APPROVED_FOR_MANUAL_SEND' }
  | { ok: false; code: 'MAKER_PO_TRANSITION_BLOCKED'; from: MakerPurchaseOrderStatus; message: string };

/**
 * The CEO approval is the only exit from DRAFT, and the only way back from a
 * voided snapshot: approving re-freezes current order data and stamps the
 * digest it approved. Every other status is already past the approval.
 */
export function evaluateMakerPoApproval(currentStatus: MakerPurchaseOrderStatus): MakerPoApprovalGate {
  const transition = transitionMakerPurchaseOrder(currentStatus, 'APPROVED_FOR_MANUAL_SEND');
  if (!transition.ok) {
    return {
      ok: false,
      code: 'MAKER_PO_TRANSITION_BLOCKED',
      from: currentStatus,
      message: `a maker purchase order in ${currentStatus} cannot be approved; only DRAFT or SNAPSHOT_VOIDED can`
    };
  }
  return { ok: true, from: currentStatus, to: 'APPROVED_FOR_MANUAL_SEND' };
}

export type MakerPoSendTransitionGate =
  | { ok: true; from: MakerPurchaseOrderStatus }
  | { ok: false; code: 'MAKER_PO_TRANSITION_BLOCKED'; from: MakerPurchaseOrderStatus; message: string };

/**
 * Sending is only reachable from APPROVED_FOR_MANUAL_SEND. SEND_UNVERIFIED is
 * a dead end by construction: a send that nobody can prove blocks every
 * further transition (T-21), and DRAFT paper has never been approved for
 * sending at all.
 */
export function evaluateMakerPoSendTransition(currentStatus: MakerPurchaseOrderStatus): MakerPoSendTransitionGate {
  const transition = transitionMakerPurchaseOrder(currentStatus, 'MAKER_PO_SENT_MANUALLY');
  if (!transition.ok) {
    return {
      ok: false,
      code: 'MAKER_PO_TRANSITION_BLOCKED',
      from: currentStatus,
      message: `a maker purchase order in ${currentStatus} cannot be sent; the send path is blocked from this status`
    };
  }
  return { ok: true, from: currentStatus };
}

// ---------------------------------------------------------------------------
// One active maker PO per film order (M8-HARDEN FIX B2)
// ---------------------------------------------------------------------------

/**
 * Whether a maker PO row counts as the order's active paper: everything except
 * the replacement exit. A cancelled PO stays on the trail as history but holds
 * no order slot, so a new maker PO can freeze for the same order.
 */
export function isActiveMakerPurchaseOrderStatus(status: string): boolean {
  return status !== MAKER_PO_CANCELLED_STATUS;
}

export type MakerPoCancellationGate =
  | { ok: true; from: MakerPurchaseOrderStatus; to: 'CANCELLED' }
  | { ok: false; code: 'MAKER_PO_TRANSITION_BLOCKED'; from: MakerPurchaseOrderStatus; message: string };

/**
 * Cancelling is the explicit, history-preserving replacement step (FIX B2): the
 * old paper is marked CANCELLED with an append-only event and a new maker PO is
 * frozen afterwards. SEND_UNVERIFIED keeps its dead end (T-21) — a send nobody
 * can prove is a human decision, not a reordering — and accepted paper is
 * finished, so neither can be cancelled.
 */
export function evaluateMakerPoCancellation(currentStatus: MakerPurchaseOrderStatus): MakerPoCancellationGate {
  const transition = transitionMakerPurchaseOrder(currentStatus, MAKER_PO_CANCELLED_STATUS);
  if (!transition.ok) {
    return {
      ok: false,
      code: 'MAKER_PO_TRANSITION_BLOCKED',
      from: currentStatus,
      message: currentStatus === 'SEND_UNVERIFIED'
        ? 'a maker purchase order in SEND_UNVERIFIED cannot be cancelled; the unproven send blocks the paper until a human resolves it'
        : `a maker purchase order in ${currentStatus} cannot be cancelled`
    };
  }
  return { ok: true, from: currentStatus, to: 'CANCELLED' };
}

// ---------------------------------------------------------------------------
// Replacement safety after a proven send (M8-HARDEN2 FIX 2)
// ---------------------------------------------------------------------------

/** How the cancellation of one paper is classified (M8-HARDEN2 FIX 2). */
export type MakerPoCancellationKind = 'INTERNAL_CANCEL' | 'MAKER_PO_CANCELLED';

export interface MakerPoCancellationClassification {
  kind: MakerPoCancellationKind;
  /** The paper's send was proven by a VERIFIED send event. */
  verifiedSend: boolean;
  /**
   * True when the replacement needs the representative's acknowledgement before
   * a new maker PO may freeze for the order — paper that already left the
   * company cannot be quietly replaced by an internal cancel.
   */
  acknowledgementRequired: boolean;
}

/**
 * Classifies one cancellation. Paper with no verified send is an internal
 * correction: cancelling it re-opens the ordering step immediately, as it always
 * has. Paper whose send was proven is production-order mail the maker may
 * already be working on: cancelling it records the same append-only events, but
 * the order stays closed until the representative acknowledges the cancellation
 * (the maker's acceptance of it), so the company never runs two production
 * orders for the same step.
 */
export function classifyMakerPoCancellation(input: { verifiedSend: boolean }): MakerPoCancellationClassification {
  return input.verifiedSend
    ? { kind: 'MAKER_PO_CANCELLED', verifiedSend: true, acknowledgementRequired: true }
    : { kind: 'INTERNAL_CANCEL', verifiedSend: false, acknowledgementRequired: false };
}

/** One cancelled paper of an order, as the replacement gate reads it. */
export interface MakerPoCancelledPaper {
  id: string;
  /** The paper's send is proven by a VERIFIED send event. */
  verifiedSend: boolean;
  /** A MAKER_CANCELLATION_ACKNOWLEDGED event is already recorded on it. */
  acknowledged: boolean;
}

export type MakerPoCancellationAckGate =
  | { ok: true; gatedOn: 'no_sent_paper_awaiting_acknowledgement' }
  | {
      ok: false;
      code: 'MAKER_PO_CANCELLATION_ACK_REQUIRED';
      /** The cancelled paper whose proven send is waiting for the acknowledgement. */
      pendingMakerPurchaseOrderId: string;
      message: string;
    };

/**
 * The order-level invariant of FIX 2: a paper that was sent and then cancelled
 * keeps the ordering step closed until its cancellation is acknowledged, so a
 * sent paper and its replacement can never both be in production at the same
 * time. Paper with no proven send (and paper already acknowledged) holds
 * nothing back.
 */
export function evaluateMakerPoCancellationAckGate(
  papers: MakerPoCancelledPaper[]
): MakerPoCancellationAckGate {
  const pending = papers.find((paper) => paper.verifiedSend && !paper.acknowledged);
  if (pending === undefined) {
    return { ok: true, gatedOn: 'no_sent_paper_awaiting_acknowledgement' };
  }
  return {
    ok: false,
    code: 'MAKER_PO_CANCELLATION_ACK_REQUIRED',
    pendingMakerPurchaseOrderId: pending.id,
    message: `送信済みのメーカー発注書（${pending.id}）が取り消されています。新しいメーカー発注書を作成するには、まず取り消し承認（メーカー取消確認）を記録してください`
  };
}

// ---------------------------------------------------------------------------
// Time guards (M8-HARDEN FIX C2)
// ---------------------------------------------------------------------------

export type MakerPoSentAtCurrencyGate =
  | { ok: true; gatedOn: 'sent_at_not_in_future' }
  | { ok: false; code: 'SENT_AT_IN_FUTURE'; message: string; serverNow: string; sentAt: string };

/**
 * A send claimed for an instant more than MAKER_PO_SENT_AT_MAX_FUTURE_SKEW_MS
 * ahead of the server clock is impossible, not early: the clock is compared in
 * UTC (Date.getTime), so a timezone-shifted client value cannot slip past it.
 * The tolerance exists for clock skew between the machine that sent the mail
 * and this server, not for future dating.
 */
export function evaluateMakerPoSentAtCurrency(input: { sentAt: Date; now: Date }): MakerPoSentAtCurrencyGate {
  const skew = input.sentAt.getTime() - input.now.getTime();
  if (skew > MAKER_PO_SENT_AT_MAX_FUTURE_SKEW_MS) {
    return {
      ok: false,
      code: 'SENT_AT_IN_FUTURE',
      message: '送信日時が現在時刻より10分以上先です。メールの送信日時を確認してください',
      serverNow: input.now.toISOString(),
      sentAt: input.sentAt.toISOString()
    };
  }
  return { ok: true, gatedOn: 'sent_at_not_in_future' };
}

// ---------------------------------------------------------------------------
// Send evidence verification (G9)
// ---------------------------------------------------------------------------

/** The read model of the evidence document version a send or accept cites. */
export interface MakerPoEvidenceDocument {
  documentId: string;
  versionId: string;
  sha256: string;
  documentType: DocumentType;
  projectId: string;
  filmSupplyOrderId: string | null;
  designKey: string | null;
  /** Human verification recorded on the documents row; separate from the hash. */
  verificationStatus: string;
  /**
   * M8-HARDEN FIX B2: the maker PO the document was uploaded for. Acceptance
   * evidence closes one exact paper, so its binding names that paper; null for
   * documents uploaded before the binding existed (and for every other type).
   */
  makerPurchaseOrderId: string | null;
  /** The stored bytes' declared content type, so an EML can be re-read. */
  declaredMimeType?: string | null;
  /** Where the bytes live, so the cited evidence can be read back. */
  storagePath?: string | null;
}

export interface MakerPoSendEvidenceRequest {
  evidenceDocumentVersionId: unknown;
  senderAddress: unknown;
  recipients: unknown;
  sentAt: Date | string | null;
  attachmentHashes: unknown;
  /**
   * M8-HARDEN FIX C1: the bytes of the cited evidence, when it is the original
   * .eml of the production-order mail. The API always supplies them (the stored
   * bytes behind the cited version, or the contentBase64 payload), so the header
   * verification always runs where a send is registered; a caller that omits
   * them gets the pre-C1 document-binding verdict, which no API path reaches.
   */
  emlBytes?: Buffer | null;
}

export interface MakerPoSendEvidenceContext {
  order: { id: string; projectId: string };
  /** The digest the CEO approved (stamped on the PO row). */
  approvedSnapshotSha256: string;
  /** The digest recomputed from current order data at registration time. */
  currentSnapshotSha256: string;
  snapshot: MakerPoSnapshot;
  /** The evidence document version, or null when the id does not resolve. */
  evidenceDocument: MakerPoEvidenceDocument | null;
  /** The PO's approval stamp: a send recorded before it cannot be plausible (FIX C2). */
  ceoApprovedAt?: Date | null;
  /** The server clock at registration (FIX C2). Defaults to the current time. */
  now?: Date;
}

/** The verification status a send event can carry (M8-HARDEN FIX C1). */
export const MAKER_PO_SEND_VERIFICATION_STATUSES = [
  'VERIFIED',
  'PENDING_MANUAL_VERIFICATION'
] as const;

export type MakerPoSendVerificationStatus = (typeof MAKER_PO_SEND_VERIFICATION_STATUSES)[number];

/** The machine-readable verification of the EML a VERIFIED / pending send rests on. */
export interface MakerPoSendVerification {
  verificationMethod: typeof MAKER_PO_SEND_VERIFICATION_METHOD_EML_HEADER_CHECK | null;
  verificationChecks: MakerPoEmlCheck[] | null;
  emlMessageId: string | null;
  emlDate: Date | null;
  matchedAttachmentHashes: string[];
}

export type MakerPoSendEvidenceEvaluation =
  | {
      ok: true;
      verificationStatus: 'VERIFIED';
      senderAddress: string;
      recipients: string[];
      sentAt: Date | string;
      attachmentHashes: string[];
      evidenceDocumentVersionId: string;
      verification: MakerPoSendVerification;
    }
  | {
      ok: true;
      verificationStatus: 'PENDING_MANUAL_VERIFICATION';
      senderAddress: string | null;
      recipients: string[];
      sentAt: Date | string;
      attachmentHashes: string[];
      evidenceDocumentVersionId: string | null;
      pendingCode: MakerPoEmlPendingCode;
      reasonNote: string;
      verification: MakerPoSendVerification;
    }
  | {
      ok: true;
      verificationStatus: 'UNVERIFIED';
      sentAt: Date | string;
    }
  | { ok: false; outcome: 'invalid_request'; code: MakerPoSendRequestErrorCode; message: string }
  | { ok: false; outcome: 'snapshot_voided'; code: 'SNAPSHOT_VOIDED'; message: string }
  | { ok: false; outcome: 'rejected'; code: MakerPoSendRejectionCode; message: string };

export type MakerPoSendRequestErrorCode =
  | 'SENT_AT_REQUIRED'
  | 'SENDER_ADDRESS_REQUIRED'
  | 'RECIPIENTS_REQUIRED'
  | 'INVALID_ATTACHMENT_HASH';

export type MakerPoSendRejectionCode =
  | 'SEND_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND'
  | 'SEND_EVIDENCE_DOCUMENT_TYPE_INVALID'
  | 'SEND_EVIDENCE_PROJECT_MISMATCH'
  | 'SEND_EVIDENCE_ORDER_MISMATCH'
  | 'SEND_RECIPIENT_MISMATCH';

function isHexSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function normalizeRecipient(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Evaluates a manual send registration (G9). The request is a proof document
 * (the sent mail file or a header proof) plus the send facts, or a bare
 * sent_at timestamp.
 *
 * Outcomes:
 * - UNVERIFIED: only a sent_at timestamp was recorded. The PO moves to
 *   SEND_UNVERIFIED and blocks further transitions (T-21);
 * - PENDING_MANUAL_VERIFICATION: the evidence bytes are an email that fails at
 *   least one header check (no Message-ID, wrong recipient, a subject that
 *   names another order, a Date that contradicts sentAt, a send dated before
 *   the approval…), or — since M8-HARDEN2 FIX 1 — a clean-header mail whose
 *   attachments are missing, match no approved artifact hash (a re-exported
 *   PDF among them) or are replaced by a download link. The event is recorded
 *   with the machine-readable check list and can never read as VERIFIED
 *   (M8-HARDEN FIX C1);
 * - VERIFIED: the evidence passes every check — since FIX C1 that means the
 *   original .eml of the production-order mail, read as an email (method
 *   eml_header_check), and since M8-HARDEN2 FIX 1 also that at least one
 *   attachment is the approved artifact bytes the snapshot freezes. Storing it
 *   is NOT proof of delivery; delivery is asserted by the representative's
 *   manual confirmation only;
 * - snapshot_voided: the recomputed order digest differs from the approved
 *   one. The paper no longer describes the real order: the send is refused and
 *   the PO is voided pending a fresh approval (T-23, T-24);
 * - rejected: the evidence was found but fails validation (type, company,
 *   order binding or the proven recipients). Recorded as SEND_REJECTED;
 * - invalid_request: malformed request fields. Nothing is persisted.
 */
export function evaluateMakerPoSendEvidence(
  request: MakerPoSendEvidenceRequest,
  context: MakerPoSendEvidenceContext
): MakerPoSendEvidenceEvaluation {
  if (!approvedSnapshotMatchesCurrent(context.approvedSnapshotSha256, context.currentSnapshotSha256)) {
    return {
      ok: false,
      outcome: 'snapshot_voided',
      code: 'SNAPSHOT_VOIDED',
      message: 'the order data no longer matches the approved maker PO snapshot; the snapshot is voided and a fresh CEO approval is required'
    };
  }

  const hasEvidence = typeof request.evidenceDocumentVersionId === 'string'
    && request.evidenceDocumentVersionId.length > 0;

  // Sent-at-only registration: recorded as an unverifiable send, never as a
  // proven one. Recipients without a proof document are not evidence.
  if (!hasEvidence) {
    if (request.sentAt === null || request.sentAt === undefined) {
      return {
        ok: false,
        outcome: 'invalid_request',
        code: 'SENT_AT_REQUIRED',
        message: 'sentAt is required: a send is registered from evidence, or as an unverifiable timestamp only'
      };
    }
    return { ok: true, verificationStatus: 'UNVERIFIED', sentAt: request.sentAt };
  }

  if (request.sentAt === null || request.sentAt === undefined) {
    return {
      ok: false,
      outcome: 'invalid_request',
      code: 'SENT_AT_REQUIRED',
      message: 'sentAt is required when registering send evidence'
    };
  }
  if (typeof request.senderAddress !== 'string' || request.senderAddress.trim().length === 0) {
    return {
      ok: false,
      outcome: 'invalid_request',
      code: 'SENDER_ADDRESS_REQUIRED',
      message: 'senderAddress is required when registering send evidence'
    };
  }
  const recipients = Array.isArray(request.recipients)
    ? request.recipients.filter((recipient): recipient is string => typeof recipient === 'string' && recipient.trim().length > 0)
    : [];
  if (recipients.length === 0) {
    return {
      ok: false,
      outcome: 'invalid_request',
      code: 'RECIPIENTS_REQUIRED',
      message: 'recipients is required when registering send evidence'
    };
  }
  let providedAttachmentHashes: string[] = [];
  if (request.attachmentHashes !== undefined && request.attachmentHashes !== null) {
    if (!Array.isArray(request.attachmentHashes)
      || !request.attachmentHashes.every((hash) => typeof hash === 'string' && isHexSha256(hash))) {
      return {
        ok: false,
        outcome: 'invalid_request',
        code: 'INVALID_ATTACHMENT_HASH',
        message: 'attachmentHashes must be an array of sha256 hex digests'
      };
    }
    providedAttachmentHashes = request.attachmentHashes;
  }

  const evidence = context.evidenceDocument;
  if (!evidence) {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'SEND_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND',
      message: 'the cited send evidence document version does not exist'
    };
  }
  if (evidence.documentType !== 'send_evidence') {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'SEND_EVIDENCE_DOCUMENT_TYPE_INVALID',
      message: 'send evidence must be a document of type send_evidence'
    };
  }
  if (evidence.projectId !== context.order.projectId) {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'SEND_EVIDENCE_PROJECT_MISMATCH',
      message: 'send evidence belongs to a different project (company)'
    };
  }
  if (evidence.filmSupplyOrderId !== context.order.id) {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'SEND_EVIDENCE_ORDER_MISMATCH',
      message: 'send evidence is bound to a different film supply order'
    };
  }
  // The proven recipients must include the recipient the frozen paper names:
  // mail that went somewhere else never reached the maker.
  const expectedRecipient = normalizeRecipient(context.snapshot.recipient.address);
  const provenRecipients = recipients.map(normalizeRecipient);
  if (!provenRecipients.includes(expectedRecipient)) {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'SEND_RECIPIENT_MISMATCH',
      message: 'the proven recipients do not include the recipient address recorded on the maker PO snapshot'
    };
  }

  const attachmentHashes = [evidence.sha256, ...providedAttachmentHashes]
    .filter((hash, index, all) => all.indexOf(hash) === index);

  const senderAddress = request.senderAddress.trim();
  // Echo the cited reference exactly as the request gave it: the caller
  // resolved it against document_versions before asking for this evaluation,
  // so the request value is the id the event row must carry.
  const evidenceDocumentVersionId = request.evidenceDocumentVersionId as string;
  const sentAtValue = request.sentAt;

  // M8-HARDEN FIX C1: the evidence bytes decide. With them, the file is read as
  // an email and its headers are checked against the frozen paper; only a
  // message that names the maker, this order, a plausible time and — since
  // M8-HARDEN2 FIX 1 — the approved artifact bytes as an attachment is VERIFIED.
  // A caller that cannot supply bytes is not verifying content at all, so the
  // document-binding verdict above stays (no API path reaches this branch — the
  // endpoints always pass the stored bytes or the contentBase64 payload).
  if (request.emlBytes === undefined || request.emlBytes === null || request.emlBytes.length === 0) {
    return {
      ok: true,
      verificationStatus: 'VERIFIED',
      senderAddress,
      recipients,
      sentAt: sentAtValue,
      attachmentHashes,
      evidenceDocumentVersionId,
      verification: {
        verificationMethod: null,
        verificationChecks: null,
        emlMessageId: null,
        emlDate: null,
        matchedAttachmentHashes: []
      }
    };
  }

  const emlEvaluation = evaluateMakerPoEmlEvidence({
    bytes: request.emlBytes,
    sentAt: typeof sentAtValue === 'string' ? new Date(sentAtValue) : sentAtValue,
    ceoApprovedAt: context.ceoApprovedAt ?? null,
    now: context.now ?? new Date(),
    expectedRecipientAddress: context.snapshot.recipient.address,
    recordedSenderAddress: senderAddress,
    subjectIdentifiers: [context.snapshot.order.code, context.snapshot.order.sevenPoNumber ?? ''],
    // M8-HARDEN2 FIX 1: the approved artifact hashes — the PO / artwork
    // revision documents the snapshot freezes — are what an attachment must
    // match for the send to verify.
    artworkFileSha256s: context.snapshot.specs.artworkFiles.map((file) => file.fileSha256)
  });

  const verification: MakerPoSendVerification = {
    verificationMethod: emlEvaluation.verificationMethod,
    verificationChecks: emlEvaluation.checks,
    emlMessageId: emlEvaluation.messageId,
    emlDate: emlEvaluation.emlDate,
    matchedAttachmentHashes: emlEvaluation.matchedAttachmentHashes
  };

  // The message's own headers are the stronger record of who sent what to whom,
  // so they replace the request-declared facts whenever the message carries them.
  const provenSenderAddress = emlEvaluation.senderAddress ?? senderAddress;
  const messageRecipients = emlEvaluation.recipients.length > 0 ? emlEvaluation.recipients : recipients;
  // The attachments whose bytes match an approved artifact are the signal FIX C1
  // records and — since M8-HARDEN2 FIX 1 — the one a VERIFIED send rests on, so
  // they belong on the event with the evidence bytes.
  const provenAttachmentHashes = [...attachmentHashes, ...emlEvaluation.matchedAttachmentHashes]
    .filter((hash, index, all) => all.indexOf(hash) === index);

  if (emlEvaluation.verificationStatus === 'PENDING_MANUAL_VERIFICATION') {
    return {
      ok: true,
      verificationStatus: 'PENDING_MANUAL_VERIFICATION',
      senderAddress: provenSenderAddress,
      recipients: messageRecipients,
      sentAt: sentAtValue,
      attachmentHashes: provenAttachmentHashes,
      evidenceDocumentVersionId,
      pendingCode: emlEvaluation.pendingCode,
      reasonNote: emlEvaluation.reasonNote,
      verification
    };
  }

  return {
    ok: true,
    verificationStatus: 'VERIFIED',
    senderAddress: provenSenderAddress,
    recipients: messageRecipients,
    sentAt: sentAtValue,
    attachmentHashes: provenAttachmentHashes,
    evidenceDocumentVersionId,
    verification
  };
}

// ---------------------------------------------------------------------------
// Acceptance (G9/T-22)
// ---------------------------------------------------------------------------

export interface MakerPoAcceptEvidenceRequest {
  evidenceDocumentVersionId: unknown;
  attachmentHashes: unknown;
  acceptedAt: Date | string | null;
}

export interface MakerPoAcceptEvidenceContext {
  order: { id: string; projectId: string };
  /** The maker PO being accepted: the evidence must be bound to exactly it (FIX B2). */
  makerPurchaseOrderId: string;
  /** The order identity the frozen paper carries, for the snapshot linkage. */
  snapshotOrder: { id: string };
  evidenceDocument: MakerPoEvidenceDocument | null;
}

export type MakerPoAcceptEvidenceEvaluation =
  | {
      ok: true;
      verificationStatus: 'VERIFIED';
      attachmentHashes: string[];
      evidenceDocumentVersionId: string;
      acceptedAt: Date | string | null;
    }
  | { ok: false; outcome: 'invalid_request'; code: 'ACCEPT_EVIDENCE_REQUIRED' | 'INVALID_ATTACHMENT_HASH'; message: string }
  | {
      ok: false;
      outcome: 'rejected';
      code:
        | 'ACCEPT_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND'
        | 'ACCEPT_EVIDENCE_DOCUMENT_TYPE_INVALID'
        | 'ACCEPT_EVIDENCE_PROJECT_MISMATCH'
        | 'ACCEPT_EVIDENCE_ORDER_MISMATCH'
        | 'ACCEPT_EVIDENCE_PO_MISMATCH'
        | 'ACCEPT_EVIDENCE_NOT_VERIFIED';
      message: string;
    };

/**
 * Evaluates an acceptance evidence registration (T-22). MAKER_PO_ACCEPTED is
 * only reachable behind an acceptance evidence document that a human verified
 * and that is bound to exactly this maker PO, this order and this company
 * (M8-HARDEN FIX B2: one order can hold a cancelled and a live paper, so an
 * order-level binding alone would let one document close both).
 */
export function evaluateMakerPoAcceptEvidence(
  request: MakerPoAcceptEvidenceRequest,
  context: MakerPoAcceptEvidenceContext
): MakerPoAcceptEvidenceEvaluation {
  let providedAttachmentHashes: string[] = [];
  if (request.attachmentHashes !== undefined && request.attachmentHashes !== null) {
    if (!Array.isArray(request.attachmentHashes)
      || !request.attachmentHashes.every((hash) => typeof hash === 'string' && isHexSha256(hash))) {
      return {
        ok: false,
        outcome: 'invalid_request',
        code: 'INVALID_ATTACHMENT_HASH',
        message: 'attachmentHashes must be an array of sha256 hex digests'
      };
    }
    providedAttachmentHashes = request.attachmentHashes;
  }

  if (typeof request.evidenceDocumentVersionId !== 'string' || request.evidenceDocumentVersionId.length === 0) {
    return {
      ok: false,
      outcome: 'invalid_request',
      code: 'ACCEPT_EVIDENCE_REQUIRED',
      message: 'evidenceDocumentVersionId is required: acceptance is only recorded from a verified acceptance document'
    };
  }

  const evidence = context.evidenceDocument;
  if (!evidence) {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'ACCEPT_EVIDENCE_DOCUMENT_VERSION_NOT_FOUND',
      message: 'the cited acceptance evidence document version does not exist'
    };
  }
  if (evidence.documentType !== 'acceptance_evidence') {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'ACCEPT_EVIDENCE_DOCUMENT_TYPE_INVALID',
      message: 'acceptance evidence must be a document of type acceptance_evidence'
    };
  }
  if (evidence.projectId !== context.order.projectId) {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'ACCEPT_EVIDENCE_PROJECT_MISMATCH',
      message: 'acceptance evidence belongs to a different project (company)'
    };
  }
  if (evidence.filmSupplyOrderId !== context.order.id) {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'ACCEPT_EVIDENCE_ORDER_MISMATCH',
      message: 'acceptance evidence is bound to a different film supply order'
    };
  }
  // M8-HARDEN FIX B2: the binding names the paper, not just the order. An
  // acceptance document of another maker PO — or of no maker PO at all — never
  // closes this one, even though both papers may belong to the same order.
  if (evidence.makerPurchaseOrderId !== context.makerPurchaseOrderId) {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'ACCEPT_EVIDENCE_PO_MISMATCH',
      message: 'acceptance evidence is bound to a different maker purchase order'
    };
  }
  // The frozen paper must describe the order the evidence is bound to: a
  // snapshot of another order can never be closed by this paperwork.
  if (context.snapshotOrder.id !== context.order.id) {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'ACCEPT_EVIDENCE_PO_MISMATCH',
      message: 'the maker purchase order snapshot describes a different film supply order'
    };
  }
  if (evidence.verificationStatus !== 'verified') {
    return {
      ok: false,
      outcome: 'rejected',
      code: 'ACCEPT_EVIDENCE_NOT_VERIFIED',
      message: 'acceptance evidence must carry a human verification (verificationStatus verified) before the maker PO can be accepted'
    };
  }

  const attachmentHashes = [evidence.sha256, ...providedAttachmentHashes]
    .filter((hash, index, all) => all.indexOf(hash) === index);

  return {
    ok: true,
    verificationStatus: 'VERIFIED',
    attachmentHashes,
    evidenceDocumentVersionId: evidence.versionId,
    acceptedAt: request.acceptedAt
  };
}
