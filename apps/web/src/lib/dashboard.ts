import { FILM_SUPPLY_ORDER_TERMINAL_STATE } from '@kanei/core';
import { holdSummaryText, paymentTermsText } from './decision-facts';
import { MAKER_PO_STATUS_LABELS } from './maker-po-data';
import type { MakerPoViewRow, PaymentGateView } from './maker-po-data';
import { navHrefsForRole } from './navigation';
import { canRoleOperate, normalizeRole } from './permissions';
import {
  knownStatus,
  labelLookup,
  nextActionForOrder,
  nextActionWithoutOrders,
  orderProgress,
  OWNER_ADMIN,
  PROGRESS_STEPS,
  SCREEN_NAMES
} from './project-data';
import type { AuditEventView, FilmSupplyOrderView, ScreenPath, Workspace } from './project-data';
import { HIDDEN_BY_ROLE_LABEL } from './redaction';
import { REPRESENTATIVE_WORK } from './representative-queue';
import { evidenceGapsFor } from './transition-evidence';
import { formatMoney, formatTimestamp, READINESS_BLOCKING_LABELS } from './vocabulary';

/**
 * UI nav-dashboard (B): the first screen after login, computed only from what
 * the existing API already answered for the signed-in role — the project
 * workspace (audit-history replay), the maker PO board and one project audit
 * read for the recent activity. Nothing here decides a permission; the role
 * checks only choose which list an item goes to (DESIGN_RULES §0-1).
 *
 * Redaction (lib/redaction.ts policy): amounts, unit prices and commissions
 * are never put on an item for staff or viewer — not even when a row handed
 * in carries them (dashboardAmount). The 決済条件 is public and is shown to
 * every role as the audit history answered it.
 */

/** Days without any recorded change after which an open order is called stalled. */
export const STALE_AFTER_DAYS = 7;

/** The newest activity rows the dashboard lists. */
export const ACTIVITY_LIMIT = 8;

/** The project audit read is oldest first and capped by the API at this many rows. */
export const ACTIVITY_READ_LIMIT = 500;

export type DashboardItemKind = 'order' | 'maker_po' | 'delivery' | 'readiness';

export interface DashboardItem {
  key: string;
  kind: DashboardItemKind;
  /** The film order code as the role may read it (null: not about one order). */
  orderCode: string | null;
  /** What to do / what is wrong, one sentence (Japanese business wording). */
  title: string;
  /** A second line with the facts behind it, or null. */
  detail: string | null;
  /** Who does it (代表者 / 担当者・代表者), or null. */
  owner: string | null;
  /** Where the item opens: the screen, with an anchor to the order when there is one. */
  href: string;
  linkLabel: string;
  /** The 決済条件 as the role reads it (public), or null when not about an order. */
  paymentTerms: string | null;
  /** admin only: the maker PO total; always null for staff and viewer. */
  amount: string | null;
  /** Index into PROGRESS_STEPS of the order's current step, when known. */
  step: number | null;
}

export interface FlowStepCount {
  index: number;
  name: string;
  /** Open orders whose current step this is. */
  count: number;
  /** How many of the signed-in operator's own items sit at this step. */
  mine: number;
}

export interface ActivityItem {
  key: string;
  at: string;
  actor: string;
  text: string;
  href: string | null;
}

export interface DashboardView {
  flow: FlowStepCount[];
  /** Orders outside the steps: completed, on hold / under review, cancelled, status withheld. */
  completedCount: number;
  exceptionCount: number;
  cancelledCount: number;
  hiddenCount: number;
  /** Orders in a state the flow table does not name (never guessed onto a step). */
  unknownCount: number;
  /** The 「지금 내가 할 일」 list of the signed-in role. */
  todo: DashboardItem[];
  /** Work that is someone else's: the representative's for staff, the staff's for admin, all for viewer. */
  others: DashboardItem[];
  blocked: DashboardItem[];
  /** The one next action shown under the flow strip. */
  nextAction: { text: string; href: string | null; linkLabel: string | null; owner: string | null };
  activity: ActivityItem[];
  /** Why the activity list is empty or partial, or null. */
  activityNote: string | null;
}

