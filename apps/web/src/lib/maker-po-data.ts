import { callApi } from './api';
import { loadWorkspace } from './project-data';
import type { FilmSupplyOrderView, Workspace } from './project-data';

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
  provisional?: boolean;
  sentAt?: string | null;
  recordedAt?: string;
  senderAddress?: string | null;
  recipients?: Array<string> | null;
  attachmentHashes?: Array<string> | null;
}

export interface PaymentGateView {
  orderId: string;
  orderStatus: string;
  paymentTerms: string;
  gate: { satisfied: boolean; code: string | null; reason: string | null; gatedOn?: string | null };
  paymentConfirmedAt: string | null;
}

/** Which orders carry maker-PO work: the freeze gate and the chain below it. */
const MAKER_PO_ORDER_STATES: readonly string[] = [
  'MAKER_PO_READY',
  'APPROVED_FOR_MANUAL_SEND',
  'MAKER_PO_SENT_MANUALLY',
  'MAKER_PO_ACCEPTED',
  'SNAPSHOT_VOIDED'
];

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
  SNAPSHOT_VOIDED: 'スナップショット失効（再承認が必要）'
};

export const MAKER_PO_EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  CEO_APPROVED: '代表承認',
  SNAPSHOT_VOIDED: 'スナップショット失効',
  SEND_EVIDENCE_REGISTERED: '送信証跡の記録',
  ACCEPT_EVIDENCE_REGISTERED: '受入証跡の記録（最終）',
  MAKER_PO_ACCEPT_RECORDED_PROVISIONAL: '受入記録（仮）',
  SEND_REJECTED: '送信却下'
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
        ? '次のアクション：大代表承認（G6の決済条件が確定している場合のみ記録できます）'
        : '次のアクション：代表者による大代表承認を待ちます（担当者は承認できません）';
    case 'APPROVED_FOR_MANUAL_SEND':
      return '次のアクション：送信証跡（send_evidence）の書類バージョンを引用して手動送信を記録する';
    case 'SEND_UNVERIFIED':
      return '次のアクション：なし（送信未確認のまま停止中。証跡を揃えたうえで代表者へ相談してください）';
    case 'MAKER_PO_SENT_MANUALLY':
      return role === 'admin'
        ? '次のアクション：受入記録（仮）を確認し、受領証跡を検証して最終受入確認を記録する'
        : '次のアクション：受入記録（仮）を記録し、代表者の最終受入確認を待ちます';
    case 'MAKER_PO_ACCEPTED':
      return '次のアクション：なし（受入確認済み。この発注の紙は完了です）';
    default:
      return `次のアクション：状態 ${status} の取り扱いを確認してください`;
  }
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
