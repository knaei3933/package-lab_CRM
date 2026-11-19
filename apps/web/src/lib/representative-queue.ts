import { callApi } from './api';
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
  MAKER_PO_READY: 'メーカー発注書の作成と代表承認',
  // Review L4: shared step — the representative's part comes after the staff record and the evidence.
  MAKER_PO_SENT_MANUALLY: '受入の最終確認（担当者の仮記録・受領証跡のあと）',
  ON_HOLD: '保留の解除（理由の確認）',
  CANCELLATION_REVIEW: '取消レビューの処理'
};

export interface RepresentativeTask {
  projectId: string;
  orderId: string;
  projectLabel: string;
  orderCode: string;
  status: string;
  work: string;
}

export interface RepresentativeQueue {
  tasks: RepresentativeTask[];
  /** Projects whose orders could not be read (named, never silently skipped). */
  unreadProjects: string[];
  /** Projects beyond the limit, not read. */
  skippedProjects: number;
  /** Review M1: the project list itself could not be read — nothing can be claimed. */
  listError?: string | null | undefined;
}

/** Review M1: the queue when the project list read failed. */
export function failedRepresentativeQueue(error: string): RepresentativeQueue {
  return { tasks: [], unreadProjects: [], skippedProjects: 0, listError: error };
}

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
      ? [{ projectId: project.id, orderId: order.id, projectLabel: `${project.code}（${project.name}）`, orderCode: order.code, status: order.status, work }]
      : [];
  });
}

export async function loadRepresentativeQueue(projects: readonly ProjectSummary[]): Promise<RepresentativeQueue> {
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
  return { tasks, unreadProjects, skippedProjects: Math.max(0, projects.length - read.length) };
}
