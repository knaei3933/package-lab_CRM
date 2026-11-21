import { loadMakerPoBoard, loadMakerPoDetail } from './maker-po-data';
import type { MakerPoEventRow } from './maker-po-data';
import { buildOrderFlow, liveMakerPo, ORDER_STEPS } from './order-flow';
import type { OrderFlowView } from './order-flow';
import type { ProjectSummary } from './project-data';
import { knownStatus, labelLookup } from './project-data';

/**
 * P1 R26 (REDESIGN §5-2): the staff home 「自分の作業」 across the operator's
 * projects, in three groups by who holds the ball — いま進められる (this role
 * can do the step now), 相手待ち (the representative or an outside party),
 * 止まっている (blocked with a reason, or an exception state). Each row opens the
 * order's own screen at its step. Built with the same flow model as the order
 * screen (lib/order-flow); the API decides every write.
 */
export const MY_WORK_PROJECT_LIMIT = 10;

export type WorkGroup = 'now' | 'waiting' | 'stuck';

export interface WorkRow {
  key: string;
  group: WorkGroup;
  projectCode: string;
  orderCode: string;
  step: number | null;
  stepTitle: string;
  /** One sentence: what to do, or what it waits for, or why it is stuck. */
  text: string;
  status: string | null;
  statusLabel: string | null;
  updatedAt: string;
}

export interface MyWork {
  rows: WorkRow[];
  unreadProjects: string[];
  skippedProjects: number;
}

/** Pure: the group of one order for the signed-in role. */
export function workGroupOf(flow: OrderFlowView): WorkGroup | null {
  if (flow.phase === 'complete' || flow.phase === 'cancelled' || flow.phase === 'hidden') return null;
  if (flow.phase === 'exception' || flow.phase === 'unknown' || flow.panel.blocked) return 'stuck';
  if (flow.panel.canAct) return 'now';
  return 'waiting';
}

/** Pure: the row's sentence. */
export function workText(flow: OrderFlowView, group: WorkGroup, stateLabel: (key: string) => string): string {
  if (flow.panel.blocked) return flow.panel.blocked.reason;
  if (flow.phase === 'exception' && flow.status) return `${stateLabel(flow.status)}（解除・再開の判断待ち）`;
  const step = flow.current ? ORDER_STEPS[flow.current - 1] : null;
  if (group === 'waiting') return flow.panel.actor === 'admin' ? '代表の確認・承認待ち' : '担当者の記録待ち';
  return step ? `${step.title}を進める` : '状態を確認する';
}

const EVENT_STATES = new Set(['APPROVED_FOR_MANUAL_SEND', 'MAKER_PO_SENT_MANUALLY']);

export async function loadMyWork(projects: readonly ProjectSummary[], role: string): Promise<MyWork> {
  const read = projects.slice(0, MY_WORK_PROJECT_LIMIT);
  const boards = await Promise.all(read.map((project) => loadMakerPoBoard(project.id)));
  const rows: WorkRow[] = [];
  const unreadProjects: string[] = [];
  for (const [index, board] of boards.entries()) {
    const project = read[index]!;
    if (board.workspace.error && board.workspace.filmOrders.length === 0) {
      unreadProjects.push(project.code);
      continue;
    }
    const stateLabel = labelLookup(board.workspace.labels, 'filmSupplyOrderStates');
    // Every order of the project (the maker board only holds orders from 製造先発注準備完了
    // on); the board entry adds the maker paper and the payment gate when there is one.
    const entries = new Map(board.boards.map((entry) => [entry.order.id, entry]));
    for (const order of board.workspace.filmOrders) {
      const entry = entries.get(order.id) ?? { order, makerPurchaseOrders: [], paymentGate: null };
      const status = knownStatus(order);
      const maker = liveMakerPo(entry.makerPurchaseOrders);
      // The send / acceptance steps depend on the paper's events (who recorded what).
      const events: MakerPoEventRow[] = maker && status && EVENT_STATES.has(status) ? (await loadMakerPoDetail(maker.id)).events : [];
      const po = order.sevenPurchaseOrderId
        ? board.workspace.sevenPurchaseOrders.find((candidate) => candidate.id === order.sevenPurchaseOrderId) ?? null
        : null;
      const flow = buildOrderFlow({
        order,
        role,
        po,
        documents: board.workspace.documents,
        revisions: board.workspace.revisions,
        gate: null,
        makerPos: entry.makerPurchaseOrders,
        makerEvents: events,
        settledSendEventIds: new Set(),
        paymentGate: entry.paymentGate,
        deliveries: board.workspace.deliveries
      });
      const group = workGroupOf(flow);
      if (!group) continue;
      const step = flow.current ? ORDER_STEPS[flow.current - 1] : null;
      rows.push({
        key: order.id,
        group,
        projectCode: project.code,
        orderCode: order.code,
        step: flow.current,
        stepTitle: step ? `${step.no} ${step.title}` : '',
        text: workText(flow, group, stateLabel),
        status,
        statusLabel: status ? stateLabel(status) : null,
        updatedAt: order.updatedAt
      });
    }
  }
  // Oldest update first: what has waited longest comes first.
  rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return { rows, unreadProjects, skippedProjects: Math.max(0, projects.length - read.length) };
}