export interface DashboardBoardInput {
  order: Pick<FilmSupplyOrderView, 'id'>;
  makerPurchaseOrders: MakerPoViewRow[];
  paymentGate: PaymentGateView | null;
}

export interface DashboardInput {
  role: string | null | undefined;
  workspace: Pick<
    Workspace,
    | 'labels'
    | 'filmOrders'
    | 'sevenPurchaseOrders'
    | 'revisions'
    | 'revisionsWithheld'
    | 'documents'
    | 'deliveries'
    | 'readiness'
  > & Partial<Pick<Workspace, 'makerPaperCleanup' | 'error'>>;
  boards: readonly DashboardBoardInput[];
  /** The project audit read (oldest first) or null when it failed. */
  activity: readonly AuditEventView[] | null;
  now: Date;
}

/**
 * The maker PO total for the dashboard: only for the representative, whatever
 * the row carries. Staff and viewer answers have no amounts (API FIX 1); this
 * is the second line of that rule, so a future API change cannot leak them here.
 */
export function dashboardAmount(role: string | null | undefined, row: Pick<MakerPoViewRow, 'snapshot'>): string | null {
  if (role !== 'admin') return null;
  const amounts = row.snapshot?.amounts;
  if (!amounts || typeof amounts.totalAmount !== 'string' || amounts.totalAmount.length === 0) return null;
  return formatMoney(amounts.currency, amounts.totalAmount);
}

/** The screen link of an item, with the order anchor the screens carry. */
export function itemHref(screen: ScreenPath, orderId: string | null): string {
  if (!orderId) return screen;
  if (screen === '/orders') return `/orders#order-${orderId}`;
  if (screen === '/maker-po') return `/maker-po#maker-order-${orderId}`;
  return screen;
}

/**
 * The screen an item may link to for the role: a screen the role's menu does
 * not offer (文書・承認 for a viewer) is replaced by the order screen, where
 * the same order's state and next step are shown.
 */
export function reachableScreen(role: string | null | undefined, screen: ScreenPath): ScreenPath {
  return navHrefsForRole(role).includes(screen) ? screen : '/orders';
}

function linkLabelFor(screen: ScreenPath): string {
  return `${SCREEN_NAMES[screen]}画面を開く`;
}

/** The transition each state needs evidence for next (transition-evidence.ts). */
const EVIDENCE_NEXT_TARGET: Readonly<Record<string, string>> = {
  SEVEN_PO_VERIFIED: 'ARTWORK_RECEIVED',
  ARTWORK_RECEIVED: 'PROOF_READY',
  FILM_SHIPPED: 'FILM_DELIVERED'
};

/**
 * Steps that wait on someone outside the company (the maker producing, the
 * carrier moving the film): a quiet week there is normal, not a stall.
 */
const OUTSIDE_WAIT_STATUSES = new Set(['FILM_IN_PRODUCTION', 'FILM_SHIPPED']);

/** Maker PO statuses that wait for the representative's 代表承認. */
const CEO_APPROVAL_STATUSES = new Set(['DRAFT', 'SNAPSHOT_VOIDED']);

/** States whose next step the representative takes (or decides) — the admin's own list. */
function isRepresentativeStep(status: string): boolean {
  return status in REPRESENTATIVE_WORK || status === 'CHANGE_REVIEW';
}

/**
 * The newest recorded work per film order: its own events and the events of
 * records whose state names the order (lines, documents, revisions, approvals,
 * deliveries — as far as the role reads that link). Null when the activity
 * read failed or hit the cap (then only the order's own updatedAt is known).
 */
function lastWorkByOrder(activity: DashboardInput['activity']): Map<string, string> | null {
  if (activity === null || activity.length >= ACTIVITY_READ_LIMIT) return null;
  const last = new Map<string, string>();
  for (const event of activity) {
    const linked = event.afterState && typeof event.afterState.filmSupplyOrderId === 'string'
      ? event.afterState.filmSupplyOrderId
      : null;
    const orderId = event.entityType === 'film_supply_order' ? event.entityId : linked;
    if (!orderId) continue;
    const previous = last.get(orderId);
    if (!previous || Date.parse(event.occurredAt) > Date.parse(previous)) last.set(orderId, event.occurredAt);
  }
  return last;
}

