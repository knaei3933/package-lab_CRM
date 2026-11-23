/**
 * P2 policy P-2: 'auditor' is the audit-only role, separate from 'viewer'
 * (see AUDITOR_READ_OPERATIONS below).
 */
export type UserRole = 'admin' | 'staff' | 'viewer' | 'auditor';
export const USER_ROLES: readonly UserRole[] = ['admin', 'staff', 'viewer', 'auditor'];
export type BusinessUnit = 'F1';
export type Operation =
  | 'project:create'
  | 'project:read'
  | 'project:update'
  | 'ceo_approve'
  | 'seven_po:create'
  | 'seven_po:register'
  | 'seven_po:register_overwrite'
  | 'seven_po:verify'
  | 'pre_order:create'
  | 'pre_order:promote'
  | 'document:create'
  | 'document:read'
  | 'document:verify'
  | 'artwork_revision:create'
  | 'artwork_approval:record'
  | 'artwork_approval:read'
  | 'artwork_approval:verify_evidence'
  | 'supply_order:create'
  | 'maker_po:create'
  | 'maker_po:read'
  | 'maker_po:cancel'
  | 'maker_po:send_evidence'
  | 'maker_po:accept_evidence'
  | 'maker_po:accept_provisional'
  | 'maker_po:verify_send'
  | 'film_order:create'
  | 'film_order:update_payment_terms'
  | 'film_order_line:create'
  | 'film_order:transition'
  | 'film_order:release_hold'
  | 'film_order:resolve_cancellation_review'
  | 'film_order:assume_receipt'
  | 'film_delivery:create'
  | 'delivery_confirmation:record'
  | 'filling_order:create'
  | 'filling_order_line:create'
  | 'filling_delivery:create'
  | 'commission_readiness:evaluate'
  | 'audit_history:read'
  // P2 R30: 希望納期・納品予定日 on a film order (staff work on an assigned project).
  | 'film_order:update_delivery_dates'
  // P2 R30: セブン化学発注書 quantity (staff) and amount (representative only).
  | 'seven_po:update_order_facts'
  | 'seven_po:update_amount'
  // P2 R33: read the maker's recipient addresses for an assigned project; manage the master.
  | 'maker_recipient:read'
  | 'maker_master:manage'
  // P2 P-2: evidence metadata (file name, hash, issuer, who uploaded/verified, when) — never bytes.
  | 'evidence_metadata:read'
  // P4 N1: list, add and remove the users assigned to a project (representative only).
  | 'project_assignment:manage'
  // P5 R5: the registered contact address of a customer / セブン化学 account (representative only).
  | 'partner_contact:manage';

export interface AuthenticatedActor {
  id: string;
  role: UserRole;
  isActive: boolean;
  assignedProjectIds: readonly string[];
}

export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: 'INACTIVE_ACTOR' | 'ROLE_FORBIDDEN' | 'PROJECT_NOT_ASSIGNED' };

/**
 * M8-OPERATOR FIX 2: the maker purchase-order matrix (design section 5.8). The
 * paper moves money, so freezing it (create) and closing it (final acceptance)
 * are the representative's decisions and are never delegated; the staff work on
 * an assigned project is recording the manual send and the provisional
 * acceptance; the viewer reads a non-sensitive status only.
 */
const MAKER_PO_ADMIN_ONLY_OPERATIONS: readonly Operation[] = [
  // P1 integration (policy P-6, decided 11-21): the DRAFT paper is drawn up by
  // staff (or the system); approving it (ceo-approval) stays the representative's.
  'maker_po:accept_evidence',
  // M8-HARDEN FIX B2: cancelling live paper frees the order for replacement
  // paper, so it is the representative's decision exactly like freezing it.
  'maker_po:cancel',
  // M8-HARDEN FIX C1: the manual verification that asserts a send's delivery is
  // never delegated — it is the human act that lifts a pending verification.
  'maker_po:verify_send'
];

/** Maker PO operations an assigned staff user may run (admin may always). */
const MAKER_PO_STAFF_OPERATIONS: readonly Operation[] = [
  'maker_po:read',
  'maker_po:create',
  'maker_po:send_evidence',
  'maker_po:accept_provisional'
];

/**
 * P2: operations only the representative runs. The amount of a seven PO is the
 * representative's information (staff never read amounts, so they never write
 * them), and the maker master decides where a maker PO may be sent.
 */
const P2_ADMIN_ONLY_OPERATIONS: readonly Operation[] = [
  'seven_po:update_amount',
  'maker_master:manage',
  // P4 N1: the assignment decides what staff, viewer and auditor may open, so
  // granting or removing it is the representative's decision.
  'project_assignment:manage',
  // P5 R5: the registered domain decides which approval mails count by
  // themselves (N4(b)), so setting it is the representative's decision.
  'partner_contact:manage'
];

/**
 * P2 policy P-2: what the auditor may read, on an assigned project only. The
 * answers these operations produce are shaped for the auditor role (codes,
 * statuses, who approved what and when, evidence metadata) and never carry
 * amounts or unit prices. Every other operation — every write, every download
 * of evidence bytes, every representative-only read — is refused.
 */
const AUDITOR_READ_OPERATIONS: readonly Operation[] = [
  'project:read',
  'audit_history:read',
  'maker_po:read',
  'artwork_approval:read',
  'evidence_metadata:read'
];

/**
 * Pure authorization core used by every server route. Staff write access is
 * assignment-scoped. CEO approval is intentionally never delegated.
 */
