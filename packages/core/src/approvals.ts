import type { DocumentType } from './documents.js';

/**
 * M3 proof revisions and dual approval (design sections 5.7 and 6.1).
 *
 * An approval is a recorded external fact, never an inferred one: an internal
 * user records that an external approver of one organization decided something
 * about one exact revision of one design, and attaches the evidence document
 * version that proves it. Everything else in this module is derived from those
 * append-only events.
 *
 * The derived rules this module owns:
 * - a valid approval for an organization exists only while the latest effective
 *   event for that organization on the current revision is an uncanceled
 *   APPROVE whose approved_file_sha256 equals the current revision hash;
 * - approval never transfers across revisions: events are scoped to the
 *   revision they name, and a new revision starts with zero approvals;
 * - dual approval for an order means every required design (every design with
 *   at least one registered revision) holds both a valid customer and a valid
 *   seven approval — the order in which the two organizations approved is
 *   irrelevant.
 */

export const APPROVAL_ORGANIZATIONS = ['customer', 'seven'] as const;
export type ApprovalOrganization = (typeof APPROVAL_ORGANIZATIONS)[number];

export const APPROVAL_DECISIONS = ['APPROVE', 'REVOKE'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const APPROVAL_EVIDENCE_SOURCES = ['email', 'signed_document', 'other_verified'] as const;
export type ApprovalEvidenceSource = (typeof APPROVAL_EVIDENCE_SOURCES)[number];

/** The two organizations whose approvals the artwork gate requires. */
export const REQUIRED_APPROVAL_ORGANIZATIONS: readonly ApprovalOrganization[] = APPROVAL_ORGANIZATIONS;

export type OrganizationValidation<T extends string> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

export function validateApprovalOrganization(value: unknown): OrganizationValidation<ApprovalOrganization> {
  if (typeof value !== 'string' || !(APPROVAL_ORGANIZATIONS as readonly string[]).includes(value)) {
    return {
      ok: false,
      code: 'UNKNOWN_APPROVAL_ORGANIZATION',
      message: `organization must be one of ${APPROVAL_ORGANIZATIONS.join(', ')}; received ${String(value)}`
    };
  }
  return { ok: true, value: value as ApprovalOrganization };
}

export function validateApprovalDecision(value: unknown): OrganizationValidation<ApprovalDecision> {
  if (typeof value !== 'string' || !(APPROVAL_DECISIONS as readonly string[]).includes(value)) {
    return {
      ok: false,
      code: 'UNKNOWN_APPROVAL_DECISION',
      message: `decision must be one of ${APPROVAL_DECISIONS.join(', ')}; received ${String(value)}`
    };
  }
  return { ok: true, value: value as ApprovalDecision };
}

export function validateApprovalEvidenceSource(value: unknown): OrganizationValidation<ApprovalEvidenceSource> {
  if (typeof value !== 'string' || !(APPROVAL_EVIDENCE_SOURCES as readonly string[]).includes(value)) {
    return {
      ok: false,
      code: 'UNKNOWN_EVIDENCE_SOURCE',
      message: `evidenceSource must be one of ${APPROVAL_EVIDENCE_SOURCES.join(', ')}; received ${String(value)}`
    };
  }
  return { ok: true, value: value as ApprovalEvidenceSource };
}

/** The read model of one append-only approval event (design section 5.7). */
export interface ApprovalEventView {
  id: string;
  artworkRevisionId: string;
  organization: ApprovalOrganization;
  decision: ApprovalDecision;
  approvedFileSha256: string;
  recordedAt: Date | string;
  eventTime: Date | string;
  supersedesEventId: string | null;
  /**
   * M7 security fix S2: which evidence version and which per-organization
   * identifier the decision rests on. Optional so the pure gate derivation can
   * be exercised with minimal fixtures; the server always fills both.
   */
  evidenceDocumentVersionId?: string;
  evidenceIdentifier?: string | null;
}

/** The read model of one artwork revision; fileSha256 is the revision hash. */
export interface ArtworkRevisionView {
  id: string;
  filmSupplyOrderId: string;
  designKey: string;
  revisionNo: number;
  fileSha256: string;
  lotMarking?: string | null;
}

function toTime(value: Date | string): number {
  return typeof value === 'string' ? new Date(value).getTime() : value.getTime();
}

/**
 * Events are replayed in recording order; the id is the tiebreaker so a stable
 * derivation is guaranteed even when two events share a recorded_at instant.
 */
function compareByRecording(a: ApprovalEventView, b: ApprovalEventView): number {
  const byTime = toTime(a.recordedAt) - toTime(b.recordedAt);
  return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface OrganizationApprovalState {
  organization: ApprovalOrganization;
  /** True only for an uncanceled APPROVE bound to the given revision hash. */
  valid: boolean;
  latestEventId: string | null;
  latestDecision: ApprovalDecision | null;
  approvedFileSha256: string | null;
  lastEventTime: Date | string | null;
  /** Set when the latest APPROVE exists but is anchored to a superseded revision. */
  invalidatedByNewerRevision: boolean;
  /** Set when a REVOKE is the latest effective event. */
  revoked: boolean;
}

/**
 * Replays one organization's events for one revision and derives the current
 * approval state. A REVOKE clears the approval; a later APPROVE re-establishes
 * it. The hash comparison is the revision binding: an approval recorded for
 * bytes other than the current revision hash is never valid (T-11).
 */
export function resolveOrganizationApproval(
  events: readonly ApprovalEventView[],
  organization: ApprovalOrganization,
  revisionId: string,
  currentSha256: string
): OrganizationApprovalState {
  const scoped = events
    .filter((event) => event.organization === organization && event.artworkRevisionId === revisionId)
    .sort(compareByRecording);

  let approval: ApprovalEventView | null = null;
  let last: ApprovalEventView | null = null;
  let revoked = false;
  for (const event of scoped) {
    last = event;
    if (event.decision === 'APPROVE') {
      approval = event;
      revoked = false;
    } else {
      approval = null;
      revoked = true;
    }
  }

  const valid = approval !== null && approval.approvedFileSha256 === currentSha256;
  return {
    organization,
    valid,
    latestEventId: last?.id ?? null,
    latestDecision: last?.decision ?? null,
    approvedFileSha256: approval?.approvedFileSha256 ?? null,
    lastEventTime: last?.eventTime ?? null,
    invalidatedByNewerRevision: approval !== null && !valid,
    revoked: revoked && approval === null
  };
}

export interface DesignApprovalGate {
  designKey: string;
  currentRevisionId: string;
  currentRevisionNo: number;
  fileSha256: string;
  lotMarking: string | null;
  customer: OrganizationApprovalState;
  seven: OrganizationApprovalState;
  dualApproved: boolean;
}

/**
 * Derives the approval gate of one design from its current revision (the
 * highest revision_no) and that revision's events. Events belonging to earlier
 * revisions stay readable as audit history and are deliberately never read
 * here: approval never transfers across revisions.
 */
export function deriveDesignApprovalGate(
  revisions: readonly ArtworkRevisionView[],
  events: readonly ApprovalEventView[]
): DesignApprovalGate | null {
  if (revisions.length === 0) return null;
  const sorted = [...revisions].sort((a, b) => a.revisionNo - b.revisionNo);
  const current = sorted[sorted.length - 1]!;
  const customer = resolveOrganizationApproval(events, 'customer', current.id, current.fileSha256);
  const seven = resolveOrganizationApproval(events, 'seven', current.id, current.fileSha256);
  return {
    designKey: current.designKey,
    currentRevisionId: current.id,
    currentRevisionNo: current.revisionNo,
    fileSha256: current.fileSha256,
    lotMarking: current.lotMarking ?? null,
    customer,
    seven,
    dualApproved: customer.valid && seven.valid
  };
}

export interface OrderApprovalGate {
  /** True only when every required design holds both valid approvals (T-34). */
  dualApproved: boolean;
  requiredDesignKeys: string[];
  designs: DesignApprovalGate[];
  missingApprovals: Array<{ designKey: string; organization: ApprovalOrganization }>;
}

/**
 * Derives the order-level approval gate. Required designs are exactly the
 * designs that have at least one registered revision on the order; an order
 * with no revisions can never be dual-approved.
 */
export function deriveOrderApprovalGate(
  revisions: readonly ArtworkRevisionView[],
  events: readonly ApprovalEventView[]
): OrderApprovalGate {
  const byDesign = new Map<string, ArtworkRevisionView[]>();
  for (const revision of revisions) {
    const bucket = byDesign.get(revision.designKey);
    if (bucket) bucket.push(revision);
    else byDesign.set(revision.designKey, [revision]);
  }

  const designs: DesignApprovalGate[] = [];
  const missing: Array<{ designKey: string; organization: ApprovalOrganization }> = [];
  for (const designKey of [...byDesign.keys()].sort()) {
    const designRevisions = byDesign.get(designKey)!;
    const gate = deriveDesignApprovalGate(designRevisions, events);
    if (!gate) continue;
    designs.push(gate);
    for (const organization of REQUIRED_APPROVAL_ORGANIZATIONS) {
      if (!gate[organization].valid) missing.push({ designKey, organization });
    }
  }

  return {
    dualApproved: designs.length > 0 && designs.every((design) => design.dualApproved),
    requiredDesignKeys: designs.map((design) => design.designKey),
    designs,
    missingApprovals: missing
  };
}

/**
 * True when any APPROVE event was ever recorded for this design, on any of its
 * revisions. A design with approval history that receives a new revision has
 * lost its approvals and must go back through change review (T-11).
 */
export function hasApprovalHistoryForDesign(
  revisions: readonly ArtworkRevisionView[],
  events: readonly ApprovalEventView[],
  designKey: string
): boolean {
  const revisionIds = new Set(
    revisions.filter((revision) => revision.designKey === designKey).map((revision) => revision.id)
  );
  return events.some((event) => revisionIds.has(event.artworkRevisionId) && event.decision === 'APPROVE');
}

const NORMAL_STATES_BEFORE_DUAL_APPROVAL: readonly string[] = [
  'SEVEN_PO_VERIFIED',
  'ARTWORK_RECEIVED',
  'PROOF_READY',
  'APPROVAL_PENDING'
];

/**
 * Whether recording this APPROVE may advance the order to DUAL_APPROVED: the
 * gate must have just closed for both organizations and the order must still
 * be in the normal chain before DUAL_APPROVED. Exception states are business
 * side-channels and are never advanced automatically.
 */
export function shouldAdvanceToDualApproved(
  gate: OrderApprovalGate,
  orderStatus: string
): boolean {
  return gate.dualApproved && NORMAL_STATES_BEFORE_DUAL_APPROVAL.includes(orderStatus);
}

/**
 * Whether the revision-registration gate is open: artwork may only be
 * registered against an order that is at or past SEVEN_PO_VERIFIED. DRAFT is
 * the only state that has not reached the verified purchase order, so every
 * other state — including the exception side-channels reached after
 * verification — may receive a revision.
 */
export function isOrderPastSevenPoVerification(orderStatus: string): boolean {
  return orderStatus !== 'DRAFT';
}

/** The revision registration gate result. */
export type RevisionRegistrationGate =
  | { ok: true; gatedOn: 'order_past_seven_po_verified' }
  | { ok: false; code: 'ORDER_NOT_PAST_SEVEN_PO_VERIFIED'; message: string };

export function evaluateRevisionRegistrationGate(orderStatus: string): RevisionRegistrationGate {
  if (!isOrderPastSevenPoVerification(orderStatus)) {
    return {
      ok: false,
      code: 'ORDER_NOT_PAST_SEVEN_PO_VERIFIED',
      message: 'artwork revisions can only be registered for an order past SEVEN_PO_VERIFIED'
    };
  }
  return { ok: true, gatedOn: 'order_past_seven_po_verified' };
}

/**
 * The evidence document an approval event cites must be bound to exactly the
 * order, design and company of the revision it approves (T-35). The binding is
 * recorded when the document is uploaded; this check refuses any evidence whose
 * recorded binding disagrees with the revision, so an approval can never rest
 * on paperwork belonging to another order, another design or another project.
 */
export interface ApprovalEvidenceDocumentInput {
  projectId: string;
  documentType: DocumentType;
  filmSupplyOrderId: string | null;
  designKey: string | null;
}

export interface ApprovalEvidenceBindingInput {
  evidenceDocument: ApprovalEvidenceDocumentInput;
  order: { id: string; projectId: string };
  revision: { designKey: string };
}

export type ApprovalEvidenceBindingCheck =
  | { ok: true; boundOn: 'order_design_project' }
  | {
      ok: false;
      code:
        | 'EVIDENCE_DOCUMENT_TYPE_INVALID'
        | 'EVIDENCE_PROJECT_MISMATCH'
        | 'EVIDENCE_ORDER_MISMATCH'
        | 'EVIDENCE_DESIGN_MISMATCH';
      message: string;
    };

export function evaluateApprovalEvidenceBinding(
  input: ApprovalEvidenceBindingInput
): ApprovalEvidenceBindingCheck {
  const { evidenceDocument, order, revision } = input;

  if (evidenceDocument.documentType !== 'approval_evidence') {
    return {
      ok: false,
      code: 'EVIDENCE_DOCUMENT_TYPE_INVALID',
      message: 'approval evidence must be a document of type approval_evidence'
    };
  }
  if (evidenceDocument.projectId !== order.projectId) {
    return {
      ok: false,
      code: 'EVIDENCE_PROJECT_MISMATCH',
      message: 'approval evidence belongs to a different project (company)'
    };
  }
  if (evidenceDocument.filmSupplyOrderId !== order.id) {
    return {
      ok: false,
      code: 'EVIDENCE_ORDER_MISMATCH',
      message: 'approval evidence is bound to a different film supply order'
    };
  }
  if (evidenceDocument.designKey !== revision.designKey) {
    return {
      ok: false,
      code: 'EVIDENCE_DESIGN_MISMATCH',
      message: 'approval evidence is bound to a different design'
    };
  }
  return { ok: true, boundOn: 'order_design_project' };
}