/**
 * The evidence gap of the order's next step, as one sentence, or null. Never
 * claimed when the role cannot see the links (viewer; withheld document
 * links) or the workspace read failed — a gap must not be invented.
 */
function evidenceGapText(
  order: FilmSupplyOrderView,
  status: string,
  input: DashboardInput,
  role: 'admin' | 'staff' | 'viewer'
): string | null {
  const target = EVIDENCE_NEXT_TARGET[status];
  const { workspace } = input;
  if (!target || role === 'viewer' || workspace.error) return null;
  if (target === 'ARTWORK_RECEIVED' && workspace.documents.some((document) => document.detailsHidden)) return null;
  const gap = evidenceGapsFor(order, workspace, [target])[0];
  return gap ? `証跡が未登録: ${gap.message}` : null;
}

function daysBetween(from: string, to: Date): number | null {
  const at = Date.parse(from);
  if (Number.isNaN(at)) return null;
  return Math.floor((to.getTime() - at) / 86_400_000);
}

export function buildDashboard(input: DashboardInput): DashboardView {
  const { workspace, now } = input;
  const role = input.role ?? null;
  const effective = normalizeRole(role);
  const stateLabel = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  const boardByOrder = new Map(input.boards.map((board) => [board.order.id, board]));

  const todo: DashboardItem[] = [];
  const others: DashboardItem[] = [];
  const blocked: DashboardItem[] = [];
  const flow: FlowStepCount[] = PROGRESS_STEPS.map((name, index) => ({ index, name, count: 0, mine: 0 }));
  let completedCount = 0;
  let exceptionCount = 0;
  let cancelledCount = 0;
  let hiddenCount = 0;
  let unknownCount = 0;
  const lastWork = lastWorkByOrder(input.activity);
  const readFailed = Boolean(workspace.error);

  for (const order of workspace.filmOrders) {
    const progress = orderProgress(order);
    const status = knownStatus(order);
    if (progress.phase === 'hidden' || status === null) {
      hiddenCount += 1;
      continue;
    }
    if (progress.phase === 'complete' || status === FILM_SUPPLY_ORDER_TERMINAL_STATE) completedCount += 1;
    else if (progress.phase === 'cancelled') cancelledCount += 1;
    else if (progress.phase === 'exception') exceptionCount += 1;
    else if (progress.phase === 'unknown') unknownCount += 1;
    else if (progress.currentStep !== null) flow[progress.currentStep]!.count += 1;

    const step = progress.currentStep ?? progress.interruptedStep;
    const terms = paymentTermsText(order);
    const board = boardByOrder.get(order.id);
    const livePapers = (board?.makerPurchaseOrders ?? []).filter((row) => row.status !== 'CANCELLED');
    const gapText = evidenceGapText(order, status, input, effective);

    // ---- the next action of the order (the same sentence the screens show).
    const action = nextActionForOrder(order, workspace, role);
    if (action.owner !== null && status !== FILM_SUPPLY_ORDER_TERMINAL_STATE) {
      const screen = reachableScreen(role, action.screens[0] ?? '/orders');
      const approvalPaper = status === 'MAKER_PO_READY'
        ? livePapers.find((row) => CEO_APPROVAL_STATUSES.has(row.status))
        : undefined;
      const item: DashboardItem = {
        key: `order-${order.id}`,
        kind: approvalPaper ? 'maker_po' : 'order',
        orderCode: order.code,
        title: approvalPaper
          ? 'メーカー発注書の代表承認を記録する（発注書は作成済み）。'
          : action.text,
        detail: approvalPaper
          ? `発注書の状態: ${MAKER_PO_STATUS_LABELS[approvalPaper.status] ?? approvalPaper.status}`
          : order.hold && status === 'ON_HOLD' ? holdSummaryText(order.hold) : gapText,
        owner: action.owner,
        href: itemHref(approvalPaper ? '/maker-po' : screen, order.id),
        linkLabel: linkLabelFor(approvalPaper ? '/maker-po' : screen),
        paymentTerms: terms,
        amount: approvalPaper ? dashboardAmount(role, approvalPaper) : null,
        step
      };
      const representativeStep = isRepresentativeStep(status) || action.owner === OWNER_ADMIN;
      const mine = effective === 'admin'
        ? representativeStep
        : effective === 'staff'
          ? action.owner !== OWNER_ADMIN && action.refusal === null
          : false;
      if (mine) {
        todo.push(item);
        // Only an order counted on a step marks that step (a held order is counted outside).
        if (progress.phase === 'active' && step !== null && flow[step]) flow[step]!.mine += 1;
      } else {
        others.push(item);
      }
    }

    // ---- blocked: exception states (保留・変更レビュー・取消レビュー).
    if (progress.phase === 'exception') {
      blocked.push({
        key: `exception-${order.id}`,
        kind: 'order',
        orderCode: order.code,
        title: `「${stateLabel(status)}」で止まっています。`,
        detail: order.hold && status === 'ON_HOLD'
          ? holdSummaryText(order.hold)
          : progress.interruptedStep !== null
            ? `止まる前の段階: ${PROGRESS_STEPS[progress.interruptedStep]}`
            : null,
        owner: action.owner,
        href: itemHref('/orders', order.id),
        linkLabel: linkLabelFor('/orders'),
        paymentTerms: terms,
        amount: null,
        step
      });
    }

    // ---- blocked: a draft without its セブン化学発注書 link, or without 明細.
    // A failed read leaves fields empty: nothing is claimed missing then.
    if (!readFailed && status === 'DRAFT' && !order.detailsHidden && !order.sevenPurchaseOrderId) {
      blocked.push({
        key: `unlinked-${order.id}`,
        kind: 'order',
        orderCode: order.code,
        title: 'セブン化学発注書に紐付いていないため、先へ進められません。',
        detail: '紐付けは作成のときだけ選べます。発注書を選んで作り直してください。',
        owner: null,
        href: itemHref('/orders', order.id),
        linkLabel: linkLabelFor('/orders'),
        paymentTerms: terms,
        amount: null,
        step
      });
    }
    if (!readFailed && !order.detailsHidden && order.lineCount === 0 && order.lines.length === 0
      && progress.phase !== 'cancelled' && progress.phase !== 'complete') {
      blocked.push({
        key: `lines-${order.id}`,
        kind: 'order',
        orderCode: order.code,
        title: '発注明細が登録されていません。',
        detail: '明細がないと、メーカー発注書と納品を記録できません。',
        owner: null,
        href: itemHref('/orders', order.id),
        linkLabel: linkLabelFor('/orders'),
        paymentTerms: terms,
        amount: null,
        step
      });
    }

    // ---- blocked: the G6 payment gate refuses the 代表承認.
    if (status === 'MAKER_PO_READY' && board?.paymentGate && !board.paymentGate.gate.satisfied) {
      blocked.push({
        key: `gate-${order.id}`,
        kind: 'maker_po',
        orderCode: order.code,
        title: '決済条件（G6）の条件を満たしていないため、代表承認を記録できません。',
        detail: board.paymentGate.gate.reason ?? null,
        owner: OWNER_ADMIN,
        href: itemHref('/maker-po', order.id),
        linkLabel: linkLabelFor('/maker-po'),
        paymentTerms: terms,
        amount: null,
        step
      });
    }

    // ---- blocked: a maker PO whose send could not be verified.
    for (const row of livePapers.filter((paper) => paper.status === 'SEND_UNVERIFIED')) {
      blocked.push({
        key: `unverified-${row.id}`,
        kind: 'maker_po',
        orderCode: order.code,
        title: `メーカー発注書が「${MAKER_PO_STATUS_LABELS.SEND_UNVERIFIED}」です。`,
        detail: effective === 'admin'
          ? '原本のEMLと発注内容を見比べて、手動確認を記録してください。'
          : '証跡を揃えたうえで代表者へ相談してください。',
        owner: OWNER_ADMIN,
        href: itemHref('/maker-po', order.id),
        linkLabel: linkLabelFor('/maker-po'),
        paymentTerms: terms,
        amount: null,
        step
      });
    }

    // ---- blocked: an open order with no recorded work for STALE_AFTER_DAYS
    // (its own records and the records linked to it), outside the steps that
    // wait on the maker or the carrier. A missing evidence of the next step is
    // named here; while the order is moving it is only the next task's note.
    if (progress.phase === 'active' && !OUTSIDE_WAIT_STATUSES.has(status)) {
      const linked = lastWork?.get(order.id);
      const lastAt = linked && Date.parse(linked) > Date.parse(order.updatedAt) ? linked : order.updatedAt;
      const idle = daysBetween(lastAt, now);
      if (idle !== null && idle >= STALE_AFTER_DAYS) {
        blocked.push({
          key: `stale-${order.id}`,
          kind: 'order',
          orderCode: order.code,
          title: `${idle}日間、記録が更新されていません（いま: ${PROGRESS_STEPS[progress.currentStep!]}）。`,
          detail: gapText ? `${gapText}（最後の記録: ${formatTimestamp(lastAt)}）` : `最後の記録: ${formatTimestamp(lastAt)}`,
          owner: null,
          href: itemHref('/orders', order.id),
          linkLabel: linkLabelFor('/orders'),
          paymentTerms: terms,
          amount: null,
          step
        });
      }
    }
  }

  // ---- deliveries recorded but not yet confirmed (受領証跡の引用).
  const unconfirmed = workspace.deliveries.filter((delivery) => !delivery.confirmed && !delivery.confirmationHidden);
  if (unconfirmed.length > 0) {
    const item: DashboardItem = {
      key: 'deliveries-unconfirmed',
      kind: 'delivery',
      orderCode: null,
      title: `未確認の納品が${unconfirmed.length}件あります。受領証跡を引用して納品確認を記録する。`,
      detail: null,
      owner: '担当者・代表者',
      href: '/deliveries',
      linkLabel: linkLabelFor('/deliveries'),
      paymentTerms: null,
      amount: null,
      step: PROGRESS_STEPS.length - 1
    };
    if (effective === 'staff' && canRoleOperate(role, 'delivery_confirmation:record')) {
      todo.push(item);
    } else {
      others.push(item);
    }
  }

  // ---- commission readiness that names what is missing.
  if (workspace.readiness && !workspace.readiness.hidden && !workspace.readiness.isReady
    && workspace.readiness.blocking.length > 0) {
    blocked.push({
      key: 'readiness',
      kind: 'readiness',
      orderCode: null,
      title: '手数料計算の準備がそろっていません。',
      detail: workspace.readiness.blocking.map((code) => READINESS_BLOCKING_LABELS[code] ?? code).join('／'),
      owner: null,
      href: '/deliveries',
      linkLabel: linkLabelFor('/deliveries'),
      paymentTerms: null,
      amount: null,
      step: PROGRESS_STEPS.length - 1
    });
  }

  return {
    flow,
    completedCount,
    exceptionCount,
    cancelledCount,
    hiddenCount,
    unknownCount,
    todo,
    others,
    blocked,
    nextAction: dashboardNextAction(input, todo, others),
    ...recentActivity(input)
  };
}

