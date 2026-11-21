import { canPerform } from '@kanei/core';
import type { Operation, UserRole } from '@kanei/core';

/**
 * UI batch B (④): which write forms a role is shown. This is display only —
 * the API decides every request with the same canPerform and refuses what the
 * role may not do. A selected project is one the API already let the operator
 * open, so the check assumes the assignment; an unknown role reads as viewer.
 * A missing role (null: GET /api/me did not answer) hides the forms the same
 * way but is never called 閲覧者 — the screen asks for a reload instead.
 */
const SELECTED_PROJECT = 'ui-selected-project';

// P2: the server's UserRole now includes 'auditor'; this screen layer still knows
// three roles and reads every other role (auditor included) as viewer, as before.
export function normalizeRole(role: string | null | undefined): Exclude<UserRole, 'auditor'> {
  return role === 'admin' || role === 'staff' ? role : 'viewer';
}

export function canRoleOperate(role: string | null | undefined, operation: Operation): boolean {
  return canPerform(
    { id: 'ui', role: normalizeRole(role), isActive: true, assignedProjectIds: [SELECTED_PROJECT] },
    operation,
    'F1',
    SELECTED_PROJECT
  ).allowed;
}

export const VIEWER_REFUSAL = '閲覧権限のため操作できません';

/**
 * P2 P-2 (contract §7): the audit-only role reads the assigned projects and never
 * writes. The write forms treat it as a viewer (normalizeRole); its own wording
 * and menu are told apart with isAuditorRole.
 */
export function isAuditorRole(role: string | null | undefined): boolean {
  return role === 'auditor';
}

export const AUDITOR_REFUSAL = '監査の権限のため操作できません';
export const REPRESENTATIVE_ONLY = 'この操作は代表者が行います';
export const ROLE_UNKNOWN = '役割を確認できませんでした。再読み込みしてください';

/**
 * Why the role cannot run the operation, or null when it can. With a label the
 * sentence names the work: 「発注書の登録は、閲覧権限のため操作できません。」.
 */
export function operationRefusal(
  role: string | null | undefined,
  operation: Operation,
  label?: string
): string | null {
  if (canRoleOperate(role, operation)) return null;
  if (role === null || role === undefined) {
    return `${ROLE_UNKNOWN}。`;
  }
  if (isAuditorRole(role)) {
    return label ? `${label}は、${AUDITOR_REFUSAL}。` : `${AUDITOR_REFUSAL}。`;
  }
  if (normalizeRole(role) === 'viewer') {
    return label ? `${label}は、${VIEWER_REFUSAL}。` : `${VIEWER_REFUSAL}。`;
  }
  return label ? `${label}は代表者が行います。` : `${REPRESENTATIVE_ONLY}。`;
}

/** The one-line notice at the top of every operator screen for a viewer. */
export const VIEWER_PAGE_NOTICE = '閲覧者のため、この画面では記録・変更はできません（閲覧のみ）';

/** P2 P-2: the same notice for the audit-only role (amounts and file contents are never shown to it). */
export const AUDITOR_PAGE_NOTICE = '監査の権限のため、この画面では記録・変更はできません（閲覧のみ）。金額とファイルの中身は表示しません';

/** The page notice when the role could not be read: forms are hidden, nothing is claimed. */
export const ROLE_UNKNOWN_PAGE_NOTICE = `${ROLE_UNKNOWN}（記録・変更のフォームは表示していません）`;
