import { callApi } from './api';
import { displayText, HIDDEN_BY_ROLE_LABEL, HIDDEN_BY_ROLE_SHORT, isFieldHiddenByRole, isStateWithheld } from './redaction';
import { formatTimestamp } from './vocabulary';

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
 * PO number is named as withheld and the short id keeps the choices apart; the
 * registration part says what is known — 公式登録済み (date visible, or the
 * registration action seen), 未登録 only when the API shows the PO unregistered,
 * and 閲覧権限なし when the role may not read it. Never 「（閲覧権限なし）（未登録）」.
 */
export function sevenPurchaseOrderChoiceLabel(po: SevenPurchaseOrderView): string {
  const number = po.poNumberHidden
    ? `発注番号 ${HIDDEN_BY_ROLE_SHORT}・ID ${po.id.slice(0, 8)}…`
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
  sha256: string;
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
  /** UI batch A: type, issuer and links were withheld from the role (staff/viewer). */
  detailsHidden: boolean;
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
  revisionNo: number;
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
    return { project: null, error: result.error ?? `案件が取得できませんでした（${result.status}）。` };
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

export async function loadWorkspace(projectId: string): Promise<Workspace> {
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
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt
      });
    } else if (event.action === 'FILM_SUPPLY_ORDER_TRANSITIONED') {
      const current = filmOrders.get(event.entityId);
      if (current) {
        current.status = requiredText(state(event.afterState), 'status', current.status);
        current.statusHidden = isStateWithheld(event);
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
        // documentType is on every full answer and off the staff allowlist.
        detailsHidden: isFieldHiddenByRole(event, 'documentType'),
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
      sha256: requiredText(after, 'sha256', '—'),
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
      revisionNo: numeric(after, 'revisionNo') ?? 1,
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

  return {
    error: firstError,
    project: projectResult.project,
    labels: labelResult.labels,
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