function dashboardNextAction(
  input: DashboardInput,
  todo: readonly DashboardItem[],
  others: readonly DashboardItem[]
): DashboardView['nextAction'] {
  const first = todo[0];
  if (first) {
    return {
      text: first.orderCode ? `${first.orderCode}: ${first.title}` : first.title,
      href: first.href,
      linkLabel: first.linkLabel,
      owner: first.owner
    };
  }
  if (input.workspace.filmOrders.length === 0 && input.workspace.error) {
    // Review M: a failed read is not 「no orders」 — never invite a duplicate registration.
    return { text: '記録を読み込めなかったため、次の行動を表示できません。画面上部の案内を確認してください。', href: null, linkLabel: null, owner: null };
  }
  if (input.workspace.filmOrders.length === 0) {
    const action = nextActionWithoutOrders(input.workspace, input.role);
    const screen = reachableScreen(input.role, action.screens[0] ?? '/orders');
    return {
      text: action.refusal ? `${action.text}（${action.refusal}）` : action.text,
      href: screen,
      linkLabel: linkLabelFor(screen),
      owner: action.owner
    };
  }
  const waiting = others[0];
  if (waiting) {
    const role = normalizeRole(input.role);
    const lead = role === 'admin'
      ? '代表者の判断が必要な作業はありません。進行中の次の作業'
      : role === 'staff'
        ? 'いまはあなたの作業はありません。代表者の作業待ち'
        : '進行中の次の作業';
    return {
      text: `${lead}: ${waiting.orderCode ? `${waiting.orderCode} ` : ''}${waiting.title}`,
      href: waiting.href,
      linkLabel: waiting.linkLabel,
      owner: waiting.owner
    };
  }
  return { text: 'この案件で進めている作業はありません。', href: null, linkLabel: null, owner: null };
}

