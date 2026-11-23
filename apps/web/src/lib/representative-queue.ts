import { callApi } from './api';
import { isMissingRoute } from './approval-card';
import { formatAmount } from './number-format';
import { senderStatusOf, senderWarningsOf } from './sender-check';
import type { SenderCheckStatus, SenderWarning } from './sender-check';
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
  // P4 N14 (P-6): drafting the maker paper is staff work; the representative's part is the 代表承認 of the drafted paper.
  DUAL_APPROVED: 'メーカー発注書の代表承認（作成は担当者・校了済み）',
  MAKER_PO_READY: 'メーカー発注書の代表承認（作成は担当者）',
  // Review L4: shared step — the representative's part comes after the staff record and the evidence.
  MAKER_PO_SENT_MANUALLY: '受入の最終確認（担当者の仮記録・受領証跡のあと）',
  ON_HOLD: '保留の解除（理由の確認）',
  CANCELLATION_REVIEW: '取消確認の処理'
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
  /** P2 R32: the maker paper's number (MPO-2026-0001) when the queue item carries it. */
  displayNumber?: string | null | undefined;
  /** Set on a blocked row: why it cannot move, in one sentence. */
  blockedReason?: string | null | undefined;
  /**
   * P4 M13 / N11 (web2a): what of the order the row is about — 「顧客／デザイン 表面A」 (the server item's
   * organization and designKey), 「明細1／500 m」 for a delivery; null when the item has none.
   */
  target?: string | null | undefined;
  /** P4 M18: the order's 希望納期 / 納品予定日 (`YYYY-MM-DD`), when the queue item carries them. */
  requestedDeliveryDate?: string | null | undefined;
  plannedDeliveryDate?: string | null | undefined;
  /** P4 N11/M13: which organization and design the row is about (null: the row is about the whole order). */
  organization?: 'customer' | 'seven' | null | undefined;
  designKey?: string | null | undefined;
  /** P4 N4: the approval-evidence file of an 承認証跡の確認 row: name, From, uploader, the sender check. */
  evidence?: QueueEvidence | null | undefined;
  /** P4 N4: the sender warnings of that evidence (EVIDENCE_SENDER_DOMAIN_MISMATCH / …_UNVERIFIABLE). */
  warnings?: SenderWarning[] | undefined;
  /** p4/web3 (c): the server's deepLink.step when it is a place, not a step number (`payment_terms`). */
  deepLinkStep?: string | null | undefined;
  /**
   * p4/web3 (c, server2 §1(2)): whether the 未定 can be fixed now (the PATCH in deepLink.action would pass);
   * false comes with the lock's message (保留・見直し中, or a CEO-approved paper). Undefined: not answered.
   */
  paymentTermsEditable?: boolean | undefined;
  paymentTermsLock?: { code: string; reason: string | null; message: string } | null | undefined;
}

export { PAYMENT_TERMS_ANCHOR } from './project-route';

/** p4/web3 (c): a row whose fix is the order's 支払条件 (from creation on — not step 7, which a DRAFT has not reached). */
export function opensPaymentTerms(task: Pick<RepresentativeTask, 'kind' | 'deepLinkStep'>): boolean {
  return task.deepLinkStep === 'payment_terms' || task.kind === 'payment_terms_undetermined';
}

export interface QueueEvidence {
  /** web2b review L-3: the declared issuer (the item's detail.evidenceIssuerEntity), shown with its label. */
  issuerEntity?: string | null | undefined;
  filename: string | null;
  fromAddress: string | null;
  uploadedBy: string | null;
  senderStatus: SenderCheckStatus | null;
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
  // p4/web3 (c): opened at the order's 支払条件 (deepLink.step = payment_terms), whatever the step — see opensPaymentTerms.
  payment_terms_undetermined: null,
  // P4 H14: the representative confirms a delivery its uploader may not confirm (P-4).
  delivery_confirmation: 12
};

/**
 * P4 H11: the Korean line of a queue row, by the kind of work (the server's `label` is Japanese
 * only; the kind is a code, so the dictionary lives here). The representative reads Korean
 * first (P-7). A kind this table does not know gets no Korean line (never a guess).
 */
export const QUEUE_KIND_KO: Readonly<Record<string, string>> = {
  approval_evidence_verification: '승인 증빙 확인',
  maker_po_creation: '제조사 발주서 작성',
  maker_po_ceo_approval: '제조사 발주서 대표 승인',
  send_verification: '송신 확인',
  maker_po_final_acceptance: '최종 수령 확인',
  hold_release: '보류 해제',
  cancellation_review: '취소 확인 처리',
  cancellation_acknowledgement: '취소 승인 기록',
  payment_terms_undetermined: '지불 조건 미정',
  delivery_confirmation: '납품 확인'
};

/** The Korean status-based work line (the fallback queue's `work`). */
export const REPRESENTATIVE_WORK_KO: Readonly<Record<string, string>> = {
  DUAL_APPROVED: '제조사 발주서 대표 승인(작성은 담당자·교정 확정 완료)',
  MAKER_PO_READY: '제조사 발주서 대표 승인(작성은 담당자)',
  MAKER_PO_SENT_MANUALLY: '최종 수령 확인(담당자의 임시 기록·수령 증빙 후)',
  ON_HOLD: '보류 해제(사유 확인)',
  CANCELLATION_REVIEW: '취소 확인 처리'
};

