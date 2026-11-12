import { FILM_SUPPLY_ORDER_EXCEPTION_STATES, FILM_SUPPLY_ORDER_STATES } from './state-machine.js';
import type { FilmSupplyOrderState } from './state-machine.js';
import { MAKER_PURCHASE_ORDER_STATUSES } from './maker-po.js';
import type { MakerPurchaseOrderStatus } from './maker-po.js';
import { COMMISSION_READINESS_STATES, FILLING_DELIVERY_CONFIRMATION_STATES } from './commission.js';
import type {
  CommissionReadinessState,
  FillingDeliveryConfirmationState
} from './commission.js';
import { APPROVAL_ORGANIZATIONS } from './approvals.js';
import type { ApprovalOrganization } from './approvals.js';

/**
 * M5 Japanese status surface (design section 8). Every state a screen can show
 * carries exactly one Japanese label, defined once here and shared by the API
 * and the web skeleton: the API exposes the mapping verbatim
 * (GET /api/status-labels) and apps/web renders it without translating or
 * re-spelling anything. A state without a label is a completeness bug, so the
 * maps below are typed as total records over the state vocabularies — adding a
 * state without a label fails to compile.
 */
export const FILM_SUPPLY_ORDER_STATUS_LABELS: Readonly<
  Record<FilmSupplyOrderState, string>
> = {
  DRAFT: '下書き',
  SEVEN_PO_VERIFIED: 'セブン化学発注書確認済',
  ARTWORK_RECEIVED: 'デザインデータ受領',
  PROOF_READY: '校正ゲラ準備完了',
  APPROVAL_PENDING: '校了確認待ち',
  DUAL_APPROVED: '校了（顧客・セブン化学）',
  MAKER_PO_READY: '製造先発注準備完了',
  APPROVED_FOR_MANUAL_SEND: '送信確認待ち',
  MAKER_PO_SENT_MANUALLY: '製造先送信済み',
  MAKER_PO_ACCEPTED: '製造先受領確認済み',
  FILM_IN_PRODUCTION: 'フィルム製造中',
  FILM_SHIPPED: 'フィルム発送済み',
  FILM_DELIVERED: 'フィルム納品完了',
  FILM_RECEIPT_ASSUMED_NO_ISSUE: '受領確認済（問題なし）',
  ON_HOLD: '保留中',
  CHANGE_REVIEW: '変更レビュー中',
  CANCELLATION_REVIEW: 'キャンセルレビュー中'
};

export const MAKER_PO_STATUS_LABELS: Readonly<
  Record<MakerPurchaseOrderStatus, string>
> = {
  DRAFT: '製造先発注承認待ち',
  APPROVED_FOR_MANUAL_SEND: '送信確認待ち',
  SEND_UNVERIFIED: '送信未確認（要対応）',
  MAKER_PO_SENT_MANUALLY: '製造先送信済み',
  MAKER_PO_ACCEPTED: '製造先受領確認済み',
  SNAPSHOT_VOIDED: '発注書無効（再承認待ち）'
};

export const COMMISSION_READINESS_STATE_LABELS: Readonly<
  Record<CommissionReadinessState, string>
> = {
  MISSING_DATA: 'データ不足',
  PENDING_VERIFICATION: '納品証跡確認待ち',
  READY: '手数料計算可能'
};

export const FILLING_DELIVERY_CONFIRMATION_STATE_LABELS: Readonly<
  Record<FillingDeliveryConfirmationState, string>
> = {
  PENDING_CONFIRMATION: '充填製品納品確認待ち',
  CONFIRMED: '充填製品納品確認済み'
};

/** Which organization approved a design (design section 8, item 4). */
export const APPROVAL_ORGANIZATION_STATUS_LABELS: Readonly<
  Record<ApprovalOrganization, string>
> = {
  customer: '校了（顧客）',
  seven: '校了（セブン化学）'
};

/** One rendered row of the status surface: the state key and its Japanese label. */
export interface StatusLabelEntry<T extends string = string> {
  key: T;
  label: string;
}

/**
 * Renders one label group in the canonical order of its vocabulary (the order
 * the states are declared in, not the alphabetical order of the keys), so
 * every screen that renders the surface shows the same sequence.
 */
export function statusLabelEntries<T extends string>(
  states: readonly T[],
  labels: Readonly<Record<T, string>>
): Array<StatusLabelEntry<T>> {
  return states.map((state) => ({ key: state, label: labels[state] }));
}

/** The film supply order surface: normal chain first, then the exception side-channels. */
export function filmSupplyOrderStatusLabelEntries(): Array<StatusLabelEntry<FilmSupplyOrderState>> {
  return statusLabelEntries(
    [...FILM_SUPPLY_ORDER_STATES, ...FILM_SUPPLY_ORDER_EXCEPTION_STATES],
    FILM_SUPPLY_ORDER_STATUS_LABELS
  );
}

export function makerPoStatusLabelEntries(): Array<StatusLabelEntry<MakerPurchaseOrderStatus>> {
  return statusLabelEntries(MAKER_PURCHASE_ORDER_STATUSES, MAKER_PO_STATUS_LABELS);
}

export function commissionReadinessStatusLabelEntries(): Array<StatusLabelEntry<CommissionReadinessState>> {
  return statusLabelEntries(COMMISSION_READINESS_STATES, COMMISSION_READINESS_STATE_LABELS);
}

export function fillingDeliveryConfirmationStatusLabelEntries(): Array<StatusLabelEntry<FillingDeliveryConfirmationState>> {
  return statusLabelEntries(FILLING_DELIVERY_CONFIRMATION_STATES, FILLING_DELIVERY_CONFIRMATION_STATE_LABELS);
}

export function approvalOrganizationStatusLabelEntries(): Array<StatusLabelEntry<ApprovalOrganization>> {
  return statusLabelEntries(APPROVAL_ORGANIZATIONS, APPROVAL_ORGANIZATION_STATUS_LABELS);
}

/** The whole Japanese status surface as the status-labels endpoint serves it. */
export interface JapaneseStatusSurface {
  filmSupplyOrderStates: Array<StatusLabelEntry<FilmSupplyOrderState>>;
  makerPurchaseOrderStatuses: Array<StatusLabelEntry<MakerPurchaseOrderStatus>>;
  commissionReadinessStates: Array<StatusLabelEntry<CommissionReadinessState>>;
  fillingDeliveryConfirmationStates: Array<StatusLabelEntry<FillingDeliveryConfirmationState>>;
  approvalOrganizations: Array<StatusLabelEntry<ApprovalOrganization>>;
}

export function japaneseStatusSurface(): JapaneseStatusSurface {
  return {
    filmSupplyOrderStates: filmSupplyOrderStatusLabelEntries(),
    makerPurchaseOrderStatuses: makerPoStatusLabelEntries(),
    commissionReadinessStates: commissionReadinessStatusLabelEntries(),
    fillingDeliveryConfirmationStates: fillingDeliveryConfirmationStatusLabelEntries(),
    approvalOrganizations: approvalOrganizationStatusLabelEntries()
  };
}
