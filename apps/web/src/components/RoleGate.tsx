import type { ReactNode } from 'react';
import type { Operation } from '@kanei/core';
import { AUDITOR_PAGE_NOTICE, isAuditorRole, normalizeRole, operationRefusal, ROLE_UNKNOWN_PAGE_NOTICE, VIEWER_PAGE_NOTICE } from '../lib/permissions';

/**
 * UI batch B (④): a write form only for the roles that may run it. Otherwise
 * one quiet line says why, in place of the form. Display only — the API keeps
 * refusing whatever the role may not do.
 */
export function RoleGate({
  role,
  operation,
  label,
  children
}: {
  role: string | null | undefined;
  operation: Operation;
  /** What the form does, e.g. 「発注書の登録」. */
  label?: string;
  children: ReactNode;
}) {
  const refusal = operationRefusal(role, operation, label);
  if (refusal === null) return <>{children}</>;
  return <p className="role-notice">{refusal}</p>;
}

/**
 * The one-line notice under the progress block of every operator screen: for a
 * viewer, and — worded apart — when the role could not be read at all.
 */
export function ViewerPageNotice({ role }: { role: string | null | undefined }) {
  if (role === null || role === undefined) return <p className="role-notice">{ROLE_UNKNOWN_PAGE_NOTICE}</p>;
  if (isAuditorRole(role)) return <p className="role-notice">{AUDITOR_PAGE_NOTICE}</p>;
  if (normalizeRole(role) !== 'viewer') return null;
  return <p className="role-notice">{VIEWER_PAGE_NOTICE}</p>;
}
