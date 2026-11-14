export type UserRole = 'admin' | 'staff' | 'viewer';
export type BusinessUnit = 'F1';
export type Operation =
  | 'project:create'
  | 'project:read'
  | 'project:update'
  | 'ceo_approve'
  | 'seven_po:create'
  | 'seven_po:register'
  | 'seven_po:verify'
  | 'pre_order:create'
  | 'pre_order:promote'
  | 'document:create'
  | 'document:verify'
  | 'artwork_revision:create'
  | 'artwork_approval:record'
  | 'artwork_approval:read'
  | 'supply_order:create'
  | 'maker_po:create'
  | 'maker_po:read'
  | 'maker_po:send_evidence'
  | 'maker_po:accept_evidence'
  | 'maker_po:accept_provisional'
  | 'film_order:create'
  | 'film_order:update_payment_terms'
  | 'film_order_line:create'
  | 'film_order:transition'
  | 'film_order:assume_receipt'
  | 'film_delivery:create'
  | 'delivery_confirmation:record'
  | 'filling_order:create'
  | 'filling_order_line:create'
  | 'filling_delivery:create'
  | 'commission_readiness:evaluate'
  | 'audit_history:read';

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
  'maker_po:create',
  'maker_po:accept_evidence'
];

/** Maker PO operations an assigned staff user may run (admin may always). */
const MAKER_PO_STAFF_OPERATIONS: readonly Operation[] = [
  'maker_po:read',
  'maker_po:send_evidence',
  'maker_po:accept_provisional'
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

  if (actor.role === 'admin') return { allowed: true };

  if (operation === 'project:create') {
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

  if (MAKER_PO_ADMIN_ONLY_OPERATIONS.includes(operation)) {
    return { allowed: false, reason: 'ROLE_FORBIDDEN' };
  }
  if (MAKER_PO_STAFF_OPERATIONS.includes(operation)) {
    return { allowed: true };
  }

  return { allowed: true };
}
