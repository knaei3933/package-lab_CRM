import {
  FILM_ORDER_CANCELLATION_STATE,
  FILM_SUPPLY_ORDER_EXCEPTION_STATES as EXCEPTION_ORDER_STATES,
  FILM_SUPPLY_ORDER_STATES,
  FILM_SUPPLY_ORDER_TERMINAL_STATE
} from '@kanei/core';
import type { FilmSupplyOrderState, Operation } from '@kanei/core';
import { cache } from 'react';
import { callApi } from './api';
import { standardTerm } from './terms';
import { operationRefusal } from './permissions';
import { shortId } from './short-id';
import { codeWithStatus, displayText, HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT, isFieldHiddenByRole, isStateWithheld } from './redaction';
import { formatDateOrTimestamp } from './vocabulary';
import type { MakerPaperCleanupSummary } from './maker-po-data';

/**
 * M6 operator UI data assembly.
 *
 * The API is write-oriented: the flow endpoints create and transition records,
 * and every one of those writes lands in the project's audit history
 * (GET /api/projects/:projectId/audit-history?entityType=...). That read-only
 * surface is therefore the listing source for every screen: each loader below
 * replays one entity type's events in occurrence order and keeps the latest
 * state per entity. No screen invents state the API did not record, and status
 * wording always comes from GET /api/status-labels.
 */

export interface PaymentTermsChangeView {
  at: string;
  actorName: string | null;
  before: string | null;
  after: string | null;
  reason: string | null;
}

export interface AuditEventView {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  occurredAt: string;
  requestMetadata: Record<string, unknown> | null;
  actor: { id: string; displayName: string; role: string } | null;
}

export interface LabelEntry {
  key: string;
  label: string;
}

export interface LabelSurface {
  filmSupplyOrderStates: LabelEntry[];
  makerPurchaseOrderStatuses: LabelEntry[];
  commissionReadinessStates: LabelEntry[];
  fillingDeliveryConfirmationStates: LabelEntry[];
  approvalOrganizations: LabelEntry[];
}

export interface ProjectView {
  id: string;
  code: string;
  name: string;
  route: string;
  status: string;
}

export interface OrderLineView {
  id: string;
  lineNumber: number;
  description: string;
  orderedQuantity: string;
  unit: string;
}

export interface FilmSupplyOrderView {
  id: string;
  code: string;
  status: string;
  sevenPurchaseOrderId: string | null;
  lineCount: number;
  lines: OrderLineView[];
  /** UI batch A: the API withheld this order's recorded details from the role. */
  detailsHidden: boolean;
  /** UI batch A: the API withheld the status (viewer); never shown as 下書き. */
  statusHidden: boolean;
  /**
   * UI batch B: the latest normal (non-exception) state the order was seen in —
   * for an order on hold or under review, the state it left. Null when the
   * role may not read the states.
   */
  lastNormalStatus: string | null;
  /**
   * UI batch E (F-11): the hold the order is in (null when not on hold, or the
   * hold record was not seen) — the reason, who put it on hold and when, so the
   * representative deciding the release can read why. The reason is withheld
   * from staff by the API (reasonHidden).
   */
  hold?: FilmOrderHoldView | null | undefined;
  /**
   * UI batch E3: the 支払条件 (G6) the audit history recorded — the creation
   * value, replaced by each later 支払条件の記録. Since the representative's
   * decision the API answers it to staff and viewer too (amounts stay hidden);
   * null when it was not recorded or the role may not read it (paymentTermsHidden).
   */
  paymentTerms?: string | null | undefined;
  /**
   * P0 R01 (policy P-5): the recorded changes of the 支払条件 after creation,
   * oldest first — who, when, from what to what and the optional reason.
   */
  paymentTermsHistory?: PaymentTermsChangeView[] | undefined;
  /** UI batch E3: the API withheld the 支払条件 from this role. */
  paymentTermsHidden?: boolean | undefined;
  /**
   * P2 R30 (contract §3-1): 希望納期 / 納品予定日 as `YYYY-MM-DD`, null when not
   * recorded. Read from GET /api/projects/:id/film-supply-orders (every role);
   * `deliveryDatesRead` is false when that list could not be read (an older API,
   * an outage) — the screens then never say 「未記録」.
   */
  requestedDeliveryDate?: string | null | undefined;
  plannedDeliveryDate?: string | null | undefined;
  deliveryDatesRead?: boolean | undefined;
  /**
   * P4 B1①: the API's own verdict that the 支払条件 is still 「未定」 (the list row's
   * `attention` holds PAYMENT_TERMS_UNDETERMINED, from creation on). true/false once
   * the list was read; undefined when it was not (an older API, an outage).
   */
  paymentTermsUndetermined?: boolean | undefined;
  /** P4 B1②: the list's `paymentTermsEditable` (the API's own answer); undefined when not read. */
  paymentTermsEditable?: boolean | undefined;
  /** P2: when the order row last changed (the list's updatedAt), when read. */
  rowUpdatedAt?: string | null | undefined;
  createdAt: string;
  updatedAt: string;
}

/** P2 R30: one row of GET /api/projects/:projectId/film-supply-orders (the fields the web reads). */
export interface FilmOrderListRow {
  id: string;
  code?: string;
  status?: string;
  requestedDeliveryDate?: string | null;
  plannedDeliveryDate?: string | null;
  updatedAt?: string;
  paymentTerms?: string | null;
  paymentTermsEditable?: unknown;
  attention?: Array<{ code?: unknown }> | null;
}

