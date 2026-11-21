import { callApi } from './api';
import { isMissingRoute } from './approval-card';
import { formatAmount } from './number-format';
import type { AuditEventView, ProjectSummary } from './project-data';

/**
 * UI batch E (F-23): the representative's decisions waiting across projects —
 * read right after login, so a 代表者の対応待ち no longer depends on opening
 * the right project first. One audit read per project (film orders only), up
 * to REPRESENTATIVE_QUEUE_PROJECT_LIMIT projects; the API decides what the
 * admin may read, and every record is still made on the project's screens.
 */
export const REPRESENTATIVE_QUEUE_PROJECT_LIMIT = 30;

/** Order states whose next step is the representative's, and that step in words. */
export const REPRESENTATIVE_WORK: Readonly<Record<string, string>> = {
  // P1 R25: a 校了 order waits for the representative's maker paper (P-6: admin draws it up).
  DUAL_APPROVED: 'メーカー発注書の作成と代表承認（校了済み）',
  MAKER_PO_READY: 'メーカー発注書の作成と代表承認',
  // Review L4: shared step — the representative's part comes after the staff record and the evidence.
  MAKER_PO_SENT_MANUALLY: '受入の最終確認（担当者の仮記録・受領証跡のあと）',
  ON_HOLD: '保留の解除（理由の確認）',
  CANCELLATION_REVIEW: '取消レビューの処理'
};

export interface RepresentativeTask {
  projectId: string;
  /** P1 R25: the project code — the row links to /p/{code}/o/{orderCode}. */
  projectCode: string;
  orderId: string;
  projectLabel: string;
  orderCode: string;
  status: string;
  work: string;
  /** P1 R25 (server queue): the kind of work, the step it opens, the facts of the row. */
  kind?: string | undefined;
  step?: number | null | undefined;
  amount?: string | null | undefined;
  waitingSince?: string | null | undefined;
  requestedBy?: string | null | undefined;
  /** Set on a blocked row: why it cannot move, in one sentence. */
  blockedReason?: string | null | undefined;
}

export interface RepresentativeQueue {
  tasks: RepresentativeTask[];
  /** Projects whose orders could not be read (named, never silently skipped). */
  unreadProjects: string[];
  /** Projects beyond the limit, not read. */
  skippedProjects: number;
  /** Review M1: the project list itself could not be read — nothing can be claimed. */
  listError?: string | null | undefined;
  /** P1 R25: stuck items the representative can fix (server queue only). */
  blocked?: RepresentativeTask[] | undefined;
  /** Where the queue came from: the server's own queue (complete) or the web's per-project read. */
  source?: 'server' | 'web' | undefined;
}