/** Audit actions that only record a read (not work done): left out of the activity. */
const READ_ONLY_ACTIONS = new Set(['DOCUMENT_VERSION_VIEWED', 'DOCUMENT_VERSION_DOWNLOADED']);

const ACTION_LABELS: Readonly<Record<string, string>> = {
  PROJECT_CREATED: '案件を作成',
  PROJECT_UPDATED: '案件を更新',
  SEVEN_PO_CREATED: 'セブン化学発注書を登録',
  SEVEN_PO_OFFICIALLY_REGISTERED: 'セブン化学発注書の公式登録を記録',
  SEVEN_PO_VERIFICATION_RECORDED: '真性行チェックリストを記録',
  FILM_SUPPLY_ORDER_CREATED: 'フィルム発注を作成',
  FILM_SUPPLY_ORDER_LINE_CREATED: '発注明細を登録',
  FILM_SUPPLY_ORDER_PAYMENT_TERMS_UPDATED: '決済条件を記録',
  FILM_SUPPLY_ORDER_TRANSITIONED: '発注の状態を変更',
  FILM_SUPPLY_ORDER_HOLD_RELEASED: '保留を解除',
  FILM_SUPPLY_ORDER_CANCELLATION_REVIEW_RESOLVED: '取消レビューを処理',
  FILM_RECEIPT_ASSUMPTION_RECORDED: '受領確認（問題なしとみなす）を記録',
  DOCUMENT_CREATED: '書類を登録',
  DOCUMENT_VERSION_UPLOADED: '書類の版を登録',
  DOCUMENT_VERIFICATION_RECORDED: '書類の確認を記録',
  ARTWORK_REVISION_REGISTERED: '校正ゲラの版を登録',
  EVIDENCE_MANUAL_VERIFICATION_RECORDED: '承認証跡の手動確認を記録',
  MAKER_PO_CREATED: 'メーカー発注書を作成',
  MAKER_PO_CEO_APPROVED: 'メーカー発注書の代表承認を記録',
  MAKER_PO_STATUS_CHANGED: 'メーカー発注書の状態を変更',
  MAKER_PO_SEND_MANUAL_VERIFICATION_RECORDED: '送信の手動確認を記録',
  MAKER_PO_ACCEPT_RECORDED_PROVISIONAL: '受入（仮）を記録',
  MAKER_PO_ACCEPT_EVIDENCE_REGISTERED: '最終受入を記録',
  MAKER_PO_CANCELLED: 'メーカー発注書を取り消し',
  MAKER_CANCELLATION_ACKNOWLEDGED: '取り消し承認を記録',
  FILM_DELIVERY_RECORDED: 'フィルム納品を記録',
  FILLING_ORDER_CREATED: '充填発注を作成',
  FILLING_DELIVERY_RECORDED: '充填製品納品を記録',
  COMMISSION_READINESS_EVALUATED: '手数料準備状態を評価'
};