export function taskWorkKo(task: Pick<RepresentativeTask, 'kind' | 'status'>): string | null {
  return (task.kind ? QUEUE_KIND_KO[task.kind] : undefined) ?? REPRESENTATIVE_WORK_KO[task.status] ?? null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const DUE_DATE_FORMAT = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', timeZone: 'UTC' });

function calendarDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

const ORGANIZATION_JA: Readonly<Record<string, string>> = { customer: '顧客', seven: 'セブン化学' };
const ORGANIZATION_KO: Readonly<Record<string, string>> = { customer: '고객', seven: '세븐화학' };

/**
 * P4 N11/M13: 「承認証跡の確認（顧客／表面A）」 — the row's title names the organization and the design, so two
 * rows of the same order are told apart (they used to read the same). A row about the whole order is unchanged.
 */
export function queueRowTitle(task: Pick<RepresentativeTask, 'work' | 'organization' | 'designKey'> & Partial<Pick<RepresentativeTask, 'target'>>): string {
  const parts = [task.organization ? ORGANIZATION_JA[task.organization] : null, task.designKey ?? null].filter((part): part is string => Boolean(part));
  if (parts.length > 0) return `${task.work}（${parts.join('／')}）`;
  // p4/web3 merge: web2a's delivery target 「明細1／500 m」 (a row with no organization / design) stays in the title.
  return task.target ? `${task.work}（${task.target}）` : task.work;
}

/** P4 N11/M13: a row's React key — two rows of one order (customer / seven, each design) must not share one. */
export function queueRowKey(task: Pick<RepresentativeTask, 'kind' | 'status' | 'projectId' | 'orderId' | 'organization' | 'designKey'> & Partial<Pick<RepresentativeTask, 'target'>>, prefix = ''): string {
  // p4/web3 merge: web2a's key also carried the target (two delivery lines of one order are two rows).
  return `${prefix}${task.kind ?? task.status}-${task.projectId}-${task.orderId}-${task.organization ?? ''}-${task.designKey ?? ''}-${task.target ?? ''}`;
}

/** The Korean twin of the suffix (the organization only; a design name is never translated). */
export function queueRowSuffixKo(task: Pick<RepresentativeTask, 'organization' | 'designKey'>): string | null {
  const parts = [task.organization ? ORGANIZATION_KO[task.organization] : null, task.designKey ?? null].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `(${parts.join('／')})` : null;
}

/**
 * P4 M18: 「希望納期 12/15（あと22日）」 — the date the customer wants the goods and how many days are left, in
 * Japan time. Past the date: 「（3日超過）」; the day itself: 「（今日）」. Null when the row has no 希望納期.
 */
export function queueDueText(task: Pick<RepresentativeTask, 'requestedDeliveryDate'>, now: Date): { text: string; late: boolean } | null {
  const date = task.requestedDeliveryDate;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const today = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  const left = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (Number.isNaN(left)) return null;
  const shown = DUE_DATE_FORMAT.format(new Date(`${date}T00:00:00Z`));
  if (left > 0) return { text: `希望納期 ${shown}（あと${left}日）`, late: false };
  if (left === 0) return { text: `希望納期 ${shown}（今日）`, late: false };
  return { text: `希望納期 ${shown}（${-left}日超過）`, late: true };
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
  const detail = record(row.detail);
  const evidence = record(detail.evidence);
  const organization = str(row.organization);
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
    displayNumber: str(paper.displayNumber) ?? undefined,
    blockedReason: blocked ? str(reason.message) : null,
    target: queueTarget(row) ?? undefined,
    requestedDeliveryDate: calendarDate(order.requestedDeliveryDate),
    plannedDeliveryDate: calendarDate(order.plannedDeliveryDate),
    organization: organization === 'customer' || organization === 'seven' ? organization : null,
    designKey: str(row.designKey),
    evidence: Object.keys(evidence).length > 0
      ? {
          ...(str(detail.evidenceIssuerEntity) ? { issuerEntity: str(detail.evidenceIssuerEntity) } : {}),
          filename: str(evidence.filename),
          fromAddress: str(evidence.fromAddress),
          uploadedBy: str(record(evidence.uploadedBy).displayName),
          senderStatus: senderStatusOf(evidence.senderDomainCheck)
        }
      : null,
    warnings: senderWarningsOf(detail.warnings),
    // p4/web3 (c): the one place-valued step the web routes by (other steps are the kind's number).
    ...(deepLink.step === 'payment_terms' ? { deepLinkStep: 'payment_terms' } : {}),
    ...(typeof row.paymentTermsEditable === 'boolean' ? { paymentTermsEditable: row.paymentTermsEditable } : {}),
    ...(paymentTermsLockOf(row.paymentTermsLock) ? { paymentTermsLock: paymentTermsLockOf(row.paymentTermsLock) } : {})
  };
}

/** Pure: the blocked row's `paymentTermsLock` (server2 §1(2)), or null. The message is the server's plain text. */
function paymentTermsLockOf(value: unknown): { code: string; reason: string | null; message: string } | null {
  const lock = record(value);
  const code = str(lock.code);
  const message = str(lock.message);
  return code && message ? { code, reason: str(lock.reason), message: message.slice(0, 200) } : null;
}

const QUEUE_ORGANIZATION_LABELS: Readonly<Record<string, string>> = { customer: '顧客', seven: 'セブン化学' };

/** P4 M13 / N11: 「顧客／表面A」 from organization + designKey; 「明細1・500 m」 for a delivery item. */
export function queueTarget(item: unknown): string | null {
  const row = record(item);
  const organization = str(row.organization);
  const designKey = str(row.designKey);
  const delivery = record(record(row.detail).delivery);
  const line = record(delivery.line);
  const parts = [
    organization ? QUEUE_ORGANIZATION_LABELS[organization] ?? organization : null,
    designKey ? `デザイン ${designKey}` : null,
    typeof line.lineNumber === 'number' ? `明細${line.lineNumber}` : null,
    str(delivery.display)
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join('／') : null;
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
