import {
  FILM_ORDER_CANCELLATION_STATE,
  FILM_SUPPLY_ORDER_EXCEPTION_STATES as EXCEPTION_ORDER_STATES,
  FILM_SUPPLY_ORDER_STATES,
  FILM_SUPPLY_ORDER_TERMINAL_STATE
} from '@kanei/core';
import type { FilmSupplyOrderState, Operation } from '@kanei/core';
import { callApi } from './api';
import { operationRefusal } from './permissions';
import { shortId } from './short-id';
import { codeWithStatus, displayText, HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT, isFieldHiddenByRole, isStateWithheld } from './redaction';
import { formatTimestamp } from './vocabulary';
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
  createdAt: string;
  updatedAt: string;
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
  /** The recorded 公式登録日 — only ever the API's own value, never a stand-in. */
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
 * registration part says what is known — 公式登録済み (date visible, or the
 * registration action seen), 未登録 only when the API shows the PO unregistered,
 * and 閲覧権限なし when the role may not read it. Never 「（閲覧権限なし）（未登録）」.
 */
export function sevenPurchaseOrderChoiceLabel(po: SevenPurchaseOrderView): string {
  const number = po.poNumberHidden
    ? `発注番号 ${HIDDEN_BY_ROLE_SHORT}・ID ${shortId(po.id)}`
    : po.poNumber;
  const registration = po.officiallyRegistered
    ? '公式登録済み'
    : po.officialRegistrationHidden
      ? `登録状況 ${HIDDEN_BY_ROLE_SHORT}`
      : '未登録';
  return `${number}（${registration}）`;
}

/**
 * The 公式登録 cell: the recorded date when the API sent it; 「公式登録済み」 with
 * the date named as withheld when the role saw only the registration action;
 * 「閲覧権限なし」 when the role cannot tell; 未登録 only when shown unregistered.
 */
