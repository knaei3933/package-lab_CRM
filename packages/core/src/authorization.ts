export type UserRole = 'admin' | 'staff' | 'viewer';
export type BusinessUnit = 'F1';
export type Operation =
  | 'project:create'
  | 'project:read'
  | 'project:update'
  | 'ceo_approve'
  | 'seven_po:create'
  | 'seven_po:register'
  | 'pre_order:create'
  | 'pre_order:promote'
  | 'film_order:create'
  | 'film_order_line:create'
  | 'film_order:transition'
  | 'film_delivery:create'
  | 'filling_order:create'
  | 'filling_order_line:create'
  | 'filling_delivery:create'
  | 'commission_readiness:evaluate';

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

  if (!projectId) return { allowed: false, reason: 'PROJECT_NOT_ASSIGNED' };
  const assigned = actor.assignedProjectIds.includes(projectId);
  if (!assigned) return { allowed: false, reason: 'PROJECT_NOT_ASSIGNED' };

  if (actor.role === 'viewer') {
    return operation === 'project:read'
      ? { allowed: true }
      : { allowed: false, reason: 'ROLE_FORBIDDEN' };
  }

  return { allowed: true };
}
