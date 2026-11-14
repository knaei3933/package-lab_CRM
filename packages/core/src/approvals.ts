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

/**
 * M8-OPERATOR FIX 4: what the identifier check did with the cited evidence.
 * `verified_in_document` means the identifier was found in the stored text,
 * `pending_manual_verification` means the evidence is binary (PDF/image) and a
 * human must confirm the identifier before the approval counts, and
 * `not_applicable` marks events whose decision never contributes to an approval
 * (a REVOKE) — the identifier was still checked where the evidence is text.
 */
export const EVIDENCE_IDENTIFIER_STATUSES = [
  'verified_in_document',
  'pending_manual_verification',
  'not_applicable'
] as const;

export type EvidenceIdentifierStatus = (typeof EVIDENCE_IDENTIFIER_STATUSES)[number];

/**
 * M8-OPER2 FIX 2: what a human decided when they checked a PDF/image approval's
 * identifier against the original evidence. The verification is its own
 * append-only event — never an edit of the approval it is about — so a
 * correction is a new row and the latest one wins.
 */
export const EVIDENCE_VERIFICATION_RESULTS = ['confirmed', 'rejected'] as const;

export type EvidenceVerificationResult = (typeof EVIDENCE_VERIFICATION_RESULTS)[number];

export function validateEvidenceVerificationResult(
  value: unknown
): OrganizationValidation<EvidenceVerificationResult> {
  if (typeof value !== 'string' || !(EVIDENCE_VERIFICATION_RESULTS as readonly string[]).includes(value)) {
    return {
      ok: false,
      code: 'UNKNOWN_EVIDENCE_VERIFICATION_RESULT',
      message: `result must be one of ${EVIDENCE_VERIFICATION_RESULTS.join(', ')}; received ${String(value)}`
    };
  }
  return { ok: true, value: value as EvidenceVerificationResult };
}

/** The read model of one append-only manual verification event (M8-OPER2 FIX 2). */
export interface EvidenceVerificationView {
  id: string;
  /** The approval event this verification is about; the approval is never edited. */
  approvalEventId: string;
  artworkRevisionId: string;
  /** The revision hash the human confirmed: must equal the approval's own hash. */
  approvedFileSha256: string;
  result: EvidenceVerificationResult;
  verifierName: string;
  verifiedAt: Date | string;
  recordedAt: Date | string;
}

/** Content types whose bytes are (mostly) text and can be searched as text. */
const TEXT_LIKE_EVIDENCE_PREFIXES = ['text/'] as const;

export function isTextLikeEvidence(contentType: string | null | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  return TEXT_LIKE_EVIDENCE_PREFIXES.some((prefix) => contentType.toLowerCase().startsWith(prefix));
}

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
  /**
   * M8-OPERATOR FIX 4: how the identifier was checked against the cited
   * evidence. Optional so the pure gate derivation keeps working with minimal
   * fixtures and so rows written before this check existed (status null) keep
   * counting — only an explicit pending_manual_verification flag holds an
   * approval out of the gate.
   */
  evidenceIdentifierStatus?: EvidenceIdentifierStatus | string | null;
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
function compareByRecording<T extends { recordedAt: Date | string; id: string }>(a: T, b: T): number {
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
  /**
   * M8-OPERATOR FIX 4: the latest APPROVE cites binary evidence whose
   * identifier a human still has to confirm. The event is recorded, but it
   * never completes the dual approval while this is true.
   */
  pendingEvidenceIdentifier: boolean;
  /**
   * M8-OPER2 FIX 2: the latest manual verification recorded for the pending
   * APPROVE (null while none exists). Only a 'confirmed' verification lets the
   * approval count toward the dual approval; 'rejected' — or no verification at
   * all — keeps the gate closed. A verification is bound to the approval event
   * id, the revision and the exact revision hash, so it can never confirm a
   * decision about other bytes.
   */
  manualVerification: {
    result: EvidenceVerificationResult;
    verifierName: string;
    verifiedAt: Date | string;
    recordedAt: Date | string;
  } | null;
}