/** The fallback wording and screen of an entity type. */
const ENTITY_LABELS: Readonly<Record<string, { label: string; screen: ScreenPath | null }>> = {
  project: { label: '案件', screen: null },
  seven_purchase_order: { label: 'セブン化学発注書', screen: '/orders' },
  pre_order_reference: { label: '先行発注', screen: '/orders' },
  film_supply_order: { label: 'フィルム発注', screen: '/orders' },
  film_supply_order_line: { label: '発注明細', screen: '/orders' },
  filling_order: { label: '充填発注', screen: '/orders' },
  filling_order_line: { label: '充填発注の明細', screen: '/orders' },
  document: { label: '書類', screen: '/documents' },
  document_version: { label: '書類の版', screen: '/documents' },
  artwork_revision: { label: '校正ゲラ', screen: '/approvals' },
  artwork_approval_event: { label: '承認（校了）', screen: '/approvals' },
  maker_purchase_order: { label: 'メーカー発注書', screen: '/maker-po' },
  maker_po_event: { label: 'メーカー発注書', screen: '/maker-po' },
  film_delivery: { label: 'フィルム納品', screen: '/deliveries' },
  filling_delivery: { label: '充填製品納品', screen: '/deliveries' },
  delivery_confirmation: { label: '納品確認', screen: '/deliveries' },
  commission_readiness: { label: '手数料準備', screen: '/deliveries' }
};