export function officialRegistrationText(po: SevenPurchaseOrderView): string {
  if (po.officialRegisteredAt) return formatTimestamp(po.officialRegisteredAt);
  if (po.officiallyRegistered) {
    return po.officialRegistrationHidden
      ? `公式登録済み（登録日は${HIDDEN_BY_ROLE_SHORT}）`
      : '公式登録済み（登録日未記録）';
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
  /** UI batch A: issuer and links were withheld from the role (staff/viewer). */
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
  entityType: string
): Promise<{ events: AuditEventView[]; error: string | null }> {
  const result = await callApi<{ events: AuditEventView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/audit-history?entityType=${encodeURIComponent(entityType)}&limit=500`
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
  return (key: string) => map.get(key) ?? key;
}

async function loadProject(projectId: string): Promise<{ project: ProjectView | null; error: string | null }> {
  const result = await callApi<ProjectView>(`/api/projects/${encodeURIComponent(projectId)}`);
  if (!result.ok || !result.data) {
    const reason = result.error ?? `案件が取得できませんでした（${result.status}）。`;
    // UI batch B (②): a remembered project the API no longer opens (404 等)
    // says what to do next; the API's own wording stays first, unchanged.
    // A lost session (401) is not a project problem: ask for a new login.
    const hint = result.status === 401
      ? RELOGIN_HINT
      : result.status >= 400 && result.status < 500 ? RESELECT_PROJECT_HINT : null;
    return { project: null, error: hint ? `${reason} ${hint}` : reason };
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
  const result = await callApi<{ projects: ProjectSummary[] }>('/api/projects');
  if (!result.ok || !result.data) return [];
  return Array.isArray(result.data.projects) ? result.data.projects : [];
}

export async function loadWorkspace(
  projectId: string,
  options: { makerPaperCleanup?: boolean } = {}
): Promise<Workspace> {
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
      loadEvents(projectId, 'document_version'),
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
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt
      });
    } else if (
      event.action === 'FILM_SUPPLY_ORDER_TRANSITIONED'
      // UI batch B: the 受領確認 (receipt assumption) moves the order into the
      // terminal state through its own action, recorded on the same entity.
      || event.action === 'FILM_RECEIPT_ASSUMPTION_RECORDED'
      // UI batch D: the admin-only hold release and cancellation review
      // resolution record their own actions (afterState.status is the state
      // resumed, or CANCELLED); without them a released order kept reading
      // 保留中 and a cancelled one キャンセルレビュー中.
      || event.action === 'FILM_SUPPLY_ORDER_HOLD_RELEASED'
      || event.action === 'FILM_SUPPLY_ORDER_CANCELLATION_REVIEW_RESOLVED'
    ) {
      const current = filmOrders.get(event.entityId);
      if (current) {
        current.status = requiredText(state(event.afterState), 'status', current.status);
        current.statusHidden = isStateWithheld(event);
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
        // issuerEntity is on every full answer and off the staff allowlist
        // (documentType joined the staff allowlist in 62d9305, so it no longer
        // tells a trimmed answer apart).
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
    const after = state(event.afterState);
    const documentId = text(after, 'documentId') ?? text(state(event.requestMetadata), 'documentId');
    if (!documentId && isFieldHiddenByRole(event, 'documentId')) documentVersionsWithheld = true;
    const current = documentId ? documents.get(documentId) : undefined;
    if (!current || !documentId) continue;
    current.versions.push({
      id: event.entityId,
      documentId,
      versionNumber: numeric(after, 'versionNumber') ?? current.versions.length + 1,
      sha256: text(after, 'sha256'),
      sha256Hidden: isFieldHiddenByRole(event, 'sha256'),
      originalFilename: requiredText(after, 'originalFilename', current.filename),
      createdAt: event.occurredAt
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
    ? await (await import('./maker-po-data')).loadMakerPaperCleanup(projectId, closedOrderIds)
    : {};

  return {
    error: firstError,
    project: projectResult.project,
    labels: labelResult.labels,
    makerPaperCleanup,
    filmOrders: [...filmOrders.values()],
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
            manualVerification: toManualVerification(entry.manualVerification)
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
export const NO_PROJECT_SELECTED_MESSAGE = '案件が選択されていません。画面上部の「案件」から選んでください。';

/** Appended to the API's refusal when the remembered project cannot be opened. */
export const RESELECT_PROJECT_HINT = '上部の「案件」から選び直してください。';

/** Appended instead when the API answered 401 (the session is gone). */
export const RELOGIN_HINT = 'ログインし直してください。';

/** Where the role may not read the film order states (viewer). */
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
  // CANCELLATION_REVIEW resolved as cancel ends the order (キャンセル終了): no
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

/** 「取り消されていない発注書 1件・取り消し承認が未記録の発注書 1件」. */
function cleanupParts(cleanup: MakerPaperCleanupSummary): string {
  const parts = [
    cleanup.livePapers > 0 ? `取り消されていない発注書 ${cleanup.livePapers}件` : null,
    cleanup.acknowledgementPapers > 0 ? `取り消し承認が未記録の発注書 ${cleanup.acknowledgementPapers}件` : null
  ].filter((part): part is string => part !== null);
  return parts.join('・');
}

/** For a frozen order: the maker cleanup the representative may record before the release. */
function frozenCleanupLine(cleanup: MakerPaperCleanupSummary | undefined): string {
  return cleanup?.state === 'cleanup'
    ? `（メーカー発注書の整理が残っています: ${cleanupParts(cleanup)}。解除の前でも、メーカー発注画面で取り消し・取り消し承認を記録できます）`
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

function draftNextAction(
  order: FilmSupplyOrderView,
  workspace: NextActionWorkspace,
  advance: (to: string) => string,
  label: (key: string) => string,
  role: string | null | undefined
): NextActionView {
  const both = OWNER_STAFF_AND_ADMIN;
  const general = nextAction(
    `セブン化学発注書の公式登録と真性行チェックリストを済ませ、${advance('SEVEN_PO_VERIFIED')}。`,
    both, ['/orders'], 'film_order:transition', role
  );
  // Staff and viewer do not read the order's PO link: say the general step.
  if (order.detailsHidden) return general;
  if (!order.sevenPurchaseOrderId) {
    return nextAction(
      `この発注はセブン化学発注書に紐付いていないため、「${label('SEVEN_PO_VERIFIED')}」へ進められません。発注書を選んでフィルム発注を作成してください。`,
      both, ['/orders'], 'film_order:create', role
    );
  }
  const po = workspace.sevenPurchaseOrders.find((candidate) => candidate.id === order.sevenPurchaseOrderId);
  if (!po) return general;
  const name = po.poNumberHidden ? 'セブン化学発注書' : `セブン化学発注書（${po.poNumber}）`;
  if (!po.officiallyRegistered && !po.officialRegistrationHidden) {
    return nextAction(`${name}の公式登録日を記録する。`, both, ['/orders'], 'seven_po:register', role);
  }
  if (!po.verificationHidden && po.verificationStatus !== 'verified') {
    return nextAction(`${name}の真性行チェックリストを記録し、確認済みにする。`, both, ['/orders'], 'seven_po:verify', role);
  }
  if (po.officiallyRegistered && po.verificationStatus === 'verified') {
    return nextAction(`${advance('SEVEN_PO_VERIFIED')}。`, both, ['/orders'], 'film_order:transition', role);
  }
  return general;
}

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
        `デザイン入稿データを文書画面で登録し、${advance('ARTWORK_RECEIVED')}。`,
        both, ['/documents', '/orders'], 'document:create', role
      );
    case 'ARTWORK_RECEIVED':
      if (workspace.revisions.some((revision) => revision.filmSupplyOrderId === order.id)) {
        return nextAction(`${advance('PROOF_READY')}。`, both, ['/orders'], 'film_order:transition', role);
      }
      // Revisions exist whose order link the role may not read: one of them may
      // be this order's, so never claim the proof is still missing.
      return (workspace.revisionsWithheld ?? 0) > 0
        ? nextAction(
          `校正ゲラの版が承認画面に登録されていることを確かめて、${advance('PROOF_READY')}。`,
          both, ['/approvals', '/orders'], 'film_order:transition', role
        )
        : nextAction(
          `校正ゲラの版を承認画面で登録し、${advance('PROOF_READY')}。`,
          both, ['/approvals', '/orders'], 'artwork_revision:create', role
        );
    case 'PROOF_READY':
      return nextAction(`${advance('APPROVAL_PENDING')}。`, both, ['/orders'], 'film_order:transition', role);
    case 'APPROVAL_PENDING':
      return nextAction(
        `顧客とセブン化学の承認（校了）を承認画面で記録する。両方そろうと自動で「${label('DUAL_APPROVED')}」になります。`,
        both, ['/approvals'], 'artwork_approval:record', role
      );
    case 'DUAL_APPROVED':
      return nextAction(`${advance('MAKER_PO_READY')}。`, both, ['/orders'], 'film_order:transition', role);
    case 'MAKER_PO_READY':
      return nextAction('メーカー発注書を作成し、代表承認を記録する。', OWNER_ADMIN, ['/maker-po'], 'maker_po:create', role);
    case 'APPROVED_FOR_MANUAL_SEND':
      return nextAction(
        'メーカーへの送信を記録する（送信済みメールの原本EMLを使います）。',
        both, ['/maker-po'], 'maker_po:send_evidence', role
      );
    case 'MAKER_PO_SENT_MANUALLY':
      return nextAction(
        'メーカーの受入を記録する（担当者が仮の記録、代表者が最終確認）。',
        both, ['/maker-po'], 'maker_po:accept_provisional', role
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
        '受領確認（問題なしとみなす）を記録するか、受領証跡を引用して納品を確認する。',
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
      return nextAction(
        `代表者が理由を記録して保留を解除する（原則として保留にする前の状態に戻ります。保留中にその段階のメーカー発注書が取り消され、残っている発注書がない場合は「${label('MAKER_PO_READY')}」に戻ります）。${frozenCleanupLine(cleanup)}`,
        OWNER_ADMIN, cleanup?.state === 'cleanup' ? ['/orders', '/maker-po'] : ['/orders'], 'film_order:release_hold', role
      );
    }
    case 'CANCELLATION_REVIEW': {
      const cleanup = workspace.makerPaperCleanup?.[order.id];
      return nextAction(
        `代表者が理由を記録して取消レビューを処理する（再開するか、取消で終了するか）。${frozenCleanupLine(cleanup)}`,
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
          `この発注は取消で終了していますが、メーカー発注書の整理が残っています（${cleanupParts(cleanup)}）。メーカー発注画面で発注書の取り消し・取り消し承認を記録する。`,
          OWNER_ADMIN, ['/maker-po'], 'maker_po:cancel', role
        );
      }
      return {
        text: 'この発注は取消で終了しています。メーカー発注書の整理（取り消し・取り消し承認）が残っていないかは、メーカー発注画面で確認してください。',
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