/** P1 R25: the step each kind of representative work opens (/p/{案件}/o/{発注}?step=N). */
export const QUEUE_KIND_STEP: Readonly<Record<string, number | null>> = {
  approval_evidence_verification: 6,
  maker_po_creation: 7,
  maker_po_ceo_approval: 8,
  send_verification: 9,
  maker_po_final_acceptance: 10,
  hold_release: null,
  cancellation_review: null,
  cancellation_acknowledgement: null,
  payment_terms_undetermined: 7
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Pure: one row of GET /api/representative-queue (p1-server API_CONTRACT §3) in the screen's shape. */
export function taskFromServerItem(item: unknown, blocked = false): RepresentativeTask | null {
  const row = record(item);
  const project = record(row.project);
  const order = record(row.order);
  const paper = record(row.makerPurchaseOrder);
  const amounts = record(paper.amounts);
  const deepLink = record(row.deepLink);
  const reason = record(row.reason);
  const projectCode = str(project.code) ?? str(deepLink.projectCode);
  const orderCode = str(order.code) ?? str(deepLink.orderCode);
  if (!projectCode || !orderCode) return null;
  const kind = str(row.kind) ?? 'unknown';
  return {
    projectId: str(project.id) ?? '',
    projectCode,
    orderId: str(order.id) ?? '',
    projectLabel: str(project.name) ? `${projectCode}（${str(project.name)}）` : projectCode,
    orderCode,
    status: str(order.status) ?? '',
    work: str(row.label) ?? (blocked ? '止まっている' : '代表の作業'),
    kind,
    step: QUEUE_KIND_STEP[kind] ?? null,
    amount: str(amounts.display) ?? (str(amounts.totalAmount) ? formatAmount(str(amounts.currency), str(amounts.totalAmount)) : null),
    waitingSince: str(row.waitingSince),
    requestedBy: str(record(row.requestedBy).displayName),
    blockedReason: blocked ? str(reason.message) : null
  };
}

/** P1 R25: the server's queue (complete: manual checks too, H3), or null when the API has no such route. */
export async function loadServerRepresentativeQueue(): Promise<RepresentativeQueue | null> {
  const result = await callApi<unknown>('/api/representative-queue');
  if (!result.ok) {
    if (isMissingRoute(result) || result.status === 403) return null;
    return { tasks: [], unreadProjects: [], skippedProjects: 0, listError: result.error ?? '代表の作業を読み込めませんでした。', source: 'server' };
  }
  const data = record(result.data);
  const items = Array.isArray(data.items) ? data.items : [];
  const blocked = Array.isArray(data.blocked) ? data.blocked : [];
  return {
    tasks: items.map((item) => taskFromServerItem(item)).filter((task): task is RepresentativeTask => task !== null),
    blocked: blocked.map((item) => taskFromServerItem(item, true)).filter((task): task is RepresentativeTask => task !== null),
    unreadProjects: [],
    skippedProjects: 0,
    source: 'server'
  };
}

/** Review M1: the queue when the project list read failed. */
export function failedRepresentativeQueue(error: string): RepresentativeQueue {
  return { tasks: [], unreadProjects: [], skippedProjects: 0, listError: error };
}

/** The order step a status's representative work opens (fallback queue). */
const STATUS_STEP: Readonly<Record<string, number | null>> = {
  DUAL_APPROVED: 7,
  MAKER_PO_READY: 7,
  MAKER_PO_SENT_MANUALLY: 10,
  ON_HOLD: null,
  CANCELLATION_REVIEW: null
};

const STATUS_ACTIONS = new Set([
  'FILM_SUPPLY_ORDER_TRANSITIONED',
  'FILM_RECEIPT_ASSUMPTION_RECORDED',
  'FILM_SUPPLY_ORDER_HOLD_RELEASED',
  'FILM_SUPPLY_ORDER_CANCELLATION_REVIEW_RESOLVED'
]);

/** The latest status and code of each film order, replayed from its audit rows (oldest first). */
export function replayOrderStatuses(events: readonly AuditEventView[]): Array<{ id: string; code: string; status: string }> {
  const orders = new Map<string, { id: string; code: string; status: string }>();
  for (const event of events) {
    const after = event.afterState ?? {};
    const status = typeof after.status === 'string' ? after.status : null;
    if (event.action === 'FILM_SUPPLY_ORDER_CREATED') {
      orders.set(event.entityId, {
        id: event.entityId,
        code: typeof after.code === 'string' ? after.code : '（コード未記録）',
        status: status ?? 'DRAFT'
      });
    } else if (STATUS_ACTIONS.has(event.action) && status) {
      const current = orders.get(event.entityId);
      if (current) current.status = status;
    }
  }
  return [...orders.values()];
}

/** The tasks of one project's orders, in the order the orders were created. */
export function representativeTasks(
  project: Pick<ProjectSummary, 'id' | 'code' | 'name'>,
  orders: ReadonlyArray<{ id: string; code: string; status: string }>
): RepresentativeTask[] {
  return orders.flatMap((order) => {
    const work = REPRESENTATIVE_WORK[order.status];
    return work
      ? [{ projectId: project.id, projectCode: project.code, orderId: order.id, projectLabel: `${project.code}（${project.name}）`, orderCode: order.code, status: order.status, work, step: STATUS_STEP[order.status] ?? null }]
      : [];
  });
}

export async function loadRepresentativeQueue(
  projects: readonly ProjectSummary[],
  options: { server?: boolean } = {}
): Promise<RepresentativeQueue> {
  if (options.server) {
    const server = await loadServerRepresentativeQueue();
    if (server) {
      const allowed = new Set(projects.map((project) => project.id));
      // The server lists every project; the caller may have left one out (the open one).
      return {
        ...server,
        tasks: server.tasks.filter((task) => !task.projectId || allowed.has(task.projectId)),
        blocked: (server.blocked ?? []).filter((task) => !task.projectId || allowed.has(task.projectId))
      };
    }
  }
  const read = projects.slice(0, REPRESENTATIVE_QUEUE_PROJECT_LIMIT);
  const answers = await Promise.all(read.map((project) => callApi<{ events: AuditEventView[] }>(
    `/api/projects/${encodeURIComponent(project.id)}/audit-history?entityType=film_supply_order&limit=500`
  )));
  const tasks: RepresentativeTask[] = [];
  const unreadProjects: string[] = [];
  read.forEach((project, index) => {
    const answer = answers[index];
    if (!answer?.ok || !answer.data || !Array.isArray(answer.data.events)) {
      unreadProjects.push(project.code);
      return;
    }
    tasks.push(...representativeTasks(project, replayOrderStatuses(answer.data.events)));
  });
  return { tasks, unreadProjects, skippedProjects: Math.max(0, projects.length - read.length), source: 'web' };
}