/**
 * The newest recorded work of the project. Only the action, the actor and the
 * time are read — never an event's amounts; a film order is named by the code
 * the workspace already shows this role, and its new state by the status the
 * role may read. A read that hit the API cap may be missing the newest rows
 * (the answer is oldest first), so nothing is claimed as 「最近」 then.
 */
function recentActivity(input: DashboardInput): Pick<DashboardView, 'activity' | 'activityNote'> {
  if (input.activity === null) {
    return { activity: [], activityNote: '最近の活動を読み込めませんでした。' };
  }
  if (input.activity.length >= ACTIVITY_READ_LIMIT) {
    return {
      activity: [],
      activityNote: `記録が${ACTIVITY_READ_LIMIT}件を超えたため、最近の活動はここに表示できません。各画面の履歴を確認してください。`
    };
  }
  const stateLabel = labelLookup(input.workspace.labels, 'filmSupplyOrderStates');
  const orders = new Map(input.workspace.filmOrders.map((order) => [order.id, order]));
  const rows = input.activity
    .filter((event) => !READ_ONLY_ACTIONS.has(event.action) && event.entityType !== 'login_guard')
    .slice(-ACTIVITY_LIMIT)
    .reverse();
  const activity = rows.map((event): ActivityItem => {
    const entity = ENTITY_LABELS[event.entityType];
    const base = ACTION_LABELS[event.action] ?? `${entity?.label ?? '記録'}を記録`;
    // A film order is named by its code; its line by the order the line's state links (when the role reads it).
    const lineOrderId = event.entityType === 'film_supply_order_line' && event.afterState
      && typeof event.afterState.filmSupplyOrderId === 'string' ? event.afterState.filmSupplyOrderId : null;
    const order = event.entityType === 'film_supply_order'
      ? orders.get(event.entityId)
      : lineOrderId ? orders.get(lineOrderId) : undefined;
    const newStatus = event.afterState && typeof event.afterState.status === 'string' ? event.afterState.status : null;
    const statusPart = event.entityType === 'film_supply_order' && newStatus && event.action !== 'FILM_SUPPLY_ORDER_CREATED'
      ? `（→「${stateLabel(newStatus)}」）`
      : '';
    const code = order && order.code !== HIDDEN_BY_ROLE_LABEL ? `${order.code} ` : '';
    const screen = entity?.screen ? reachableScreen(input.role, entity.screen) : null;
    return {
      key: event.id,
      at: formatTimestamp(event.occurredAt),
      actor: event.actor?.displayName ?? '（記録者不明）',
      text: `${code}${base}${statusPart}`,
      href: screen ? itemHref(screen, order ? order.id : null) : null
    };
  });
  return {
    activity,
    activityNote: activity.length === 0 ? 'まだ記録はありません。' : null
  };
}