export function canPerform(
  actor: AuthenticatedActor,
  operation: Operation,
  businessUnit: BusinessUnit,
  projectId?: string
): AuthorizationDecision {
  if (!actor.isActive) return { allowed: false, reason: 'INACTIVE_ACTOR' };

  if (operation === 'ceo_approve') {
    return actor.role === 'admin'
      ? { allowed: true }
      : { allowed: false, reason: 'ROLE_FORBIDDEN' };
  }

  // M8-OPER2 FIX 2: confirming or rejecting a pending evidence identifier is
  // the human act that lets an approval complete the dual approval, so it is
  // never delegated — the representative verifies, staff and viewer wait.
  if (operation === 'artwork_approval:verify_evidence') {
    return actor.role === 'admin'
      ? { allowed: true }
      : { allowed: false, reason: 'ROLE_FORBIDDEN' };
  }

  // The first official registration is staff recording work. Once a date
  // exists, changing it rewrites the date every downstream gate reads, so only
  // the representative may call register-official again.
  if (operation === 'seven_po:register_overwrite') {
    return actor.role === 'admin'
      ? { allowed: true }
      : { allowed: false, reason: 'ROLE_FORBIDDEN' };
  }

  // Releasing a hold rewrites the order's position in the delivery chain. The
  // representative owns that recovery decision; staff and viewer are denied
  // before project assignment can make the answer differ.
  if (operation === 'film_order:release_hold') {
    return actor.role === 'admin'
      ? { allowed: true }
      : { allowed: false, reason: 'ROLE_FORBIDDEN' };
  }

  // Closing a cancellation review is equally final: it resumes the exact entry
  // origin or closes the film order as cancelled. The representative owns both.
  if (operation === 'film_order:resolve_cancellation_review') {
    return actor.role === 'admin'
      ? { allowed: true }
      : { allowed: false, reason: 'ROLE_FORBIDDEN' };
  }

  if (actor.role === 'admin') return { allowed: true };

  // P2 P-2: the auditor reads, and only the AUDITOR_READ_OPERATIONS, and only on
  // an assigned project. Checked before every staff/viewer rule so no later
  // default (project:create, the staff fall-through) can ever allow a write.
  if (actor.role === 'auditor') {
    if (!AUDITOR_READ_OPERATIONS.includes(operation)) return { allowed: false, reason: 'ROLE_FORBIDDEN' };
    if (!projectId) return { allowed: false, reason: 'PROJECT_NOT_ASSIGNED' };
    return actor.assignedProjectIds.includes(projectId)
      ? { allowed: true }
      : { allowed: false, reason: 'PROJECT_NOT_ASSIGNED' };
  }
  // Fail closed for any role this function does not know.
  if (actor.role !== 'staff' && actor.role !== 'viewer') return { allowed: false, reason: 'ROLE_FORBIDDEN' };

  if (P2_ADMIN_ONLY_OPERATIONS.includes(operation)) return { allowed: false, reason: 'ROLE_FORBIDDEN' };

  if (operation === 'project:create') {
    // P2 conductor decision (2026-11-21): the viewer writes nothing — creating
    // a project included (until P2 any signed-in role could).
    if (actor.role === 'viewer') return { allowed: false, reason: 'ROLE_FORBIDDEN' };
    return businessUnit === 'F1' ? { allowed: true } : { allowed: false, reason: 'ROLE_FORBIDDEN' };
  }

  // M8-OPERATOR FIX 1: the maker PO status read is the one maker-PO operation a
  // viewer may run, and only on an assigned project — the filtered answer keeps
  // the amounts out.
  if (actor.role === 'viewer' && operation === 'maker_po:read') {
    if (!projectId) return { allowed: false, reason: 'PROJECT_NOT_ASSIGNED' };
    return actor.assignedProjectIds.includes(projectId)
      ? { allowed: true }
      : { allowed: false, reason: 'PROJECT_NOT_ASSIGNED' };
  }

  if (!projectId) return { allowed: false, reason: 'PROJECT_NOT_ASSIGNED' };
  const assigned = actor.assignedProjectIds.includes(projectId);
  if (!assigned) return { allowed: false, reason: 'PROJECT_NOT_ASSIGNED' };

  if (actor.role === 'viewer') {
    const readable = operation === 'project:read' || operation === 'audit_history:read';
    return readable
      ? { allowed: true }
      : { allowed: false, reason: 'ROLE_FORBIDDEN' };
  }

  // G6 auto-fill exposes only the mail's own Message-ID header, never stored
  // bytes or paths. It is evidence needed to record an approval, so a viewer
  // has no reason to call it while assigned staff and the representative may.
  if (operation === 'document:read') {
    return actor.role === 'staff' ? { allowed: true } : { allowed: false, reason: 'ROLE_FORBIDDEN' };
  }

  if (MAKER_PO_ADMIN_ONLY_OPERATIONS.includes(operation)) {
    return { allowed: false, reason: 'ROLE_FORBIDDEN' };
  }
  if (MAKER_PO_STAFF_OPERATIONS.includes(operation)) {
    return { allowed: true };
  }

  return { allowed: true };
}

/**
 * The one authorization gate for writing an existing seven-PO official date.
 * New rows are initial registrations and use the caller's regular permission;
 * once a date exists, both separate HTTP routes must arrive here.
 */
export function canWriteSevenPoOfficialDate(
  actor: AuthenticatedActor,
  currentOfficialRegisteredAt: Date | string | null,
  businessUnit: BusinessUnit,
  projectId?: string
): AuthorizationDecision {
  const isOverwrite = currentOfficialRegisteredAt !== null && currentOfficialRegisteredAt !== undefined;
  return canPerform(
    actor,
    isOverwrite ? 'seven_po:register_overwrite' : 'seven_po:register',
    businessUnit,
    projectId
  );
}