/**
 * The latest verification naming this approval event, this revision and this
 * exact revision hash. Verifications are append-only: a later one supersedes an
 * earlier one by replay order, never by editing it.
 */
function latestVerificationFor(
  approvalEventId: string,
  revisionId: string,
  currentSha256: string,
  verifications: readonly EvidenceVerificationView[]
): EvidenceVerificationView | null {
  const matches = verifications
    .filter((verification) =>
      verification.approvalEventId === approvalEventId
      && verification.artworkRevisionId === revisionId
      && verification.approvedFileSha256 === currentSha256
    )
    .sort(compareByRecording);
  return matches.length > 0 ? matches[matches.length - 1]! : null;
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
  currentSha256: string,
  verifications: readonly EvidenceVerificationView[] = []
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

  // M8-OPERATOR FIX 4: an APPROVE whose identifier is still awaiting manual
  // verification is a recorded fact but not a counted approval — it can never
  // complete the dual approval on its own (and nothing auto-approves it later).
  // M8-OPER2 FIX 2: the only thing that lifts that hold is a human's 'confirmed'
  // verification of exactly this approval event. A 'rejected' verification, or
  // no verification at all, keeps the approval out of the gate.
  const manualVerificationRow = approval === null
    ? null
    : latestVerificationFor(approval.id, revisionId, currentSha256, verifications);
  const manualVerification = manualVerificationRow === null
    ? null
    : {
        result: manualVerificationRow.result,
        verifierName: manualVerificationRow.verifierName,
        verifiedAt: manualVerificationRow.verifiedAt,
        recordedAt: manualVerificationRow.recordedAt
      };
  const pendingEvidenceIdentifier =
    approval !== null
    && approval.evidenceIdentifierStatus === 'pending_manual_verification'
    && manualVerification?.result !== 'confirmed';
  const valid =
    approval !== null && approval.approvedFileSha256 === currentSha256 && !pendingEvidenceIdentifier;
  return {
    organization,
    valid,
    latestEventId: last?.id ?? null,
    latestDecision: last?.decision ?? null,
    approvedFileSha256: approval?.approvedFileSha256 ?? null,
    lastEventTime: last?.eventTime ?? null,
    invalidatedByNewerRevision:
      approval !== null && approval.approvedFileSha256 !== currentSha256,
    revoked: revoked && approval === null,
    pendingEvidenceIdentifier,
    manualVerification
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
 * here: approval never transfers across revisions. The manual verifications
 * (M8-OPER2 FIX 2) decide which pending approvals count; they are optional so
 * the pure derivation keeps working without them — an absent verification list
 * simply leaves every pending approval out of the gate.
 */
export function deriveDesignApprovalGate(
  revisions: readonly ArtworkRevisionView[],
  events: readonly ApprovalEventView[],
  verifications: readonly EvidenceVerificationView[] = []
): DesignApprovalGate | null {
  if (revisions.length === 0) return null;
  const sorted = [...revisions].sort((a, b) => a.revisionNo - b.revisionNo);
  const current = sorted[sorted.length - 1]!;
  const customer = resolveOrganizationApproval(events, 'customer', current.id, current.fileSha256, verifications);
  const seven = resolveOrganizationApproval(events, 'seven', current.id, current.fileSha256, verifications);
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
  events: readonly ApprovalEventView[],
  verifications: readonly EvidenceVerificationView[] = []
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
    const gate = deriveDesignApprovalGate(designRevisions, events, verifications);
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
 * M7-SEC3 FIX 1: the evidence identifier is only accepted when it is actually
 * derivable from the evidence document the event cites.
 *
 * The deterministic rule (one rule, no fallback): the identifier must appear in
 * the stored evidence version's decoded text content as a literal, case
 * sensitive substring. Decoding is `Buffer.toString('utf8')`, so an identifier
 * quoted inside a mail export, a signed PDF's text layer or a CSV log matches,
 * and an identifier invented by the recorder does not.
 *
 * Why substring and not a sha256 prefix: two organizations may legitimately
 * cite the same evidence file version (M7 fix S2), and a digest prefix is the
 * same for both of them, so the digest rule would make the per-organization
 * identifier impossible exactly where S2 needs it. The substring rule keeps the
 * two organizations distinguishable inside one shared file — each quotes its
 * own message id or signature block.
 */
export interface ApprovalEvidenceIdentifierInput {
  identifier: string;
  /** The stored evidence version's bytes, decoded as UTF-8. */
  evidenceText: string;
}

export type ApprovalEvidenceIdentifierCheck =
  | { ok: true; matchedOn: 'evidence_document_content' }
  | { ok: false; code: 'EVIDENCE_IDENTIFIER_NOT_IN_DOCUMENT'; message: string };

export function evaluateApprovalEvidenceIdentifier(
  input: ApprovalEvidenceIdentifierInput
): ApprovalEvidenceIdentifierCheck {
  const { identifier, evidenceText } = input;
  if (!evidenceText.includes(identifier)) {
    return {
      ok: false,
      code: 'EVIDENCE_IDENTIFIER_NOT_IN_DOCUMENT',
      message:
        '承認証跡識別子（evidenceIdentifier）は引用した承認証跡ファイルの内容に含まれていなければなりません。メッセージIDや署名ブロックなど、証跡ファイル内に実際に記録されている識別子を指定してください'
    };
  }
  return { ok: true, matchedOn: 'evidence_document_content' };
}

/**
 * M8-OPERATOR FIX 4: the same identifier rule, aware of what the evidence
 * actually is.
 *
 * The UTF-8 substring rule above silently lies for binary evidence: a PDF or an
 * image does not carry its text as raw UTF-8, so a genuine signed PDF fails the
 * check (the operator then uploads a fake "text" file instead), and a crafted
 * byte string can pass it. Both directions are wrong, so the check now splits on
 * the evidence kind:
 * - text-like evidence (text/plain, text/csv): unchanged substring match, and a
 *   miss is still a refusal;
 * - binary evidence (PDF, images): the identifier is never auto-verified. The
 *   event is recorded with `pending_manual_verification` and — through the gate
 *   derivation — never completes the dual approval until a human confirms the
 *   identifier. Nothing here approves anything by itself.
 */
export interface ApprovalEvidenceIdentifierBytesInput {
  identifier: string;
  /** The stored evidence version's bytes. */
  bytes: Buffer;
  /** The declared content type of the evidence version. */
  contentType: string | null | undefined;
}

export type ApprovalEvidenceIdentifierBytesCheck =
  | {
      ok: true;
      status: 'verified_in_document';
      matchedOn: 'evidence_document_content';
    }
  | {
      ok: true;
      status: 'pending_manual_verification';
      matchedOn: 'manual_verification';
      message: string;
    }
  | { ok: false; code: 'EVIDENCE_IDENTIFIER_NOT_IN_DOCUMENT'; message: string };

export function evaluateApprovalEvidenceIdentifierForBytes(
  input: ApprovalEvidenceIdentifierBytesInput
): ApprovalEvidenceIdentifierBytesCheck {
  if (isTextLikeEvidence(input.contentType)) {
    const check = evaluateApprovalEvidenceIdentifier({
      identifier: input.identifier,
      // Binary-looking bytes uploaded as text simply do not match, which is the
      // existing refusal — no new status is invented for them.
      evidenceText: input.bytes.toString('utf8')
    });
    return check.ok
      ? { ok: true, status: 'verified_in_document', matchedOn: check.matchedOn }
      : check;
  }

  return {
    ok: true,
    status: 'pending_manual_verification',
    matchedOn: 'manual_verification',
    message:
      '承認証跡がバイナリ（PDF・画像）のため、識別子（evidenceIdentifier）は自動検証できません。承認イベントは記録しましたが、手動確認が完了するまで二重承認には算入されません'
  };
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