/** P2 R30: the list's dates, by order id; null when the list could not be read. */
export async function loadFilmOrderList(projectId: string): Promise<Map<string, FilmOrderListRow> | null> {
  const result = await callApi<{ orders: FilmOrderListRow[] }>(`/api/projects/${encodeURIComponent(projectId)}/film-supply-orders`);
  if (!result.ok || !result.data || !Array.isArray(result.data.orders)) return null;
  return new Map(result.data.orders.filter((row) => typeof row?.id === 'string').map((row) => [row.id, row]));
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** P2 R30, pure: the list's dates merged into the replayed orders (unknown shapes read as not recorded). */
export function mergeDeliveryDates(orders: FilmSupplyOrderView[], list: ReadonlyMap<string, FilmOrderListRow> | null): void {
  for (const order of orders) {
    if (!list) {
      order.deliveryDatesRead = false;
      order.paymentTermsUndetermined = undefined;
      order.paymentTermsEditable = undefined;
      continue;
    }
    const row = list.get(order.id);
    order.deliveryDatesRead = row !== undefined;
    const date = (value: unknown) => (typeof value === 'string' && CALENDAR_DATE.test(value) ? value : null);
    order.requestedDeliveryDate = row ? date(row.requestedDeliveryDate) : null;
    order.plannedDeliveryDate = row ? date(row.plannedDeliveryDate) : null;
    order.rowUpdatedAt = row && typeof row.updatedAt === 'string' ? row.updatedAt : null;
    order.paymentTermsEditable = row && typeof row.paymentTermsEditable === 'boolean' ? row.paymentTermsEditable : undefined;
    // P4 B1①: read the API's attention, whatever the order's status.
    order.paymentTermsUndetermined = row === undefined
      ? undefined
      : Array.isArray(row.attention) && row.attention.some((entry) => entry?.code === 'PAYMENT_TERMS_UNDETERMINED');
  }
}

export interface FilmOrderHoldView {
  reason: string | null;
  reasonHidden: boolean;
  actorName: string | null;
  at: string;
}

export interface FillingOrderView {
  id: string;
  code: string;
  lineCount: number;
  lines: OrderLineView[];
  /** UI batch A: the API withheld this order's recorded details from the role. */
  detailsHidden: boolean;
  createdAt: string;
}

export interface SevenPurchaseOrderView {
  id: string;
  poNumber: string;
  /** UI batch A follow-up: the PO number was withheld from the role (staff/viewer). */
  poNumberHidden: boolean;
  /** The recorded 本登録日 — only ever the API's own value, never a stand-in. */
  officialRegisteredAt: string | null;
  /**
   * The PO is known to be officially registered: the date is visible, or the
   * SEVEN_PO_OFFICIALLY_REGISTERED action (which every role reads) was seen.
   */
  officiallyRegistered: boolean;
  verificationStatus: string | null;
  reviewPending: boolean;
  /** UI batch A: the registration date may exist but is withheld from the role. */
  officialRegistrationHidden: boolean;
  /** UI batch A: a checklist was recorded but its result is withheld from the role. */
  verificationHidden: boolean;
}

/**
 * UI batch A follow-up (M1): the select label of a セブン化学発注書. A withheld
 * PO number is named as withheld and the short id keeps the choices apart — its
 * last 8 characters, because a uuidv7's leading characters are its creation
 * time and POs made within ~65 seconds share them; the
 * registration part says what is known — 本登録済み (date visible, or the
 * registration action seen), 未登録 only when the API shows the PO unregistered,
 * and 閲覧権限なし when the role may not read it. Never 「（閲覧権限なし）（未登録）」.
 */
export function sevenPurchaseOrderChoiceLabel(po: SevenPurchaseOrderView): string {
  const number = po.poNumberHidden
    ? `発注番号 ${HIDDEN_BY_ROLE_SHORT}・ID ${shortId(po.id)}`
    : po.poNumber;
  const registration = po.officiallyRegistered
    ? '本登録済み'
    : po.officialRegistrationHidden
      ? `登録状況 ${HIDDEN_BY_ROLE_SHORT}`
      : '未登録';
  return `${number}（${registration}）`;
}

/**
 * The 本登録 cell: the recorded date when the API sent it; 「本登録済み」 with
 * the date named as withheld when the role saw only the registration action;
 * 「閲覧権限なし」 when the role cannot tell; 未登録 only when shown unregistered.
 */
export function officialRegistrationText(po: SevenPurchaseOrderView): string {
  if (po.officialRegisteredAt) return formatDateOrTimestamp(po.officialRegisteredAt);
  if (po.officiallyRegistered) {
    return po.officialRegistrationHidden
      ? `本登録済み（登録日は${HIDDEN_BY_ROLE_SHORT}）`
      : '本登録済み（登録日未記録）';
  }
  return po.officialRegistrationHidden ? HIDDEN_BY_ROLE_LABEL : '未登録';
}

export interface DocumentVersionView {
  id: string;
  documentId: string;
  versionNumber: number;
  /** null when absent; see sha256Hidden for whether the role was denied it. */
  sha256: string | null;
  /** The content digest was withheld from the role (staff/viewer). */
  sha256Hidden: boolean;
  originalFilename: string;
  createdAt: string;
  /** P1 P-4: who uploaded this version (the upload audit row's actor). */
  uploadedByUserId?: string | null | undefined;
}

export interface DocumentView {
  id: string;
  documentType: string;
  issuerEntity: string;
  filename: string;
  note: string | null;
  verificationStatus: string;
  verificationNote: string | null;
  sevenPurchaseOrderId: string | null;
  filmSupplyOrderId: string | null;
  designKey: string | null;
  /** The maker PO the document was uploaded for (admin answer only; null when unbound or withheld). */
  makerPurchaseOrderId: string | null;
  /** P1 P-4: who registered it (the creation audit row's actor) — staff never confirm their own evidence. */
  uploadedByUserId?: string | null | undefined;
  /** Issuer and links were withheld from the role (viewer; staff reads them since db4bd88). */
  detailsHidden: boolean;
  /** The document type was withheld (viewer; staff sees it since 62d9305). */
  typeHidden: boolean;
  /** UI batch A: the verification result was withheld from the role (viewer). */
  verificationHidden: boolean;
  createdAt: string;
  updatedAt: string;
  versions: DocumentVersionView[];
}

export interface ArtworkRevisionView {
  id: string;
  filmSupplyOrderId: string;
  designKey: string;
  /** null when absent — never a stand-in number; see revisionNoHidden. */
  revisionNo: number | null;
  /** The revision number was withheld from the role (staff since 62d9305 sees the binding but not the number). */
  revisionNoHidden: boolean;
  fileDocumentVersionId: string;
  note: string | null;
  invalidatedApprovals: boolean;
  createdAt: string;
}

export interface ApprovalEventRecord {
  id: string;
  artworkRevisionId: string;
  organization: string;
  decision: string;
  designKey: string;
  revisionNo: number | null;
  evidenceDocumentVersionId: string;
  evidenceSource: string;
  /** The recorded approval time; null when absent (never the record time instead). */
  eventTime: string | null;
  recordedAt: string;
  /** UI batch A follow-up: the decision details were withheld from the role (staff/viewer). */
  detailsHidden: boolean;
}

export interface DeliveryView {
  id: string;
  kind: 'film' | 'filling';
  orderId: string | null;
  lineId: string | null;
  unit: string;
  deliveredQuantity: string;
  deliverySequence: number | null;
  /** The recorded delivery date; null when absent (never the record time instead). */
  deliveredAt: string | null;
  /** When the delivery was recorded (the audit row time); for ordering only. */
  recordedAt: string;
  note: string | null;
  confirmed: boolean;
  evidenceDocumentVersionId: string | null;
  confirmedAt: string | null;
  /** UI batch A follow-up: order, quantity, sequence and date were withheld from the role. */
  detailsHidden: boolean;
  /**
   * Not known to be confirmed, but a confirmation exists whose delivery link
   * the role may not read — so 未確認 cannot be claimed either.
   */
  confirmationHidden: boolean;
}

export interface ReadinessView {
  readinessState: string;
  isReady: boolean;
  blocking: string[];
  evaluatedAt: string;
  /** UI batch A follow-up: the evaluation result was withheld from the role. */
  hidden: boolean;
}

export interface OrganizationApprovalStateView {
  organization: string;
  valid: boolean;
  latestDecision: string | null;
  revoked: boolean;
  invalidatedByNewerRevision: boolean;
  /** M8-OPER2 FIX 2: the approval is recorded but its identifier is unverified. */
  pendingEvidenceIdentifier: boolean;
  /** The latest manual verification of that approval, when one exists. */
  manualVerification: {
    result: string;
    verifierName: string;
    verifiedAt: string;
    recordedAt: string;
  } | null;
}

/** M8-OPER2 FIX 2: one pending evidence verification the representative can act on. */
export interface PendingManualVerificationView {
  approvalEventId: string;
  revisionId: string;
  designKey: string;
  revisionNo: number;
  organization: string;
  evidenceDocumentVersionId: string | null;
  evidenceIdentifier: string | null;
  approvedFileSha256: string;
  eventTime: string;
  recordedAt: string;
  manualVerification: OrganizationApprovalStateView['manualVerification'];
  /**
   * P0 R02 (B2, p0-server approval-gate): who issued the cited evidence, who
   * should have (顧客の承認 → customer_generated, セブン化学 → seven), whether
   * they match, the declared shared-evidence exception, and whether 「確認」 can
   * be recorded at all (the API refuses it on a mismatch without the exception).
   */
  evidenceIssuerEntity: string | null;
  expectedIssuerEntity: string | null;
  issuerMatchesOrganization: boolean | null;
  sharedEvidenceException: { reason: string | null } | null;
  confirmable: boolean;
  /** P0 review H1: the other organization's approval rests on the same evidence content. */
  sameContentUsedByOtherOrganization: boolean;
  /**
   * False for an older approval the gate holds back (auto-verified before the
   * content check): it cannot take a manual check and must be recorded again
   * on that organization's own evidence (EVIDENCE_REQUIRES_REPLACEMENT).
   */
  recordedAsPending: boolean;
}

export interface DesignApprovalGateView {
  designKey: string;
  currentRevisionId: string;
  currentRevisionNo: number;
  fileSha256: string;
  customer: OrganizationApprovalStateView;
  seven: OrganizationApprovalStateView;
  dualApproved: boolean;
}

export interface ApprovalGateView {
  orderId: string;
  orderStatus: string;
  dualApproved: boolean;
  missingApprovals: Array<{ designKey: string; organization: string }>;
  designs: DesignApprovalGateView[];
  /** Admin only: the pending evidence verifications awaiting a decision. */
  pendingManualVerifications: PendingManualVerificationView[];
}

export interface Workspace {
  error: string | null;
  project: ProjectView | null;
  labels: LabelSurface | null;
  filmOrders: FilmSupplyOrderView[];
  fillingOrders: FillingOrderView[];
  sevenPurchaseOrders: SevenPurchaseOrderView[];
  documents: DocumentView[];
  revisions: ArtworkRevisionView[];
  approvalEvents: ApprovalEventRecord[];
  deliveries: DeliveryView[];
  readiness: ReadinessView | null;
  /**
   * UI batch A follow-up: document versions exist whose document link the role
   * may not read, so per-document version lists are incomplete for this role.
   */
  documentVersionsWithheld: boolean;
  /** Proof revisions whose film order link the role may not read. */
  revisionsWithheld: number;
  /**
   * Recheck 7 Medium-3: the maker paper still to clean up on each cancelled or
   * frozen order (by order id). Absent for an order means "not read" — the
   * screens then never say there is nothing left to do.
   */
  makerPaperCleanup?: Record<string, MakerPaperCleanupSummary> | undefined;
  /**
   * UI batch E (F-12): the selected project could not be opened (deleted, or
   * not assigned to this operator). The screens then show only how to choose
   * a project — no forms that would post into it.
   */
  projectRefused?: boolean | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function state(record: Record<string, unknown> | null): Record<string, unknown> {
  return isRecord(record) ? record : {};
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requiredText(record: Record<string, unknown>, key: string, fallback: string): string {
  return text(record, key) ?? fallback;
}

function numeric(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

async function loadEvents(
  projectId: string,
  entityType: string,
  actions: readonly string[] = []
): Promise<{ events: AuditEventView[]; error: string | null }> {
  // P0 integration: `action` keeps reads (DOCUMENT_VERSION_VIEWED…) out of the 500-row window.
  const actionQuery = actions.length > 0 ? `&action=${encodeURIComponent(actions.join(','))}` : '';
  const result = await callApi<{ events: AuditEventView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/audit-history?entityType=${encodeURIComponent(entityType)}&limit=500${actionQuery}`
  );
  if (!result.ok || !result.data) {
    return { events: [], error: result.error ?? `監査履歴が取得できませんでした（${result.status}）。` };
  }
  return { events: Array.isArray(result.data.events) ? result.data.events : [], error: null };
}

/** Turns the status-labels surface into a lookup that never invents a label. */
export function labelLookup(
  surface: LabelSurface | null,
  section: keyof LabelSurface
): (key: string) => string {
  const entries = surface ? surface[section] : [];
  const map = new Map<string, string>();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.key === 'string' && typeof entry?.label === 'string') {
      map.set(entry.key, entry.label);
    }
  }
  // P1 R28: the §9 standard wording first (lib/terms), then the API's label, never the key unless unknown to both.
  return (key: string) => standardTerm(section, key)?.ja ?? map.get(key) ?? key;
}

async function loadProject(projectId: string): Promise<{ project: ProjectView | null; error: string | null; refused?: boolean }> {
  const result = await callApi<ProjectView>(`/api/projects/${encodeURIComponent(projectId)}`);
  if (!result.ok || !result.data) {
    const reason = result.error ?? `案件が取得できませんでした（${result.status}）。`;
    // UI batch B (②): a remembered project the API no longer opens (404 等)
    // says what to do next; the API's own wording stays first, unchanged.
    // A lost session (401) is not a project problem: ask for a new login.
    const hint = result.status === 401
      ? RELOGIN_HINT
      : result.status >= 400 && result.status < 500 ? RESELECT_PROJECT_HINT : null;
    return {
      project: null,
      error: hint ? `${reason} ${hint}` : reason,
      // UI batch E (F-12): the remembered project is gone or not this operator's (4xx, not a lost session).
      refused: result.status >= 400 && result.status < 500 && result.status !== 401
    };
  }
  return {
    project: {
      id: result.data.id,
      code: result.data.code,
      name: result.data.name,
      route: result.data.route,
      status: result.data.status
    },
    error: null
  };
}

async function loadLabels(): Promise<{ labels: LabelSurface | null; error: string | null }> {
  const result = await callApi<LabelSurface>('/api/status-labels');
  if (!result.ok || !result.data) {
    return { labels: null, error: result.error ?? 'ステータスラベルが取得できませんでした。' };
  }
  return { labels: result.data, error: null };
}

function readLines(events: AuditEventView[], orderKey: string): Map<string, OrderLineView> {
  const lines = new Map<string, OrderLineView>();
  for (const event of events) {
    const after = state(event.afterState);
    const line: OrderLineView = {
      id: event.entityId,
      lineNumber: numeric(after, 'lineNumber') ?? 0,
      description: displayText(event, 'description', '（説明未記録）'),
      orderedQuantity: requiredText(after, 'orderedQuantity', '—'),
      unit: requiredText(after, 'unit', '—')
    };
    const orderId = text(after, orderKey) ?? text(state(event.requestMetadata), orderKey);
    if (!orderId) continue;
    lines.set(line.id, line);
  }
  return lines;
}

/** One row of GET /api/projects: only the fields the top-bar selector renders. */
export interface ProjectSummary {
  id: string;
  code: string;
  name: string;
  status: string;
}

/**
 * M8-UI3: the projects the signed-in operator may open, read from
 * GET /api/projects. The API answers admin with every non-deleted project and
 * staff / viewer with only their project_assignments rows, so the top-bar
 * selector never offers an id the operator could not already open by hand. An
 * unreachable or empty answer yields an empty list — the direct-input field
 * below the selector stays usable, so nothing is trapped by a list read.
 */
export async function loadSelectableProjects(): Promise<ProjectSummary[]> {
  return (await loadSelectableProjectList()).projects;
}

/**
 * UI batch E (review M1, M3): the same read with its failure kept, so the
 * representative queue never says 「対応待ちはありません」 after a failed read,
 * and memoised per server request (React cache) so the layout's selector and
 * the queue share one GET /api/projects.
 */
export const loadSelectableProjectList = cache(async (): Promise<{ projects: ProjectSummary[]; error: string | null }> => {
  const result = await callApi<{ projects: ProjectSummary[] }>('/api/projects');
  if (!result.ok || !result.data) {
    return { projects: [], error: result.error ?? `案件の一覧を取得できませんでした（${result.status}）。` };
  }
  return { projects: Array.isArray(result.data.projects) ? result.data.projects : [], error: null };
});

export async function loadWorkspace(
  projectId: string,
  options: { makerPaperCleanup?: boolean } = {}
): Promise<Workspace> {
  // P2 R30: the order list (delivery dates) is read beside the audit replay.
  const filmOrderListRead = loadFilmOrderList(projectId);
  const [projectResult, labelResult, filmOrderEvents, filmLineEvents, fillingOrderEvents, fillingLineEvents, poEvents, documentEvents, versionEvents, revisionEvents, approvalEvents, filmDeliveryEvents, fillingDeliveryEvents, confirmationEvents, readinessEvents] =
    await Promise.all([
      loadProject(projectId),
      loadLabels(),
      loadEvents(projectId, 'film_supply_order'),
      loadEvents(projectId, 'film_supply_order_line'),
      loadEvents(projectId, 'filling_order'),
      loadEvents(projectId, 'filling_order_line'),
      loadEvents(projectId, 'seven_purchase_order'),
      loadEvents(projectId, 'document'),
      loadEvents(projectId, 'document_version', ['DOCUMENT_VERSION_UPLOADED']),
      loadEvents(projectId, 'artwork_revision'),
      loadEvents(projectId, 'artwork_approval_event'),
      loadEvents(projectId, 'film_delivery'),
      loadEvents(projectId, 'filling_delivery'),
      loadEvents(projectId, 'delivery_confirmation'),
      loadEvents(projectId, 'commission_readiness')
    ]);

  const firstError = projectResult.error
    ?? labelResult.error
    ?? filmOrderEvents.error
    ?? filmLineEvents.error
    ?? fillingOrderEvents.error
    ?? fillingLineEvents.error
    ?? poEvents.error
    ?? documentEvents.error
    ?? versionEvents.error
    ?? revisionEvents.error
    ?? approvalEvents.error
    ?? filmDeliveryEvents.error
    ?? fillingDeliveryEvents.error
    ?? confirmationEvents.error
    ?? readinessEvents.error;

  // ---- film supply orders: create + transition replay (latest status wins).
  const filmLines = readLines(filmLineEvents.events, 'filmSupplyOrderId');
  const filmOrders = new Map<string, FilmSupplyOrderView>();
  for (const event of filmOrderEvents.events) {
    const after = state(event.afterState);
    if (event.action === 'FILM_SUPPLY_ORDER_CREATED') {
      filmOrders.set(event.entityId, {
        id: event.entityId,
        code: displayText(event, 'code', '（コード未記録）'),
        status: requiredText(after, 'status', 'DRAFT'),
        sevenPurchaseOrderId: text(after, 'sevenPurchaseOrderId'),
        lineCount: numeric(after, 'lineCount') ?? 0,
        lines: [],
        // lineCount is on every full answer and off the staff allowlist, so its
        // absence marks a role-shaped answer (viewer: no state; staff: trimmed).
        detailsHidden: isFieldHiddenByRole(event, 'lineCount'),
        statusHidden: isStateWithheld(event),
        lastNormalStatus: isStateWithheld(event) ? null : normalStatusOrNull(text(after, 'status')),
        paymentTerms: text(after, 'paymentTerms'),
        paymentTermsHidden: isFieldHiddenByRole(event, 'paymentTerms'),
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt
      });
    } else if (event.action === 'FILM_SUPPLY_ORDER_PAYMENT_TERMS_UPDATED') {
      // UI batch E3: a later 支払条件の記録 replaces the creation value. Its full
      // state is never empty ({ paymentTerms }), so an empty answer was trimmed.
      const current = filmOrders.get(event.entityId);
      if (current) {
        const recorded = text(after, 'paymentTerms');
        const metadata = event.requestMetadata ?? {};
        (current.paymentTermsHistory ??= []).push({
          at: event.occurredAt,
          actorName: event.actor?.displayName ?? null,
          before: text(state(event.beforeState), 'paymentTerms'),
          after: recorded,
          reason: text(metadata, 'reason') ?? text(after, 'reason')
        });
        if (recorded) {
          current.paymentTerms = recorded;
          current.paymentTermsHidden = false;
        } else if (isFieldHiddenByRole(event, 'paymentTerms', { emptyMeansTrimmed: true })) {
          current.paymentTerms = null;
          current.paymentTermsHidden = true;
        }
        current.updatedAt = event.occurredAt;
      }
    } else if (
      event.action === 'FILM_SUPPLY_ORDER_TRANSITIONED'
      // UI batch B: the 受領確認 (receipt assumption) moves the order into the
      // terminal state through its own action, recorded on the same entity.
      || event.action === 'FILM_RECEIPT_ASSUMPTION_RECORDED'
      // UI batch D: the admin-only hold release and cancellation review
      // resolution record their own actions (afterState.status is the state
      // resumed, or CANCELLED); without them a released order kept reading
      // 保留中 and a cancelled one 取消確認中.
      || event.action === 'FILM_SUPPLY_ORDER_HOLD_RELEASED'
      || event.action === 'FILM_SUPPLY_ORDER_CANCELLATION_REVIEW_RESOLVED'
    ) {
      const current = filmOrders.get(event.entityId);
      if (current) {
        current.status = requiredText(state(event.afterState), 'status', current.status);
        current.statusHidden = isStateWithheld(event);
        // UI batch E (F-11): the latest move into ON_HOLD carries the reason; any later move ends it.
        current.hold = current.statusHidden
          ? null
          : current.status === 'ON_HOLD'
            ? {
              reason: text(state(event.afterState), 'holdReason'),
              reasonHidden: isFieldHiddenByRole(event, 'holdReason'),
              actorName: event.actor?.displayName ?? null,
              at: event.occurredAt
            }
            : null;
        if (!current.statusHidden) {
          current.lastNormalStatus = normalStatusOrNull(current.status)
            ?? normalStatusOrNull(text(state(event.beforeState), 'status'))
            ?? current.lastNormalStatus;
        }
        current.updatedAt = event.occurredAt;
      }
    }
  }
  for (const order of filmOrders.values()) {
    order.lines = [...filmLines.values()].filter((line) =>
      isLineOfOrder(filmLineEvents.events, line.id, order.id)
    );
    order.lineCount = order.lines.length > 0 ? order.lines.length : order.lineCount;
  }

  // ---- filling orders (no status axis).
  const fillingLines = readLines(fillingLineEvents.events, 'fillingOrderId');
  const fillingOrders = new Map<string, FillingOrderView>();
  for (const event of fillingOrderEvents.events) {
    if (event.action !== 'FILLING_ORDER_CREATED') continue;
    const after = state(event.afterState);
    fillingOrders.set(event.entityId, {
      id: event.entityId,
      code: displayText(event, 'code', '（コード未記録）'),
      lineCount: numeric(after, 'lineCount') ?? 0,
      lines: [],
      // lineCount is on every full answer and off the staff allowlist, so its
      // absence marks a role-shaped answer (viewer: no state; staff: trimmed).
      detailsHidden: isFieldHiddenByRole(event, 'lineCount'),
      createdAt: event.occurredAt
    });
  }
  for (const order of fillingOrders.values()) {
    order.lines = [...fillingLines.values()].filter((line) =>
      isLineOfOrder(fillingLineEvents.events, line.id, order.id)
    );
    order.lineCount = order.lines.length > 0 ? order.lines.length : order.lineCount;
  }

  // ---- seven purchase orders: create → official registration → checklist.
  const sevenPurchaseOrders = new Map<string, SevenPurchaseOrderView>();
  for (const event of poEvents.events) {
    const after = state(event.afterState);
    if (event.action === 'SEVEN_PO_CREATED') {
      const registeredAt = text(after, 'officialRegisteredAt');
      sevenPurchaseOrders.set(event.entityId, {
        id: event.entityId,
        poNumber: displayText(event, 'poNumber', '（発注番号未記録）'),
        poNumberHidden: isFieldHiddenByRole(event, 'poNumber'),
        officialRegisteredAt: registeredAt,
        officiallyRegistered: registeredAt !== null,
        verificationStatus: null,
        reviewPending: false,
        officialRegistrationHidden: isFieldHiddenByRole(event, 'officialRegisteredAt'),
        verificationHidden: false
      });
    } else if (event.action === 'SEVEN_PO_OFFICIALLY_REGISTERED') {
      const current = sevenPurchaseOrders.get(event.entityId);
      if (current) {
        // The action itself is readable by every role, so the PO is known to
        // be registered. The date is shown only when the API sent it: a hidden
        // date stays hidden (never the record time in its place), and an admin
        // answer without one reads as unrecorded.
        current.officiallyRegistered = true;
        current.officialRegisteredAt = text(after, 'officialRegisteredAt');
        current.officialRegistrationHidden = isFieldHiddenByRole(event, 'officialRegisteredAt');
      }
    } else if (event.action === 'SEVEN_PO_VERIFICATION_RECORDED') {
      const current = sevenPurchaseOrders.get(event.entityId);
      if (current) {
        current.verificationStatus = text(after, 'verificationStatus');
        current.reviewPending = bool(after, 'reviewPending');
        current.verificationHidden = isFieldHiddenByRole(event, 'verificationStatus');
      }
    }
  }

  // ---- documents + versions.
  const documents = new Map<string, DocumentView>();
  for (const event of documentEvents.events) {
    const after = state(event.afterState);
    if (event.action === 'DOCUMENT_CREATED') {
      documents.set(event.entityId, {
        id: event.entityId,
        documentType: requiredText(after, 'documentType', 'unknown'),
        issuerEntity: requiredText(after, 'issuerEntity', 'unknown'),
        filename: displayText(event, 'originalFilename', '（ファイル名未記録）'),
        note: text(after, 'note'),
        verificationStatus: requiredText(after, 'verificationStatus', 'unverified'),
        verificationNote: text(after, 'verificationNote'),
        sevenPurchaseOrderId: text(after, 'sevenPurchaseOrderId'),
        filmSupplyOrderId: text(after, 'filmSupplyOrderId'),
        designKey: text(after, 'designKey'),
        makerPurchaseOrderId: text(after, 'makerPurchaseOrderId'),
        uploadedByUserId: event.actor?.id ?? null,
        // issuerEntity is on every full answer. Since db4bd88 staff reads it
        // (with the file name and the PO / film order links), so only the
        // viewer answer, which carries no document identity, is hidden here.
        detailsHidden: isFieldHiddenByRole(event, 'issuerEntity'),
        typeHidden: isFieldHiddenByRole(event, 'documentType'),
        verificationHidden: isFieldHiddenByRole(event, 'verificationStatus'),
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        versions: []
      });
    } else if (event.action === 'DOCUMENT_VERIFICATION_RECORDED') {
      const current = documents.get(event.entityId);
      if (current) {
        current.verificationStatus = requiredText(after, 'verificationStatus', current.verificationStatus);
        current.verificationNote = text(after, 'verificationNote');
        current.verificationHidden = isFieldHiddenByRole(event, 'verificationStatus');
        current.updatedAt = event.occurredAt;
      }
    }
  }
  let documentVersionsWithheld = false;
  for (const event of versionEvents.events) {
    // P0 integration: only an upload makes a version. The API also records
    // DOCUMENT_VERSION_VIEWED (every Message-ID read of the approvals screen) and
    // DOCUMENT_VERSION_DOWNLOADED on the same entity; counted as versions they
    // listed one evidence many times, and every render read each copy again
    // (511 view rows for one EML after a handful of renders).
    if (event.action !== 'DOCUMENT_VERSION_UPLOADED') continue;
    const after = state(event.afterState);
    const documentId = text(after, 'documentId') ?? text(state(event.requestMetadata), 'documentId');
    if (!documentId && isFieldHiddenByRole(event, 'documentId')) documentVersionsWithheld = true;
    const current = documentId ? documents.get(documentId) : undefined;
    if (!current || !documentId) continue;
    if (current.versions.some((version) => version.id === event.entityId)) continue;
    current.versions.push({
      id: event.entityId,
      documentId,
      versionNumber: numeric(after, 'versionNumber') ?? current.versions.length + 1,
      sha256: text(after, 'sha256'),
      sha256Hidden: isFieldHiddenByRole(event, 'sha256'),
      originalFilename: requiredText(after, 'originalFilename', current.filename),
      createdAt: event.occurredAt,
      uploadedByUserId: event.actor?.id ?? null
    });
  }
  for (const document of documents.values()) {
    document.versions.sort((a, b) => a.versionNumber - b.versionNumber);
  }

  // ---- artwork revisions + recorded approval events.
  const revisions: ArtworkRevisionView[] = [];
  let revisionsWithheld = 0;
  for (const event of revisionEvents.events) {
    if (event.action !== 'ARTWORK_REVISION_REGISTERED') continue;
    const after = state(event.afterState);
    const orderId = text(after, 'filmSupplyOrderId') ?? text(state(event.requestMetadata), 'filmSupplyOrderId');
    if (!orderId) {
      if (isFieldHiddenByRole(event, 'filmSupplyOrderId')) revisionsWithheld += 1;
      continue;
    }
    revisions.push({
      id: event.entityId,
      filmSupplyOrderId: orderId,
      designKey: displayText(event, 'designKey', '（デザイン未記録）'),
      revisionNo: numeric(after, 'revisionNo'),
      revisionNoHidden: isFieldHiddenByRole(event, 'revisionNo'),
      fileDocumentVersionId: requiredText(after, 'fileDocumentVersionId', '—'),
      note: text(after, 'note'),
      invalidatedApprovals: bool(after, 'invalidatedApprovals'),
      createdAt: event.occurredAt
    });
  }
  revisions.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  const approvalRecords: ApprovalEventRecord[] = [];
  for (const event of approvalEvents.events) {
    // M8-OPER2 FIX 2: a manual verification is recorded as its own audit row of
    // type evidence manual verification, naming the approval event it is about.
    // It is not an approval decision, so it stays out of this decision history —
    // for every role (the action survives the role filter, the payload does not).
    if (event.action === 'EVIDENCE_MANUAL_VERIFICATION_RECORDED') continue;
    const after = state(event.afterState);
    approvalRecords.push({
      id: event.entityId,
      artworkRevisionId: requiredText(after, 'artworkRevisionId', event.entityId),
      organization: requiredText(after, 'organization', '—'),
      decision: requiredText(after, 'decision', '—'),
      designKey: requiredText(after, 'designKey', '—'),
      revisionNo: numeric(after, 'revisionNo'),
      evidenceDocumentVersionId: requiredText(after, 'evidenceDocumentVersionId', '—'),
      evidenceSource: requiredText(after, 'evidenceSource', '—'),
      eventTime: text(after, 'eventTime'),
      recordedAt: event.occurredAt,
      // organization is on every full answer and off the staff allowlist.
      detailsHidden: isFieldHiddenByRole(event, 'organization')
    });
  }

  // ---- deliveries + confirmations (deliveryId → confirmation).
  const confirmations = new Map<string, { evidenceDocumentVersionId: string | null; confirmedAt: string }>();
  let confirmationsWithheld = false;
  for (const event of confirmationEvents.events) {
    const after = state(event.afterState);
    const deliveryId = text(after, 'deliveryId')
      ?? (event.action === 'FILM_DELIVERY_CONFIRMED'
        ? text(after, 'filmDeliveryId')
        : text(after, 'fillingDeliveryId'));
    if (!deliveryId) {
      if (isFieldHiddenByRole(event, 'deliveryId')) confirmationsWithheld = true;
      continue;
    }
    confirmations.set(deliveryId, {
      evidenceDocumentVersionId: text(after, 'evidenceDocumentVersionId'),
      confirmedAt: event.occurredAt
    });
  }

  const deliveries: DeliveryView[] = [];
  for (const event of filmDeliveryEvents.events) {
    const after = state(event.afterState);
    deliveries.push(toDeliveryView(event, after, 'film', 'filmSupplyOrderId', 'filmSupplyOrderLineId', confirmations, confirmationsWithheld));
  }
  for (const event of fillingDeliveryEvents.events) {
    const after = state(event.afterState);
    deliveries.push(toDeliveryView(event, after, 'filling', 'fillingOrderId', 'fillingOrderLineId', confirmations, confirmationsWithheld));
  }
  // Hidden delivery dates sort by the record time (order only — never shown as the date).
  const sortKey = (delivery: DeliveryView) => delivery.deliveredAt ?? delivery.recordedAt;
  deliveries.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));

  // ---- commission readiness: the latest evaluation wins.
  let readiness: ReadinessView | null = null;
  for (const event of readinessEvents.events) {
    const after = state(event.afterState);
    const blocking = Array.isArray(after.blocking)
      ? after.blocking.filter((entry): entry is string => typeof entry === 'string')
      : [];
    readiness = {
      readinessState: requiredText(after, 'readinessState', 'MISSING_DATA'),
      isReady: bool(after, 'isReady'),
      blocking,
      evaluatedAt: event.occurredAt,
      // The full evaluation answer is never empty, so an empty staff answer is
      // the allowlist trimming every key away — not a missing evaluation.
      hidden: isFieldHiddenByRole(event, 'readinessState', { emptyMeansTrimmed: true })
    };
  }

  // Medium-3: what the maker paper of a cancelled or frozen order still needs
  // (live paper, an owed 取り消し承認). Dynamic import: maker-po-data imports
  // this module. The /maker-po board reads the same paper itself and passes
  // makerPaperCleanup: false, then fills it from its own read.
  const closedOrderIds = options.makerPaperCleanup === false
    ? []
    : [...filmOrders.values()]
      .filter((order) => {
        const status = knownStatus(order);
        return status !== null && (status === FILM_ORDER_CANCELLATION_STATE
          || (EXCEPTION_ORDER_STATES as readonly string[]).includes(status));
      })
      .map((order) => order.id);
  const makerPaperCleanup = closedOrderIds.length > 0
    ? await (await import('./maker-po-data.js')).loadMakerPaperCleanup(projectId, closedOrderIds)
    : {};

  const filmOrderList = [...filmOrders.values()];
  mergeDeliveryDates(filmOrderList, await filmOrderListRead);

  return {
    error: firstError,
    project: projectResult.project,
    projectRefused: projectResult.refused === true,
    labels: labelResult.labels,
    makerPaperCleanup,
    filmOrders: filmOrderList,
    fillingOrders: [...fillingOrders.values()],
    sevenPurchaseOrders: [...sevenPurchaseOrders.values()],
    documents: [...documents.values()],
    revisions,
    approvalEvents: approvalRecords,
    deliveries,
    readiness,
    documentVersionsWithheld,
    revisionsWithheld
  };
}

function toDeliveryView(
  event: AuditEventView,
  after: Record<string, unknown>,
  kind: 'film' | 'filling',
  orderKey: string,
  lineKey: string,
  confirmations: Map<string, { evidenceDocumentVersionId: string | null; confirmedAt: string }>,
  confirmationsWithheld: boolean
): DeliveryView {
  const confirmation = confirmations.get(event.entityId);
  return {
    id: event.entityId,
    kind,
    orderId: text(after, orderKey) ?? text(state(event.requestMetadata), orderKey),
    lineId: text(after, lineKey),
    unit: requiredText(after, 'unit', '—'),
    deliveredQuantity: requiredText(after, 'deliveredQuantity', '—'),
    deliverySequence: numeric(after, 'deliverySequence'),
    deliveredAt: text(after, 'deliveredAt'),
    recordedAt: event.occurredAt,
    note: text(after, 'note'),
    confirmed: confirmation !== undefined,
    evidenceDocumentVersionId: confirmation?.evidenceDocumentVersionId ?? null,
    confirmedAt: confirmation?.confirmedAt ?? null,
    // deliveredQuantity is on every full answer and off the staff allowlist.
    detailsHidden: isFieldHiddenByRole(event, 'deliveredQuantity'),
    confirmationHidden: confirmation === undefined && confirmationsWithheld
  };
}

/**
 * Line events carry the parent order id in afterState (and in requestMetadata).
 * Matching through the events keeps the pairing exact even when only the
 * metadata recorded it.
 */
function isLineOfOrder(events: AuditEventView[], lineId: string, orderId: string): boolean {
  for (const event of events) {
    if (event.entityId !== lineId) continue;
    const after = state(event.afterState);
    const metadata = state(event.requestMetadata);
    return text(after, 'filmSupplyOrderId') === orderId
      || text(after, 'fillingOrderId') === orderId
      || text(metadata, 'filmSupplyOrderId') === orderId
      || text(metadata, 'fillingOrderId') === orderId;
  }
  return false;
}

interface RawDesignGate {
  designKey?: unknown;
  currentRevisionId?: unknown;
  currentRevisionNo?: unknown;
  fileSha256?: unknown;
  dualApproved?: unknown;
  customer?: unknown;
  seven?: unknown;
}

export async function loadApprovalGate(orderId: string): Promise<ApprovalGateView | null> {
  const result = await callApi<{
    orderId: string;
    orderStatus: string;
    dualApproved: unknown;
    missingApprovals: unknown;
    designs: unknown;
    pendingManualVerifications: unknown;
  }>(`/api/film-supply-orders/${encodeURIComponent(orderId)}/approval-gate`);
  if (!result.ok || !result.data) return null;
  const gate = result.data;
  const designs = Array.isArray(gate.designs) ? (gate.designs as RawDesignGate[]) : [];
  return {
    orderId: typeof gate.orderId === 'string' ? gate.orderId : orderId,
    orderStatus: typeof gate.orderStatus === 'string' ? gate.orderStatus : '—',
    dualApproved: gate.dualApproved === true,
    missingApprovals: Array.isArray(gate.missingApprovals)
      ? (gate.missingApprovals as unknown[])
          .filter(isRecord)
          .filter((entry) => typeof entry.designKey === 'string' && typeof entry.organization === 'string')
          .map((entry) => ({ designKey: entry.designKey as string, organization: entry.organization as string }))
      : [],
    designs: designs.map((design) => ({
      designKey: typeof design.designKey === 'string' ? design.designKey : '—',
      currentRevisionId: typeof design.currentRevisionId === 'string' ? design.currentRevisionId : '—',
      currentRevisionNo: typeof design.currentRevisionNo === 'number' ? design.currentRevisionNo : 0,
      fileSha256: typeof design.fileSha256 === 'string' ? design.fileSha256 : '—',
      customer: toOrganizationState(design.customer, 'customer'),
      seven: toOrganizationState(design.seven, 'seven'),
      dualApproved: design.dualApproved === true
    })),
    // The API answers this list to admin only; every other role receives an
    // empty array and the screen never renders a verification form.
    pendingManualVerifications: Array.isArray(gate.pendingManualVerifications)
      ? (gate.pendingManualVerifications as unknown[])
          .filter(isRecord)
          .filter((entry) => typeof entry.approvalEventId === 'string')
          .map((entry) => ({
            approvalEventId: entry.approvalEventId as string,
            revisionId: typeof entry.revisionId === 'string' ? entry.revisionId : '—',
            designKey: typeof entry.designKey === 'string' ? entry.designKey : '—',
            revisionNo: typeof entry.revisionNo === 'number' ? entry.revisionNo : 0,
            organization: typeof entry.organization === 'string' ? entry.organization : '—',
            evidenceDocumentVersionId: text(entry, 'evidenceDocumentVersionId'),
            evidenceIdentifier: text(entry, 'evidenceIdentifier'),
            approvedFileSha256: typeof entry.approvedFileSha256 === 'string' ? entry.approvedFileSha256 : '—',
            eventTime: typeof entry.eventTime === 'string' ? entry.eventTime : '—',
            recordedAt: typeof entry.recordedAt === 'string' ? entry.recordedAt : '—',
            manualVerification: toManualVerification(entry.manualVerification),
            evidenceIssuerEntity: text(entry, 'evidenceIssuerEntity'),
            expectedIssuerEntity: text(entry, 'expectedIssuerEntity'),
            issuerMatchesOrganization: typeof entry.issuerMatchesOrganization === 'boolean' ? entry.issuerMatchesOrganization : null,
            sharedEvidenceException: isRecord(entry.sharedEvidenceException)
              ? { reason: text(entry.sharedEvidenceException, 'reason') }
              : entry.sharedEvidenceException === true ? { reason: null } : null,
            // An older API without the field: 「確認」 stays offered and the API decides.
            confirmable: entry.confirmable !== false,
            sameContentUsedByOtherOrganization: entry.sameContentUsedByOtherOrganization === true,
            recordedAsPending: entry.recordedAsPending !== false
          }))
      : []
  };
}

function toManualVerification(value: unknown): OrganizationApprovalStateView['manualVerification'] {
  const record = state(isRecord(value) ? value : null);
  const result = text(record, 'result');
  if (!result) return null;
  return {
    result,
    verifierName: requiredText(record, 'verifierName', '—'),
    verifiedAt: requiredText(record, 'verifiedAt', '—'),
    recordedAt: requiredText(record, 'recordedAt', '—')
  };
}

function toOrganizationState(value: unknown, organization: string): OrganizationApprovalStateView {
  const record = state(isRecord(value) ? value : null);
  return {
    organization,
    valid: bool(record, 'valid'),
    latestDecision: text(record, 'latestDecision'),
    revoked: bool(record, 'revoked'),
    invalidatedByNewerRevision: bool(record, 'invalidatedByNewerRevision'),
    pendingEvidenceIdentifier: bool(record, 'pendingEvidenceIdentifier'),
    manualVerification: toManualVerification(record.manualVerification)
  };
}

// ---------------------------------------------------------------------------
// UI batch B (①): the project progress stepper and 「次にやること」. Pure
// functions over the already loaded Workspace — no extra API read.
// ---------------------------------------------------------------------------

/** Shown on every operator screen while no project is selected. */
export const NO_PROJECT_SELECTED_MESSAGE = 'まだ案件を選んでいません。画面上部の「案件」で作業する案件を選ぶと、この画面に内容が表示されます。';

/** Appended to the API's refusal when the remembered project cannot be opened. */
export const RESELECT_PROJECT_HINT = '上部の「案件」から選び直してください。';

/** Appended instead when the API answered 401 (the session is gone). */
export const RELOGIN_HINT = 'ログインし直してください。';

/** Where the role may not read the film order states (viewer). */
/** UI batch E (F-12): the selected project cannot be opened — the one thing to do next. */
export const PROJECT_UNAVAILABLE_MESSAGE = 'この案件は開けません。削除されたか、担当から外れた可能性があります。「案件を選び直す」を押して、開ける案件から選んでください。';

/** The way out of PROJECT_UNAVAILABLE_MESSAGE (forgets the project, then the dashboard offers the ones that open). */
export const RESELECT_PROJECT_LABEL = '案件を選び直す';

export const STATUS_HIDDEN_NOTICE = 'この役割では発注の状態は表示されません（閲覧権限なし）';

function normalStatusOrNull(status: string | null): string | null {
  return status !== null && (FILM_SUPPLY_ORDER_STATES as readonly string[]).includes(status) ? status : null;
}

/**
 * The order's status when the role may read it, else null. A withheld status
 * keeps the data layer's 'DRAFT' placeholder in `status`; every status branch
 * on the screens reads this helper so that placeholder is never taken as 下書き.
 */
export function knownStatus(order: Pick<FilmSupplyOrderView, 'status' | 'statusHidden'>): string | null {
  return order.statusHidden ? null : order.status;
}

/**
 * 「版3」, or 「版（閲覧権限なし）」 when the role may see the revision's binding
 * but not its number (staff since 62d9305), or 「版未記録」 — never a stand-in
 * number.
 */
export function revisionNumberText(revision: Pick<ArtworkRevisionView, 'revisionNo' | 'revisionNoHidden'>): string {
  if (revision.revisionNo !== null) return `版${revision.revisionNo}`;
  return revision.revisionNoHidden ? `版（${HIDDEN_BY_ROLE_SHORT}）` : '版未記録';
}

/** 「code（状態）」 of a film order for selects and headings. */
export function filmOrderChoiceLabel(
  order: Pick<FilmSupplyOrderView, 'code' | 'status' | 'statusHidden'>,
  stateLabel: (key: string) => string
): string {
  const status = knownStatus(order);
  return codeWithStatus(order.code, status === null ? null : stateLabel(status));
}

/** The eight steps of one film order, in business order. */
export const PROGRESS_STEPS = [
  '発注書確認',
  'デザイン受領',
  '校正・校了',
  '発注書・代表承認',
  'メーカーへ送信',
  '受入確認',
  '生産・出荷',
  '納品・受領'
] as const;

/**
 * The current step of each state (index into PROGRESS_STEPS). The terminal
 * state is past the last step (every step done); the exception states have no
 * current step of their own — the step they interrupted comes from
 * lastNormalStatus.
 */
export const STATUS_PROGRESS_STEP: Readonly<Record<FilmSupplyOrderState, number | null>> = {
  DRAFT: 0,
  SEVEN_PO_VERIFIED: 1,
  ARTWORK_RECEIVED: 2,
  PROOF_READY: 2,
  APPROVAL_PENDING: 2,
  DUAL_APPROVED: 3,
  MAKER_PO_READY: 3,
  APPROVED_FOR_MANUAL_SEND: 4,
  MAKER_PO_SENT_MANUALLY: 5,
  MAKER_PO_ACCEPTED: 6,
  FILM_IN_PRODUCTION: 6,
  FILM_SHIPPED: 6,
  FILM_DELIVERED: 7,
  FILM_RECEIPT_ASSUMED_NO_ISSUE: 8,
  ON_HOLD: null,
  CHANGE_REVIEW: null,
  CANCELLATION_REVIEW: null
};

export type ProgressStepMark = 'done' | 'current' | 'interrupted' | 'upcoming' | 'unmarked';

export interface OrderProgress {
  /** hidden: the role may not read the status; unknown: a status the table does not name. */
  phase: 'hidden' | 'unknown' | 'active' | 'exception' | 'complete' | 'cancelled';
  status: string | null;
  currentStep: number | null;
  interruptedStep: number | null;
  marks: ProgressStepMark[];
}

function stepOf(status: string): number | null | undefined {
  return (STATUS_PROGRESS_STEP as Readonly<Record<string, number | null>>)[status];
}

function marksUpTo(step: number, at: ProgressStepMark): ProgressStepMark[] {
  return PROGRESS_STEPS.map((_, index) => (index < step ? 'done' : index === step ? at : 'upcoming'));
}

export function orderProgress(
  order: Pick<FilmSupplyOrderView, 'status' | 'statusHidden' | 'lastNormalStatus'>
): OrderProgress {
  const status = knownStatus(order);
  const unmarked = PROGRESS_STEPS.map((): ProgressStepMark => 'unmarked');
  if (status === null) {
    return { phase: 'hidden', status: null, currentStep: null, interruptedStep: null, marks: unmarked };
  }
  // CANCELLATION_REVIEW resolved as cancel ends the order (取消済): no
  // step is current or done any more, and it is not an unknown status.
  if (status === FILM_ORDER_CANCELLATION_STATE) {
    return { phase: 'cancelled', status, currentStep: null, interruptedStep: null, marks: unmarked };
  }
  const step = stepOf(status);
  if (step === undefined) {
    return { phase: 'unknown', status, currentStep: null, interruptedStep: null, marks: unmarked };
  }
  if (step === null) {
    const left = order.lastNormalStatus ? stepOf(order.lastNormalStatus) : null;
    const interrupted = typeof left === 'number' && left < PROGRESS_STEPS.length ? left : null;
    return {
      phase: 'exception',
      status,
      currentStep: null,
      interruptedStep: interrupted,
      marks: interrupted === null
        ? PROGRESS_STEPS.map((): ProgressStepMark => 'upcoming')
        : marksUpTo(interrupted, 'interrupted')
    };
  }
  if (step >= PROGRESS_STEPS.length) {
    return {
      phase: 'complete',
      status,
      currentStep: null,
      interruptedStep: null,
      marks: PROGRESS_STEPS.map((): ProgressStepMark => 'done')
    };
  }
  return { phase: 'active', status, currentStep: step, interruptedStep: null, marks: marksUpTo(step, 'current') };
}

/** Orders split for the stepper: in progress, completed (folded), and status withheld. */
export function groupOrdersForProgress(orders: FilmSupplyOrderView[]): {
  active: FilmSupplyOrderView[];
  completed: FilmSupplyOrderView[];
  hidden: FilmSupplyOrderView[];
} {
  const hidden = orders.filter((order) => knownStatus(order) === null);
  const completed = orders.filter((order) => knownStatus(order) === FILM_SUPPLY_ORDER_TERMINAL_STATE);
  const active = orders.filter((order) => {
    const status = knownStatus(order);
    return status !== null && status !== FILM_SUPPLY_ORDER_TERMINAL_STATE;
  });
  return { active, completed, hidden };
}

export type ScreenPath = '/orders' | '/documents' | '/approvals' | '/maker-po' | '/deliveries';

/** The screen names the 「○○画面を開く」 links use (same order as the menu). */
export const SCREEN_NAMES: Readonly<Record<ScreenPath, string>> = {
  '/orders': '発注',
  '/documents': '文書',
  '/approvals': '承認',
  '/maker-po': 'メーカー発注',
  '/deliveries': '納品確認'
};

export const OWNER_STAFF_AND_ADMIN = '担当者・代表者';
export const OWNER_ADMIN = '代表者';

export interface NextActionView {
  /** One sentence: what to do next. */
  text: string;
  /** Who does it, or null when nothing is left to do. */
  owner: string | null;
  /** Where it is done (first = main screen). */
  screens: ScreenPath[];
  operation: Operation | null;
  /** Why the signed-in role cannot do it (display only; the API decides). */
  refusal: string | null;
}

type NextActionWorkspace = Pick<Workspace, 'labels' | 'sevenPurchaseOrders' | 'revisions'>
  & Partial<Pick<Workspace, 'revisionsWithheld' | 'makerPaperCleanup'>>;

/**
 * Recheck 8 Low-9: live paper the screen cannot cancel (送信未確認, 受入済み) —
 * the API refuses the cancel, so the copy must not ask for one. The maker
 * contact is the representative's call.
 */
export function uncancellableLivePapers(work: MakerPaperCleanupSummary): number {
  return Math.max(0, work.livePapers - work.cancellablePapers);
}

/**
 * Recheck 8 Low-9: the action sentence for a closed order's maker cleanup,
 * naming only the records the API will take (取り消し for cancellable paper,
 * 取り消し承認 for an owed one) and the maker contact for the rest.
 */
export function makerCleanupRecords(work: MakerPaperCleanupSummary): string[] {
  return [
    work.cancellablePapers > 0 ? '発注書の取り消し' : null,
    work.acknowledgementPapers > 0 ? '取り消し承認' : null
  ].filter((part): part is string => part !== null);
}

export function makerCleanupActionText(work: MakerPaperCleanupSummary): string {
  const records = makerCleanupRecords(work);
  const stuck = uncancellableLivePapers(work) > 0
    ? '取り消せない発注書（送信未確認・受入済み）は、メーカーへの連絡と対応を代表者が判断する。'
    : '';
  return records.length > 0
    ? `発注の画面の「その他の操作」で${records.join('・')}を記録する。${stuck}`
    : stuck;
}

/** 「取り消されていない発注書 1件・取り消し承認が未記録の発注書 1件」. */
function cleanupParts(cleanup: MakerPaperCleanupSummary): string {
  const parts = [
    cleanup.livePapers > 0
      ? `取り消されていない発注書 ${cleanup.livePapers}件${uncancellableLivePapers(cleanup) > 0
        ? `（うち取り消せない発注書 ${uncancellableLivePapers(cleanup)}件）`
        : ''}`
      : null,
    cleanup.acknowledgementPapers > 0 ? `取り消し承認が未記録の発注書 ${cleanup.acknowledgementPapers}件` : null
  ].filter((part): part is string => part !== null);
  return parts.join('・');
}

/** For a frozen order: the maker cleanup the representative may record before the release. */
function frozenCleanupLine(cleanup: MakerPaperCleanupSummary | undefined): string {
  return cleanup?.state === 'cleanup'
    ? `（メーカー発注書の整理が残っています: ${cleanupParts(cleanup)}。解除の前でも、発注の画面の「その他の操作」で取り消し・取り消し承認を記録できます）`
    : '';
}

function nextAction(
  text: string,
  owner: string,
  screens: ScreenPath[],
  operation: Operation,
  role: string | null | undefined
): NextActionView {
  return { text, owner, screens, operation, refusal: operationRefusal(role, operation) };
}

/**
 * UI batch E (F-05): what to do with a film order created without its セブン化学
 * 発注書. The link is chosen only at creation (no endpoint adds it later), so the
 * order is made again with the PO and the old one is ended.
 */
export const UNLINKED_ORDER_REMEDY = (label: (key: string) => string): string =>
  `紐付けは作成のときだけ選べます。発注画面の「フィルム発注を作成する」で発注書を選んで作り直し、この発注は「${label('CANCELLATION_REVIEW')}」から取消で終了してください`;

function draftNextAction(
  order: FilmSupplyOrderView,
  workspace: NextActionWorkspace,
  advance: (to: string) => string,
  label: (key: string) => string,
  role: string | null | undefined
): NextActionView {
  const both = OWNER_STAFF_AND_ADMIN;
  const general = nextAction(
    `セブン化学発注書の本登録と発注書の照合チェックを済ませ、${advance('SEVEN_PO_VERIFIED')}。`,
    both, ['/orders'], 'film_order:transition', role
  );
  // Staff and viewer do not read the order's PO link. UI batch E (F-05, T2):
  // when every PO the role can see is already registered and verified, the
  // general step would ask again for work that is done — so say the transition
  // and the one cause left (the order has no PO link), the same cause the
  // representative reads.
  if (order.detailsHidden) {
    const pos = workspace.sevenPurchaseOrders;
    const allReady = pos.length > 0
      && pos.every((po) => po.officiallyRegistered && po.verificationStatus === 'verified' && !po.reviewPending);
    return allReady
      ? nextAction(
        `${advance('SEVEN_PO_VERIFIED')}。進められないときは、この発注がセブン化学発注書に紐付いていません（${UNLINKED_ORDER_REMEDY(label)}）。`,
        both, ['/orders'], 'film_order:transition', role
      )
      : general;
  }
  if (!order.sevenPurchaseOrderId) {
    return nextAction(
      `この発注はセブン化学発注書に紐付いていないため、「${label('SEVEN_PO_VERIFIED')}」へ進められません。${UNLINKED_ORDER_REMEDY(label)}。`,
      both, ['/orders'], 'film_order:create', role
    );
  }
  const po = workspace.sevenPurchaseOrders.find((candidate) => candidate.id === order.sevenPurchaseOrderId);
  if (!po) return general;
  const name = po.poNumberHidden ? 'セブン化学発注書' : `セブン化学発注書（${po.poNumber}）`;
  if (!po.officiallyRegistered && !po.officialRegistrationHidden) {
    return nextAction(`${name}の本登録日を記録する。`, both, ['/orders'], 'seven_po:register', role);
  }
  if (!po.verificationHidden && po.verificationStatus !== 'verified') {
    return nextAction(`${name}の発注書の照合チェックを記録し、確認済みにする。`, both, ['/orders'], 'seven_po:verify', role);
  }
  if (po.officiallyRegistered && po.verificationStatus === 'verified') {
    return nextAction(`${advance('SEVEN_PO_VERIFIED')}。`, both, ['/orders'], 'film_order:transition', role);
  }
  return general;
}

/** P4 M5: the proof registration moves the order on by itself — never 「状態を「校正準備完了」へ進める」. */
const AUTO_PROOF_TEXT = '校正ゲラを登録すると自動で進みます。進んでいないときは、発注の画面で理由を確認してください。';

/** 「次にやること」 of one film order for the signed-in role. */
export function nextActionForOrder(
  order: FilmSupplyOrderView,
  workspace: NextActionWorkspace,
  role: string | null | undefined
): NextActionView {
  const label = labelLookup(workspace.labels, 'filmSupplyOrderStates');
  const advance = (to: string) => `状態を「${label(to)}」へ進める`;
  const both = OWNER_STAFF_AND_ADMIN;
  const status = knownStatus(order);
  if (status === null) {
    return {
      text: '発注の状態が閲覧権限なしのため、次の作業は表示できません。',
      owner: null,
      screens: [],
      operation: null,
      refusal: operationRefusal(role, 'film_order:transition')
    };
  }
  switch (status) {
    case 'DRAFT':
      return draftNextAction(order, workspace, advance, label, role);
    case 'SEVEN_PO_VERIFIED':
      return nextAction(
        `デザイン入稿データを発注の画面（手順4）で登録し、${advance('ARTWORK_RECEIVED')}。`,
        both, ['/documents', '/orders'], 'document:create', role
      );
    case 'ARTWORK_RECEIVED':
      if (workspace.revisions.some((revision) => revision.filmSupplyOrderId === order.id)) {
        return nextAction(AUTO_PROOF_TEXT, both, ['/orders'], 'film_order:transition', role);
      }
      // Revisions exist whose order link the role may not read: one of them may
      // be this order's, so never claim the proof is still missing.
      return (workspace.revisionsWithheld ?? 0) > 0
        ? nextAction(
          `校正ゲラの版が登録されていることを発注の画面で確かめます。${AUTO_PROOF_TEXT}`,
          both, ['/approvals', '/orders'], 'film_order:transition', role
        )
        : nextAction(
          `校正ゲラを発注の画面（手順5）で登録します。登録すると自動で進みます。`,
          both, ['/approvals', '/orders'], 'artwork_revision:create', role
        );
    case 'PROOF_READY':
      return nextAction(`校正ゲラの登録で自動で進みます。進んでいないときは、発注の画面で理由を確認してください。`, both, ['/orders'], 'film_order:transition', role);
    case 'APPROVAL_PENDING':
      return nextAction(
        `顧客とセブン化学の承認（校了）を発注の画面（手順6）で記録する。両方そろうと自動で「${label('DUAL_APPROVED')}」になります。`,
        both, ['/approvals'], 'artwork_approval:record', role
      );
    case 'DUAL_APPROVED':
      return nextAction(`「${label('MAKER_PO_READY')}」へは自動で進みます（支払条件が決まっていること）。進んでいないときは、発注の画面で理由を確認してください。`, both, ['/orders'], 'film_order:transition', role);
    case 'MAKER_PO_READY':
      // P-6 (P1 integration): staff (or the representative) draft the paper; the 代表承認 stays the representative's.
      return nextAction('メーカー発注書（下書き）を作成する。作成後に代表が承認します。', OWNER_STAFF_AND_ADMIN, ['/maker-po'], 'maker_po:create', role);
    case 'APPROVED_FOR_MANUAL_SEND':
      return nextAction(
        'メーカーへの送信を記録する（送信済みメールの原本EMLを使います）。',
        both, ['/maker-po'], 'maker_po:send_evidence', role
      );
    case 'MAKER_PO_SENT_MANUALLY':
      // UI batch E (F-10): the final confirmation waits for a checked 受領証跡 —
      // say so to the staff member who records the provisional one.
      return nextAction(
        'メーカーの受入を記録する（担当者が仮の記録と受領証跡の登録、代表者が受領証跡を確認して最終確認）。',
        both, ['/maker-po', '/documents'], 'maker_po:accept_provisional', role
      );
    case 'MAKER_PO_ACCEPTED':
      return nextAction(`${advance('FILM_IN_PRODUCTION')}。`, both, ['/orders'], 'film_order:transition', role);
    case 'FILM_IN_PRODUCTION':
      return nextAction(`出荷されたら、${advance('FILM_SHIPPED')}。`, both, ['/orders'], 'film_order:transition', role);
    case 'FILM_SHIPPED':
      return nextAction(
        `納品を記録し、${advance('FILM_DELIVERED')}。`,
        both, ['/deliveries', '/orders'], 'film_delivery:create', role
      );
    case 'FILM_DELIVERED':
      return nextAction(
        '問題なしで完了を記録するか、受領証跡を引用して納品を確認する。',
        both, ['/orders', '/deliveries'], 'film_order:assume_receipt', role
      );
    case FILM_SUPPLY_ORDER_TERMINAL_STATE:
      return { text: 'この発注は完了しています。', owner: null, screens: [], operation: null, refusal: null };
    // Hold and cancellation review are left only through their admin-only
    // endpoints (reason required); the server resumes the state the order
    // left, so the screen names no target. No /maker-po link: a held order is
    // not on the maker PO board (B-M1).
    // Low-7 (b): a hold whose maker paper was all cancelled meanwhile resumes at
    // MAKER_PO_READY, not at the maker step it left (server hold-release).
    case 'ON_HOLD': {
      const cleanup = workspace.makerPaperCleanup?.[order.id];
      // UI batch E (F-11): the representative reads why the order was held.
      const why = order.hold?.reason ? `保留の理由は「${order.hold.reason}」です。` : '';
      return nextAction(
        `${why}代表者が理由を記録して保留を解除する（原則として保留にする前の状態に戻ります。保留中にその段階のメーカー発注書が取り消され、残っている発注書がない場合は「${label('MAKER_PO_READY')}」に戻ります）。${frozenCleanupLine(cleanup)}`,
        OWNER_ADMIN, cleanup?.state === 'cleanup' ? ['/orders', '/maker-po'] : ['/orders'], 'film_order:release_hold', role
      );
    }
    case 'CANCELLATION_REVIEW': {
      const cleanup = workspace.makerPaperCleanup?.[order.id];
      return nextAction(
        `代表者が理由を記録して取消確認を処理する（再開するか、取消で終了するか）。${frozenCleanupLine(cleanup)}`,
        OWNER_ADMIN, cleanup?.state === 'cleanup' ? ['/orders', '/maker-po'] : ['/orders'],
        'film_order:resolve_cancellation_review', role
      );
    }
    case 'CHANGE_REVIEW': {
      const cleanup = workspace.makerPaperCleanup?.[order.id];
      return nextAction(
        `再開する状態を選んで、状態を進める。${frozenCleanupLine(cleanup)}`,
        both, cleanup?.state === 'cleanup' ? ['/orders', '/maker-po'] : ['/orders'], 'film_order:transition', role
      );
    }
    // Medium-3: 「これ以上の作業はありません」 only when the maker paper is known
    // to be settled — a cancelled order can keep live paper the maker may produce.
    case FILM_ORDER_CANCELLATION_STATE: {
      const cleanup = workspace.makerPaperCleanup?.[order.id];
      if (cleanup?.state === 'none') {
        return { text: 'この発注は取消で終了しています。これ以上の作業はありません。', owner: null, screens: [], operation: null, refusal: null };
      }
      if (cleanup?.state === 'cleanup') {
        return nextAction(
          `この発注は取消で終了していますが、メーカー発注書の整理が残っています（${cleanupParts(cleanup)}）。${makerCleanupActionText(cleanup)}`,
          OWNER_ADMIN, ['/maker-po'], 'maker_po:cancel', role
        );
      }
      return {
        text: 'この発注は取消で終了しています。メーカー発注書の整理（取り消し・取り消し承認）が残っていないかは、発注の画面で確認してください。',
        owner: null,
        screens: ['/maker-po'],
        operation: null,
        refusal: null
      };
    }
    default:
      return {
        text: `この状態（${label(status)}）の次の作業は画面に表示できません。`,
        owner: null,
        screens: [],
        operation: null,
        refusal: null
      };
  }
}

/** 「次にやること」 of a project without a film order yet. */
export function nextActionWithoutOrders(
  workspace: Pick<Workspace, 'sevenPurchaseOrders'>,
  role: string | null | undefined
): NextActionView {
  return workspace.sevenPurchaseOrders.length === 0
    ? nextAction('セブン化学発注書を登録する。', OWNER_STAFF_AND_ADMIN, ['/orders'], 'seven_po:create', role)
    : nextAction('フィルム発注を作成する。', OWNER_STAFF_AND_ADMIN, ['/orders'], 'film_order:create', role);
}
