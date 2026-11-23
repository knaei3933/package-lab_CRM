/**
 * p4/web3 (p4-web2b REVIEW L-6): 「外す」 removes the row its form sits in, so the form's own result line
 * goes with it and a screen reader hears nothing — and adding the last person in the list removes the add
 * form the same way (live check w04). The change is remembered for a short while (an httpOnly cookie:
 * project id, added/removed, user id, time — no name, no rule) and the panel says it in a status line that
 * is always on the page (a live region present before the change is the one that is announced).
 */
export const ASSIGNMENT_NOTICE_COOKIE = 'kanei_assignment_notice';
export const ASSIGNMENT_NOTICE_MAX_AGE_SECONDS = 120;

export interface AssignmentNotice {
  projectId: string;
  kind: 'added' | 'removed';
  userId: string;
  at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function encodeAssignmentNotice(notice: AssignmentNotice): string {
  return `${notice.projectId}|${notice.kind}|${notice.userId}|${notice.at}`;
}

/** Pure: the cookie back to a notice of THIS project; anything malformed is no notice. */
export function decodeAssignmentNotice(value: string | null | undefined, projectId: string): AssignmentNotice | null {
  if (typeof value !== 'string' || value.length > 120) return null;
  const [project, kind, userId, at, extra] = value.split('|');
  if (extra !== undefined || !project || !userId || !at || !UUID.test(userId) || !ISO.test(at) || project !== projectId) return null;
  if (kind !== 'added' && kind !== 'removed') return null;
  return { projectId: project, kind, userId, at };
}
